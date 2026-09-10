#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-release.sh — build the web client and zip it as notis-web-<ver>.zip.
# The bundle is built for notis.fun's layout; a host with another layout edits
# three values in web/index.html after unzipping.
#
# Requires: node (>=22), pnpm, zip.
# Output: notis-web-<version>.zip in the repo root.
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./package.json').version")
PKG="notis-web-${VERSION}"
STAGE=$(mktemp -d)

echo "==> Building $PKG.zip"

# The bundle's workspace dependencies need a dist.
pnpm --filter '@dagsocial/web^...' build

cd packages/web
VITE_WEB_BASE=/web/ VITE_API_BASE=/testnet/api VITE_FAUCET_BASE=/testnet/faucet npx vite build

# ---------------------------------------------------------------------------
# Check the build
# ---------------------------------------------------------------------------
SHELL_FILE="dist/index.html"

grep -q '<base href="/web/">' "$SHELL_FILE" \
  || { echo "FAIL: <base href> missing or wrong"; exit 1; }
grep -q 'name="notis-api" content="/testnet/api"' "$SHELL_FILE" \
  || { echo "FAIL: notis-api meta missing or wrong"; exit 1; }
grep -q 'name="notis-faucet" content="/testnet/faucet"' "$SHELL_FILE" \
  || { echo "FAIL: notis-faucet meta missing or wrong"; exit 1; }

if grep -Pn 'href="/[^"]*"|src="/[^"]*"' "$SHELL_FILE" | grep -v '<base '; then
  echo "FAIL: root-absolute href or src in the built shell (above)"
  exit 1
fi

if grep -n "url('/" dist/fonts/fonts.css; then
  echo "FAIL: root-absolute url( in dist/fonts/fonts.css (above)"
  exit 1
fi

echo "==> Build checks passed"

# ---------------------------------------------------------------------------
# Stage and zip
# ---------------------------------------------------------------------------
cd "$REPO_ROOT"
mkdir -p "$STAGE/$PKG"
cp -r packages/web/dist "$STAGE/$PKG/web"
cp packages/web/deploy/nginx.example.conf "$STAGE/$PKG/nginx.example.conf"
cp packages/web/deploy/README.txt "$STAGE/$PKG/README.txt"

cd "$STAGE"
zip -r -X "$REPO_ROOT/$PKG.zip" "$PKG"
cd "$REPO_ROOT"
rm -rf "$STAGE"

echo "==> Done: $PKG.zip"
sha256sum "$PKG.zip"
du -h "$PKG.zip"
