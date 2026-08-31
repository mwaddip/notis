#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-tarball.sh — package the node as a zero-dependency linux-x64 tarball:
# the built app, a production node_modules (linux-x64 better-sqlite3 prebuild),
# and a bundled Node runtime, with run.sh (server) and run-miner.sh (miner)
# launchers defaulting to testnet. No system Node required to run it.
#
# Requires (build host): node (>=22), pnpm, rsync, curl, tar.
# Output: notis-node-<version>-linux-x64.tar.gz in the repo root.
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./package.json').version")
NODE_VER="v$(node -p 'process.versions.node')"   # bundle the runtime we build with
PKG="notis-node-${VERSION}-linux-x64"
STAGE=$(mktemp -d)
APP="$STAGE/$PKG"
mkdir -p "$APP/bin"

echo "==> Building $PKG.tar.gz (Node $NODE_VER)"
pnpm build

# ---------------------------------------------------------------------------
# 1. App tree + production node_modules (mirrors build-deb.sh)
# ---------------------------------------------------------------------------
echo "==> Assembling app tree"
rsync -a \
  --exclude '.git' --exclude '.github' --exclude '.claude' \
  --exclude 'node_modules' --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' \
  --exclude '*.deb' --exclude '*.tar.gz' --exclude 'prompts' --exclude 'tmp' \
  --exclude 'CLAUDE.md' --exclude 'SETTINGS.md' --exclude 'SESSION_CONTEXT.md' \
  --exclude 'dagsocial.md' --exclude 'HOW_IT_WORKS.md' --exclude 'AUDIT-*.md' \
  --exclude 'docs' \
  --exclude '.env' --exclude '.env.*' --exclude '*.key' --exclude '*.pem' --exclude '*.der' \
  "$REPO_ROOT/" "$APP/app/"

echo "==> Installing production dependencies"
(
  cd "$APP/app"
  pnpm approve-builds better-sqlite3 cbor-extract esbuild 2>&1 | tail -3 || true
  pnpm install --prod --frozen-lockfile 2>&1 | tail -5
)

for d in types validation wire net node; do
  [ -d "$APP/app/packages/$d/dist" ] || { echo "  ✗ packages/$d missing dist/ — build failed"; exit 1; }
done
[ -d "$APP/app/tools/faucet/dist" ] || echo "  (note: tools/faucet dist absent — not needed by the node)"

# ---------------------------------------------------------------------------
# 2. Bundle the official Node linux-x64 runtime
# ---------------------------------------------------------------------------
echo "==> Downloading Node $NODE_VER runtime"
curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz" | tar -xJ -C "$STAGE"
cp "$STAGE/node-${NODE_VER}-linux-x64/bin/node" "$APP/bin/node"
chmod +x "$APP/bin/node"

# ---------------------------------------------------------------------------
# 3. Launchers
# ---------------------------------------------------------------------------
cat > "$APP/run.sh" <<'RUNEOF'
#!/usr/bin/env bash
# Notis testnet node (server). No system Node needed.
cd "$(dirname "$0")"
export NETWORK_TYPE=testnet PORT=3000 FAUCET_URL=https://notis.fun/testnet/faucet
export DB_PATH="./data/notis.db"; mkdir -p ./data
exec ./bin/node ./app/packages/node/dist/index.js
RUNEOF

cat > "$APP/run-miner.sh" <<'MINEREOF'
#!/usr/bin/env bash
# Notis testnet node + miner loop. Ctrl-C / close to stop mining.
cd "$(dirname "$0")"
export NETWORK_TYPE=testnet PORT=3000 FAUCET_URL=https://notis.fun/testnet/faucet
export DB_PATH="./data/notis.db"; mkdir -p ./data
./bin/node ./app/packages/node/scripts/gen-miner-key.mjs ./data/miner-key.json
export MINER_PUBKEY="$(./bin/node -e "console.log(require(process.cwd()+'/data/miner-key.json').publicKey)")"
export MINING_SECRET="$(./bin/node -e "console.log(require('crypto').randomUUID())")"
export NODE_ROLE=miner MINER_PCT="${MINER_PCT:-25}"
./bin/node ./app/packages/node/dist/index.js &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null || true' EXIT
sleep 2
NODE_URL=http://localhost:3000 ./bin/node ./app/packages/node/scripts/miner.mjs
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
