// BTX send: coin selection + broadcast. The actual signing happens in the
// crypto worker (it holds the ML-DSA secret); this module prepares the
// inputs/outputs and broadcasts the signed hex via the RPC edge.

import { BTX_RPC_POOL, btxParams } from "../chains/btx/network";
import { p2mrScriptPubKey, estimateBtxVsize, type BtxTxInput, type BtxTxOutput } from "../chains/btx/tx";
import { decodeP2MRAddress } from "../chains/btx/address";
import { fetchBtxUtxos, type BtxUtxo } from "./btx-indexer";

const DUST_SAT = 546n;
export const DEFAULT_FEE_RATE = 25; // sat/vByte (BTX mempool floor is generous; PQ txs are large)

export interface BtxSpendPlan {
  ins: BtxTxInput[];
  outs: BtxTxOutput[];
  feeSat: bigint;
  changeSat: bigint;
}

/** Validate a recipient is a well-formed BTX P2MR address. Throws otherwise. */
export function assertValidBtxRecipient(address: string): void {
  decodeP2MRAddress(address); // throws on bad hrp/version/checksum
}

/**
 * Coin-select over a single-address UTXO set (the beta wallet uses one receive
 * address). Greedy largest-first until amount+fee is covered; adds a change
 * output back to `fromAddress` unless it would be dust. Throws on insufficient
 * funds. Fee is recomputed as inputs are added (PQ inputs are ~3.8KB each).
 */
export function planBtxSpend(
  fromAddress: string,
  utxos: BtxUtxo[],
  toAddress: string,
  amountSat: bigint,
  feeRatePerVb = DEFAULT_FEE_RATE,
): BtxSpendPlan {
  assertValidBtxRecipient(toAddress);
  if (amountSat <= 0n) throw new Error("amount must be positive");
  const fromSpk = p2mrScriptPubKey(fromAddress);
  const toSpk = p2mrScriptPubKey(toAddress);
  const sorted = [...utxos].sort((a, b) => (b.valueSat > a.valueSat ? 1 : b.valueSat < a.valueSat ? -1 : 0));

  const ins: BtxTxInput[] = [];
  let inSum = 0n;
  for (const u of sorted) {
    ins.push({ txid: u.txid, vout: u.vout, valueSat: u.valueSat, scriptPubKey: fromSpk });
    inSum += u.valueSat;
    // fee for current input count, assuming recipient + change (2 outs)
    const fee = BigInt(estimateBtxVsize(ins.length, 2) * feeRatePerVb);
    if (inSum >= amountSat + fee) {
      const change = inSum - amountSat - fee;
      const outs: BtxTxOutput[] = [{ scriptPubKey: toSpk, valueSat: amountSat }];
      if (change >= DUST_SAT) {
        outs.push({ scriptPubKey: fromSpk, valueSat: change });
        return { ins, outs, feeSat: fee, changeSat: change };
      }
      // change is dust → drop it, recompute fee for 1 output, give dust to fee
      const fee1 = BigInt(estimateBtxVsize(ins.length, 1) * feeRatePerVb);
      if (inSum >= amountSat + fee1) {
        return { ins, outs, feeSat: inSum - amountSat, changeSat: 0n };
      }
    }
  }
  throw new Error("insufficient BTX balance for amount + fee");
}

/** Convenience: fetch UTXOs then plan. */
export async function prepareBtxSpend(
  fromAddress: string,
  toAddress: string,
  amountSat: bigint,
  feeRatePerVb = DEFAULT_FEE_RATE,
  override?: string,
): Promise<BtxSpendPlan> {
  const utxos = await fetchBtxUtxos(fromAddress, override);
  return planBtxSpend(fromAddress, utxos, toAddress, amountSat, feeRatePerVb);
}

/** Broadcast a signed tx hex via the RPC edge pool (sendrawtransaction). */
export async function broadcastBtxTx(hex: string, override?: string): Promise<string> {
  const params = btxParams("mainnet", override);
  const bases = Array.from(
    new Set((params.rpcLabel === "custom" ? [params.rpcUrl, ...BTX_RPC_POOL] : [...BTX_RPC_POOL]).map((u) => u.replace(/\/+$/, ""))),
  );
  let lastErr: unknown = new Error("no BTX endpoints");
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "1.0", id: "send", method: "sendrawtransaction", params: [hex] }),
      });
      const j = (await res.json()) as { result?: string; error?: { message: string } };
      if (j.error) throw new Error(j.error.message); // node rejected — do NOT rotate (deterministic)
      if (typeof j.result === "string" && j.result.length === 64) return j.result; // txid
      throw new Error("unexpected sendrawtransaction response"); // never silently rotate past this
    } catch (e) {
      // A node-level reject (RuntimeError from j.error) is deterministic — rethrow.
      if (e instanceof Error && !/fetch|network|timeout|5\d\d/i.test(e.message)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
