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
#   VITE_FAUCET_BASE   absolute base for the shell's notis-faucet — the origin
#                      the emitter derives the one optional host from, on both
#                      manifests; an explicit empty value builds a faucet-less
#                      extension and declares no optional host
#                      (WEB_INTERFACE → The extension → "The manifest").
#   VITE_PUBLIC        origin+base the shell carries as `notis-public` — the
#                      absolute URL a copied post link is composed against, the
#                      base the bridge's content-script match is derived from,
#                      and the base the background checks the bridge's sender
#                      against. Unset takes the notis.fun default below; an
#                      explicit empty value builds an extension with no bridge
#                      and no `content_scripts`.
#   NOTIS_EXTENSION_KEY    Chrome extension public key for a stable id
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./package.json').version")
STAGE=$(mktemp -d)

# One variable pins the linter's major — web-ext@10 is the release measured
# against the emitted manifests.
WEBEXT_MAJOR=10

echo "==> Building notis-extension-${VERSION}"

pnpm --filter '@dagsocial/web^...' build

cd packages/web

# Testnet defaults; the proof and dev harnesses override via the environment.
export VITE_WEB_BASE=/
export VITE_API_BASE=""
# `-` (not `:-`): only unset falls back to the default; an explicit empty
# string reaches the emitter as the empty faucet base, so no
# `optional_host_permissions` on either manifest (WEB_INTERFACE → The
# extension → "The manifest").
export VITE_FAUCET_BASE=${VITE_FAUCET_BASE-https://notis.fun/testnet/faucet}
export VITE_PUBLIC_ORIGIN=${VITE_PUBLIC_ORIGIN:-https://notis.fun}
export VITE_NODES=${VITE_NODES:-'["https://notis.fun/testnet/api"]'}
# `-` (not `:-`): only unset falls back to the default; an explicit empty
# string reaches the emitter as the empty base, so no bridge and no
# `content_scripts` (WEB_INTERFACE → "The build's `notis-public`").
export VITE_PUBLIC=${VITE_PUBLIC-https://notis.fun/web/}
export VITE_IDENTITY=extension

# Staging: a fresh temp dir every build — the 216-2 append trap is impossible
# by construction (WEB_INTERFACE → The extension).
CHROME_DIR="${STAGE}/chrome"
FIREFOX_DIR="${STAGE}/firefox"
mkdir -p "$CHROME_DIR" "$FIREFOX_DIR"

# Three Vite builds share output into a scratch — pages first, background
# lib next, then the bridge lib when a public base is set. The bridge is one
# classic IIFE file with no `import`, so both browsers inject it at
# `document_start` as they are (WEB_INTERFACE → The extension → "The manifest").
SCRATCH=$(mktemp -d)
NOTIS_EXT_OUTDIR="$SCRATCH" npx vite build --config vite.extension.config.ts
NOTIS_EXT_OUTDIR="$SCRATCH" npx vite build --config vite.background.config.ts
if [ -n "$VITE_PUBLIC" ]; then
  NOTIS_EXT_OUTDIR="$SCRATCH" npx vite build --config vite.bridge.config.ts
fi

# Copy the built assets to both staging dirs.
for target in "$CHROME_DIR" "$FIREFOX_DIR"; do
  cp -r "$SCRATCH"/* "$target/"
done

# Manifests — one template, two per-browser overlays. The public base
# derives the bridge's match pattern; the faucet base derives the one
# optional host; the empty string on either drops the corresponding key
# (WEB_INTERFACE → The extension → "The manifest").
node extension/emit-manifests.mjs "$VERSION" "$CHROME_DIR" "$FIREFOX_DIR" "$VITE_PUBLIC" "$VITE_FAUCET_BASE"

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

# The bridge's expected match pattern is computed from the same module the
# emitter uses — never a second implementation in shell. An empty
# `notis-public` prints an empty line, and the check below reads that as
# `no bridge, no content_scripts`.
EXPECTED_PATTERN=$(node -e "import('./extension/match-pattern.mjs').then(m => process.stdout.write(m.matchPatternFor(process.argv[1]) ?? ''))" "$VITE_PUBLIC")

# The one optional host both manifests declare, computed from the same
# module the emitter uses. An empty `VITE_FAUCET_BASE` prints an empty line,
# and the check below reads that as `no key on either manifest`.
EXPECTED_OPTIONAL_HOST=$(node -e "import('./extension/match-pattern.mjs').then(m => process.stdout.write(m.originPatternFor(process.argv[1]) ?? ''))" "$VITE_FAUCET_BASE")

# Firefox's `browser_specific_settings` — the whole object stated literally
# here, a second statement of the contract's object on purpose: a check that
# reads the emitter's own constant proves nothing. Deep-equality by
# canonical JSON, both sides run through `JSON.parse` and `JSON.stringify`
# so key order and whitespace do not decide the comparison.
EXPECTED_BSS='{
  "gecko": {
    "id": "extension@notis.fun",
    "strict_min_version": "140.0",
    "update_url": "https://raw.githubusercontent.com/mwaddip/notis/updates/firefox/updates.json",
    "data_collection_permissions": {
      "required": ["personalCommunications", "financialAndPaymentInfo"]
    }
  },
  "gecko_android": { "strict_min_version": "142.0" }
}'

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

  # The bridge and its content-script entry — WEB_INTERFACE → "The manifest".
  # A non-empty `notis-public` builds the bridge and pins one entry whose
  # `matches` is the pattern the module gives, whose `js` is `bridge.js`,
  # whose `run_at` is `document_start`; an empty `notis-public` builds
  # neither the file nor the key.
  bridge="$target/bridge.js"
  if [ -n "$VITE_PUBLIC" ]; then
    [ -f "$bridge" ] || { echo "FAIL: $bridge missing"; exit 1; }
    if grep -qE '^import |[^A-Za-z_]import[ (][^ ]' "$bridge"; then
      echo "FAIL: \`import\` in $bridge — the IIFE build must not import at runtime"
      exit 1
    fi
    # The build-time replacement placed the literal `notis-public` value into
    # the built file. `grep -c 0 exits 1` is a `set -e` trap — read the count
    # into a variable first.
    grep_count=$(grep -Fc "$VITE_PUBLIC" "$bridge" || true)
    [ "$grep_count" -gt 0 ] || { echo "FAIL: literal VITE_PUBLIC ($VITE_PUBLIC) missing in $bridge"; exit 1; }
    if grep -Fq 'import.meta' "$bridge"; then
      echo "FAIL: \`import.meta\` remains in $bridge — the build-time replacement did not happen"
      exit 1
    fi
    cs=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('$target/manifest.json','utf8')).content_scripts ?? null))")
    expected_cs=$(node -e "process.stdout.write(JSON.stringify([{matches:[process.argv[1]],js:['bridge.js'],run_at:'document_start'}]))" "$EXPECTED_PATTERN")
    [ "$cs" = "$expected_cs" ] || { echo "FAIL: $target/manifest.json content_scripts = $cs, expected $expected_cs"; exit 1; }
  else
    [ ! -f "$bridge" ] || { echo "FAIL: $bridge present under an empty VITE_PUBLIC"; exit 1; }
    cs=$(node -e "const m = JSON.parse(require('fs').readFileSync('$target/manifest.json','utf8')); process.stdout.write('content_scripts' in m ? 'present' : 'absent')")
    [ "$cs" = 'absent' ] || { echo "FAIL: $target/manifest.json carries content_scripts under an empty VITE_PUBLIC"; exit 1; }
  fi

  # The one optional host both manifests declare — the pattern computed
  # through the module (EXPECTED_OPTIONAL_HOST) — or the key absent under an
  # empty faucet base (WEB_INTERFACE → The extension → "The manifest").
  if [ -n "$VITE_FAUCET_BASE" ]; then
    ohp=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('$target/manifest.json','utf8')).optional_host_permissions ?? null))")
    expected_ohp=$(node -e "process.stdout.write(JSON.stringify([process.argv[1]]))" "$EXPECTED_OPTIONAL_HOST")
    [ "$ohp" = "$expected_ohp" ] || { echo "FAIL: $target/manifest.json optional_host_permissions = $ohp, expected $expected_ohp"; exit 1; }
  else
    ohp=$(node -e "const m = JSON.parse(require('fs').readFileSync('$target/manifest.json','utf8')); process.stdout.write('optional_host_permissions' in m ? 'present' : 'absent')")
    [ "$ohp" = 'absent' ] || { echo "FAIL: $target/manifest.json carries optional_host_permissions under an empty VITE_FAUCET_BASE"; exit 1; }
  fi

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

# Firefox's `browser_specific_settings` deep-equals the object stated
# literally above (EXPECTED_BSS) — a second statement of the contract on
# purpose (WEB_INTERFACE → The extension → "The manifest").
actual_bss=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('$FIREFOX_DIR/manifest.json','utf8')).browser_specific_settings))")
canonical_bss=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))" "$EXPECTED_BSS")
[ "$actual_bss" = "$canonical_bss" ] \
  || { echo "FAIL: $FIREFOX_DIR/manifest.json browser_specific_settings differs from the object in this script"; echo "  actual:   $actual_bss"; echo "  expected: $canonical_bss"; exit 1; }

# Chrome's manifest carries no `browser_specific_settings` key.
chrome_bss=$(node -e "const m = JSON.parse(require('fs').readFileSync('$CHROME_DIR/manifest.json','utf8')); process.stdout.write('browser_specific_settings' in m ? 'present' : 'absent')")
[ "$chrome_bss" = 'absent' ] || { echo "FAIL: $CHROME_DIR/manifest.json carries browser_specific_settings"; exit 1; }

# web-ext lint on the Firefox stage — the extension's own manifest linter,
# major pinned above. `--self-hosted` reads the manifest as a self-hosted
# add-on's, where an `update_url` is legitimate; without it the lint errors
# on `MANIFEST_UPDATE_URL` (WEB_INTERFACE → "The build check that keeps the
# web bundle honest").
echo "==> web-ext lint (Firefox stage)"
npx --yes -p "web-ext@${WEBEXT_MAJOR}" web-ext lint --source-dir "$FIREFOX_DIR" --self-hosted

echo "==> Build checks passed"

# ---------------------------------------------------------------------------
# Zip. `zip -r -X` — no extended attributes.
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
