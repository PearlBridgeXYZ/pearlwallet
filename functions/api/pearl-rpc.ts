// CF Pages Function: POST /api/pearl-rpc
//
// Same-origin Pearl RPC compatibility proxy backed by Blockbook. This
// keeps pearlwallet.xyz usable when the browser cannot reach the public
// sentry RPC directly, and avoids exposing blockbook.pearlresearch.ai to
// browser CORS. Only the wallet's small JSON-RPC method surface is
// translated.

const BLOCKBOOK_URL = "https://blockbook.pearlresearch.ai";

interface JsonRpcRequest {
  jsonrpc?: string;
  method?: string;
  params?: unknown[];
  id?: string | number | null;
}

interface BlockbookVin {
  txid?: string;
  vout?: number;
  n?: number;
}

interface BlockbookVout {
  value?: string | number;
  n?: number;
  hex?: string;
  addresses?: string[];
}

interface BlockbookTx {
  txid?: string;
  vin?: BlockbookVin[];
  vout?: BlockbookVout[];
  confirmations?: number;
  blockHash?: string;
  hex?: string;
  time?: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function ok(id: JsonRpcRequest["id"], result: unknown): Response {
  return json({ jsonrpc: "2.0", result, id: id ?? null });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
  return json({ jsonrpc: "2.0", error: { code, message }, id: id ?? null });
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizePearlAddress(address: string): string {
  return address.toLowerCase();
}

async function blockbook(path: string): Promise<unknown> {
  const r = await fetch(`${BLOCKBOOK_URL}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "pearlwallet-rpc-proxy/1",
    },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `upstream ${r.status}`;
    throw new Error(message);
  }
  return body;
}

function mapVin(vin: BlockbookVin): Record<string, unknown> {
  return {
    txid: vin.txid,
    vout: vin.vout,
    n: vin.n,
  };
}

function mapVout(vout: BlockbookVout): Record<string, unknown> {
  const addresses = vout.addresses ?? [];
  const value = Number(vout.value ?? 0) / 100_000_000;
  return {
    value,
    n: vout.n,
    scriptPubKey: {
      hex: vout.hex,
      address: addresses[0],
      addresses,
    },
  };
}

function mapTx(tx: BlockbookTx): Record<string, unknown> {
  return {
    txid: tx.txid,
    vin: (tx.vin ?? []).map(mapVin),
    vout: (tx.vout ?? []).map(mapVout),
    confirmations: tx.confirmations,
    time: tx.time,
  };
}

async function handleRpc(req: JsonRpcRequest): Promise<Response> {
  const id = req.id ?? null;
  const params = Array.isArray(req.params) ? req.params : [];

  try {
    switch (req.method) {
      case "searchrawtransactions": {
        const address = normalizePearlAddress(asString(params[0]));
        if (!address) return rpcError(id, -32602, "missing address");
        const skip = asNumber(params[2], 0);
        const count = asNumber(params[3], 100);
        const page = Math.floor(skip / count) + 1;
        const data = await blockbook(
          `/api/v2/address/${encodeURIComponent(address)}?details=txs&pageSize=${count}&page=${page}`,
        ) as { error?: unknown; transactions?: BlockbookTx[] };
        if (data.error) return rpcError(id, -5, String(data.error));
        return ok(id, (data.transactions ?? []).map(mapTx));
      }
      case "sendrawtransaction": {
        const raw = asString(params[0]);
        if (!raw) return rpcError(id, -32602, "missing raw transaction");
        const data = await blockbook(`/api/v2/sendtx/${encodeURIComponent(raw)}`) as {
          error?: unknown;
          result?: string;
          txid?: string;
        };
        if (data.error) return rpcError(id, -26, String(data.error));
        return ok(id, data.result ?? data.txid);
      }
      case "getblockcount": {
        const data = await blockbook("/api/v2/") as { blockbook?: { bestHeight?: number } };
        return ok(id, data.blockbook?.bestHeight);
      }
      case "getbestblockhash": {
        const data = await blockbook("/api/v2/") as { backend?: { bestBlockHash?: string } };
        return ok(id, data.backend?.bestBlockHash);
      }
      case "getblockhash": {
        const height = asNumber(params[0], -1);
        if (height < 0) return rpcError(id, -32602, "missing block height");
        const data = await blockbook(`/api/v2/block-height/${height}`) as { hash?: string; error?: unknown };
        if (data.error) return rpcError(id, -5, String(data.error));
        return ok(id, data.hash);
      }
      case "getrawtransaction": {
        const txid = asString(params[0]);
        const verbose = Boolean(params[1]);
        if (!txid) return rpcError(id, -32602, "missing txid");
        const tx = await blockbook(`/api/v2/tx/${encodeURIComponent(txid)}`) as BlockbookTx & { error?: unknown };
        if (tx.error) return rpcError(id, -5, String(tx.error));
        if (!verbose) return ok(id, tx.hex);
        return ok(id, {
          ...mapTx(tx),
          hex: tx.hex,
          blockhash: tx.blockHash,
        });
      }
      case "getblock": {
        const hash = asString(params[0]);
        if (!hash) return rpcError(id, -32602, "missing block hash");
        const block = await blockbook(`/api/v2/block/${encodeURIComponent(hash)}`) as {
          error?: unknown;
          hash?: string;
          height?: number;
          confirmations?: number;
          txs?: Array<{ txid?: string }>;
          time?: number;
          previousBlockHash?: string;
        };
        if (block.error) return rpcError(id, -5, String(block.error));
        return ok(id, {
          hash: block.hash,
          height: block.height,
          confirmations: block.confirmations,
          tx: (block.txs ?? []).map((tx) => tx.txid),
          time: block.time,
          previousblockhash: block.previousBlockHash,
        });
      }
      default:
        return rpcError(id, -32601, `unsupported method: ${String(req.method)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return rpcError(id, -32000, message);
  }
}

export const onRequestPost = async ({ request }: { request: Request }): Promise<Response> => {
  let body: JsonRpcRequest;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "invalid JSON");
  }
  return handleRpc(body);
};
