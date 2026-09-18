#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-extension.sh — build @dagsocial/web as a browser extension and zip
# it for Chrome and Firefox. The web bundle is a separate target
# (build-release.sh) and shares the App byte for byte — only the identity
# implementation, the two extra pages and the shell's values differ.
#
# WEB_INTERFACE → "The extension".
#
# Env overrides (dev/proof harnesses):
#   VITE_NODES         JSON array of API bases the shell carries as notis-nodes
#   VITE_FAUCET_BASE   absolute base for the shell's notis-faucet
#   VITE_PUBLIC        origin+base for shareable links (empty by default)
#   NOTIS_EXTENSION_KEY    Chrome extension public key for a stable id
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./package.json').version")
STAGE=$(mktemp -d)

echo "==> Building notis-extension-${VERSION}"

pnpm --filter '@dagsocial/web^...' build

cd packages/web

# Testnet defaults; the proof and dev harnesses override via the environment.
export VITE_WEB_BASE=/
export VITE_API_BASE=""
export VITE_FAUCET_BASE=${VITE_FAUCET_BASE:-https://notis.fun/testnet/faucet}
export VITE_PUBLIC_ORIGIN=${VITE_PUBLIC_ORIGIN:-https://notis.fun}
export VITE_NODES=${VITE_NODES:-'["https://notis.fun/testnet/api"]'}
export VITE_PUBLIC=${VITE_PUBLIC:-https://notis.fun/web/}
export VITE_IDENTITY=extension

# Staging: a fresh temp dir every build — the 216-2 append trap is impossible
# by construction (WEB_INTERFACE → The extension).
CHROME_DIR="${STAGE}/chrome"
FIREFOX_DIR="${STAGE}/firefox"
mkdir -p "$CHROME_DIR" "$FIREFOX_DIR"

# Two Vite builds share output into a scratch — pages first, background lib
# next. Copied to both staging dirs.
SCRATCH=$(mktemp -d)
NOTIS_EXT_OUTDIR="$SCRATCH" npx vite build --config vite.extension.config.ts
NOTIS_EXT_OUTDIR="$SCRATCH" npx vite build --config vite.background.config.ts

# Copy the built assets to both staging dirs.
for target in "$CHROME_DIR" "$FIREFOX_DIR"; do
  cp -r "$SCRATCH"/* "$target/"
done

# Manifests — one template, two per-browser overlays.
node extension/emit-manifests.mjs "$VERSION" "$CHROME_DIR" "$FIREFOX_DIR"

# Icons — the four PNGs the manifest names.
for target in "$CHROME_DIR" "$FIREFOX_DIR"; do
  mkdir -p "$target/icons"
  cp extension/icons/16.png extension/icons/32.png extension/icons/48.png extension/icons/128.png "$target/icons/"
done

# ---------------------------------------------------------------------------
# Checks — WEB_INTERFACE → "The build check that keeps the web bundle honest"
# and its extension siblings.
# ---------------------------------------------------------------------------

echo "==> Running extension build checks"

for target in "$CHROME_DIR" "$FIREFOX_DIR"; do
  shell="$target/index.html"
  prompt="$target/prompt.html"

  # The shell carries no inline <script> — the extension page's default CSP
  # forbids it (WEB_INTERFACE → "Permissions and policy, the whole list"). An
  # inline script is literally <script> (no attributes); a `src=` script is
  # `<script src=...>`. `grep -q '<script>'` catches the first without a PCRE
  # lookahead — a lookahead exits 2 on both matches and none, which `if`
  # reads as false either way.
  if grep -q '<script>' "$shell"; then
    echo "FAIL: inline <script> in $shell"
    exit 1
  fi
  if [ -f "$prompt" ] && grep -q '<script>' "$prompt"; then
    echo "FAIL: inline <script> in $prompt"
    exit 1
  fi

  # <base href="/"> in the extension build.
  grep -q '<base href="/">' "$shell" \
    || { echo "FAIL: <base href='/'> missing in $shell"; exit 1; }

  # The three build-time metas carry the extension's values.
  grep -Fq "name=\"notis-nodes\" content='$VITE_NODES'" "$shell" \
    || { echo "FAIL: notis-nodes meta wrong in $shell (expected $VITE_NODES)"; exit 1; }
  grep -Fq "name=\"notis-public\" content=\"$VITE_PUBLIC\"" "$shell" \
    || { echo "FAIL: notis-public meta wrong in $shell (expected $VITE_PUBLIC)"; exit 1; }
  grep -Fq "name=\"notis-faucet\" content=\"$VITE_FAUCET_BASE\"" "$shell" \
    || { echo "FAIL: notis-faucet meta wrong in $shell (expected $VITE_FAUCET_BASE)"; exit 1; }

  # background.js is one classic file with no `import` — WEB_INTERFACE →
  # "The background is one classic file with no `import`".
  bg="$target/background.js"
  [ -f "$bg" ] || { echo "FAIL: $bg missing"; exit 1; }
  if grep -qE '^import |[^A-Za-z_]import[ (][^ ]' "$bg"; then
    echo "FAIL: `import` in $bg — the IIFE build must not import at runtime"
    exit 1
  fi

  # The manifest parses and names the version.
  mv=$(node -p "JSON.parse(require('fs').readFileSync('$target/manifest.json','utf8')).version")
  [ "$mv" = "$VERSION" ] || { echo "FAIL: manifest version $mv != $VERSION"; exit 1; }

  # Every href/src is relative — the <base> alone decides where they resolve.
  if grep -En 'href="/[^"]*"|src="/[^"]*"' "$shell" | grep -v '<base '; then
    echo "FAIL: root-absolute href or src in $shell (above)"
    exit 1
  fi
  if [ -f "$prompt" ] && grep -En 'href="/[^"]*"|src="/[^"]*"' "$prompt" | grep -v '<base '; then
    echo "FAIL: root-absolute href or src in $prompt (above)"
    exit 1
  fi

  # Icons — the four PNGs.
  for size in 16 32 48 128; do
    [ -f "$target/icons/${size}.png" ] || { echo "FAIL: $target/icons/${size}.png missing"; exit 1; }
  done
done

# web-ext lint on the Firefox stage — the extension's own manifest linter.
echo "==> web-ext lint (Firefox stage)"
npx --yes web-ext lint --source-dir "$FIREFOX_DIR"

echo "==> Build checks passed"

# ---------------------------------------------------------------------------
# Zip. `zip -r -X` — no extended attributes, so the archive is byte-stable.
# ---------------------------------------------------------------------------
cd "$STAGE"
CHROME_ZIP="notis-extension-${VERSION}-chrome.zip"
FIREFOX_ZIP="notis-extension-${VERSION}-firefox.zip"
(cd chrome && zip -r -X "$STAGE/$CHROME_ZIP" .)
(cd firefox && zip -r -X "$STAGE/$FIREFOX_ZIP" .)
mv "$STAGE/$CHROME_ZIP" "$STAGE/$FIREFOX_ZIP" "$REPO_ROOT/"
cd "$REPO_ROOT"
rm -rf "$STAGE" "$SCRATCH"

echo "==> Done: $CHROME_ZIP and $FIREFOX_ZIP"
for z in "$CHROME_ZIP" "$FIREFOX_ZIP"; do
  sha256sum "$z"
  du -h "$z"
done
