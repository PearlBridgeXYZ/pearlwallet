// Transient slice for a vault proposal that arrived via /vault/tx/<token>.
//
// The proposal is consumed once from the relay (one-time GET), then held
// in memory only — never persisted to Dexie, never written to disk. The
// downstream pages (SignMultisigPsbt, SendFromVault) read this slice on
// mount and clear it as soon as they've used it. If the user navigates
// away or closes the tab, the proposal is gone.

import { create } from "zustand";

export interface PendingPsbtProposal {
  kind: "psbt-base64";
  payload: string; // PSBT base64
  metadata: Record<string, unknown> | null;
  token: string;
}

export interface PendingIntentProposal {
  kind: "tx-intent";
  intent: {
    vaultAddress: string;
    destination: string;
    amountGrains: string; // bigint encoded as decimal string
    memo?: string;
    network?: "mainnet" | "testnet";
  };
  metadata: Record<string, unknown> | null;
  token: string;
}

export type PendingProposal = PendingPsbtProposal | PendingIntentProposal;

interface ProposalState {
  pending: PendingProposal | null;
  set(p: PendingProposal): void;
  clear(): void;
  consumePsbt(): PendingPsbtProposal | null;
  consumeIntent(): PendingIntentProposal | null;
}

export const useProposal = create<ProposalState>((set, get) => ({
  pending: null,
  set(p) {
    set({ pending: p });
  },
  clear() {
    set({ pending: null });
  },
  consumePsbt() {
    const p = get().pending;
    if (!p || p.kind !== "psbt-base64") return null;
    set({ pending: null });
    return p;
  },
  consumeIntent() {
    const p = get().pending;
    if (!p || p.kind !== "tx-intent") return null;
    set({ pending: null });
    return p;
  },
}));
