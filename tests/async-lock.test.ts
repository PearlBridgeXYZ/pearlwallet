// v0.1.7: standalone test of the makeAsyncLock pattern used inside
// wallet-store.ts to serialize state mutations vs. cross-tab broadcast
// handlers. The actual lock instance is module-private; this test
// reconstructs the same pattern and exercises the invariants the
// wallet-store relies on:
//
//   1. Calls run strictly in order — N concurrent calls FIFO-serialize.
//   2. A throwing call doesn't poison the chain — later calls still run.
//   3. The lock is re-entrant-safe only across `await` boundaries; it
//      doesn't try to detect synchronous re-entry (and doesn't need to,
//      since JS is single-threaded and the lock is for async ops).

import { describe, it, expect } from "vitest";

function makeAsyncLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((res) => (release = res));
    try {
      await prev;
    } catch {
      // swallow — prior caller's problem
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

describe("makeAsyncLock", () => {
  it("serializes concurrent calls in submission order", async () => {
    const lock = makeAsyncLock();
    const events: string[] = [];

    const a = lock(async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 10));
      events.push("a-end");
      return "a";
    });
    const b = lock(async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("b-end");
      return "b";
    });
    const c = lock(async () => {
      events.push("c-start");
      events.push("c-end");
      return "c";
    });

    const results = await Promise.all([a, b, c]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual([
      "a-start", "a-end",
      "b-start", "b-end",
      "c-start", "c-end",
    ]);
  });

  it("a throwing call doesn't break the chain", async () => {
    const lock = makeAsyncLock();
    const events: string[] = [];

    const a = lock(async () => {
      events.push("a");
      throw new Error("boom");
    });
    const b = lock(async () => {
      events.push("b");
      return "ok";
    });

    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe("ok");
    expect(events).toEqual(["a", "b"]);
  });

  it("does not deadlock when a task takes zero microtasks", async () => {
    const lock = makeAsyncLock();
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await lock(async () => i));
    }
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it("broadcast-handler scenario: peer 'wiped' event after local unlock starts", async () => {
    // Models the wallet-store race the lock closes: a local unlock is
    // mid-flight when a peer-tab wipe arrives. Both get wrapped in
    // walletLock(); the peer wipe MUST run after unlock completes (or
    // throws) — not interleaved with it.
    const lock = makeAsyncLock();
    const log: string[] = [];
    let walletState = { status: "locked", blob: "ciphertext" as string | null };

    const localUnlock = lock(async () => {
      log.push("unlock:resolve-worker");
      await new Promise((r) => setTimeout(r, 10));
      // After the worker call resolves the store would `set({status: 'unlocked'})`.
      // The peer 'wiped' event MUST NOT have run yet at this point.
      expect(walletState.blob).toBe("ciphertext");
      walletState = { status: "unlocked", blob: walletState.blob };
      log.push("unlock:set-state");
    });

    const peerWiped = lock(async () => {
      log.push("wiped:set-state");
      walletState = { status: "no-wallet", blob: null };
    });

    await Promise.all([localUnlock, peerWiped]);
    expect(log).toEqual(["unlock:resolve-worker", "unlock:set-state", "wiped:set-state"]);
    expect(walletState.status).toBe("no-wallet");
  });
});
