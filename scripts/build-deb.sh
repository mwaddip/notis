#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# build-deb.sh — package dagsocial-node as a .deb
#
# Requires: node (>=22), pnpm, dpkg-deb, rsync
# Output:   dagsocial-node_<version>_amd64.deb in the repo root
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(node -p "require('./package.json').version")
PKG="dagsocial-node"
DEB="${PKG}_${VERSION}_amd64.deb"
STAGING=$(mktemp -d)
APP_DIR="$STAGING/opt/dagsocial"

echo "==> Building $DEB"

# ---------------------------------------------------------------------------
# 1. Build all workspace packages
# ---------------------------------------------------------------------------
echo "==> Building workspace packages..."
pnpm build

# ---------------------------------------------------------------------------
# 2. Create staging directory tree
# ---------------------------------------------------------------------------
echo "==> Assembling staging tree in $STAGING"
mkdir -p "$APP_DIR"
mkdir -p "$STAGING/etc/dagsocial"
mkdir -p "$STAGING/usr/lib/systemd/system"
mkdir -p "$STAGING/DEBIAN"

# ---------------------------------------------------------------------------
# 3. Copy project files (exclude git, node_modules, temp files)
# ---------------------------------------------------------------------------
rsync -a \
  --exclude '.git' \
  --exclude '.github' \
  --exclude '.claude' \
  --exclude 'node_modules' \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  --exclude '*.deb' \
  --exclude 'prompts' \
  --exclude 'tmp' \
  --exclude 'CLAUDE.md' \
  --exclude 'SESSION_CONTEXT.md' \
  `# SETTINGS.md is the machine-local workflow file, excluded from git via .git/info/exclude` \
  --exclude 'SETTINGS.md' \
  --exclude 'dagsocial.md' \
  --exclude 'HOW_IT_WORKS.md' \
  --exclude 'AUDIT-*.md' \
  --exclude 'scripts/build-deb.sh' \
  `# The daemon needs none of docs/, and rsync copies the WORKING TREE — so a` \
  `# git-excluded file is not an excluded file here. docs/ holds the local-only` \
  `# governance notes (.git/info/exclude) and docs/specs/ (.gitignore); both` \
  `# would otherwise ship in a package headed for a public host.` \
  --exclude 'docs' \
  "$REPO_ROOT/" "$APP_DIR/"

# ---------------------------------------------------------------------------
# 4. Install production dependencies only
# ---------------------------------------------------------------------------
echo "==> Installing production dependencies..."
cd "$APP_DIR"
# Approve native module builds (pnpm v11 gate, harmless on v10)
pnpm approve-builds better-sqlite3 cbor-extract esbuild 2>&1 | tail -3 || true
pnpm install --prod --frozen-lockfile 2>&1 | tail -5

# pnpm workspaces link local packages via symlinks — ensure they resolve.
# The rsync above copies the working tree, so a dist/ present here is one the
# build produced; this loop is what turns a missing one into a failed package
# rather than a daemon that will not start.
for pkg in types validation wire net node; do
  if [ -d "$APP_DIR/packages/$pkg/dist" ]; then
    echo "  ✓ packages/$pkg"
  else
    echo "  ✗ packages/$pkg missing dist/ — build may have failed"
    exit 1
  fi
done

# Named separately because the loop above is keyed on packages/$pkg and the
# faucet lives under tools/. This is the only build-time signal that its dist
# exists: without it a faucet that failed to build still ships, and the first
# sign is a systemd unit pointing at a file that is not there.
if [ -d "$APP_DIR/tools/faucet/dist" ]; then
  echo "  ✓ tools/faucet"
else
  echo "  ✗ tools/faucet missing dist/ — build may have failed"
  exit 1
fi

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 5. Systemd unit
# ---------------------------------------------------------------------------
cp "$REPO_ROOT/packages/node/scripts/dagsocial-node.service" \
   "$STAGING/usr/lib/systemd/system/dagsocial-node.service"
cp "$REPO_ROOT/tools/faucet/scripts/dagsocial-faucet.service" \
   "$STAGING/usr/lib/systemd/system/dagsocial-faucet.service"

# ---------------------------------------------------------------------------
# 6. Default environment file
# ---------------------------------------------------------------------------
cat > "$STAGING/etc/dagsocial/node.env" <<'ENVEOF'
# DAGsocial node environment — edit after install
NODE_ROLE=server
MINING_SECRET=
PORT=3000
ADMIN_PORT=3001
ADMIN_BIND_ADDRESS=127.0.0.1
DB_PATH=/var/lib/dagsocial/dagsocial.db
# NETWORK_TYPE is the name config.ts reads. This said NETWORK_MODE until
# 2026-08-11, which nothing read — invisible only because the code default is
# also testnet, so any other value was silently ignored.
NETWORK_TYPE=testnet
LISTEN_ADDRS=/ip4/0.0.0.0/tcp/9733
# Set when serving behind an nginx path prefix, e.g. /testnet — the UI's API
# base and canonical post URLs are derived from it.
#PUBLIC_URL=/
ENVEOF

cat > "$STAGING/etc/dagsocial/faucet.env" <<'ENVEOF'
# Notis faucet environment — edit after install, then:
#   systemctl enable --now dagsocial-faucet
#
# The faucet holds an ordinary Ed25519 owner key and does what any member can
# do. No consensus rule names it.

# The node's API base, e.g. https://notis.fun/testnet/api
NODE_URL=http://127.0.0.1:3000
# Decides the invite bond range the service will accept at startup.
# Must match the node's NETWORK_TYPE.
NETWORK_TYPE=testnet

# The PKCS8 DER secret, hex-encoded, mode 0600. NOT SHIPPED — copy it here
# after install. The service refuses to start if the key does not derive
# FAUCET_PUBLIC_KEY below.
FAUCET_KEY_PATH=/etc/dagsocial/faucet.key
# The identity the key must derive, 64 lowercase hex. Stated rather than
# derived so it can be checked.
FAUCET_PUBLIC_KEY=

# The invite bond, and therefore the karma grant — they are equal. Must sit
# inside the network's [inviteBondMin, inviteBondMax].
FAUCET_BOND_AMOUNT=250
# Credits per /faucet/credits call, in base units (1 credit = 10^8).
FAUCET_CREDIT_AMOUNT=10000000000

# Beside the node's 3000, not colliding with it.
PORT=3100
# Requests per IP per hour, per endpoint.
RATE_LIMIT_PER_HOUR=5
ENVEOF

# ---------------------------------------------------------------------------
# 7. DEBIAN control files
# ---------------------------------------------------------------------------

# conffiles — dpkg preserves user edits to these on upgrade
cat > "$STAGING/DEBIAN/conffiles" <<'CONFFILES'
/etc/dagsocial/node.env
/etc/dagsocial/faucet.env
CONFFILES

# control
cat > "$STAGING/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: net
Priority: optional
Architecture: amd64
Depends: nodejs (>= 22)
Maintainer: DAGsocial
Description: DAGsocial node — decentralized social network
 DAGsocial is a decentralized social network with a prunable content DAG
 and a UTXO-based karma/credit ledger. This package provides the node
 daemon (Express API, libp2p networking, SQLite store, AVL+ state proofs)
 and the faucet service, which holds an ordinary owner key and invites.
EOF

# postinst
cat > "$STAGING/DEBIAN/postinst" <<'POSTINST'
#!/bin/bash
set -e

# Create data directory
mkdir -p /var/lib/dagsocial
chown -R root:root /var/lib/dagsocial

# Enable and start the service if this is an install (not upgrade)
if [ "$1" = "configure" ] && [ -z "${2:-}" ]; then
  systemctl daemon-reload
  systemctl enable dagsocial-node
  systemctl start dagsocial-node || true
  echo "dagsocial-node installed and started."
  echo "Edit /etc/dagsocial/node.env to configure, then: systemctl restart dagsocial-node"
  # The faucet is installed but not started: it needs a secret key this package
  # does not ship, and a service restarting against a missing key says nothing
  # useful in the journal.
  echo "The faucet is installed and stopped. Copy its key to"
  echo "/etc/dagsocial/faucet.key (mode 0600), fill in /etc/dagsocial/faucet.env,"
  echo "then: systemctl enable --now dagsocial-faucet"
elif [ "$1" = "configure" ] && [ -n "${2:-}" ]; then
  # Upgrade — restart the service to pick up the new binary
  systemctl daemon-reload
  systemctl try-restart dagsocial-node || true
  systemctl try-restart dagsocial-faucet || true
  echo "dagsocial-node upgraded and restarted."
fi

exit 0
POSTINST
chmod 755 "$STAGING/DEBIAN/postinst"

# prerm
cat > "$STAGING/DEBIAN/prerm" <<'PRERM'
#!/bin/bash
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  systemctl stop dagsocial-faucet 2>/dev/null || true
  systemctl disable dagsocial-faucet 2>/dev/null || true
  systemctl stop dagsocial-node 2>/dev/null || true
  systemctl disable dagsocial-node 2>/dev/null || true
fi
exit 0
PRERM
chmod 755 "$STAGING/DEBIAN/prerm"

# ---------------------------------------------------------------------------
# 8. Build the .deb
# ---------------------------------------------------------------------------
echo "==> Building .deb package..."
dpkg-deb --root-owner-group --build "$STAGING" "$REPO_ROOT/$DEB"

# ---------------------------------------------------------------------------
# 9. Cleanup
# ---------------------------------------------------------------------------
rm -rf "$STAGING"

echo "==> Done: $DEB"
du -h "$REPO_ROOT/$DEB"
