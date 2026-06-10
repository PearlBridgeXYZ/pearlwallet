# Releasing PearlWallet

Protocol: **every version that ships to the hosted site also ships as a
GitHub release.** Self-hosted users must always be able to download an
artifact identical to what is running at
[wallet.pearlbridge.xyz](https://wallet.pearlbridge.xyz/).

## Steps

1. Bump `version` in `package.json` and commit (the release script
   refuses to re-ship an already-tagged version).
2. Run `scripts/release.sh [--repo <owner/repo>] [--notes <file>]`.
   It builds the deployable bundle (with the TypeScript gate), builds
   the single-file offline artifact, tags `vX.Y.Z`, pushes, and creates
   the GitHub release with `pearlwallet-offline-vX.Y.Z.html` attached.
3. Deploy the **same commit's** `dist/` to your hosting. Hosted and
   released artifacts must come from the same build.
4. Verify the live bundle contains the new version string (exact-string
   grep — the bundle embeds historical version strings, so a loose
   regex match will lie to you).

## Self-hosting

Each release's `pearlwallet-offline-vX.Y.Z.html` is the whole wallet in
one file — open it locally or serve it from any static host. To build
from source instead: `npm ci && npm run build`, then serve `dist/`.
