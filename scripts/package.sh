#!/usr/bin/env bash
# Official release packaging. Builds store-ready artifacts into release/:
#   beldex-wallet-chrome-v<V>.zip       — upload to Chrome Web Store
#   beldex-wallet-firefox-v<V>.zip      — upload to AMO
#   beldex-wallet-source-v<V>.zip       — AMO source-review zip (git archive HEAD)
#   build-manifest-v<V>.json            — binds binaries to source + config
#   build-manifest-v<V>.json.asc        — detached GPG signature (only when signed)
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
#      typecheck, BOTH target builds, and finally the tests — tests run AFTER
#      the build because several exercise the built bundle and skip without it.
#   4. Build manifest: commit/tree hash, lockfile hash, node/npm versions,
#      resolved config, host_permissions and per-file sha256 hashes of both
#      outputs are recorded in release/build-manifest-v<V>.json, which also
#      cross-checks each built manifest.json against the reviewed config.
#   5. Reproduce-and-compare: the source zip is extracted to a temp dir,
#      rebuilt from scratch (`npm ci` + build), and the rebuilt outputs must be
#      byte-identical to the packaged ones — otherwise the release aborts.
#   6. Signing: the manifest is detach-signed when RELEASE_SIGNING_KEY is set;
#      otherwise the run ends with a prominent UNSIGNED warning.
#
# Run via: npm run package
set -euo pipefail

# Resolve the repo root once and address git by path (-C), so the script does
# not depend on the caller's working directory or on `cd` side effects.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
git() { command git -C "$ROOT" "$@"; }

V=$(node -p "require('$ROOT/package.json').version")

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

if [ -f "$ROOT/.env" ]; then
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

# ---- 3. hermetic build (BUILD BEFORE TEST) ----------------------------------

rm -rf dist firefox dist-testnet firefox-testnet release
npm ci
npm run typecheck
npm run build      # produce dist/ + firefox/ FIRST...
npm test           # ...so the bundle-driven tests actually run (they skip w/o a build)

# ---- 4. build manifest (also cross-checks built manifests vs networks.json) --

mkdir -p release
node scripts/write-build-manifest.mjs

# ---- package: binaries and source from the SAME verified checkout -----------

(cd dist && zip -qrX "$ROOT/release/beldex-wallet-chrome-v$V.zip" .)
(cd firefox && zip -qrX "$ROOT/release/beldex-wallet-firefox-v$V.zip" .)
git archive HEAD -o "$ROOT/release/beldex-wallet-source-v$V.zip"

# ---- 5. reproduce from the source zip and compare ---------------------------

echo "[package] verifying: rebuilding from the source zip and comparing..."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
unzip -q "release/beldex-wallet-source-v$V.zip" -d "$TMP/src"
(cd "$TMP/src" && npm ci --silent && npm run build --silent)
# write-build-manifest --check recomputes dist/ + firefox/ content hashes in
# the rebuilt tree (its CWD) and compares them to the manifest we just wrote.
(cd "$TMP/src" && node "$ROOT/scripts/write-build-manifest.mjs" --check \
  "$ROOT/release/build-manifest-v$V.json")

# ---- 6. sign the manifest, or clearly mark it unsigned ----------------------

MANIFEST="release/build-manifest-v$V.json"
if [ -n "${RELEASE_SIGNING_KEY:-}" ]; then
  command -v gpg >/dev/null 2>&1 || {
    echo "ERROR: RELEASE_SIGNING_KEY is set but gpg was not found on PATH." >&2
    exit 1
  }
  gpg --local-user "$RELEASE_SIGNING_KEY" --armor --detach-sign \
      --output "$MANIFEST.asc" "$MANIFEST"
  echo "SIGNED: $MANIFEST.asc"
  echo "  verify with: gpg --verify $MANIFEST.asc $MANIFEST"
  SIGN_STATE="signed"
else
  echo "############################################################" >&2
  echo "⚠  UNSIGNED RELEASE MANIFEST" >&2
  echo "   $MANIFEST has NO detached signature." >&2
  echo "   Set RELEASE_SIGNING_KEY=<gpg key id> and re-run to produce" >&2
  echo "   $MANIFEST.asc before publishing an official build." >&2
  echo "############################################################" >&2
  SIGN_STATE="UNSIGNED"
fi

echo "Artifacts ($SIGN_STATE):"
ls -l release/*-v"$V".* 2>/dev/null
