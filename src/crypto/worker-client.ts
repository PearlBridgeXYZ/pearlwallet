// Main-thread RPC to the crypto Web Worker.

import CryptoWorker from "./worker?worker";
import type { WorkerCmd, WorkerResp } from "./worker";

type Cmd = WorkerCmd["cmd"];
type CmdArgs<C extends Cmd> = Omit<Extract<WorkerCmd, { cmd: C }>, "id" | "cmd">;

class WorkerClient {
  private worker: Worker | null = null;
  private inflight = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;

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
      this.worker.onerror = (ev) => {
        // eslint-disable-next-line no-console
        console.error("crypto worker error", ev);
      };
    }
    return this.worker;
  }

  call<C extends Cmd, R = unknown>(cmd: C, args: CmdArgs<C>): Promise<R> {
    const w = this.ensure();
    const id = String(this.nextId++);
    return new Promise<R>((resolve, reject) => {
      this.inflight.set(id, { resolve: resolve as (v: unknown) => void, reject });
      w.postMessage({ id, cmd, ...args } as WorkerCmd);
    });
  }

  /**
   * Terminate and respawn — used on lock to wipe key material. Any calls
   * in flight (e.g. an unlock racing with an idle auto-lock) had their
   * worker killed mid-postMessage; we must reject the awaiters explicitly
   * so they don't hang forever. Pre-fix, lock-during-unlock wedged the UI.
   */
  reset(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const { reject } of this.inflight.values()) {
      reject(new Error("E_WORKER_RESET"));
    }
    this.inflight.clear();
  }
}

export const cryptoWorker = new WorkerClient();
