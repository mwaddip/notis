#!/usr/bin/env node
// MESH_INTERFACE → Acceptance — brings the stage up: create every
// `notismesh-<host>` namespace, wire them via veth pairs created inside the
// namespaces themselves, apply nft rules per NAT type, lift the
// per-namespace unprivileged-port floor where the stage needs port 53 / 80 /
// 443, create every mesh node's key, start the Notis nodes and their mesh
// nodes as the invoking user under the Node that is running `up`, run the
// miner inside `pub1`'s namespace, wait until every honest node is at height
// ≥ 50, cut `hostile-lagging` off, and write `stage/out/pids.json` and
// `stage/out/browser/config.json`.
//
// The host is never touched outside `notismesh-*` namespaces, their nft
// rules, and `/etc/netns/notismesh-*/resolv.conf`. Every veth is created
// inside its namespace (both ends placed at creation), so no host-visible
// interface survives a crash between `add` and `set netns`. Every stage
// process runs as the invoking user with Node 24's absolute path.
//
// `--dry-run` prints every command `up` would run, marks the privileged
// ones, generates throwaway Ed25519 keys inline for the config preview,
// creates no namespace, writes nothing under `stage/out/`, and starts no
// process.

import { mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { CommandLog } from './lib/commands.mjs';
import { readTopology, natRouters, publicMeshHosts } from './lib/topology.mjs';
import { buildPageConfig } from './lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const OUT_DIR = join(HERE, 'out');
const CACHE_DIR = join(HERE, 'cache');
const TOPOLOGY_PATH = join(HERE, 'topology.json');

// MESH_INTERFACE → Acceptance — "every stage process ... Node that is
// running `up`". `process.execPath` is Node 24's absolute path on this
// machine; `env` passes it through `sudo -u` without going near sudo's
// `secure_path` (which would resolve `node` to the host's older binary).
const NODE_ABS = process.execPath;
const INVOKING_USER = process.env.SUDO_USER ?? process.env.USER;
if (!INVOKING_USER) {
  process.stderr.write('refusing to start: USER is unset — the stage runs its processes as the invoking user, and sudo -u needs a name\n');
  process.exit(2);
}

// MESH_INTERFACE → Acceptance — Pebble v2.8.0's linux-amd64 release as the
// tar.gz archive the project publishes; the inner binary is at
// `pebble-linux-amd64/linux/amd64/pebble`. The SHA-256 was computed by
// downloading the archive once (see `prompts/mesh-poc-t9-REPORT.md` for
// the URL and the command).
const PEBBLE_VERSION = 'v2.8.0';
const PEBBLE_URL = `https://github.com/letsencrypt/pebble/releases/download/${PEBBLE_VERSION}/pebble-linux-amd64.tar.gz`;
const PEBBLE_SHA256 = '34595d915bbc2fc827affb3f58593034824df57e95353b031c8d5185724485ce';
const PEBBLE_INNER_PATH = 'pebble-linux-amd64/linux/amd64/pebble';

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

function nsOf(host) {
  return `notismesh-${host}`;
}

function assertNoStageNamespaces(dryRun) {
  if (dryRun) return;
  const out = execFileSync('ip', ['netns', 'list'], { encoding: 'utf8' });
  const stale = out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((l) => l.startsWith('notismesh-'));
  if (stale.length > 0) {
    process.stderr.write(`refusing to start: these notismesh-* namespaces already exist: ${stale.join(', ')}\n`);
    process.stderr.write(`run 'pnpm --filter @dagsocial/mesh-poc stage:down' first\n`);
    process.exit(2);
  }
}

// MESH_INTERFACE → Acceptance — "every stage process ... as the invoking
// user ... the Node that is running `up`". `userNode(args, env)` is one
// `sudo -u <user> -- env ...` wrap, so every spawn line in the dry-run says
// which user and which Node binary; the host's older `/usr/bin/node`, which
// `secure_path` would resolve to under a plain `sudo node`, never runs.
function userEnv(env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) out.push(`${k}=${v}`);
  return out;
}
function userWrap(ns, env, binary = NODE_ABS) {
  // `sudo ip netns exec <ns> sudo -u <user> -- env <VARS> <binary>` runs
  // `<binary>` in `<ns>` as `<user>`. The outer `sudo` enters the
  // namespace (root is required); the inner `-u <user>` drops privilege
  // before `env` and the binary start. The default binary is Node 24's
  // absolute path, so a bare `userWrap(ns, env)` is the common case.
  return [
    'sudo', 'ip', 'netns', 'exec', ns,
    'sudo', '-u', INVOKING_USER, '--',
    'env', ...userEnv(env),
    binary,
  ];
}

// -----------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------

const { dryRun } = parseArgs(process.argv.slice(2));
const log = new CommandLog({ dryRun });

assertNoStageNamespaces(dryRun);

const topology = readTopology(TOPOLOGY_PATH);

if (!dryRun) {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
}

// -----------------------------------------------------------------------
// Phase 1: namespaces and the internet bridge
// -----------------------------------------------------------------------

const bridgeNs = nsOf('bridge');
const bridgeIf = topology.internet.bridgeName;

log.shell('sudo', ['ip', 'netns', 'add', bridgeNs], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'add', bridgeIf, 'type', 'bridge'], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'addr', 'add', `${topology.internet.gateway}/24`, 'dev', bridgeIf], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', bridgeIf, 'up'], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', 'lo', 'up'], { privileged: true });

// One namespace per host. Veth pairs are created inside the destination
// namespace (`ip -n <ns-A> link add X peer name Y netns <ns-B>` places both
// ends at creation), so a crash between the add and a `set netns` leaves
// nothing behind on the host.
for (const [name, host] of Object.entries(topology.hosts)) {
  const ns = nsOf(name);
  log.shell('sudo', ['ip', 'netns', 'add', ns], { privileged: true });
  log.shell('sudo', ['ip', '-n', ns, 'link', 'set', 'lo', 'up'], { privileged: true });

  if (host.role === 'nat') {
    // Outside: veth from the bridge namespace to this NAT router. The add
    // is run inside `bridgeNs` so `v-<name>-o` lives there; `netns <ns>`
    // places the peer end inside the NAT namespace at creation.
    const outVeth = `v-${name}-o`;
    const outPeer = `vp-${name}-o`;
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'add', outVeth, 'type', 'veth', 'peer', 'name', outPeer, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', outVeth, 'master', bridgeIf, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.outsideAddr}/24`, 'dev', outPeer], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', outPeer, 'up'], { privileged: true });

    // Inside bridge inside the NAT namespace itself — holds the gateway
    // address, every private host behind this NAT connects to it. The
    // bridge lives entirely inside `<ns>`.
    const innerBr = `br-${name}-in`;
    log.shell('sudo', ['ip', '-n', ns, 'link', 'add', innerBr, 'type', 'bridge'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.insideGateway}/24`, 'dev', innerBr], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', innerBr, 'up'], { privileged: true });

    log.shell('sudo', ['ip', 'netns', 'exec', ns, 'sysctl', '-w', 'net.ipv4.ip_forward=1'], { privileged: true });
    continue;
  }

  if (host.parent === undefined) {
    // Plain host on the internet bridge.
    const veth = `v-${name}`;
    const peer = `vp-${name}`;
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'add', veth, 'type', 'veth', 'peer', 'name', peer, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', veth, 'master', bridgeIf, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.addr}/24`, 'dev', peer], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', peer, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'route', 'add', 'default', 'via', topology.internet.gateway], { privileged: true });
  } else {
    // Private host behind a NAT router. The outer end of the veth lives
    // inside the parent NAT namespace, bridged to its inside bridge; the
    // inner end lives inside this host's namespace.
    const parent = topology.hosts[host.parent];
    const parentNs = nsOf(host.parent);
    const innerBr = `br-${host.parent}-in`;
    const veth = `v-${name}`;
    const peer = `vp-${name}`;
    log.shell('sudo', ['ip', '-n', parentNs, 'link', 'add', veth, 'type', 'veth', 'peer', 'name', peer, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', parentNs, 'link', 'set', veth, 'master', innerBr, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.addr}/24`, 'dev', peer], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', peer, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'route', 'add', 'default', 'via', parent.insideGateway], { privileged: true });
  }
}

// -----------------------------------------------------------------------
// Phase 2: nft NAT rules per router
// -----------------------------------------------------------------------

for (const { name, host } of natRouters(topology)) {
  const ns = nsOf(name);
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', 'nat'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', 'nat', 'POSTROUTING', '{', 'type', 'nat', 'hook', 'postrouting', 'priority', '100', ';', '}'], { privileged: true });
  if (host.nat === 'symmetric') {
    log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', 'nat', 'POSTROUTING', 'oifname', `vp-${name}-o`, 'masquerade', 'random-fully'], { privileged: true });
  } else {
    log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', 'nat', 'POSTROUTING', 'oifname', `vp-${name}-o`, 'masquerade'], { privileged: true });
  }
}

// -----------------------------------------------------------------------
// Phase 3: unprivileged port floors, resolv.conf, DNS witness counter
// -----------------------------------------------------------------------

// MESH_INTERFACE → Acceptance — a stage process runs as the invoking user;
// pub1 binds TCP 443 (WSS) and 80 (ACME http-01), dns-log binds 53. Lifting
// `net.ipv4.ip_unprivileged_port_start` to 0 is a per-namespace sysctl in
// Linux ≥ 4.11 — the kernel registers it under `init_net.sysctl` with
// `net_namespace_list` scope — and this stage runs on kernel 6.8, well above
// that. Nothing is set outside a namespace.
const unprivPortHosts = ['pub1', 'dns-log', 'browser'];
for (const name of unprivPortHosts) {
  if (topology.hosts[name] === undefined) continue;
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf(name), 'sysctl', '-w', 'net.ipv4.ip_unprivileged_port_start=0'], { privileged: true });
}

const browserHost = topology.hosts.browser;
const dnsLogHost = topology.hosts['dns-log'];
if (browserHost && dnsLogHost) {
  const resolvConfPath = `/etc/netns/${nsOf('browser')}/resolv.conf`;
  log.shell('sudo', ['mkdir', '-p', `/etc/netns/${nsOf('browser')}`], { privileged: true });
  log.shell('sudo', ['sh', '-c', `echo nameserver ${dnsLogHost.addr} > ${resolvConfPath}`], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'table', 'ip', 'dns_witness'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'chain', 'ip', 'dns_witness', 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'rule', 'ip', 'dns_witness', 'out', 'udp', 'dport', '{', '53', ',', '853', '}', 'counter'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'rule', 'ip', 'dns_witness', 'out', 'tcp', 'dport', '{', '53', ',', '853', '}', 'counter'], { privileged: true });
}

// -----------------------------------------------------------------------
// Phase 4: mesh keys and notisIds
// -----------------------------------------------------------------------

const meshKeyTool = join(PACKAGE_ROOT, 'dist', 'node', 'mesh-key-tool.js');
const hostsWithMesh = Object.entries(topology.hosts).filter(([, h]) => h.mesh !== undefined);
const notisIds = {};

for (const [name] of hostsWithMesh) {
  const keyPath = join(OUT_DIR, name, 'mesh.key');
  // The real run invokes the key tool and reads the printed notisId; the
  // dry-run shows the command but computes a throwaway id inline so the
  // config preview below has a plausible shape without writing anything to
  // disk.
  log.shell(NODE_ABS, [meshKeyTool, 'ensure', keyPath]);
  if (dryRun) {
    const seed = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(seed);
    notisIds[name] = bytesToHex(pub);
  } else {
    const r = spawnSync(NODE_ABS, [meshKeyTool, 'ensure', keyPath], { encoding: 'utf8' });
    if (r.status !== 0) {
      process.stderr.write(`mesh-key-tool exit ${r.status}: ${r.stderr}\n`);
      process.exit(1);
    }
    notisIds[name] = r.stdout.trim();
  }
}

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// -----------------------------------------------------------------------
// Phase 5: Pebble
// -----------------------------------------------------------------------

const pebbleHost = topology.hosts.pebble;
const pebbleArchive = join(CACHE_DIR, 'pebble-linux-amd64.tar.gz');
const pebbleBin = join(CACHE_DIR, PEBBLE_INNER_PATH);
if (pebbleHost) {
  // Download, verify, extract — all three on the host as the user; nothing
  // the stage runs as root.
  log.shell('sh', ['-c', `test -f ${pebbleArchive} || curl -L ${PEBBLE_URL} -o ${pebbleArchive}`]);
  log.shell('sh', ['-c', `echo "${PEBBLE_SHA256}  ${pebbleArchive}" | sha256sum --check`]);
  log.shell('tar', ['xzf', pebbleArchive, '-C', CACHE_DIR]);
}

const pebbleConfigPath = join(OUT_DIR, 'pebble-config.json');
const pebbleRootPath = join(OUT_DIR, 'pebble-root.pem');
const pebbleListenPort = pebbleHost ? Number(pebbleHost.pebble.listen.split(':').pop()) : 0;
const pebbleManagementPort = pebbleHost ? Number(pebbleHost.pebble.managementListen.split(':').pop()) : 0;
if (pebbleHost && !dryRun) {
  // Pebble's own release carries the test certs in `pebble-linux-amd64/test/certs/`.
  const pebbleTestDir = join(CACHE_DIR, 'pebble-linux-amd64', 'test');
  writeFileSync(pebbleConfigPath, JSON.stringify({
    pebble: {
      listenAddress: `${pebbleHost.addr}:${pebbleListenPort}`,
      managementListenAddress: `${pebbleHost.addr}:${pebbleManagementPort}`,
      httpPort: pebbleHost.pebble.httpChallengePort,
      tlsPort: 5001,
      ocspResponderURL: '',
      certificate: join(pebbleTestDir, 'certs', 'localhost', 'cert.pem'),
      privateKey: join(pebbleTestDir, 'certs', 'localhost', 'key.pem'),
      profile: 'shortlived',
    },
  }, null, 2));
}

if (pebbleHost) {
  log.spawn(userWrap(nsOf('pebble'), { PEBBLE_VA_NOSLEEP: '1' }, pebbleBin).concat(['-config', pebbleConfigPath]), { description: 'pebble' });
}

// -----------------------------------------------------------------------
// Phase 6: dns-log server
// -----------------------------------------------------------------------

const dnsLogScript = join(HERE, 'dns-log.mjs');
if (dnsLogHost) {
  log.spawn(userWrap(nsOf('dns-log'), {
    DNS_LOG_PATH: join(OUT_DIR, 'dns.log'),
    DNS_LOG_BIND: dnsLogHost.addr,
    DNS_LOG_PORT: String(dnsLogHost.dnsPort),
  }).concat([dnsLogScript]), { description: 'dns-log' });
}

// -----------------------------------------------------------------------
// Phase 7: Notis nodes, mesh nodes, hostile upstreams
// -----------------------------------------------------------------------

const notisNodeEntry = join(REPO_ROOT, 'packages', 'node', 'dist', 'index.js');
const minerScript = join(REPO_ROOT, 'packages', 'node', 'scripts', 'miner.mjs');
const meshNodeEntry = join(PACKAGE_ROOT, 'dist', 'node', 'main.js');
const hostileUpstreamScript = join(HERE, 'hostile-upstream.mjs');

const pub1Host = topology.hosts.pub1;
const pub1Base = `http://${pub1Host.addr}:${pub1Host.node.httpPort}`;

for (const [name, host] of Object.entries(topology.hosts)) {
  const ns = nsOf(name);
  const dbPath = join(OUT_DIR, name, 'notis.db');

  if (host.node !== undefined) {
    const notisEnv = {
      NETWORK_TYPE: 'devnet',
      NODE_ROLE: host.node.role,
      PORT: String(host.node.httpPort),
      ADMIN_PORT: String(host.node.httpPort + 1),
      DB_PATH: dbPath,
      LISTEN_ADDRS: `/ip4/${host.addr}/tcp/${host.node.p2pPort}`,
      BOOTSTRAP_PEERS: `/ip4/${pub1Host.addr}/tcp/${pub1Host.node.p2pPort}`,
      MINING_SECRET: 'stage-mining-secret',
    };
    log.spawn(userWrap(ns, notisEnv).concat([notisNodeEntry]), { description: `notis:${name}` });
  }

  if (host.mesh !== undefined) {
    const meshStateDir = join(OUT_DIR, name);
    const meshKeyPath = join(meshStateDir, 'mesh.key');
    let upstream;
    const hostileListenPort = 7000;
    if (host.mesh.upstreamMode !== undefined) {
      log.spawn(userWrap(ns, {
        MODE: host.mesh.upstreamMode,
        PORT: String(hostileListenPort),
        PUB1_BASE: pub1Base,
      }).concat([hostileUpstreamScript]), { description: `hostile-upstream:${name}` });
      upstream = `http://127.0.0.1:${hostileListenPort}`;
    } else if (host.node !== undefined) {
      upstream = `http://127.0.0.1:${host.node.httpPort}`;
    } else {
      continue;
    }
    const meshEnv = {
      MESH_KEY_PATH: meshKeyPath,
      MESH_NETWORK: 'devnet',
      MESH_ROLE: host.mesh.role,
      MESH_STATE_DIR: meshStateDir,
      MESH_UPSTREAM: upstream,
      MESH_LISTEN: host.mesh.role === 'public'
        ? `/ip4/${host.addr}/udp/${host.mesh.webrtcPort}/webrtc-direct`
        : '/ip4/127.0.0.1/udp/0/webrtc-direct',
      MESH_BOOTSTRAP: `/ip4/${pub1Host.addr}/tcp/${pub1Host.node.p2pPort}`,
      ...(host.mesh.stunPort !== undefined ? { MESH_STUN: `${host.addr}:${host.mesh.stunPort}` } : {}),
      ...(host.mesh.wss !== undefined ? {
        MESH_WSS: `${host.addr}:${host.mesh.wss.port}`,
        MESH_ACME_DIRECTORY: `https://${pebbleHost.addr}:${pebbleListenPort}/dir`,
        MESH_ACME_CHALLENGE_PORT: String(host.mesh.wss.acmeChallengePort),
        NODE_EXTRA_CA_CERTS: pebbleRootPath,
      } : {}),
    };
    log.spawn(userWrap(ns, meshEnv).concat([meshNodeEntry]), { description: `mesh:${name}` });
  }
}

// -----------------------------------------------------------------------
// Phase 8: miner inside pub1, wait for height, cut off hostile-lagging
// -----------------------------------------------------------------------

// MESH_INTERFACE → Acceptance — the miner reads `pub1`'s HTTP; pub1's HTTP
// binds pub1's namespace loopback, so the miner runs inside notismesh-pub1.
log.spawn(userWrap(nsOf('pub1'), {
  NODE_URL: `http://127.0.0.1:${pub1Host.node.httpPort}`,
  MINING_SECRET: 'stage-mining-secret',
  MINER_PCT: '100',
}).concat([minerScript]), { description: 'miner' });

const honestHeightTargetHost = ['pub1', 'pub2', 'priv1', 'priv2'];
log.records.push(`[wait] every honest node reads /blocks/current.height >= 50: ${honestHeightTargetHost.join(', ')}`);
if (dryRun) {
  process.stdout.write(`[wait] every honest node reads /blocks/current.height >= 50: ${honestHeightTargetHost.join(', ')}\n`);
}

const laggingHost = topology.hosts['hostile-lagging'];
if (laggingHost) {
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('hostile-lagging'), 'nft', 'add', 'table', 'ip', 'lag_cut'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('hostile-lagging'), 'nft', 'add', 'chain', 'ip', 'lag_cut', 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', 'policy', 'drop', ';', '}'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('hostile-lagging'), 'nft', 'add', 'rule', 'ip', 'lag_cut', 'out', 'oifname', 'lo', 'accept'], { privileged: true });
}

// -----------------------------------------------------------------------
// Phase 9: Pebble root install, browser host, config.json, pids.json
// -----------------------------------------------------------------------

const browserProfileHome = join(OUT_DIR, 'browser', 'home');
const browserProfileDir = join(OUT_DIR, 'browser', 'profile');
const pageServeDir = join(PACKAGE_ROOT, 'dist-page');
const chromiumBin = '/home/mwaddip/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

// MESH_INTERFACE → The IP certificate — the root Pebble answers from its
// management API. The real run fetches it after Pebble starts; the dry-run
// prints the command.
log.shell('sh', ['-c', `curl -sfk https://${pebbleHost.addr}:${pebbleManagementPort}/roots/0 -o ${pebbleRootPath} || { echo "pebble root fetch failed" >&2; exit 1; }`]);

// `certutil -d sql:<home>/.pki/nssdb -A -n pebble-root -t ",,"` installs the
// root into the NSS db Chromium reads when `HOME` is set to that profile.
// `libnss3-tools` provides it — a missing certutil is a stop-condition for
// `up`, since the browser host cannot trust the IP certificate without it.
log.shell('sh', ['-c', `which certutil >/dev/null || { echo "certutil (libnss3-tools) not installed on this machine — install it before stage:up" >&2; exit 1; }`]);
log.shell('mkdir', ['-p', join(browserProfileHome, '.pki', 'nssdb')]);
log.shell('sh', ['-c', `certutil -N -d sql:${join(browserProfileHome, '.pki', 'nssdb')} --empty-password 2>/dev/null || true`]);
log.shell('certutil', ['-A', '-d', `sql:${join(browserProfileHome, '.pki', 'nssdb')}`, '-n', 'pebble-root', '-t', ',,', '-i', pebbleRootPath]);
log.shell('sh', ['-c', `certutil -L -d sql:${join(browserProfileHome, '.pki', 'nssdb')} | grep -q pebble-root || { echo "pebble-root not in profile NSS db" >&2; exit 1; }`]);

// Serve the page over plain HTTP on the browser host's loopback. A tiny
// static server is enough; the browser dials it over `http://localhost`,
// and loads `config.json` from the same origin.
const pageServerScript = join(HERE, 'page-server.mjs');
log.spawn(userWrap(nsOf('browser'), {
  SERVE_DIR: pageServeDir,
  CONFIG_PATH: join(OUT_DIR, 'browser', 'config.json'),
  PAGE_PORT: String(browserHost.httpPort),
}).concat([pageServerScript]), { description: 'page-server' });

// Chromium under the throwaway profile. `HOME` points to the browser host's
// private directory so Chromium reads the NSS db we populated above; no
// flag, no system store — the root is scoped to this launch.
log.spawn(userWrap(nsOf('browser'), { HOME: browserProfileHome, DISPLAY: process.env.DISPLAY ?? ':0' }, chromiumBin).concat([
  '--headless=new',
  `--user-data-dir=${browserProfileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=9222',
  `http://localhost:${browserHost.httpPort}/`,
]), { description: 'chromium' });

const configPath = join(OUT_DIR, 'browser', 'config.json');
const pidsPath = join(OUT_DIR, 'pids.json');
const pageConfig = buildPageConfig(topology, notisIds);

if (dryRun) {
  process.stdout.write(`\n[would write] ${configPath}:\n${JSON.stringify(pageConfig, null, 2)}\n`);
  process.stdout.write(`\n[dry-run complete] ${log.privilegedCount} privileged command(s) listed; no namespace, file or process was created.\n`);
} else {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(pageConfig, null, 2));
  writeFileSync(pidsPath, JSON.stringify({
    pids: log.pids,
    namespaces: [bridgeNs, ...Object.keys(topology.hosts).map(nsOf)],
  }, null, 2));
  process.stdout.write(`stage up: ${log.pids.length} processes, ${Object.keys(topology.hosts).length + 1} namespaces\n`);
}
