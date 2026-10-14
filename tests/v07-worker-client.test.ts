// Final review, round 3 — S8: a crypto worker that errors (uncaught error,
// undeliverable reply) fails the calls in flight instead of leaving them
// pending forever (one may hold the cross-tab broadcast lock). The signer
// timeout under the lock is tested in v07-review-final-r3.test.ts.

import { describe, expect, it, vi } from "vitest";

const { workers, FakeWorker } = vi.hoisted(() => {
  const workers: InstanceType<typeof FakeWorker>[] = [];
  class FakeWorker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessageerror: ((ev: unknown) => void) | null = null;
    posted: { id: string; cmd: string }[] = [];
    constructor() {
      workers.push(this);
    }
    postMessage(m: { id: string; cmd: string }) {
      this.posted.push(m);
    }
    terminate() {}
  }
  return { workers, FakeWorker };
});
vi.mock("../src/crypto/worker?worker", () => ({ default: FakeWorker }));

import { cryptoWorker } from "../src/crypto/worker-client";

describe("S8 — worker errors fail the calls in flight", () => {
  it("onerror rejects every pending call; a late reply is ignored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = cryptoWorker.call("lock", {});
    const b = cryptoWorker.call("lock", {});
    const w = workers.at(-1)!;
    w.onerror!(new Event("error"));
    await expect(a).rejects.toThrow("E_WORKER_ERROR");
    await expect(b).rejects.toThrow("E_WORKER_ERROR");
    // A reply arriving afterwards changes nothing.
    w.onmessage!({ data: { id: w.posted[0]!.id, ok: true, result: {} } } as MessageEvent);
    // The client keeps working for new calls.
    const c = cryptoWorker.call<"lock", { ok: boolean }>("lock", {});
    const replacement = workers.at(-1)!;
    expect(replacement).not.toBe(w);
    const id = replacement.posted.at(-1)!.id;
    replacement.onmessage!({ data: { id, ok: true, result: { ok: true } } } as MessageEvent);
    await expect(c).resolves.toEqual({ ok: true });
  });

  it("onmessageerror rejects pending calls too", async () => {
    const a = cryptoWorker.call("lock", {});
    workers.at(-1)!.onmessageerror!(new Event("messageerror"));
    await expect(a).rejects.toThrow("E_WORKER_ERROR");
  });

  it("reset still rejects with E_WORKER_RESET", async () => {
    const a = cryptoWorker.call("lock", {});
    cryptoWorker.reset();
    await expect(a).rejects.toThrow("E_WORKER_RESET");
  });
});
