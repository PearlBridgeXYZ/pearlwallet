// In-memory, display-side balance state shared by the dashboard hook
// (ui/hooks/useWalletBalances.ts) and cleared by the wallet store on lock,
// wipe and wallet switch so nothing about one session's addresses outlives
// it in the tab:
//
//   • last good per-address PRL balance (keep-last-good display merging)
//   • per-wallet scan progress ("Scanning 7/40")
//   • per-wallet scan baseline: what the last complete full walk found,
//     used to make periodic refreshes cheaper (see services/discovery.ts
//     `refresh`)
//
// Nothing here is persisted and nothing here reaches coin selection.

export interface ScanProgress {
  done: number;
  total: number;
  running: boolean;
}

/** Result of the last complete, full (nothing skipped) wallet walk. */
export interface ScanBaseline {
  /** ms timestamp at which that full walk STARTED. */
  fullAt: number;
  /** Highest index with history per branch [external, internal]. */
  lastUsed: [number, number];
  /** Addresses that walk read successfully and found without history. */
  knownUnused: ReadonlySet<string>;
}

type Listener = () => void;

const progressByPool = new Map<string, ScanProgress>();
const progressListeners = new Set<Listener>();

/** Last successfully read balance per pool address (display only). */
export const lastGoodByAddress = new Map<string, { grains: bigint; at: number }>();

const baselineByPool = new Map<string, ScanBaseline>();

// Bumped by clearBalanceMemory. A scan captures it when it starts and
// writes nothing once it has changed, so a scan still in flight when the
// wallet locks cannot repopulate the memory afterwards.
let epoch = 0;

/** Current memory epoch (see clearBalanceMemory). */
export function memoryEpoch(): number {
  return epoch;
}

export function getProgress(key: string): ScanProgress | undefined {
  return progressByPool.get(key);
}

export function setProgress(key: string, p: ScanProgress): void {
  progressByPool.set(key, p);
  for (const l of progressListeners) l();
}

export function subscribeProgress(l: Listener): () => void {
  progressListeners.add(l);
  return () => progressListeners.delete(l);
}

export function getScanBaseline(key: string): ScanBaseline | undefined {
  return baselineByPool.get(key);
}

export function setScanBaseline(key: string, b: ScanBaseline): void {
  baselineByPool.set(key, b);
}

/** Forget remembered per-address balances, scan progress and scan
 *  baselines. Called on lock, wipe and wallet switch. */
export function clearBalanceMemory(): void {
  epoch++;
  lastGoodByAddress.clear();
  progressByPool.clear();
  baselineByPool.clear();
  for (const l of progressListeners) l();
}

/** Test-only: sizes of the in-memory stores. */
export function __balanceMemorySizesForTests(): { lastGood: number; progress: number; baselines: number } {
  return { lastGood: lastGoodByAddress.size, progress: progressByPool.size, baselines: baselineByPool.size };
}
