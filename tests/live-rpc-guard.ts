// Guard for PEARL_LIVE=1 test files. rpc.pearlbridge.xyz is the endpoint
// real wallets share, so a live run must look like one well-behaved wallet:
//
//   • production pacing — tests/setup-fast-rpc.ts sets an unlimited rate
//     before every test, which a live file must undo;
//   • one live run per machine — concurrent runs (reviewers, evidence
//     imports, several snapshots) each have their own limiter, so their
//     rates add up at the origin. A lock directory serialises them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { _setPearlRpcTuningForTests, _resetPearlRpcHealthForTests } from "../src/services/pearl-rpc";

const LOCK_DIR = path.join(os.tmpdir(), "pearlwallet-live-rpc.lock");
const WAIT_MS = 15 * 60_000;
const POLL_MS = 2_000;

function holderAlive(): boolean {
  try {
    const pid = Number(fs.readFileSync(path.join(LOCK_DIR, "pid"), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquire(): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(path.join(LOCK_DIR, "pid"), String(process.pid));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // A holder that died leaves its directory behind; reclaim it. (A fresh
    // directory whose pid file is not written yet counts as held.)
    const st = fs.statSync(LOCK_DIR, { throwIfNoEntry: false });
    if (!st) continue;
    if (!holderAlive() && Date.now() - st.mtimeMs > 5_000) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`live RPC lock busy: ${LOCK_DIR}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function release(): void {
  try {
    if (Number(fs.readFileSync(path.join(LOCK_DIR, "pid"), "utf8")) === process.pid) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  } catch { /* not held */ }
}

/** Call at the top level of a live test file, after reading PEARL_LIVE. */
export function useLiveRpc(live: boolean): void {
  if (!live) return;
  beforeAll(acquire, WAIT_MS + 60_000);
  afterAll(release);
  // Runs after the global fast-tuning hook (setup files register first).
  beforeEach(() => {
    _setPearlRpcTuningForTests(undefined);
    _resetPearlRpcHealthForTests();
  });
}
