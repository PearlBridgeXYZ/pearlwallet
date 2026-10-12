// R6 N4 (Sonnet F01) — create / restore that fails after the worker built
// the new wallet's session leaves no session behind.
//
// Before: if anything threw between the worker's createWallet /
// restoreWallet and the status becoming "unlocked" (here: the keystore
// write refused with QuotaExceededError), the error propagated with the
// worker still holding the unsaved wallet's unlocked session (and any
// balance memory), while the tab showed no wallet.
//
// Now the worker is reset and balance memory cleared before rethrowing.
// Real wallet store; the worker and the keystore table are mocked.
import { afterEach, describe, expect, it, vi } from "vitest";

const BLOB = { version: 1, kdf: "PBKDF2-SHA256", kdfIterations: 1, kdfSalt: "00", cipher: "AES-256-GCM", iv: "00", aad: "00", ciphertext: "new" };
const ADDRS = { pearl: "prl1pnew", pearlPool: ["prl1pnew"], pearlChange: [], eth: "0x1111111111111111111111111111111111111111" };
const quota = () => Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });

async function openTab() {
  vi.resetModules();
  const dbm = await import("../src/storage/db");
  vi.spyOn(dbm.db, "transaction").mockImplementation((async (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)()) as never);
  vi.spyOn(dbm.db.keystore, "get").mockResolvedValue(undefined as never);
  vi.spyOn(dbm.db.keystore, "add").mockRejectedValue(quota());
  vi.spyOn(dbm.db.keystore, "put").mockRejectedValue(quota());
  for (const t of ["addressBook", "txCache", "vaults", "vaultPendingTxs", "bridgeCrossings", "bridgeDepositPins"] as const) {
    vi.spyOn(dbm.db[t] as never, "clear" as never).mockResolvedValue(undefined as never);
  }
  const wc = await import("../src/crypto/worker-client");
  const reset = vi.spyOn(wc.cryptoWorker, "reset").mockImplementation(() => undefined);
  vi.spyOn(wc.cryptoWorker, "call").mockImplementation((async (m: string) => {
    if (m === "createWallet") return { mnemonic: "m", blob: BLOB, addresses: ADDRS };
    if (m === "restoreWallet") return { blob: BLOB, addresses: ADDRS };
    throw new Error(`unexpected ${m}`);
  }) as never);
  const ws = await import("../src/state/wallet-store");
  const bm = await import("../src/state/balance-memory");
  ws.useWallet.setState({ status: "no-wallet", addresses: null, blob: null });
  return { ws, bm, reset };
}

afterEach(() => vi.restoreAllMocks());

describe("N4 — a keystore write refused after the worker built the session", () => {
  for (const kind of ["createWallet", "restoreWallet"] as const) {
    for (const overwrite of [false, true]) {
      it(`${kind}${overwrite ? " (consented overwrite)" : ""}: QuotaExceededError → worker reset and balance memory cleared before the error propagates; not unlocked`, async () => {
        const T = await openTab();
        T.bm.lastGoodByAddress.set("prl1pnew", { grains: 1n, at: 1 });
        let cleared = 0;
        T.bm.onBalanceMemoryClear(() => cleared++);
        const opts = overwrite ? { allowOverwrite: true as const, observedBlob: null } : undefined;
        const p = kind === "createWallet" ? T.ws.useWallet.getState().createWallet(128, "pw", opts) : T.ws.useWallet.getState().restoreWallet("words", "pw", opts);
        const err = await p.catch((e) => e);
        expect((err as Error).name).toBe("QuotaExceededError");
        expect(T.reset).toHaveBeenCalledTimes(1);
        expect(cleared).toBe(1);
        expect(T.bm.lastGoodByAddress.size).toBe(0);
        expect(T.ws.useWallet.getState().status).toBe("no-wallet");
        expect(T.ws.useWallet.getState().addresses).toBeNull();
      });
    }
  }
});
