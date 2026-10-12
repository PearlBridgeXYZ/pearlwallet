// R4 L1 — an ETH status-unknown record is never erased by another tab's
// concurrent write.
//
// Before (e06cf60): every record lived in ONE localStorage key holding a
// JSON object, rewritten whole by every change. A browser updates each
// tab's localStorage view from the others asynchronously, so a tab that
// rewrote the key from a view that did not yet include another tab's new
// record erased that record — the only block against a second payment
// (Sol r2 t7 / t10 / t11 in Chromium: tab A's mainnet send ended status-
// unknown, tab B's sepolia sends rewrote the key, the record was gone and a
// fresh tab C signed a second payment with the next nonce).
// Now: one key per record, so a write never touches another record's key.
//
// Model of the browser: one origin store (the backend) and one replica per
// tab. A tab's writes apply to its replica and the backend at once and
// reach the other tabs' replicas only when `deliver()` runs (per key, in
// order, last writer wins: what Chromium does). A tab opened later starts
// from the backend.
import { afterEach, describe, expect, it, vi } from "vitest";

const ME = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x0000000000000000000000000000000000000002";
const H = (b: string) => `0x${b.repeat(32)}` as const;
const g = globalThis as unknown as Record<string, unknown>;

interface Replica {
  map: Map<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}
function origin() {
  const backend = new Map<string, string>();
  const replicas: Replica[] = [];
  const inFlight: Array<{ src: Replica; k: string; v: string | null }> = [];
  function replica(): Replica {
    const map = new Map(backend);
    const r: Replica = {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        map.set(k, String(v));
        backend.set(k, String(v));
        inFlight.push({ src: r, k, v: String(v) });
      },
      removeItem: (k) => {
        map.delete(k);
        backend.delete(k);
        inFlight.push({ src: r, k, v: null });
      },
      key: (i) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    };
    replicas.push(r);
    return r;
  }
  function deliver(): void {
    for (const { src, k, v } of inFlight.splice(0)) {
      for (const r of replicas) {
        if (r === src) continue;
        if (v === null) r.map.delete(k);
        else r.map.set(k, v);
      }
    }
  }
  return { backend, replica, deliver };
}

type Mod = typeof import("../src/state/eth-unknown");
interface Tab { m: Mod; ls: Replica }
async function openTab(o: ReturnType<typeof origin>): Promise<Tab> {
  vi.resetModules();
  const ls = o.replica();
  g.localStorage = ls;
  return { m: await import("../src/state/eth-unknown"), ls };
}
function inTab<T>(t: Tab, fn: () => T): T {
  g.localStorage = t.ls;
  return fn();
}

afterEach(() => {
  delete g.localStorage;
  vi.restoreAllMocks();
});

describe("L1 — per-record keys: a concurrent write by another tab never erases a record", () => {
  it("t11 shape: A's mainnet send ends status-unknown while B (stale view) records and clears its own sepolia sends → a fresh tab C still refuses", async () => {
    const o = origin();
    const A = await openTab(o);
    const B = await openTab(o);
    // B has an older status-unknown record of its own on sepolia (so its
    // view of the store is non-empty, as in t10).
    inTab(B, () => B.m.recordEthUnknown({ network: "sepolia", from: ME, hash: H("44"), what: "ETH transfer" }));
    o.deliver();
    // A: status unknown on mainnet.
    inTab(A, () => A.m.recordEthUnknown({ network: "mainnet", from: ME, hash: H("11"), what: "ETH transfer" }));
    // B, before A's write reaches it: a sepolia send recorded in flight and
    // cleared on a confirmed outcome; then a status-unknown one acknowledged.
    inTab(B, () => {
      B.m.beginEthBroadcast({ network: "sepolia", from: ME, hash: H("22"), what: "ETH transfer" });
      B.m.clearEthUnknown("sepolia", ME, H("22"));
      B.m.recordEthUnknown({ network: "sepolia", from: ME, hash: H("33"), what: "burn" });
      B.m.clearEthUnknown("sepolia", ME, H("33"));
    });
    o.deliver();
    // A fresh tab (or the browser reopened): the mainnet block survived.
    const C = await openTab(o);
    expect(() => inTab(C, () => C.m.assertNoUnresolvedEthBroadcast("mainnet", ME))).toThrow(`E_ETH_UNRESOLVED_BROADCAST: ${H("11")}`); // pre-fix: no throw (record erased)
    expect(() => inTab(B, () => B.m.assertNoUnresolvedEthBroadcast("mainnet", ME))).toThrow(B.m.EthUnresolvedBroadcastError);
    expect(() => inTab(A, () => A.m.assertNoUnresolvedEthBroadcast("mainnet", ME))).toThrow();
    // B's own older sepolia record is untouched; nothing else is left.
    expect(inTab(C, () => C.m.unresolvedEthUnknown("sepolia", ME)).map((r) => r.hash)).toEqual([H("44")]);
  });

  it("two tabs recording at once (different addresses, same address, different networks): every record survives in every tab", async () => {
    const o = origin();
    const A = await openTab(o);
    const B = await openTab(o);
    inTab(A, () => A.m.recordEthUnknown({ network: "mainnet", from: ME, hash: H("aa"), what: "ETH transfer" }));
    inTab(B, () => B.m.recordEthUnknown({ network: "mainnet", from: OTHER, hash: H("bb"), what: "approval" }));
    inTab(B, () => B.m.recordEthUnknown({ network: "mainnet", from: ME, hash: H("cc"), what: "burn" }));
    inTab(A, () => A.m.recordEthUnknown({ network: "sepolia", from: ME, hash: H("dd"), what: "ETH transfer" }));
    o.deliver();
    const C = await openTab(o);
    for (const t of [A, B, C]) {
      expect(inTab(t, () => t.m.unresolvedEthUnknown("mainnet", ME)).map((r) => r.hash).sort()).toEqual([H("aa"), H("cc")]);
      expect(inTab(t, () => t.m.unresolvedEthUnknown("mainnet", OTHER)).map((r) => r.hash)).toEqual([H("bb")]);
      expect(inTab(t, () => t.m.unresolvedEthUnknown("sepolia", ME)).map((r) => r.hash)).toEqual([H("dd")]);
    }
  });

  it("acknowledging in one tab while another records: only the acknowledged record goes", async () => {
    const o = origin();
    const A = await openTab(o);
    const B = await openTab(o);
    inTab(A, () => A.m.recordEthUnknown({ network: "mainnet", from: ME, hash: H("11"), what: "ETH transfer" }));
    o.deliver();
    inTab(B, () => B.m.recordEthUnknown({ network: "mainnet", from: ME, hash: H("22"), what: "burn" }));
    inTab(A, () => A.m.clearEthUnknown("mainnet", ME, H("11"))); // A has not seen H22 yet
    o.deliver();
    const C = await openTab(o);
    expect(inTab(C, () => C.m.unresolvedEthUnknown("mainnet", ME)).map((r) => r.hash)).toEqual([H("22")]); // pre-fix: [] (A's rewrite dropped it)
  });
});

describe("L1 — fail closed", () => {
  it("a malformed / unknown-shape entry for the address blocks signing (assertNoUnresolvedEthBroadcast refuses) until acknowledged", async () => {
    const o = origin();
    const A = await openTab(o);
    const key = (h: string) => `pearl-wallet-eth-unknown-v3:mainnet:${ME.toLowerCase()}:${h}`;
    A.ls.setItem(key(H("11")), "{not json");
    expect(() => inTab(A, () => A.m.assertNoUnresolvedEthBroadcast("mainnet", ME))).toThrow(`E_ETH_UNRESOLVED_BROADCAST: ${H("11")}`);
    // Even with exceptInflight (the pre-lock check): an unreadable entry is never "in flight".
    expect(() => inTab(A, () => A.m.assertNoUnresolvedEthBroadcast("mainnet", ME, { exceptInflight: true }))).toThrow(A.m.EthUnresolvedBroadcastError);
    expect(inTab(A, () => A.m.currentEthUnknown("mainnet", ME))).toMatchObject({ hash: H("11"), what: A.m.ETH_UNKNOWN_UNREADABLE });
    A.ls.setItem(key(H("11")), JSON.stringify({ network: "mainnet", from: ME.toLowerCase(), hash: H("11"), what: "x", ts: 1, sent: "yes" }));
    expect(() => inTab(A, () => A.m.assertNoUnresolvedEthBroadcast("mainnet", ME))).toThrow();
    A.ls.setItem(key("garbage"), "{}");
    expect(inTab(A, () => A.m.unresolvedEthUnknown("mainnet", ME))).toHaveLength(2);
    // Another address is not blocked by them.
    expect(() => inTab(A, () => A.m.assertNoUnresolvedEthBroadcast("mainnet", OTHER))).not.toThrow();
    // The user checks and acknowledges each: unblocked.
    expect(await inTab(A, () => A.m.acknowledgeEthUnknownChecked("mainnet", ME, H("11")))).toBe(true);
    expect(await inTab(A, () => A.m.acknowledgeEthUnknownChecked("mainnet", ME, `0x${"0".repeat(64)}`))).toBe(true);
    expect(() => inTab(A, () => A.m.assertNoUnresolvedEthBroadcast("mainnet", ME))).not.toThrow();
  });

  it("setItem failure: the record cannot reach localStorage → this tab still refuses to sign (in-memory copy); a failed acknowledge or 'sent' mark keeps blocking", async () => {
    const o = origin();
    const A = await openTab(o);
    const realSet = A.ls.setItem;
    const realRemove = A.ls.removeItem;
    A.ls.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    inTab(A, () => A.m.recordEthUnknown({ network: "mainnet", from: ME, hash: H("11"), what: "ETH transfer" }));
    expect(() => inTab(A, () => A.m.assertNoUnresolvedEthBroadcast("mainnet", ME))).toThrow(`E_ETH_UNRESOLVED_BROADCAST: ${H("11")}`);
    // beginEthBroadcast refuses (nothing would be sent).
    expect(() => inTab(A, () => A.m.beginEthBroadcast({ network: "mainnet", from: OTHER, hash: H("22"), what: "ETH transfer" }))).toThrow(/E_ETH_BROADCAST_RECORD/);
    // A stored record whose 'sent' mark or removal cannot be written stays blocking.
    A.ls.setItem = realSet;
    inTab(A, () => A.m.recordEthUnknown({ network: "mainnet", from: OTHER, hash: H("33"), what: "burn" }));
    A.ls.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    A.ls.removeItem = () => {
      throw new Error("SecurityError");
    };
    inTab(A, () => A.m.markEthUnknownSent("mainnet", OTHER, H("33")));
    inTab(A, () => A.m.clearEthUnknown("mainnet", OTHER, H("33")));
    expect(() => inTab(A, () => A.m.assertNoUnresolvedEthBroadcast("mainnet", OTHER))).toThrow(`E_ETH_UNRESOLVED_BROADCAST: ${H("33")}`);
    A.ls.setItem = realSet;
    A.ls.removeItem = realRemove;
  });

  it("wipe removes every record key (and the former v2 key)", async () => {
    const o = origin();
    const A = await openTab(o);
    inTab(A, () => {
      A.m.recordEthUnknown({ network: "mainnet", from: ME, hash: H("11"), what: "ETH transfer" });
      A.m.recordEthUnknown({ network: "sepolia", from: OTHER, hash: H("22"), what: "burn" });
    });
    A.ls.setItem("pearl-wallet-eth-unknown-v2", "{}");
    A.ls.setItem("pearl-wallet-ui-v6", "{}");
    inTab(A, () => A.m.clearAllEthUnknown());
    expect([...A.ls.map.keys()]).toEqual(["pearl-wallet-ui-v6"]);
  });
});
