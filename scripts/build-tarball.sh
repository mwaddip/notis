#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-tarball.sh — package the node as a linux-x64 tarball for a host with
# Node ≥ 24 on PATH: the bundled app under app/, run.sh (server) and
# run-miner.sh (miner) launchers that default to testnet. No faucet rides.
#
# Requires (build host): node (>=24), pnpm, tar.
# Output: notis-node-<version>-linux-x64.tar.gz in the repo root.
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./package.json').version")
PKG="notis-node-${VERSION}-linux-x64"
STAGE=$(mktemp -d)
APP="$STAGE/$PKG"
mkdir -p "$APP"

echo "==> Building $PKG.tar.gz"

# ---------------------------------------------------------------------------
# 1. Build all workspace packages
# ---------------------------------------------------------------------------
pnpm build

# ---------------------------------------------------------------------------
# 2. Bundle the node and miner-consolidate into $APP/app (no faucet)
#    (NODE_INTERFACE → "The packages carry the node as one bundle, beside
#    the native modules it loads.").
# ---------------------------------------------------------------------------
node "$REPO_ROOT/scripts/bundle-node.mjs" --out "$APP/app"

# ---------------------------------------------------------------------------
# 3. Launchers — the system's node on PATH, Node ≥ 24 (NODE_INTERFACE →
#    "The .deb and the tarball run the system's Node; the Windows installer
#    carries its own.").
# ---------------------------------------------------------------------------
cat > "$APP/run.sh" <<'RUNEOF'
#!/usr/bin/env bash
# Notis testnet node (server). Needs Node ≥ 24 on PATH.
set -e
cd "$(dirname "$0")"
VER=$(node -p 'process.versions.node' 2>/dev/null || true)
MAJOR=${VER%%.*}
if [ -z "$VER" ] || [ "$MAJOR" -lt 24 ] 2>/dev/null; then
  echo "run.sh: Node ≥ 24 required on PATH; found '${VER:-none}'." >&2
  exit 1
fi
export NETWORK_TYPE=testnet PORT=3000
export DB_PATH="./data/notis.db"; mkdir -p ./data
exec node ./app/dist/node.js
RUNEOF

cat > "$APP/run-miner.sh" <<'MINEREOF'
#!/usr/bin/env bash
# Notis testnet node + miner loop. Needs Node ≥ 24 on PATH.
set -e
cd "$(dirname "$0")"
VER=$(node -p 'process.versions.node' 2>/dev/null || true)
MAJOR=${VER%%.*}
if [ -z "$VER" ] || [ "$MAJOR" -lt 24 ] 2>/dev/null; then
  echo "run-miner.sh: Node ≥ 24 required on PATH; found '${VER:-none}'." >&2
  exit 1
fi
export NETWORK_TYPE=testnet PORT=3000
export DB_PATH="./data/notis.db"; mkdir -p ./data
# MINING_INTERFACE → Consolidation — the key file is the one source the miner
# reads; `gen-miner-key.mjs` writes it where `MINER_KEY_PATH` names.
node ./app/scripts/gen-miner-key.mjs ./data/miner-key.json > /dev/null
export MINER_KEY_PATH="./data/miner-key.json"
export MINING_SECRET="$(node -e "console.log(require('crypto').randomUUID())")"
export NODE_ROLE=miner MINER_PCT="${MINER_PCT:-25}"
node ./app/dist/node.js &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null || true' EXIT
sleep 2
NODE_URL=http://localhost:3000 node ./app/scripts/miner.mjs
MINEREOF

chmod +x "$APP/run.sh" "$APP/run-miner.sh"

# ---------------------------------------------------------------------------
# 4. Tar
# ---------------------------------------------------------------------------
echo "==> Creating tarball"
tar -czf "$REPO_ROOT/$PKG.tar.gz" -C "$STAGE" "$PKG"
rm -rf "$STAGE"
echo "==> Done: $PKG.tar.gz"
du -h "$REPO_ROOT/$PKG.tar.gz"
