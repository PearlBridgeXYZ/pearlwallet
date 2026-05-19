// Main-thread RPC to the crypto Web Worker.
import CryptoWorker from "./worker?worker";
class WorkerClient {
    worker = null;
    inflight = new Map();
    nextId = 1;
    ensure() {
        if (!this.worker) {
            this.worker = new CryptoWorker();
            this.worker.onmessage = (ev) => {
                const { id } = ev.data;
                const pending = this.inflight.get(id);
                if (!pending)
                    return;
                this.inflight.delete(id);
                if (ev.data.ok)
                    pending.resolve(ev.data.result);
                else
                    pending.reject(new Error(ev.data.error));
            };
            this.worker.onerror = (ev) => {
                // eslint-disable-next-line no-console
                console.error("crypto worker error", ev);
            };
        }
        return this.worker;
    }
    call(cmd, args) {
        const w = this.ensure();
        const id = String(this.nextId++);
        return new Promise((resolve, reject) => {
            this.inflight.set(id, { resolve: resolve, reject });
            w.postMessage({ id, cmd, ...args });
        });
    }
    /** Terminate and respawn — used on lock to wipe key material. */
    reset() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.inflight.clear();
    }
}
export const cryptoWorker = new WorkerClient();
