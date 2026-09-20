#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# sign-extension.sh — sign the release's own Firefox zip through
# addons.mozilla.org's unlisted channel, publish the signed xpi and the
# entry in `firefox/updates.json` on the repository's `updates` branch, and
# verify a live release from the update manifest.
#
# WEB_INTERFACE → "The Firefox build ships signed as well".
#
# Subcommands:
#   submit <ver> [--dry-run [--rev <rev>] [--zip <file>]]
#     Sign the release's own zip. `--rev` and `--zip` are accepted with
#     `--dry-run` only, so a real submission always signs the release's own
#     zip at the release's own tag. Exit 0 on success, 3 when web-ext
#     returned without a signed file, 1 on a refusal, 2 on usage.
#
#   entry <ver> <xpi> [--zip <file>] [--into <path to firefox/updates.json>]
#     Copy the signed xpi into the repo root and print its manifest entry.
#     `--into` rewrites that update manifest with the entry appended.
#
#   published <ver> [--xpi <file>]
#     Fetch the live update manifest that the xpi's `update_url` names,
#     look up the entry for <ver>, download `update_link` and check its
#     status, content-type and hash.
#
# Assumes GNU coreutils on Linux (stat -c %a, sha256sum). All JSON work
# goes through extension/update-manifest.mjs; every fact about the add-on
# is read from the manifest inside the zip or the xpi in hand.
#
# If addons.mozilla.org refuses --amo-metadata on a first submission,
# submit without the approval notes and enter them in the developer hub.
# ---------------------------------------------------------------------------

CALLER_PWD="$(pwd -P)"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
UPDATE_MJS="$REPO_ROOT/packages/web/extension/update-manifest.mjs"
BUILD_EXT_SH="$REPO_ROOT/packages/web/scripts/build-extension.sh"

# Resolve a possibly-relative caller-supplied path against the caller's own
# CWD, before `cd "$REPO_ROOT"` moves the shell.
resolve_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$CALLER_PWD" "$1" ;;
  esac
}

cd "$REPO_ROOT"

# The pinned web-ext major — must match build-extension.sh's WEBEXT_MAJOR
# (WEB_INTERFACE → "The build check that keeps the web bundle honest").
WEBEXT_MAJOR=10

usage() {
  cat <<'EOF' >&2
usage:
  sign-extension.sh submit <ver> [--dry-run [--rev <rev>] [--zip <file>]]
  sign-extension.sh entry <ver> <xpi> [--zip <file>] [--into <updates.json>]
  sign-extension.sh published <ver> [--xpi <file>]

If addons.mozilla.org refuses --amo-metadata on a first submission, submit
without the approval notes and enter them in the developer hub.
EOF
  exit 2
}

fail() { echo "FAIL: $*" >&2; exit 1; }

# Every command needs these — one refusal names the missing tool.
require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || fail "required tool not found: $tool"
  done
}

# Refuse when the pinned web-ext major drifts from build-extension.sh's.
check_webext_major() {
  local built
  built=$(grep -E '^WEBEXT_MAJOR=' "$BUILD_EXT_SH" | head -1 | sed 's/^WEBEXT_MAJOR=//')
  [ "$built" = "$WEBEXT_MAJOR" ] \
    || fail "WEBEXT_MAJOR=$WEBEXT_MAJOR differs from $BUILD_EXT_SH ($built)"
}

# One scratch dir, one EXIT trap.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# ---------------------------------------------------------------------------
# Helpers reading facts from a manifest through update-manifest.mjs.
# ---------------------------------------------------------------------------

# Emit "$id\n$strict_min_version\n$update_url\n" from a manifest.json;
# refuse on a missing gecko block or an update_url repoFromUpdateUrl rejects.
read_gecko() {
  local mf="$1"
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const g = m.browser_specific_settings && m.browser_specific_settings.gecko;
    if (!g || typeof g.id !== 'string' || typeof g.strict_min_version !== 'string' || typeof g.update_url !== 'string') {
      console.error('gecko block is missing id, strict_min_version or update_url');
      process.exit(1);
    }
    import(process.argv[2]).then(u => {
      u.repoFromUpdateUrl(g.update_url);
      process.stdout.write(g.id + '\n' + g.strict_min_version + '\n' + g.update_url + '\n');
    }).catch(e => { console.error(e.message); process.exit(1); });
  " "$mf" "$UPDATE_MJS"
}

# Emit "$owner\n$repo\n" from an update_url.
read_repo() {
  local url="$1"
  node -e "
    import(process.argv[2]).then(u => {
      const r = u.repoFromUpdateUrl(process.argv[1]);
      process.stdout.write(r.owner + '\n' + r.repo + '\n');
    }).catch(e => { console.error(e.message); process.exit(1); });
  " "$url" "$UPDATE_MJS"
}

# Emit the manifest.version from a manifest.json.
read_manifest_version() {
  node -p "JSON.parse(require('fs').readFileSync('$1','utf8')).version"
}

# ---------------------------------------------------------------------------
# submit
# ---------------------------------------------------------------------------

do_submit() {
  local ver="${1:-}"
  [ -n "$ver" ] || usage
  shift
  local dry_run=0 rev="" zip_arg=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --rev) [ -n "${2:-}" ] || usage; rev="$2"; shift 2 ;;
      --zip) [ -n "${2:-}" ] || usage; zip_arg="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  if [ "$dry_run" -eq 0 ] && { [ -n "$rev" ] || [ -n "$zip_arg" ]; }; then
    echo "--rev and --zip are accepted with --dry-run only" >&2
    exit 2
  fi

  require_tools git gh node pnpm npx unzip zip diff sha256sum
  check_webext_major

  # Revision: v<ver> resolves (or --rev); package.json at it says <ver>.
  local revision
  if [ -n "$rev" ]; then
    revision=$(git rev-parse --verify "$rev^{commit}" 2>/dev/null) \
      || fail "revision $rev does not resolve"
  else
    revision=$(git rev-parse --verify "v$ver^{commit}" 2>/dev/null) \
      || fail "tag v$ver does not resolve"
  fi
  local pkg_ver
  git show "$revision:package.json" > "$SCRATCH/pkg.json" 2>/dev/null \
    || fail "package.json missing at $revision"
  pkg_ver=$(read_manifest_version "$SCRATCH/pkg.json")
  [ "$pkg_ver" = "$ver" ] \
    || fail "package.json at $revision names $pkg_ver, not $ver"

  # Firefox zip: --zip or gh release download. Resolve --zip to an absolute
  # path so it survives the `cd` into scratch dirs.
  local asset="notis-extension-$ver-firefox.zip"
  local zip_path
  if [ -n "$zip_arg" ]; then
    zip_path=$(resolve_path "$zip_arg")
    [ -f "$zip_path" ] || fail "--zip $zip_arg does not exist"
  else
    gh release download "v$ver" -p "$asset" --dir "$SCRATCH" >/dev/null 2>&1 || true
    zip_path="$SCRATCH/$asset"
    [ -f "$zip_path" ] || fail "release v$ver carries no $asset"
  fi

  # Source archive of the revision.
  local archive="$SCRATCH/notis-$ver.tar.gz"
  git archive --format=tar.gz --prefix="notis-$ver/" -o "$archive" "$revision"

  # REVIEWERS.md inside the archive: the two command lines verbatim and the
  # running pnpm's version.
  local extract="$SCRATCH/extract"
  mkdir -p "$extract"
  (cd "$extract" && tar -xzf "$archive")
  local archive_root="$extract/notis-$ver"
  [ -d "$archive_root" ] || fail "archive extraction produced no notis-$ver/"
  local reviewers="$archive_root/packages/web/extension/REVIEWERS.md"
  [ -f "$reviewers" ] || fail "$reviewers missing from the archive at $revision"
  local cmd1="pnpm install --frozen-lockfile --filter '@dagsocial/web...'"
  local cmd2="bash packages/web/scripts/build-extension.sh"
  grep -Fq -- "$cmd1" "$reviewers" \
    || fail "REVIEWERS.md inside the archive omits: $cmd1"
  grep -Fq -- "$cmd2" "$reviewers" \
    || fail "REVIEWERS.md inside the archive omits: $cmd2"
  local pnpm_ver
  pnpm_ver=$(pnpm --version)
  grep -Fq "pnpm@$pnpm_ver" "$reviewers" \
    || fail "REVIEWERS.md inside the archive does not name pnpm@$pnpm_ver"

  # Clean build from the archive: the two commands REVIEWERS.md names,
  # with the caller's build-time variables unset — VITE_NODES, VITE_FAUCET_BASE,
  # VITE_PUBLIC, VITE_PUBLIC_ORIGIN and NOTIS_EXTENSION_KEY.
  echo "==> Clean build from $archive_root"
  (
    cd "$archive_root"
    unset VITE_NODES VITE_FAUCET_BASE VITE_PUBLIC VITE_PUBLIC_ORIGIN NOTIS_EXTENSION_KEY
    pnpm install --frozen-lockfile --filter '@dagsocial/web...'
    bash packages/web/scripts/build-extension.sh
  )
  local built_zip="$archive_root/$asset"
  [ -f "$built_zip" ] || fail "clean build produced no $asset"

  # Compare contents — three builds of one tree gave three zip hashes with
  # identical contents. Extract both and diff -r.
  local zip_contents="$SCRATCH/release_contents"
  local built_contents="$SCRATCH/built_contents"
  mkdir -p "$zip_contents" "$built_contents"
  (cd "$zip_contents" && unzip -q "$zip_path")
  (cd "$built_contents" && unzip -q "$built_zip")
  if ! diff -r "$zip_contents" "$built_contents" > "$SCRATCH/diff.out"; then
    echo "FAIL: release $asset contents differ from the clean build:" >&2
    cat "$SCRATCH/diff.out" >&2
    exit 1
  fi

  # Manifest inside the release zip.
  local mf="$zip_contents/manifest.json"
  [ -f "$mf" ] || fail "$asset has no manifest.json"
  local zip_ver
  zip_ver=$(read_manifest_version "$mf")
  [ "$zip_ver" = "$ver" ] || fail "$asset manifest.json version $zip_ver != $ver"
  local gecko id update_url
  gecko=$(read_gecko "$mf") \
    || fail "$asset manifest.json has no acceptable gecko block"
  id=$(printf '%s' "$gecko" | sed -n '1p')
  update_url=$(printf '%s' "$gecko" | sed -n '3p')

  # Keys file — mode, keys defined non-empty; each failure its own refusal.
  local keys_file="${NOTIS_AMO_ENV:-$HOME/.config/dagsocial/amo.env}"
  keys_file=$(resolve_path "$keys_file")
  [ -f "$keys_file" ] || fail "keys file $keys_file does not exist"
  local mode
  mode=$(stat -c %a "$keys_file")
  [ "$mode" = "600" ] || fail "keys file $keys_file mode $mode, expected 600"
  # shellcheck disable=SC1090
  if ! ( . "$keys_file"; [ -n "${WEB_EXT_API_KEY:-}" ] ) >/dev/null 2>&1; then
    fail "keys file $keys_file defines no WEB_EXT_API_KEY"
  fi
  # shellcheck disable=SC1090
  if ! ( . "$keys_file"; [ -n "${WEB_EXT_API_SECRET:-}" ] ) >/dev/null 2>&1; then
    fail "keys file $keys_file defines no WEB_EXT_API_SECRET"
  fi

  # Approval notes — a few plain sentences read by the reviewer.
  local owner repo pair
  pair=$(read_repo "$update_url")
  owner=$(printf '%s' "$pair" | sed -n '1p')
  repo=$(printf '%s' "$pair" | sed -n '2p')
  local approval_notes
  approval_notes="No account is needed. Open the extension's page from its toolbar button, \
create an identity in the profile window, press \"ask the faucet\" for testnet rep and \$NOTIS, \
and post from \"new post\". The secret key stays in the background script and is never \
transmitted. The one content script runs on https://notis.fun/web/p/* and passes a post id to \
the background. The source is git archive of tag v$ver of https://github.com/$owner/$repo, \
built per packages/web/extension/REVIEWERS.md."

  if [ "$dry_run" -eq 1 ]; then
    local file_count archive_size
    file_count=$(find "$zip_contents" -type f | wc -l)
    archive_size=$(stat -c %s "$archive")
    echo "revision:     $revision"
    echo "file count:   $file_count"
    echo "archive size: $archive_size bytes"
    echo "add-on id:    $id"
    echo "update URL:   $update_url"
    echo "approval notes:"
    echo "$approval_notes"
    exit 0
  fi

  # Real submission. The AMO metadata JSON — reference reads the shape from
  # its update page; a first submission may refuse this shape, in which case
  # the developer hub takes the notes by hand (see this script's header).
  local metadata_file="$SCRATCH/amo-metadata.json"
  node -e "
    require('fs').writeFileSync(process.argv[1], JSON.stringify({ version: { approval_notes: process.argv[2] } }));
  " "$metadata_file" "$approval_notes"

  mkdir -p "$SCRATCH/signed"
  echo "==> web-ext sign (unlisted)"
  (
    # shellcheck disable=SC1090
    . "$keys_file"
    export WEB_EXT_API_KEY WEB_EXT_API_SECRET
    npx --yes -p "web-ext@${WEBEXT_MAJOR}" web-ext sign \
      --channel unlisted \
      --source-dir "$zip_contents" \
      --upload-source-code "$archive" \
      --amo-metadata "$metadata_file" \
      --artifacts-dir "$SCRATCH/signed"
  ) || true

  local signed_xpi
  signed_xpi=$(find "$SCRATCH/signed" -maxdepth 1 -type f -name '*.xpi' | head -1)
  if [ -z "$signed_xpi" ]; then
    cat >&2 <<EOF
no signed file came back; if addons.mozilla.org lists the version as awaiting
review, fetch the signed file from the developer hub and run \`entry $ver <file>\`
— never \`submit\` the same number twice.
EOF
    exit 3
  fi

  do_entry "$ver" "$signed_xpi" --zip "$zip_path"
}

# ---------------------------------------------------------------------------
# entry
# ---------------------------------------------------------------------------

do_entry() {
  local ver="${1:-}" xpi="${2:-}"
  { [ -n "$ver" ] && [ -n "$xpi" ]; } || usage
  shift 2
  local zip_arg="" into=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --zip) [ -n "${2:-}" ] || usage; zip_arg="$2"; shift 2 ;;
      --into) [ -n "${2:-}" ] || usage; into="$2"; shift 2 ;;
      *) usage ;;
    esac
  done

  require_tools git gh node unzip diff sha256sum
  xpi=$(resolve_path "$xpi")
  [ -f "$xpi" ] || fail "xpi does not exist"
  [ -z "$into" ] || into=$(resolve_path "$into")

  local asset="notis-extension-$ver-firefox.zip"
  local zip_path
  if [ -n "$zip_arg" ]; then
    zip_path=$(resolve_path "$zip_arg")
    [ -f "$zip_path" ] || fail "--zip $zip_arg does not exist"
    echo "==> comparing against the local zip $zip_arg (no gh release download)"
  else
    gh release download "v$ver" -p "$asset" --dir "$SCRATCH" >/dev/null 2>&1 || true
    zip_path="$SCRATCH/$asset"
    [ -f "$zip_path" ] || fail "release v$ver carries no $asset"
  fi

  # Extract xpi and zip into fresh dirs.
  local xpi_dir="$SCRATCH/entry_xpi"
  local zip_dir="$SCRATCH/entry_zip"
  rm -rf "$xpi_dir" "$zip_dir"
  mkdir -p "$xpi_dir" "$zip_dir"
  (cd "$xpi_dir" && unzip -q "$xpi")
  (cd "$zip_dir" && unzip -q "$zip_path")

  # xpi's manifest.json version matches <ver>.
  local xpi_mf="$xpi_dir/manifest.json"
  [ -f "$xpi_mf" ] || fail "$xpi has no manifest.json"
  local xpi_ver
  xpi_ver=$(read_manifest_version "$xpi_mf")
  [ "$xpi_ver" = "$ver" ] || fail "$xpi manifest.json version $xpi_ver != $ver"

  # Compare after copying the xpi contents into a scratch dir with the
  # top-level META-INF/ removed — an exact exclusion, unlike `diff -x` which
  # matches any depth (the extension has no nested META-INF today, and this
  # is the ceiling).
  local xpi_cmp="$SCRATCH/entry_xpi_cmp"
  rm -rf "$xpi_cmp"
  mkdir -p "$xpi_cmp"
  (
    shopt -s dotglob nullglob
    cd "$xpi_dir"
    for entry_name in *; do
      [ "$entry_name" = "META-INF" ] && continue
      cp -a "$entry_name" "$xpi_cmp/"
    done
  )
  if ! diff -r "$xpi_cmp" "$zip_dir" > "$SCRATCH/entry_diff.out"; then
    echo "FAIL: xpi contents outside META-INF/ differ from $asset:" >&2
    cat "$SCRATCH/entry_diff.out" >&2
    exit 1
  fi

  # xpi's sha256 — the target file's guard.
  local xpi_sha
  xpi_sha=$(sha256sum "$xpi" | awk '{print $1}')
  local target="$REPO_ROOT/notis-extension-$ver-firefox.xpi"
  if [ -e "$target" ]; then
    local target_sha
    target_sha=$(sha256sum "$target" | awk '{print $1}')
    [ "$target_sha" = "$xpi_sha" ] \
      || fail "$target exists and differs from $xpi (sha256 $target_sha vs $xpi_sha)"
  else
    cp "$xpi" "$target"
  fi

  # Print sha256 and entryFor's entry.
  local entry_json
  entry_json=$(node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    const g = m.browser_specific_settings.gecko;
    const sha = process.argv[3];
    import(process.argv[2]).then(u => {
      const r = u.repoFromUpdateUrl(g.update_url);
      const e = u.entryFor({ version: m.version, sha256Hex: sha, minVersion: g.strict_min_version, owner: r.owner, repo: r.repo });
      process.stdout.write(JSON.stringify(e, null, 2));
    }).catch(e => { console.error(e.message); process.exit(1); });
  " "$xpi_mf" "$UPDATE_MJS" "$xpi_sha")
  echo "sha256:  $xpi_sha"
  echo "entry:"
  echo "$entry_json"

  # --into rewrites the file through appendEntry.
  if [ -n "$into" ]; then
    [ -f "$into" ] || fail "--into $into does not exist"
    local id_line
    id_line=$(node -p "JSON.parse(require('fs').readFileSync('$xpi_mf','utf8')).browser_specific_settings.gecko.id")
    node -e "
      const fs = require('fs');
      const text = fs.readFileSync(process.argv[1],'utf8');
      const entry = JSON.parse(process.argv[2]);
      const id = process.argv[3];
      const out = process.argv[4];
      import(process.argv[5]).then(u => {
        const next = u.appendEntry(text, id, entry);
        fs.writeFileSync(out, next);
      }).catch(e => { console.error(e.message); process.exit(1); });
    " "$into" "$entry_json" "$id_line" "$into" "$UPDATE_MJS" \
      || fail "appendEntry refused the entry against $into"
    echo "==> $into updated"
  fi
}

# ---------------------------------------------------------------------------
# published
# ---------------------------------------------------------------------------

do_published() {
  local ver="${1:-}"
  [ -n "$ver" ] || usage
  shift
  local xpi=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --xpi) [ -n "${2:-}" ] || usage; xpi="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  if [ -n "$xpi" ]; then
    xpi=$(resolve_path "$xpi")
  else
    xpi="$REPO_ROOT/notis-extension-$ver-firefox.xpi"
  fi
  [ -f "$xpi" ] || fail "xpi $xpi does not exist"

  require_tools node unzip sha256sum curl

  local xpi_dir="$SCRATCH/pub_xpi"
  rm -rf "$xpi_dir"
  mkdir -p "$xpi_dir"
  (cd "$xpi_dir" && unzip -q "$xpi")
  local xpi_mf="$xpi_dir/manifest.json"
  [ -f "$xpi_mf" ] || fail "$xpi has no manifest.json"

  local gecko id update_url
  gecko=$(read_gecko "$xpi_mf") \
    || fail "$xpi has no acceptable gecko block"
  id=$(printf '%s' "$gecko" | sed -n '1p')
  update_url=$(printf '%s' "$gecko" | sed -n '3p')

  # Fetch the update manifest. raw.githubusercontent.com caches for 300 s,
  # so a 404 on a just-pushed manifest may clear on retry.
  local mf_file="$SCRATCH/pub_updates.json"
  local status
  status=$(curl -sSL -o "$mf_file" -w '%{http_code}' "$update_url" || true)
  [ "$status" != "404" ] \
    || fail "update manifest $update_url answers 404 (raw.githubusercontent.com caches for 300 s)"
  [ "$status" = "200" ] \
    || fail "update manifest $update_url answers $status"

  # checkManifest returns the entry.
  local entry_json
  entry_json=$(node -e "
    const fs = require('fs');
    const text = fs.readFileSync(process.argv[1],'utf8');
    const id = process.argv[2];
    const ver = process.argv[3];
    const url = process.argv[4];
    import(process.argv[5]).then(u => {
      const r = u.repoFromUpdateUrl(url);
      const e = u.checkManifest(text, { id, version: ver, owner: r.owner, repo: r.repo });
      process.stdout.write(JSON.stringify(e));
    }).catch(e => { console.error(e.message); process.exit(1); });
  " "$mf_file" "$id" "$ver" "$update_url" "$UPDATE_MJS") \
    || fail "checkManifest refused the manifest at $update_url"

  local update_link update_hash
  update_link=$(printf '%s' "$entry_json" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).update_link")
  update_hash=$(printf '%s' "$entry_json" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).update_hash")

  # Download update_link — 200, application/x-xpinstall.
  local dl="$SCRATCH/pub_download.xpi"
  local dl_meta dl_status dl_ct
  dl_meta=$(curl -sSL -o "$dl" -w '%{http_code}|%{content_type}' "$update_link" || true)
  dl_status="${dl_meta%%|*}"
  dl_ct="${dl_meta#*|}"
  [ "$dl_status" = "200" ] \
    || fail "update_link $update_link answers $dl_status"
  case "$dl_ct" in
    application/x-xpinstall*) ;;
    *) fail "update_link content-type $dl_ct, expected application/x-xpinstall" ;;
  esac

  # sha256(body) == update_hash == sha256(local xpi).
  local body_sha local_sha
  body_sha=$(sha256sum "$dl" | awk '{print $1}')
  local_sha=$(sha256sum "$xpi" | awk '{print $1}')
  [ "sha256:$body_sha" = "$update_hash" ] \
    || fail "downloaded body sha256:$body_sha != update_hash $update_hash"
  [ "$body_sha" = "$local_sha" ] \
    || fail "downloaded body sha256 $body_sha != local xpi sha256 $local_sha"

  echo "update_link: $update_link"
  echo "sha256:      $body_sha"
  echo "OK"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

CMD="${1:-}"
[ -n "$CMD" ] || usage
shift
case "$CMD" in
  submit) do_submit "$@" ;;
  entry) do_entry "$@" ;;
  published) do_published "$@" ;;
  *) usage ;;
esac
