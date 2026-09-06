#!/usr/bin/env bash
# Official release packaging. Builds store-ready artifacts into release/:
#   beldex-wallet-chrome-v<V>.zip       — upload to Chrome Web Store
#   beldex-wallet-firefox-v<V>.zip      — upload to AMO
#   beldex-wallet-source-v<V>.zip       — AMO source-review zip (git archive HEAD)
#   build-manifest-v<V>.json            — binds binaries to source + config
#
# Release-integrity guarantees (external audit):
#   1. REFUSES a dirty tree: any tracked change (staged or not) or untracked
#      file aborts — the source zip is git HEAD, so the builds must be too.
#   2. REFUSES unrecorded configuration: a .env file, or any ambient
#      BDX_* / MAINNET_* / TESTNET_* environment variable, aborts. Official
#      builds resolve their endpoints from the reviewed src/lib/networks.json
#      ONLY, and host_permissions derive from those endpoints.
#   3. Hermetic build: node_modules reinstalled with `npm ci` (lockfile-exact),
#      every output directory (including testnet ones) removed first, then
#      typecheck + tests + both target builds from this checkout.
#   4. Build manifest: commit/tree hash, lockfile hash, node/npm versions,
#      resolved config, host_permissions and per-file sha256 hashes of both
#      outputs are recorded in release/build-manifest-v<V>.json, which also
#      cross-checks each built manifest.json against the reviewed config.
#   5. Reproduce-and-compare: the source zip is extracted to a temp dir,
#      rebuilt from scratch (`npm ci` + build), and the rebuilt outputs must be
#      byte-identical to the packaged ones — otherwise the release aborts.
#
# Run via: npm run package
set -euo pipefail
cd "$(dirname "$0")/.."

V=$(node -p "require('./package.json').version")

# ---- 1. clean-tree preconditions -------------------------------------------

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: refusing release from modified tracked source — commit first." >&2
  git status --short >&2
  exit 1
fi
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "ERROR: refusing release with untracked inputs:" >&2
  git ls-files --others --exclude-standard >&2
  exit 1
fi

# ---- 2. unrecorded-configuration preconditions ------------------------------

if [ -f .env ]; then
  echo "ERROR: .env exists. Official builds take configuration ONLY from the" >&2
  echo "reviewed src/lib/networks.json — delete or move .env and retry." >&2
  exit 1
fi
AMBIENT=$(env | grep -E '^(BDX_|MAINNET_|TESTNET_)' | cut -d= -f1 || true)
if [ -n "$AMBIENT" ]; then
  echo "ERROR: ambient build-config environment variables set: $AMBIENT" >&2
  echo "Unset them — official builds must not take unrecorded configuration." >&2
  exit 1
fi

# ---- 3. hermetic build ------------------------------------------------------

rm -rf dist firefox dist-testnet firefox-testnet release
npm ci
npm run typecheck
npm test
npm run build

# ---- 4. build manifest (also cross-checks built manifests vs networks.json) --

mkdir -p release
node scripts/write-build-manifest.mjs

# ---- package: binaries and source from the SAME verified checkout -----------

(cd dist && zip -qrX "../release/beldex-wallet-chrome-v$V.zip" .)
(cd firefox && zip -qrX "../release/beldex-wallet-firefox-v$V.zip" .)
git archive HEAD -o "release/beldex-wallet-source-v$V.zip"

# ---- 5. reproduce from the source zip and compare ---------------------------

echo "[package] verifying: rebuilding from the source zip and comparing..."
ROOT=$(pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
unzip -q "release/beldex-wallet-source-v$V.zip" -d "$TMP/src"
(cd "$TMP/src" && npm ci --silent && npm run build --silent)
# write-build-manifest --check recomputes dist/ + firefox/ content hashes in
# the rebuilt tree (its CWD) and compares them to the manifest we just wrote.
(cd "$TMP/src" && node "$ROOT/scripts/write-build-manifest.mjs" --check \
  "$ROOT/release/build-manifest-v$V.json")

echo "Artifacts:"
ls -l release/*-v"$V".*
echo "Record + sign release/build-manifest-v$V.json alongside the store uploads."
