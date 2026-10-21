#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-release.sh — build the web client and zip it as notis-web-<ver>.zip.
# The bundle is built for notis.fun's layout; a host with another layout
# edits seven values in web/index.html after unzipping — matching the count
# README.txt names.
#
# Requires: node (>=22), pnpm, zip.
# Output: notis-web-<version>.zip in the repository's root.
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./package.json').version")
PKG="notis-web-${VERSION}"
STAGE=$(mktemp -d)
# WEB_INTERFACE → The client is served from the node's own origin →
# "A zip holds one build" — the stage directory goes however the script
# ends, never leaving a half-written build behind.
trap 'rm -rf "$STAGE"' EXIT

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

# WEB_INTERFACE → The client is served from the node's own origin →
# "The web build's shell carries its own security policy" — the shell holds
# exactly one Content-Security-Policy meta, placed between <meta charset=…>
# and <base>, with the content the module itself exports. The expected
# string is read from the module (no second copy in this script).
EXPECTED_POLICY=$(node --input-type=module -e "import { WEB_SECURITY_POLICY } from './scripts/content-security-policy.mjs'; process.stdout.write(WEB_SECURITY_POLICY);")
EXPECTED_META="<meta http-equiv=\"Content-Security-Policy\" content=\"${EXPECTED_POLICY}\">"
# Count across the whole shell so a stray second meta surfaces as a hit.
policy_count=$(grep -Fc 'http-equiv="Content-Security-Policy"' "$SHELL_FILE" || true)
[ "$policy_count" = "1" ] \
  || { echo "FAIL: $SHELL_FILE carries $policy_count Content-Security-Policy metas, expected 1"; exit 1; }
grep -Fq "$EXPECTED_META" "$SHELL_FILE" \
  || { echo "FAIL: $SHELL_FILE policy meta content differs from the module's string"; echo "  expected: $EXPECTED_META"; exit 1; }
# indexOf returns -1 for an absent anchor, so each arm of the placement
# check reaches its own FAIL line and names which anchors are missing.
# The here-string form `<<<` appends a newline, so read returns 0 (its
# EOF-without-newline arm returns 1 and would trip errexit even on a
# filled read).
POSITIONS=$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
const html = readFileSync(process.argv[1], 'utf8');
process.stdout.write(
  html.indexOf('<meta charset=\"utf-8\">') + ' ' +
  html.indexOf('http-equiv=\"Content-Security-Policy\"') + ' ' +
  html.indexOf('<base ')
);
" "$SHELL_FILE")
read -r charset_pos policy_pos base_pos <<< "$POSITIONS"
if [ "$charset_pos" = "-1" ] || [ "$policy_pos" = "-1" ] || [ "$base_pos" = "-1" ]; then
  echo "FAIL: $SHELL_FILE missing one of <meta charset=…>, policy meta, or <base>"
  echo "  charset at $charset_pos, policy at $policy_pos, base at $base_pos"
  exit 1
fi
if [ "$policy_pos" -le "$charset_pos" ] || [ "$policy_pos" -ge "$base_pos" ]; then
  echo "FAIL: $SHELL_FILE policy meta is not between <meta charset=…> and <base>"
  echo "  charset at $charset_pos, policy at $policy_pos, base at $base_pos"
  exit 1
fi

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
# that keeps the web bundle honest". `nipopow/proof` is the tip verifier's
# request path, `api/v1/proof` is the figures' and the names' single-key path,
# and `api/v1/range` is the figures' holdings-by-range path (NODE_INTERFACE →
# Nipopow, → AVL+ State Root), so a stray chunk that pulled any verifier into
# the page script surfaces as a hit here.
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
if grep -Fnq "api/v1/range" dist/assets/*.js; then
  echo "FAIL: api/v1/range reference found in the web bundle (the figures verifier's range path leaked into the zip)"
  grep -Fn "api/v1/range" dist/assets/*.js | head -5
  exit 1
fi
# The web bundle holds no post cache — WEB_INTERFACE → The extension → "The
# post cache". `notis.posts.` is the IndexedDB database-name prefix the
# extension's cache keys on, so a stray chunk that pulled the cache module
# into the page script surfaces as a hit here.
if grep -Fnq "notis.posts." dist/assets/*.js; then
  echo "FAIL: notis.posts. reference found in the web bundle (the post cache leaked into the zip)"
  grep -Fn "notis.posts." dist/assets/*.js | head -5
  exit 1
fi
# The web bundle holds no resolver — WEB_INTERFACE → The extension → "The
# resolve". `posts/batch` is the request path the resolver sends to each of
# the seed list's nodes, so a stray chunk that pulled the resolver into the
# page script surfaces as a hit here (NODE_INTERFACE → Posts → "The batch
# read answers posts by id").
if grep -Fnq "posts/batch" dist/assets/*.js; then
  echo "FAIL: posts/batch reference found in the web bundle (the resolver leaked into the zip)"
  grep -Fn "posts/batch" dist/assets/*.js | head -5
  exit 1
fi

echo "==> Build checks passed"

# ---------------------------------------------------------------------------
# Stage and zip. The zip is assembled inside $STAGE and lands in the
# repository's root through `mv -f`, so a zip of that name standing there
# is replaced — never added to.
# WEB_INTERFACE → The client is served from the node's own origin →
# "A zip holds one build".
# ---------------------------------------------------------------------------
cd "$REPO_ROOT"
mkdir -p "$STAGE/$PKG"
cp -r packages/web/dist "$STAGE/$PKG/web"
cp packages/web/deploy/nginx.example.conf "$STAGE/$PKG/nginx.example.conf"
cp packages/web/deploy/README.txt "$STAGE/$PKG/README.txt"

(cd "$STAGE" && zip -r -X "$STAGE/$PKG.zip" "$PKG")
mv -f "$STAGE/$PKG.zip" "$REPO_ROOT/$PKG.zip"

echo "==> Done: $PKG.zip"
sha256sum "$PKG.zip"
du -h "$PKG.zip"
