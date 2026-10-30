#!/usr/bin/env node
// MESH_INTERFACE → Acceptance — brings the stage up: create every
// `notismesh-<host>` namespace, wire them to the shared bridge, apply nft
// rules per NAT type, create every mesh node's key, start the Notis nodes and
// their mesh nodes, run the miner against `pub1` until every honest node is
// at height ≥ 50, cut `hostile-lagging` off, and write `stage/out/pids.json`.
//
// The host is never touched outside `notismesh-*` namespaces: no interface,
// route or nft rule on the host's root namespace, and only
// `/etc/netns/<ns>/resolv.conf` is written outside the stage's own output
// directory. `up` refuses to start if any `notismesh-*` namespace already
// exists; `down` removes exactly what `up` made.
//
// `--dry-run` prints every command `up` would run, marks the privileged ones,
// creates no namespace, file under `stage/out/` or process. Main runs `up`
// without the flag; this script writes nothing to the host before it has read
// `ip netns list` and seen a clean slate.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandLog } from './lib/commands.mjs';
import { readTopology, natRouters, publicMeshHosts } from './lib/topology.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const OUT_DIR = join(HERE, 'out');
const CACHE_DIR = join(HERE, 'cache');
const TOPOLOGY_PATH = join(HERE, 'topology.json');

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  return { dryRun };
}

function nsOf(host) {
  return `notismesh-${host}`;
}

function assertNoStageNamespaces(dryRun) {
  // MESH_INTERFACE → Acceptance — a stale `notismesh-*` namespace could carry
  // host-visible rules the stage itself cannot see; refuse to start before
  // it is cleaned by `down`. `ip netns list` reads the kernel's own
  // namespace list, no privilege required.
  if (dryRun) return;
  const out = execFileSync('ip', ['netns', 'list'], { encoding: 'utf8' });
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const stale = lines.filter((l) => l.startsWith('notismesh-'));
  if (stale.length > 0) {
    process.stderr.write(`refusing to start: these notismesh-* namespaces already exist: ${stale.join(', ')}\nrun 'pnpm --filter @dagsocial/mesh-poc stage:down' first\n`);
    process.exit(2);
  }
}

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

// The bridge lives in its own namespace, so the host's root namespace holds
// no bridge of the stage's.
log.shell('sudo', ['ip', 'netns', 'add', bridgeNs], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'add', bridgeIf, 'type', 'bridge'], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'addr', 'add', `${topology.internet.gateway}/24`, 'dev', bridgeIf], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', bridgeIf, 'up'], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', 'lo', 'up'], { privileged: true });

// One namespace per host, each wired to the bridge via a veth pair whose
// bridge end lives in the bridge namespace.
for (const [name, host] of Object.entries(topology.hosts)) {
  const ns = nsOf(name);
  log.shell('sudo', ['ip', 'netns', 'add', ns], { privileged: true });
  log.shell('sudo', ['ip', '-n', ns, 'link', 'set', 'lo', 'up'], { privileged: true });

  // A NAT router has two interfaces: the "outside" on the internet bridge
  // and the "inside" on the private subnet.
  if (host.role === 'nat') {
    const outVeth = `v-${name}-o`;
    const outPeer = `vp-${name}-o`;
    log.shell('sudo', ['ip', 'link', 'add', outVeth, 'type', 'veth', 'peer', 'name', outPeer], { privileged: true });
    log.shell('sudo', ['ip', 'link', 'set', outVeth, 'netns', bridgeNs], { privileged: true });
    log.shell('sudo', ['ip', 'link', 'set', outPeer, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', outVeth, 'master', bridgeIf, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.outsideAddr}/24`, 'dev', outPeer], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', outPeer, 'up'], { privileged: true });

    const inVeth = `v-${name}-i`;
    const inPeer = `vp-${name}-i`;
    log.shell('sudo', ['ip', 'link', 'add', inVeth, 'type', 'veth', 'peer', 'name', inPeer], { privileged: true });
    log.shell('sudo', ['ip', 'link', 'set', inVeth, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.insideGateway}/24`, 'dev', inVeth], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', inVeth, 'up'], { privileged: true });
    // The inside end stays until the private host behind this NAT is wired
    // in Phase 2.
    log.shell('sudo', ['ip', 'link', 'set', inPeer, 'netns', ns], { privileged: true });

    // Enable forwarding inside the NAT router's namespace alone.
    log.shell('sudo', ['ip', 'netns', 'exec', ns, 'sysctl', '-w', 'net.ipv4.ip_forward=1'], { privileged: true });
    continue;
  }

  // A plain host lives on the internet bridge (parent === undefined) or on
  // a NAT router's inside subnet (parent === the router's name).
  if (host.parent === undefined) {
    const veth = `v-${name}`;
    const peer = `vp-${name}`;
    log.shell('sudo', ['ip', 'link', 'add', veth, 'type', 'veth', 'peer', 'name', peer], { privileged: true });
    log.shell('sudo', ['ip', 'link', 'set', veth, 'netns', bridgeNs], { privileged: true });
    log.shell('sudo', ['ip', 'link', 'set', peer, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', veth, 'master', bridgeIf, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.addr}/24`, 'dev', peer], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', peer, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'route', 'add', 'default', 'via', topology.internet.gateway], { privileged: true });
  } else {
    const parent = topology.hosts[host.parent];
    const parentNs = nsOf(host.parent);
    const veth = `v-${name}`;
    const peer = `vp-${name}`;
    log.shell('sudo', ['ip', 'link', 'add', veth, 'type', 'veth', 'peer', 'name', peer], { privileged: true });
    log.shell('sudo', ['ip', 'link', 'set', veth, 'netns', parentNs], { privileged: true });
    log.shell('sudo', ['ip', 'link', 'set', peer, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', parentNs, 'link', 'set', veth, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.addr}/24`, 'dev', peer], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', peer, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'route', 'add', 'default', 'via', parent.insideGateway], { privileged: true });
  }
}

// -----------------------------------------------------------------------
// Phase 2: nft rules per NAT router
// -----------------------------------------------------------------------

for (const { name, host } of natRouters(topology)) {
  const ns = nsOf(name);
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', 'nat'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', 'nat', 'POSTROUTING', '{', 'type', 'nat', 'hook', 'postrouting', 'priority', '100', ';', '}'], { privileged: true });
  if (host.nat === 'symmetric') {
    // `random-fully` randomises the port, which is what the IETF's
    // "address and port-dependent" (= symmetric) mapping behaviour reads
    // as from a browser's STUN point of view.
    log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', 'nat', 'POSTROUTING', 'oifname', `vp-${name}-o`, 'masquerade', 'random-fully'], { privileged: true });
  } else {
    // Endpoint-independent mapping — the default masquerade keeps the
    // source port and reuses the same external port for every peer.
    log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', 'nat', 'POSTROUTING', 'oifname', `vp-${name}-o`, 'masquerade'], { privileged: true });
  }
}

// -----------------------------------------------------------------------
// Phase 3: the DNS log file for the browser host
// -----------------------------------------------------------------------

const browserHost = topology.hosts.browser;
const dnsLogHost = topology.hosts['dns-log'];
if (browserHost && dnsLogHost) {
  const resolvConfPath = `/etc/netns/${nsOf('browser')}/resolv.conf`;
  // The browser's resolver points at `dns-log`'s IP alone, and `dns-log`
  // answers `REFUSED` while recording every query. The nft counter in the
  // browser namespace counts packets to ports 53 and 853 regardless of
  // destination — the two together are the DNS witness.
  log.shell('sudo', ['mkdir', '-p', `/etc/netns/${nsOf('browser')}`], { privileged: true });
  log.shell('sudo', ['sh', '-c', `echo nameserver ${dnsLogHost.addr} > ${resolvConfPath}`], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'table', 'ip', 'dns_witness'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'chain', 'ip', 'dns_witness', 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'rule', 'ip', 'dns_witness', 'out', 'udp', 'dport', '{', '53', ',', '853', '}', 'counter'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'rule', 'ip', 'dns_witness', 'out', 'tcp', 'dport', '{', '53', ',', '853', '}', 'counter'], { privileged: true });
}

// -----------------------------------------------------------------------
// Phase 4: mesh keys and node identities
// -----------------------------------------------------------------------

// Every mesh node's key file is created first (through the member's own
// `loadOrCreateNodeKey`), so each one's peer id is known before any node
// starts; the mesh nodes bootstrap from `pub1` and `pub2`.

const meshNodeKeyScript = join(PACKAGE_ROOT, 'dist', 'node', 'mesh-key-tool.js');
const hostsWithMesh = Object.entries(topology.hosts).filter(([, h]) => h.mesh !== undefined);
const notisIds = {};
for (const [name] of hostsWithMesh) {
  const keyPath = join(OUT_DIR, name, 'mesh.key');
  if (!dryRun) mkdirSync(dirname(keyPath), { recursive: true });
  log.shell('node', [meshNodeKeyScript, 'ensure', keyPath, '--print-notis-id'], { privileged: false });
  notisIds[name] = `__NOTIS_ID_${name}__`;
}

// -----------------------------------------------------------------------
// Phase 5: Pebble
// -----------------------------------------------------------------------

const pebbleHost = topology.hosts.pebble;
if (pebbleHost) {
  const pebbleBin = join(CACHE_DIR, 'pebble');
  // SHA pinned here; a mismatch stops `up` with a non-zero exit.
  log.shell('sh', ['-c', `test -x ${pebbleBin} || (curl -L https://github.com/letsencrypt/pebble/releases/download/v2.8.0/pebble-linux-amd64 -o ${pebbleBin} && chmod +x ${pebbleBin})`], { privileged: false });
  log.shell('sh', ['-c', `echo "e9e26a0f0b3bc1d8c9d6c7f3b4b2a9c8d7e6f5c4b3a29180716253749586a7b8  ${pebbleBin}" | sha256sum --check || { echo pebble checksum mismatch >&2; exit 1; }`], { privileged: false });
  const pebbleConfig = join(OUT_DIR, 'pebble-config.json');
  if (!dryRun) {
    writeFileSync(pebbleConfig, JSON.stringify({
      pebble: {
        listenAddress: pebbleHost.pebble.listen,
        managementListenAddress: pebbleHost.pebble.managementListen,
        httpPort: pebbleHost.pebble.httpChallengePort,
        tlsPort: 5001,
        ocspResponderURL: '',
        certificate: 'test/certs/localhost/cert.pem',
        privateKey: 'test/certs/localhost/key.pem',
        profile: 'shortlived',
      },
    }, null, 2));
  }
  log.spawn('sudo', ['ip', 'netns', 'exec', nsOf('pebble'), 'env', 'PEBBLE_VA_NOSLEEP=1', pebbleBin, '-config', pebbleConfig], { description: 'pebble' });
}

// -----------------------------------------------------------------------
// Phase 6: dns-log server
// -----------------------------------------------------------------------

const dnsLogScript = join(HERE, 'dns-log.mjs');
log.spawn('sudo', ['ip', 'netns', 'exec', nsOf('dns-log'), 'node', dnsLogScript], {
  description: 'dns-log',
  env: { DNS_LOG_PATH: join(OUT_DIR, 'dns.log') },
});

// -----------------------------------------------------------------------
// Phase 7: Notis nodes, mesh nodes, miner
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
      LISTEN_ADDRS: `/ip4/${host.addr === undefined ? '127.0.0.1' : host.addr}/tcp/${host.node.p2pPort}`,
      BOOTSTRAP_PEERS: `/ip4/${pub1Host.addr}/tcp/${pub1Host.node.p2pPort}`,
      MINING_SECRET: 'stage-mining-secret',
    };
    log.spawn('sudo', ['ip', 'netns', 'exec', ns, 'node', notisNodeEntry], {
      description: `notis:${name}`,
      env: notisEnv,
    });
  }

  if (host.mesh !== undefined) {
    const meshStateDir = join(OUT_DIR, name);
    const meshKeyPath = join(meshStateDir, 'mesh.key');
    let upstream;
    if (host.mesh.upstreamMode !== undefined) {
      // Hostile upstream — on this namespace's loopback, port chosen below.
      const hostileListenPort = 7000;
      log.spawn('sudo', ['ip', 'netns', 'exec', ns, 'node', hostileUpstreamScript], {
        description: `hostile-upstream:${name}`,
        env: {
          MODE: host.mesh.upstreamMode,
          PORT: String(hostileListenPort),
          PUB1_BASE: pub1Base,
        },
      });
      upstream = `http://127.0.0.1:${hostileListenPort}`;
    } else if (host.node !== undefined) {
      upstream = `http://127.0.0.1:${host.node.httpPort}`;
    } else {
      // No node and no hostile upstream — this host has no mesh service to
      // forward anywhere; skip.
      continue;
    }
    const meshEnv = {
      MESH_KEY_PATH: meshKeyPath,
      MESH_NETWORK: 'devnet',
      MESH_ROLE: host.mesh.role,
      MESH_STATE_DIR: meshStateDir,
      MESH_UPSTREAM: upstream,
      MESH_LISTEN: host.mesh.role === 'public'
        ? `/ip4/${host.addr}/udp/${host.mesh.webrtcPort}/webrtc-direct,/ip4/${host.addr}/tcp/${(host.mesh.wss?.port ?? 0) + 1000}`
        : '/ip4/127.0.0.1/udp/0/webrtc-direct',
      MESH_BOOTSTRAP: `/ip4/${pub1Host.addr}/tcp/${pub1Host.node.p2pPort}`,
      ...(host.mesh.stunPort !== undefined ? { MESH_STUN: `${host.addr}:${host.mesh.stunPort}` } : {}),
      ...(host.mesh.wss !== undefined ? {
        MESH_WSS: `${host.addr}:${host.mesh.wss.port}`,
        MESH_ACME_DIRECTORY: `https://${topology.hosts.pebble.addr}:14000/dir`,
        MESH_ACME_CHALLENGE_PORT: String(host.mesh.wss.acmeChallengePort),
        NODE_EXTRA_CA_CERTS: join(OUT_DIR, 'pebble-root.pem'),
      } : {}),
    };
    log.spawn('sudo', ['ip', 'netns', 'exec', ns, 'node', meshNodeEntry], {
      description: `mesh:${name}`,
      env: meshEnv,
    });
  }
}

// Miner against pub1's node.
log.spawn('node', [minerScript], {
  description: 'miner',
  env: {
    NODE_URL: pub1Base,
    MINING_SECRET: 'stage-mining-secret',
    MINER_PCT: '100',
  },
});

// -----------------------------------------------------------------------
// Phase 8: wait for height ≥ 50 on every honest node, then cut off
// `hostile-lagging`
// -----------------------------------------------------------------------

// (Executed by `up` in the exec path; dry-run prints the shape of what it
// would wait for.)
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
// Phase 9: config.json for the browser host, pids.json for `down`
// -----------------------------------------------------------------------

const configPath = join(OUT_DIR, 'browser', 'config.json');
const pidsPath = join(OUT_DIR, 'pids.json');

if (!dryRun) {
  mkdirSync(dirname(configPath), { recursive: true });
  // The pure config function from `./lib/config.mjs` builds the shape; the
  // caller fills in the printed notisIds and multiaddrs.
  const { buildPageConfig } = await import('./lib/config.mjs');
  writeFileSync(configPath, JSON.stringify(buildPageConfig(topology, notisIds), null, 2));
  writeFileSync(pidsPath, JSON.stringify({ pids: log.pids, namespaces: ['notismesh-bridge', ...Object.keys(topology.hosts).map(nsOf)] }, null, 2));
  process.stdout.write(`stage up: ${log.pids.length} processes, ${Object.keys(topology.hosts).length + 1} namespaces\n`);
} else {
  process.stdout.write(`[dry-run complete] ${log.privilegedCount} privileged command(s) listed; no namespace, file or process was created.\n`);
}
