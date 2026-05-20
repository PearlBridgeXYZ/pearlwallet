// Thin JSON-RPC client for the Pearl sentry endpoint. Only methods
// the public sentry allowlist exposes are used (see
// docs/SENTRY-RPC-REQUIREMENTS.md). PRL balance is computed by
// walking searchrawtransactions and folding inputs/outputs into a
// UTXO set keyed by `${txid}:${vout}`.

import { pearlParams } from "../chains/pearl/network";
import { useUI } from "../state/ui-store";

interface RpcResult<T> {
  jsonrpc?: string;
  result: T | null;
  error: { code: number; message: string } | null;
  id: number | string | null;
}

interface RawTxVout {
  value: number; // PRL as float — converted via toFixed(8) to avoid IEEE drift
  n: number;
  scriptPubKey: {
    address?: string;
    addresses?: string[];
  };
}

interface RawTxVin {
  txid?: string; // absent on coinbase
  vout?: number;
}

interface RawTx {
  txid: string;
  vin: RawTxVin[];
  vout: RawTxVout[];
  confirmations?: number;
}

function rpcUrl(): string {
  const override = useUI.getState().pearlRpcOverride;
  return pearlParams("mainnet", override).rpcUrl;
}

async function call<T>(method: string, params: unknown[]): Promise<T> {
  // Single retry on transient sentry overload (5xx). Pool walks fire
  // multiple heavyweight searchrawtransactions calls in flight and a
  // brief 503 burst from the sentry would otherwise mark the whole
  // balance as "error" for the user.
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    const res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    if (!res.ok) {
      lastErr = new Error(`rpc http ${res.status}`);
      if (res.status >= 500 && res.status < 600) continue;
      throw lastErr;
    }
    const body = (await res.json()) as RpcResult<T>;
    if (body.error) {
      // -5 "No information available about address" = zero-activity address.
      // Caller catches and converts to empty result.
      throw new Error(`rpc ${body.error.code}: ${body.error.message}`);
    }
    if (body.result === null) throw new Error("rpc null result");
    return body.result;
  }
  throw lastErr ?? new Error("rpc exhausted retries");
}

// PRL float → grains. Round via toFixed(8) string to dodge float drift.
function prlToGrains(value: number): bigint {
  const [whole, frac = ""] = value.toFixed(8).split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace("-", "");
  return sign * (BigInt(wholeAbs) * 100_000_000n + BigInt(fracPadded));
}

function voutPaysAddress(vout: RawTxVout, address: string): boolean {
  if (vout.scriptPubKey.address === address) return true;
  return Array.isArray(vout.scriptPubKey.addresses) &&
    vout.scriptPubKey.addresses.includes(address);
}

/**
 * Returns the confirmed + mempool balance (in grains) for `address`,
 * by walking searchrawtransactions in pages and tracking a UTXO set.
 */
export async function fetchPrlBalanceGrains(address: string): Promise<bigint> {
  const PAGE = 100;
  let skip = 0;
  const utxo = new Map<string, bigint>();

  while (true) {
    let page: RawTx[];
    try {
      page = await call<RawTx[]>("searchrawtransactions", [address, 1, skip, PAGE]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Zero-activity addresses come back as -5; treat as empty wallet.
      if (msg.includes("No information available about address")) return 0n;
      throw err;
    }
    if (!page || page.length === 0) break;

    for (const tx of page) {
      for (const vout of tx.vout) {
        if (voutPaysAddress(vout, address)) {
          utxo.set(`${tx.txid}:${vout.n}`, prlToGrains(vout.value));
        }
      }
      for (const vin of tx.vin) {
        if (!vin.txid || vin.vout === undefined) continue;
        utxo.delete(`${vin.txid}:${vin.vout}`);
      }
    }

    if (page.length < PAGE) break;
    skip += page.length;
  }

  let total = 0n;
  for (const amt of utxo.values()) total += amt;
  return total;
}
