#!/usr/bin/env bash
# PearlWallet release protocol — every version that ships to the hosted
# site also ships as a GitHub release, so self-hosted users always have
# a downloadable artifact that matches what's live.
#
# What this does (in order, all-or-nothing as far as practical):
#   1. Sanity: clean tree, version in package.json not already tagged
#   2. Build the deployable bundle (dist/) — tsc gate included
#   3. Build the single-file offline artifact (dist-offline/)
#   4. Tag vX.Y.Z at HEAD and push the tag
#   5. Create the GitHub release with the offline HTML attached
#
# Usage:  scripts/release.sh [--repo <owner/repo>] [--notes <file>]
#   --repo   GitHub repo for the release (default: origin's repo)
#   --notes  Markdown file with release notes (default: auto-generated)
# Env:
#   GIT_REMOTE  remote to push main+tag to (default: origin)
#
# Requires: gh (authenticated), node 18+, a clean working tree.
set -euo pipefail

cd "$(dirname "$0")/.."

REPO=""
NOTES_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)  REPO="$2"; shift 2 ;;
    --notes) NOTES_FILE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# 1 — sanity
if [ -n "$(git status --porcelain)" ]; then
  echo "release: working tree not clean — commit or stash first" >&2
  exit 1
fi
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "release: ${TAG} already tagged — bump package.json version first" >&2
  exit 1
fi
echo "release: shipping ${TAG} @ $(git rev-parse --short HEAD)"

# 2 — deployable bundle (also the tsc type gate)
npm run build

# 3 — offline artifact
npm run build:offline
ASSET="dist-offline/pearlwallet-offline-${TAG}.html"
[ -f "$ASSET" ] || { echo "release: expected ${ASSET} missing" >&2; exit 1; }

# checksum for the release body / verification
SHA256=$(sha256sum "$ASSET" | cut -d' ' -f1)
echo "release: asset ${ASSET} sha256=${SHA256}"

# 4 — tag + push
REMOTE="${GIT_REMOTE:-origin}"
git tag -a "$TAG" -m "PearlWallet ${TAG}"
git push "$REMOTE" "HEAD:main" "refs/tags/${TAG}"

# 5 — GitHub release
GH_ARGS=(release create "$TAG" "$ASSET" --title "${TAG}")
[ -n "$REPO" ] && GH_ARGS+=(--repo "$REPO")
if [ -n "$NOTES_FILE" ]; then
  GH_ARGS+=(--notes-file "$NOTES_FILE")
elif [ -n "${RELEASE_NOTES:-}" ]; then
  GH_ARGS+=(--notes "$RELEASE_NOTES")
else
  GH_ARGS+=(--generate-notes)
fi
gh "${GH_ARGS[@]}"

echo
echo "release: ${TAG} published (asset sha256 ${SHA256})"
echo "release: remember — the hosted site should be redeployed from this"
echo "         same commit so hosted and self-hosted stay identical."
