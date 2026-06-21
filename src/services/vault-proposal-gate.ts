// Pure decision for whether VaultProposal should fetch (and thereby CONSUME)
// the one-time relay artifact for a /vault/tx/:token deeplink.
//
// Extracted from the component so the load-bearing invariant — the one-time
// token is NEVER consumed when the user has the Vaults surface turned off,
// or while locked, or with no token — is unit-testable in the node test env
// (the component itself needs a React renderer the suite doesn't have).
//
// Re-entrancy (the component's fetchedRef one-shot guard) is intentionally
// NOT modelled here; it's a render-lifecycle concern, not part of the
// "are we allowed to consume this token at all" policy.
export function shouldConsumeProposal(opts: {
  multisigEnabled: boolean;
  status: string;
  token: string | undefined;
}): boolean {
  if (!opts.multisigEnabled) return false; // Vaults opted out — don't burn the token
  if (opts.status !== "unlocked") return false; // act only after unlock
  if (!opts.token) return false;
  return true;
}
