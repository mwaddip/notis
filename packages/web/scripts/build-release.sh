#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-release.sh — build the web client and zip it as notis-web-<ver>.zip.
# The bundle is built for notis.fun's layout; a host with another layout edits
# four values in web/index.html after unzipping.
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
VITE_PUBLIC_ORIGIN=https://notis.fun VITE_WEB_BASE=/web/ VITE_API_BASE=/testnet/api VITE_FAUCET_BASE=/testnet/faucet VITE_NODES="[]" VITE_PUBLIC="" VITE_NETWORK="" npx vite build

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
grep -q "name=\"notis-nodes\" content='\[\]'" "$SHELL_FILE" \
  || { echo "FAIL: notis-nodes meta missing or wrong (web build: empty JSON array)"; exit 1; }
grep -q 'name="notis-public" content=""' "$SHELL_FILE" \
  || { echo "FAIL: notis-public meta missing or wrong (web build: empty)"; exit 1; }
grep -q 'name="notis-network" content=""' "$SHELL_FILE" \
  || { echo "FAIL: notis-network meta missing or wrong (web build: empty — no verifier)"; exit 1; }
grep -q 'property="og:image" content="https://notis.fun/web/og.png"' "$SHELL_FILE" \
  || { echo "FAIL: og:image meta missing or wrong"; exit 1; }
[ -f dist/og.png ] || { echo "FAIL: dist/og.png missing"; exit 1; }
grep -q '<script src="theme.js">' "$SHELL_FILE" \
  || { echo "FAIL: theme.js script src missing"; exit 1; }
if grep -q '<script>' "$SHELL_FILE"; then
  echo "FAIL: inline <script> in the built shell — extension pages' default CSP forbids it (WEB_INTERFACE → The extension)"
  exit 1
fi
[ -f dist/theme.js ] || { echo "FAIL: dist/theme.js missing"; exit 1; }

if grep -En 'href="/[^"]*"|src="/[^"]*"' "$SHELL_FILE" | grep -v '<base '; then
  echo "FAIL: root-absolute href or src in the built shell (above)"
  exit 1
fi

if grep -n "url('/" dist/fonts/fonts.css; then
  echo "FAIL: root-absolute url( in dist/fonts/fonts.css (above)"
  exit 1
fi

# The web bundle carries no extension code — WEB_INTERFACE → The extension.
# `chrome.` in an extension bundle is `chrome.runtime`, `chrome.storage` &c.; the
# web bundle carries none of that, so a stray chunk from the extension entries
# would surface as a hit here.
if grep -Fnq "chrome." dist/assets/*.js; then
  echo "FAIL: chrome.* reference found in the web bundle (extension code leaked into the zip)"
  grep -Fn "chrome." dist/assets/*.js | head -5
  exit 1
fi

# The web bundle is handed no verifier — WEB_INTERFACE → "The build check
# that keeps the web bundle honest". `nipopow/proof` is the tip verifier's one
# request path and `api/v1/proof` is the figures verifier's (NODE_INTERFACE →
# Nipopow, → AVL+ State Root), so a stray chunk that pulled either verifier
# into the page script surfaces as a hit here.
if grep -Fnq "nipopow/proof" dist/assets/*.js; then
  echo "FAIL: nipopow/proof reference found in the web bundle (a verifier leaked into the zip)"
  grep -Fn "nipopow/proof" dist/assets/*.js | head -5
  exit 1
fi
if grep -Fnq "api/v1/proof" dist/assets/*.js; then
  echo "FAIL: api/v1/proof reference found in the web bundle (the figures verifier leaked into the zip)"
  grep -Fn "api/v1/proof" dist/assets/*.js | head -5
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
