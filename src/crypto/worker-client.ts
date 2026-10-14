// Main-thread RPC to the crypto Web Worker.

import CryptoWorker from "./worker?worker";
import type { WorkerCmd, WorkerResp } from "./worker";

type Cmd = WorkerCmd["cmd"];
type CmdArgs<C extends Cmd> = Omit<Extract<WorkerCmd, { cmd: C }>, "id" | "cmd">;

class WorkerClient {
  private worker: Worker | null = null;
  private inflight = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private failureHandler: (() => void) | null = null;

  onFailure(handler: () => void): void { this.failureHandler = handler; }

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new CryptoWorker();
      this.worker.onmessage = (ev: MessageEvent<WorkerResp>) => {
        const { id } = ev.data;
        const pending = this.inflight.get(id);
        if (!pending) return;
        this.inflight.delete(id);
        if (ev.data.ok) pending.resolve(ev.data.result);
        else pending.reject(new Error(ev.data.error));
      };
      // An uncaught worker error or an undeliverable reply means the calls
      // in flight may never be answered: fail them now instead of leaving
      // their callers (one may hold the broadcast lock) waiting forever. A
      // late reply to a failed call is ignored (its id is gone).
      this.worker.onerror = (ev) => {
        // eslint-disable-next-line no-console
        console.error("crypto worker error", ev);
        this.reset("E_WORKER_ERROR");
      };
      this.worker.onmessageerror = () => this.reset("E_WORKER_ERROR");
    }
    return this.worker;
  }

  call<C extends Cmd, R = unknown>(cmd: C, args: CmdArgs<C>): Promise<R> {
    const w = this.ensure();
    const id = String(this.nextId++);
    return new Promise<R>((resolve, reject) => {
      this.inflight.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try { w.postMessage({ id, cmd, ...args } as WorkerCmd); }
      catch (e) { this.inflight.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  /**
   * Terminate and respawn — used on lock to wipe key material. Any calls
   * in flight (e.g. an unlock racing with an idle auto-lock) had their
   * worker killed mid-postMessage; we must reject the awaiters explicitly
   * so they don't hang forever. Pre-fix, lock-during-unlock wedged the UI.
   */
  reset(code = "E_WORKER_RESET"): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.failInflight(code);
    if (code === "E_WORKER_ERROR") this.failureHandler?.();
  }

  private failInflight(code: string): void {
    const pending = [...this.inflight.values()];
    this.inflight.clear();
    for (const { reject } of pending) reject(new Error(code));
  }
}

export const cryptoWorker = new WorkerClient();
