// MESH_INTERFACE → Acceptance / Discovery / No anchor reached — the stage's
// unit checks: the topology's shape, the page config holds no DNS and passes
// the client's refusals, the hostile upstream's two bodies, and `--dry-run`
// touches nothing. These run in CI without root, without the stage, and
// without the network beyond loopback.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeNipopowProof, verifyProof } from '@dagsocial/nipopow';
import { verifierProfile } from '@dagsocial/nipopow-client';
import { profileFor } from '@dagsocial/types';
import { readTopology, assertTopologyWhole } from '../stage/lib/topology.mjs';
import { buildPageConfig, buildIdentitiesOut } from '../stage/lib/config.mjs';
import { malformedBody, invalidBody } from '../stage/hostile-upstream.mjs';
import {
  HOSTILE_FORK_PAIR,
  partnerOf,
  joinBootstrapPeers,
  pairBootstrapAddr,
  buildHostCutArgs,
  buildPairCutArgs,
  notisBootstrapPeersFor,
} from '../stage/lib/hostile-fork-pair.mjs';
import { assertClientConfig } from '../src/client/mesh-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const STAGE_DIR = join(PACKAGE_ROOT, 'stage');
const TOPOLOGY_PATH = join(STAGE_DIR, 'topology.json');
const UP_SCRIPT = join(STAGE_DIR, 'up.mjs');
const OUT_DIR = join(STAGE_DIR, 'out');
const CACHE_DIR = join(STAGE_DIR, 'cache');
const PROOF_FIXTURE = join(HERE, 'fixtures', 'devnet-proof-24-20.hex');

// MESH_INTERFACE → Discovery — a fake notisId map for `buildPageConfig`'s
// unit tests. The real `up` reads these ids from the mesh node's own stdout
// line; the test fills in 64-hex placeholders so the pure function has
// something to concatenate.
function fakeIdentities(): Record<string, string> {
  return {
    pub1: 'a'.repeat(64),
    pub2: 'b'.repeat(64),
    'hostile-malformed': 'c'.repeat(64),
    'hostile-invalid': 'd'.repeat(64),
    'hostile-lagging': 'e'.repeat(64),
    'hostile-publisher': '3'.repeat(64),
    priv1: 'f'.repeat(64),
    priv2: '1'.repeat(64),
    lan1: '2'.repeat(64),
  };
}

describe('stage/topology.json is whole', () => {
  it('every host has an address, a role and a NAT type; no hostname', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const errors = assertTopologyWhole(topology);
    expect(errors, errors.join('; ')).toEqual([]);
  });

  it('the host the pair\'s miner mines against runs a miner node', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    expect(topology.hosts['hostile-lagging'].node.role).toBe('miner');
  });

  it('each NAT router has an inside and an outside', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const nats = Object.entries(topology.hosts as Record<string, any>).filter(([, h]) => h.role === 'nat');
    expect(nats.length, 'the stage has three NAT routers').toBeGreaterThanOrEqual(3);
    for (const [name, host] of nats) {
      expect(host.outsideAddr, `${name}: outsideAddr`).toBeDefined();
      expect(host.insideSubnet, `${name}: insideSubnet`).toBeDefined();
      expect(host.insideGateway, `${name}: insideGateway`).toBeDefined();
    }
  });

  it('every anchor the page config names is a public mesh node', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const config = buildPageConfig(topology, fakeIdentities(), undefined, { dryRun: true });
    const publicIds = new Set(
      Object.entries(topology.hosts as Record<string, any>)
        .filter(([, h]) => h.role === 'public' && h.mesh?.role === 'public')
        .map(([name]) => fakeIdentities()[name]),
    );
    expect(config.anchors.length).toBeGreaterThan(0);
    for (const a of config.anchors) {
      expect(publicIds.has(a.notisId), `anchor ${a.notisId} is a public mesh node`).toBe(true);
    }
  });

  // MESH_INTERFACE → Acceptance 7 — a private node sits on the
  // browser's own inside bridge (natC's), with a mesh node of its
  // own and its own devnet node, reached by the reader's hand.
  it('lan1 is a private mesh node on natC\'s inside bridge', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const lan1 = (topology.hosts as Record<string, any>).lan1;
    expect(lan1, 'topology holds a lan1 host').toBeDefined();
    expect(lan1.role).toBe('private');
    expect(lan1.parent).toBe('natC');
    expect(lan1.addr).toBe('10.103.0.21');
    expect(lan1.mesh?.role).toBe('private');
    expect(lan1.node, 'lan1 carries its own devnet node').toBeDefined();
  });
});

describe('the page config holds no DNS and passes the client\'s checks', () => {
  it('buildPageConfig output has no /dns4/, /dns6/, /dnsaddr/ components', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const config = buildPageConfig(topology, fakeIdentities(), undefined, { dryRun: true });
    expect(config.anchors.length, 'the stage has anchors').toBeGreaterThan(0);
    for (const a of config.anchors) {
      expect(a.addrs.length, `anchor ${a.notisId} has addresses`).toBeGreaterThan(0);
      for (const addr of a.addrs) {
        expect(addr).not.toMatch(/\/dns4\/|\/dns6\/|\/dnsaddr\//);
      }
    }
    for (const s of config.seeds) {
      for (const addr of s.addrs) {
        expect(addr).not.toMatch(/\/dns4\/|\/dns6\/|\/dnsaddr\//);
      }
    }
  });

  it('assertClientConfig accepts the output', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const config = buildPageConfig(topology, fakeIdentities(), undefined, { dryRun: true });
    expect(config.anchors.length).toBeGreaterThan(0);
    // MESH_INTERFACE → NAT → "A client's STUN list comes from the
    // public nodes it holds" — the built config writes no
    // `stunServers` key; the page refuses the key in words.
    expect('stunServers' in config).toBe(false);
    // profileFor is read here as the page's `runMain` reads it, so a shape
    // the page builder returns is a shape the page accepts.
    profileFor(config.network);
    expect(() => assertClientConfig({
      anchors: config.anchors,
      seeds: config.seeds,
    })).not.toThrow();
  });
});

describe('buildIdentitiesOut writes a row per host up started a mesh node for', () => {
  const topology = {
    network: 'devnet' as const,
    hosts: {
      pub1: {
        role: 'public', addr: '10.100.0.11',
        mesh: { role: 'public', webrtcPort: 4001 },
        node: { httpPort: 3100 },
      },
      lan1: {
        role: 'private', addr: '10.103.0.21',
        mesh: { role: 'private', webrtcPort: 4001 },
        node: { httpPort: 3100 },
      },
      // A host up started no mesh node for (no notisId) is left out.
      browser: { role: 'browser', addr: '10.103.0.11' },
    },
  };

  // MESH_INTERFACE → Discovery → "A node added by hand" — "A private
  // node prints its local WebRTC-direct address with its key, for its
  // operator to hand over". The row's `localAddrs` carries whatever
  // the private host's identity line printed; s7's
  // `buildByHandLanVariant` reads it so lan1 is named at an address
  // a browser can dial.
  it('each row carries localAddrs from the host\'s latest identity line', () => {
    const notisIds = { pub1: 'a'.repeat(64), lan1: 'b'.repeat(64) };
    const lan1Local = '/ip4/10.103.0.21/udp/4001/webrtc-direct/certhash/uEiA/p2p/PLan1';
    const meshIdentities = {
      pub1: { multiaddrs: ['/ip4/10.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/PPub1'], localAddrs: [] },
      lan1: { multiaddrs: ['/circuit/addr'], localAddrs: [lan1Local] },
    };
    const out = buildIdentitiesOut(topology, notisIds, meshIdentities);
    expect(Object.keys(out).sort()).toEqual(['lan1', 'pub1']);
    expect(out.lan1!.localAddrs).toEqual([lan1Local]);
    expect(out.pub1!.localAddrs).toEqual([]);
    // The row's other fields are still written.
    expect(out.lan1!.notisId).toBe('b'.repeat(64));
    expect(out.lan1!.meshRole).toBe('private');
    expect(out.lan1!.addr).toBe('10.103.0.21');
    expect(out.lan1!.httpPort).toBe(3100);
    expect(out.lan1!.multiaddrs).toEqual(['/circuit/addr']);
  });

  it('a host with no identity line reads empty lists', () => {
    const notisIds = { pub1: 'a'.repeat(64), lan1: 'b'.repeat(64) };
    const out = buildIdentitiesOut(topology, notisIds, { pub1: { multiaddrs: ['/x'] } });
    expect(out.lan1!.multiaddrs).toEqual([]);
    expect(out.lan1!.localAddrs).toEqual([]);
  });
});

describe('the hostile upstream', () => {
  it('malformed answers with a non-hex proof field', () => {
    const body = malformedBody();
    expect(body.proof).toBe('not-hex');
    // The client reads `/nipopow/proof/:m/:k` as hex before decoding; a
    // non-hex string fails that step. `resolveTip` turns this into
    // `refuseCode: 'invalid'` without a proof, which the mesh client
    // reads as `lie` of kind `malformed`
    // (MESH_INTERFACE → The client's node list).
    expect(() => hexToBytes(body.proof)).toThrow();
  });

  it('invalid: decodes but verifyProof refuses', () => {
    expect(existsSync(PROOF_FIXTURE), `fixture ${PROOF_FIXTURE}`).toBe(true);
    const validHex = readFileSync(PROOF_FIXTURE, 'utf8').trim();
    // Sanity: the fixture itself decodes and verifies, so a failure on the
    // flipped version proves the flip is what broke it.
    const validProof = decodeNipopowProof(hexToBytes(validHex));
    const profile = profileFor('devnet');
    // `nowMs` must sit at or after the chain's last stamp — a future-drift
    // check in verifyProof refuses a header past `nowMs + maxFutureDriftMs`.
    const lastTailHeader = validProof.suffixTail[validProof.suffixTail.length - 1];
    const chainTipMs = lastTailHeader !== undefined ? lastTailHeader.createdAt : validProof.suffixHead.header.createdAt;
    const nowMs = chainTipMs + 60_000;
    const okResult = verifyProof(validProof, { m: 24, k: 20 }, verifierProfile(profile, nowMs));
    expect(okResult.ok, `valid fixture must verify: ${JSON.stringify(okResult)}`).toBe(true);

    const body = invalidBody(validHex);
    const bytes = hexToBytes(body.proof);
    // `decodeNipopowProof` reads the flipped bytes without throwing — the
    // nonce field is a VLQ unsigned integer, every value is a legal
    // encoding (MESH_INTERFACE → The client's node list, "lie" row).
    const flippedProof = decodeNipopowProof(bytes);
    const badResult = verifyProof(flippedProof, { m: 24, k: 20 }, verifierProfile(profile, nowMs));
    expect(badResult.ok, 'verifyProof must refuse the flipped proof').toBe(false);
  });
});

// MESH_INTERFACE → Acceptance 8 — a node on another chain has its
// proof read when its tip moves, with the client's own, and the
// client's tip stays the honest chain's / MINING_INTERFACE → "The
// peer-readiness gate" — the hostile fork pair's pure builders.
// `hostile-lagging` and `hostile-malformed` peer with each other alone
// so the lagging miner can produce templates; the per-host cut leaves
// exactly one accept rule for the partner's p2p address ahead of the
// drop-everything-on-p2p-port rules on both the output and input
// chain.
describe('the hostile fork pair bootstrap and cut builders', () => {
  function fakeTopology(): any {
    return {
      hosts: {
        pub1: { role: 'public', addr: '11.100.0.11', node: { httpPort: 3100, p2pPort: 9100 } },
        'hostile-lagging': { role: 'hostile', addr: '11.100.0.33', node: { httpPort: 3100, p2pPort: 9100 } },
        'hostile-malformed': { role: 'hostile', addr: '11.100.0.31', node: { httpPort: 3100, p2pPort: 9100 } },
      },
    };
  }

  it('HOSTILE_FORK_PAIR names hostile-lagging and hostile-malformed in that order', () => {
    expect([...HOSTILE_FORK_PAIR]).toEqual(['hostile-lagging', 'hostile-malformed']);
  });

  it("partnerOf returns the other host; a host outside the pair returns null", () => {
    expect(partnerOf('hostile-lagging')).toBe('hostile-malformed');
    expect(partnerOf('hostile-malformed')).toBe('hostile-lagging');
    expect(partnerOf('pub1')).toBeNull();
    expect(partnerOf('hostile-invalid')).toBeNull();
  });

  it('joinBootstrapPeers keeps the base first and appends new entries, dropping duplicates and empties', () => {
    const base = '/ip4/11.100.0.11/tcp/9100';
    const partner = '/ip4/11.100.0.31/tcp/9100';
    expect(joinBootstrapPeers(base, [partner])).toBe(
      '/ip4/11.100.0.11/tcp/9100,/ip4/11.100.0.31/tcp/9100',
    );
    // duplicates kept once; empty strings and non-strings dropped
    expect(joinBootstrapPeers(base, [base, partner, '', null as any, partner])).toBe(
      '/ip4/11.100.0.11/tcp/9100,/ip4/11.100.0.31/tcp/9100',
    );
    // the base-first invariant: an extra listed before the base cannot overtake it
    expect(joinBootstrapPeers(base, []).startsWith(base)).toBe(true);
  });

  it('pairBootstrapAddr builds the partner addr with the partner p2p port and no /p2p/ tail; a non-pair host answers null', () => {
    const topo = fakeTopology();
    expect(pairBootstrapAddr(topo, 'hostile-lagging')).toBe('/ip4/11.100.0.31/tcp/9100');
    expect(pairBootstrapAddr(topo, 'hostile-malformed')).toBe('/ip4/11.100.0.33/tcp/9100');
    expect(pairBootstrapAddr(topo, 'pub1')).toBeNull();
    // Node p2p's BOOTSTRAP_PEERS rejects a tail with /p2p/ for a
    // bare-TCP seed; the builder must not add one.
    const lag = pairBootstrapAddr(topo, 'hostile-lagging');
    expect(lag).not.toMatch(/\/p2p\//);
  });

  // The accept rule for the pair's partner MUST sit ahead of the drop
  // on the same chain; nft reads rules in order, so a drop before the
  // accept would cut the pair's own traffic too.
  it('buildHostCutArgs writes accept rules ahead of drops on both chains for hostile-lagging', () => {
    const topo = fakeTopology();
    const rules = buildHostCutArgs(topo, 'hostile-lagging');
    const idx = (predicate: (r: { description: string; argv: string[] }) => boolean) =>
      rules.findIndex(predicate);
    const outAccept = idx((r) => r.description === 'hostile-lagging-pair-out-accept-hostile-malformed');
    const outDrop = idx((r) => r.description === 'hostile-lagging-pair-out-drop');
    const inAccept = idx((r) => r.description === 'hostile-lagging-pair-in-accept-hostile-malformed');
    const inDrop = idx((r) => r.description === 'hostile-lagging-pair-in-drop');
    expect(outAccept, `out-accept present`).toBeGreaterThan(-1);
    expect(outDrop, `out-drop present`).toBeGreaterThan(-1);
    expect(inAccept, `in-accept present`).toBeGreaterThan(-1);
    expect(inDrop, `in-drop present`).toBeGreaterThan(-1);
    expect(outAccept, `out-accept before out-drop`).toBeLessThan(outDrop);
    expect(inAccept, `in-accept before in-drop`).toBeLessThan(inDrop);
  });

  // The accept rule names the partner's address + p2p port on the
  // correct direction: outbound keys on daddr (where the packet is
  // headed), inbound on saddr (where the packet came from).
  it('buildHostCutArgs: hostile-lagging\'s accepts name hostile-malformed\'s addr and p2p port on the right direction', () => {
    const topo = fakeTopology();
    const rules = buildHostCutArgs(topo, 'hostile-lagging');
    const outAccept = rules.find((r) => r.description === 'hostile-lagging-pair-out-accept-hostile-malformed')!;
    const inAccept = rules.find((r) => r.description === 'hostile-lagging-pair-in-accept-hostile-malformed')!;
    const outArgv = outAccept.argv.join(' ');
    const inArgv = inAccept.argv.join(' ');
    expect(outArgv).toMatch(/\bdaddr 11\.100\.0\.31\b/);
    expect(outArgv).toMatch(/\btcp dport 9100 accept\b/);
    expect(inArgv).toMatch(/\bsaddr 11\.100\.0\.31\b/);
    expect(inArgv).toMatch(/\btcp sport 9100 accept\b/);
  });

  // The hostile-malformed cut mirrors the lagging one with the pair
  // reversed: accept the lagging node's address, drop everything else.
  it('buildHostCutArgs: hostile-malformed\'s accepts name hostile-lagging\'s addr', () => {
    const topo = fakeTopology();
    const rules = buildHostCutArgs(topo, 'hostile-malformed');
    const outAccept = rules.find((r) => r.description === 'hostile-malformed-pair-out-accept-hostile-lagging')!;
    const inAccept = rules.find((r) => r.description === 'hostile-malformed-pair-in-accept-hostile-lagging')!;
    expect(outAccept, 'out-accept present').toBeDefined();
    expect(inAccept, 'in-accept present').toBeDefined();
    expect(outAccept.argv.join(' ')).toMatch(/\bdaddr 11\.100\.0\.33\b/);
    expect(inAccept.argv.join(' ')).toMatch(/\bsaddr 11\.100\.0\.33\b/);
  });

  // Every rule runs inside this host's namespace; a stray `nft add
  // rule` outside the namespace would land on the host.
  it('buildHostCutArgs: every argv is a sudo ip netns exec notismesh-<name> nft command', () => {
    const topo = fakeTopology();
    for (const name of HOSTILE_FORK_PAIR) {
      const rules = buildHostCutArgs(topo, name);
      expect(rules.length, `${name}: at least seven rules`).toBeGreaterThanOrEqual(7);
      for (const r of rules) {
        expect(r.argv.slice(0, 6)).toEqual(['sudo', 'ip', 'netns', 'exec', `notismesh-${name}`, 'nft']);
      }
    }
  });

  // The cut's table name must be a legal nft identifier and the chains
  // must declare `type filter hook output/input priority 0`. nft -c
  // would reject anything else — the dry-run gate's nft -c case asserts
  // that for the whole dry-run.
  it('buildHostCutArgs: table and chains carry the right nft phrases', () => {
    const topo = fakeTopology();
    const rules = buildHostCutArgs(topo, 'hostile-lagging', { table: 'lag_cut' });
    const table = rules.find((r) => r.description === 'hostile-lagging-pair-add-table')!;
    const chainOut = rules.find((r) => r.description === 'hostile-lagging-pair-add-chain-out')!;
    const chainIn = rules.find((r) => r.description === 'hostile-lagging-pair-add-chain-in')!;
    expect(table.argv.join(' ')).toMatch(/\bnft add table ip lag_cut$/);
    expect(chainOut.argv.join(' ')).toMatch(/\bnft add chain ip lag_cut out { type filter hook output priority 0 ; }$/);
    expect(chainIn.argv.join(' ')).toMatch(/\bnft add chain ip lag_cut in { type filter hook input priority 0 ; }$/);
  });

  // buildPairCutArgs concatenates both hosts' rules in pair order: a
  // single call carries the whole fork cut.
  it('buildPairCutArgs: both hosts in order, each host\'s seven rules in a row', () => {
    const topo = fakeTopology();
    const rules = buildPairCutArgs(topo);
    const hosts = rules.map((r) => r.description.split('-pair-')[0]);
    // The first seven belong to hostile-lagging, the next seven to
    // hostile-malformed. There is no interleaving.
    const first = hosts.indexOf('hostile-lagging');
    const malformedStart = hosts.indexOf('hostile-malformed');
    expect(first).toBe(0);
    expect(malformedStart).toBeGreaterThan(0);
    for (let i = 0; i < malformedStart; i += 1) {
      expect(hosts[i], `rule ${i} is a hostile-lagging rule`).toBe('hostile-lagging');
    }
    for (let i = malformedStart; i < hosts.length; i += 1) {
      expect(hosts[i], `rule ${i} is a hostile-malformed rule`).toBe('hostile-malformed');
    }
  });

  it('buildHostCutArgs: a host outside HOSTILE_FORK_PAIR throws naming the pair', () => {
    const topo = fakeTopology();
    expect(() => buildHostCutArgs(topo, 'pub1')).toThrow(/HOSTILE_FORK_PAIR/);
  });

  // MESH_INTERFACE → Acceptance 8 — the pair's Notis BOOTSTRAP_PEERS
  // names the partner alone (no pub1), so each pair host starts from
  // genesis with no path to the honest chain; every other host names
  // pub1 alone.
  it('notisBootstrapPeersFor: a pair host answers the partner addr; every other host answers pub1', () => {
    const topo = fakeTopology();
    const pub1Addr = '/ip4/11.100.0.11/tcp/9100';
    expect(notisBootstrapPeersFor(topo, 'hostile-lagging', pub1Addr)).toBe('/ip4/11.100.0.31/tcp/9100');
    expect(notisBootstrapPeersFor(topo, 'hostile-malformed', pub1Addr)).toBe('/ip4/11.100.0.33/tcp/9100');
    expect(notisBootstrapPeersFor(topo, 'pub1', pub1Addr)).toBe(pub1Addr);
    expect(notisBootstrapPeersFor(topo, 'pub2' as string, pub1Addr)).toBe(pub1Addr);
  });

  // The pair's BOOTSTRAP_PEERS answer must NOT carry pub1 — a mutation
  // that joins pub1 beside the partner would restore the honest chain's
  // reach into the pair and the pair would sync up on genesis.
  it('notisBootstrapPeersFor: a pair host\'s answer does not contain pub1\'s addr', () => {
    const topo = fakeTopology();
    const pub1Addr = '/ip4/11.100.0.11/tcp/9100';
    for (const pair of HOSTILE_FORK_PAIR) {
      expect(notisBootstrapPeersFor(topo, pair, pub1Addr)).not.toContain('11.100.0.11');
    }
  });
});

describe('stage up --dry-run', () => {
  // Shared capture — the dry-run runs once and every case below reads its
  // output. A per-case run would spawn Node seven times.
  let out = '';
  let status: number | null = null;
  let outBefore = false;
  let cacheBefore = false;
  let pidsBefore: number | null = null;
  let configBefore: number | null = null;

  function mtimeOf(path: string): number | null {
    try { return statSync(path).mtimeMs; } catch { return null; }
  }

  function runDryOnce(): void {
    if (out !== '') return;
    outBefore = existsSync(OUT_DIR);
    cacheBefore = existsSync(CACHE_DIR);
    pidsBefore = mtimeOf(join(OUT_DIR, 'pids.json'));
    configBefore = mtimeOf(join(OUT_DIR, 'browser', 'config.json'));
    const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    out = res.stdout;
    status = res.status;
    if (res.status !== 0) {
      throw new Error(`up --dry-run exit ${res.status}: ${res.stderr}`);
    }
  }

  // MESH_INTERFACE → Acceptance — nothing a scenario reads may come
  // from an earlier run. `stage/out/` is moved aside to
  // `stage/out.prev/` (replacing any older `.prev`) as the first step,
  // before any key, cert or log is written. `stage/cache/` (the
  // Pebble tarball + binary) is left in place.
  it("rotates stage/out/ to stage/out.prev/ as its first step", () => {
    runDryOnce();
    const lines = out.split('\n').filter((l) => l !== '');
    const firstLine = lines[0];
    expect(firstLine, 'the dry-run has at least one line').toBeDefined();
    expect(firstLine, `first step rotates stage/out: ${firstLine}`).toMatch(
      /stage\/out(?:['"]?)\s|stage\/out['"]?\s|stage\/out\.prev/,
    );
    // The rotation precedes every other step: no `[privileged]`, no
    // `[cert]`, no `[spawn:*]` runs before it.
    const rotIdx = lines.findIndex((l) => /stage\/out\.prev/.test(l));
    expect(rotIdx, 'rotation present').toBeGreaterThanOrEqual(0);
    const privIdx = lines.findIndex((l) => l.startsWith('[privileged]'));
    const certIdx = lines.findIndex((l) => l.startsWith('[cert]'));
    const spawnIdx = lines.findIndex((l) => l.startsWith('[spawn:'));
    expect(rotIdx, 'rotation before any [privileged]').toBeLessThan(privIdx);
    if (certIdx >= 0) expect(rotIdx, 'rotation before any [cert]').toBeLessThan(certIdx);
    if (spawnIdx >= 0) expect(rotIdx, 'rotation before any [spawn:]').toBeLessThan(spawnIdx);
  }, 30_000);

  it('exits 0, prints at least one privileged command, creates no namespace, file or process', () => {
    runDryOnce();
    expect(status).toBe(0);
    expect(out.length, 'stdout must not be empty').toBeGreaterThan(0);
    const privilegedLines = out.split('\n').filter((l) => l.startsWith('[privileged] '));
    expect(privilegedLines.length, 'at least one [privileged] command printed').toBeGreaterThan(0);
    if (!outBefore) {
      expect(existsSync(OUT_DIR), 'stage/out/ was not created').toBe(false);
    }
    if (!cacheBefore) {
      expect(existsSync(CACHE_DIR), 'stage/cache/ was not created').toBe(false);
    }
    // A previous real `stage:up` run may leave pids.json or config.json
    // under `stage/out/`; the dry-run must not WRITE either, so compare
    // mtimes rather than existence.
    expect(mtimeOf(join(OUT_DIR, 'pids.json')), 'pids.json unchanged by dry-run').toBe(pidsBefore);
    expect(mtimeOf(join(OUT_DIR, 'browser', 'config.json')), 'config.json unchanged by dry-run').toBe(configBefore);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — the host is never touched outside
  // the `notismesh-*` namespaces. Veth pairs are created inside their
  // destination namespaces (`ip -n <ns> link add ... peer name ...
  // netns <other>` places both ends at creation), so no `ip link ...`
  // line without `-n` or `netns exec` appears for a link operation
  // other than `netns add`/`del`.
  it('no command creates or changes a link outside a notismesh-* namespace', () => {
    runDryOnce();
    const bad: string[] = [];
    for (const raw of out.split('\n')) {
      const line = raw.replace(/^\[privileged\] /, '').trim();
      if (line === '') continue;
      // Allow `sudo ip netns add`, `sudo ip netns delete`, `sudo ip netns
      // exec ...`, `sudo ip netns list`, and `sudo ip -n <ns> ...`.
      if (/^sudo\s+ip\s+netns\s+(add|delete|list|exec)\b/.test(line)) continue;
      if (/^sudo\s+ip\s+-n\s+\S+\b/.test(line)) continue;
      // Any other `sudo ip link ...` or `sudo ip addr ...` touches the host.
      if (/^sudo\s+ip\s+(link|addr|route|rule|neighbor)\b/.test(line)) {
        bad.push(line);
      }
    }
    expect(bad, `host-visible ip operations:\n  ${bad.join('\n  ')}`).toEqual([]);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — every stage process runs as the invoking
  // user with Node 24's absolute path. Every `[spawn:*]` line carries
  // `sudo -u <user> --` and names an absolute Node 24 binary.
  it('every [spawn:*] names the invoking user and Node 24', () => {
    runDryOnce();
    const user = process.env.SUDO_USER ?? process.env.USER;
    expect(typeof user, 'the test needs USER set to match up.mjs').toBe('string');
    const nodeAbs = process.execPath;
    expect(nodeAbs).toMatch(/^\//);
    const spawnLines = out.split('\n').filter((l) => l.startsWith('[spawn:'));
    expect(spawnLines.length, 'at least one spawn line').toBeGreaterThan(0);
    for (const line of spawnLines) {
      // Chromium and Pebble are external binaries, not Node — they still
      // pass through the `sudo -u <user> -- env` wrap, but the final
      // executable is their own absolute path.
      expect(line, line).toMatch(new RegExp(`sudo -u ${user} --`));
      if (line.startsWith('[spawn:chromium]') || line.startsWith('[spawn:pebble]')) continue;
      expect(line, `spawn must name an absolute Node 24 binary: ${line}`).toContain(nodeAbs);
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — the miner reads its node's HTTP; a
  // node's HTTP binds its namespace loopback. The honest miner (boot
  // + steady) runs inside `notismesh-pub1`; the pair's miner
  // (lagging boot + lagging steady) runs inside
  // `notismesh-hostile-lagging`.
  it('each miner spawn runs inside its node\'s namespace', () => {
    runDryOnce();
    const minerLines = out.split('\n').filter((l) => l.startsWith('[spawn:miner'));
    expect(minerLines.length, 'at least one miner spawn is present').toBeGreaterThan(0);
    const pub1Ns = 'ip netns exec notismesh-pub1';
    const laggingNs = 'ip netns exec notismesh-hostile-lagging';
    for (const minerLine of minerLines) {
      if (minerLine.startsWith('[spawn:miner-lagging-boot]') || minerLine.startsWith('[spawn:miner-lagging]')) {
        expect(minerLine, `miner-lagging* inside hostile-lagging namespace: ${minerLine}`).toContain(laggingNs);
      } else {
        expect(minerLine, `miner inside pub1 namespace: ${minerLine}`).toContain(pub1Ns);
      }
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — pub1 binds 443 and 80, dns-log binds 53,
  // the browser profile is a user; the per-namespace sysctl lifts the
  // unprivileged-port floor to 0 inside pub1, dns-log and browser alone.
  it('the ip_unprivileged_port_start sysctl is set inside pub1 and dns-log', () => {
    runDryOnce();
    for (const host of ['pub1', 'dns-log']) {
      const re = new RegExp(`ip netns exec notismesh-${host} sysctl -w net\\.ipv4\\.ip_unprivileged_port_start=0`);
      expect(out, `pattern for ${host}`).toMatch(re);
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — the browser host's resolver, nft counter,
  // Chromium launch and the page server are part of the dry-run.
  it('the browser host carries resolver, nft counter, page-server and Chromium', () => {
    runDryOnce();
    expect(out, 'resolv.conf write').toContain('/etc/netns/notismesh-browser/resolv.conf');
    expect(out, 'nft dns_witness counter').toContain('dns_witness');
    expect(out, 'page-server spawn').toContain('[spawn:page-server]');
    expect(out, 'chromium spawn').toContain('[spawn:chromium]');
  }, 30_000);

  // MESH_INTERFACE → Acceptance / The client's node list — scenario
  // 6b's step needs `hostile-lagging`'s mesh node to answer the
  // browser so a valid proof of a lighter chain lands as `behind` and
  // never `blacklisted`. An output `policy drop` would drop the mesh
  // node's replies too — the mesh client would read it as unreachable
  // (`retry`), never `behind`. The cut drops only TCP to/from the
  // Notis p2p port, and nothing else.
  it('the hostile-lagging cut is Notis-p2p-only, not an output-drop policy', () => {
    runDryOnce();
    const lagLines = out.split('\n').filter((l) => l.includes('lag_cut'));
    expect(lagLines.length, 'the cut has at least one rule').toBeGreaterThan(0);
    const joined = lagLines.join('\n');
    expect(joined, 'the cut has no output-drop policy').not.toMatch(/policy\s+drop/);
    expect(joined, 'the cut drops TCP to the Notis p2p port').toMatch(/tcp\s+dport\s+9100.*drop/);
    expect(joined, 'the cut drops TCP from the Notis p2p port').toMatch(/tcp\s+sport\s+9100.*drop/);
  }, 30_000);

  // MESH_INTERFACE → Acceptance 8 — a node on another chain has its
  // proof read when its tip moves, with the client's own, and the
  // client's tip stays the honest chain's / MINING_INTERFACE → "The
  // peer-readiness gate" — the hostile fork pair grows a chain of
  // its own from genesis: each pair host names the partner ALONE in
  // `BOOTSTRAP_PEERS` (no pub1), so the pair never dials an honest
  // node and never sees the honest chain's blocks.
  it("the pair hostiles' Notis BOOTSTRAP_PEERS names the partner alone (no pub1)", () => {
    runDryOnce();
    const spawnLines = out.split('\n').filter((l) => l.startsWith('[spawn:notis:'));
    expect(spawnLines.length, 'at least one notis spawn').toBeGreaterThan(0);
    const pairAddrs: Record<string, string> = {
      'hostile-lagging': '/ip4/11.100.0.31/tcp/9100',
      'hostile-malformed': '/ip4/11.100.0.33/tcp/9100',
    };
    for (const name of Object.keys(pairAddrs)) {
      const line = spawnLines.find((l) => l.startsWith(`[spawn:notis:${name}]`));
      expect(line, `pair notis spawn: ${name}`).toBeDefined();
      const m = /BOOTSTRAP_PEERS=([^\s]+)/.exec(line!);
      expect(m, `BOOTSTRAP_PEERS present on ${name}`).not.toBeNull();
      const value = m![1]!;
      expect(value, `${name} names the partner alone`).toBe(pairAddrs[name]);
      expect(value, `${name} does NOT name pub1`).not.toContain('/ip4/11.100.0.11/');
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance 8 — a node on another chain has its
  // proof read when its tip moves, with the client's own, and the
  // client's tip stays the honest chain's — the pair cut runs the
  // same seven-rule ruleset on both hosts, with the accept rule for
  // the partner's p2p address sitting ahead of the drop on both the
  // output and input chain. nft reads rules in
  // order, so a drop before the accept would cut the pair's own
  // traffic too and the lagging miner would be back to one Active
  // peer: none.
  it('the lag_cut carries an accept rule for the partner\'s p2p addr ahead of the drop on both hosts', () => {
    runDryOnce();
    const lines = out.split('\n');
    const partnerFor: Record<string, string> = {
      'hostile-lagging': '11.100.0.31',
      'hostile-malformed': '11.100.0.33',
    };
    for (const host of ['hostile-lagging', 'hostile-malformed']) {
      const partner = partnerFor[host]!;
      const nsFragment = `ip netns exec notismesh-${host} nft add rule ip lag_cut`;
      const outAcceptIdx = lines.findIndex((l) =>
        l.includes(nsFragment) &&
        l.includes(` out ip daddr ${partner} `) &&
        l.includes(' accept'));
      const inAcceptIdx = lines.findIndex((l) =>
        l.includes(nsFragment) &&
        l.includes(` in ip saddr ${partner} `) &&
        l.includes(' accept'));
      const outDropIdx = lines.findIndex((l) =>
        l.includes(nsFragment) &&
        /\bout tcp dport 9100 drop\b/.test(l));
      const inDropIdx = lines.findIndex((l) =>
        l.includes(nsFragment) &&
        /\bin tcp sport 9100 drop\b/.test(l));
      expect(outAcceptIdx, `${host}: out-accept present`).toBeGreaterThanOrEqual(0);
      expect(inAcceptIdx, `${host}: in-accept present`).toBeGreaterThanOrEqual(0);
      expect(outDropIdx, `${host}: out-drop present`).toBeGreaterThanOrEqual(0);
      expect(inDropIdx, `${host}: in-drop present`).toBeGreaterThanOrEqual(0);
      expect(outAcceptIdx, `${host}: out-accept before out-drop`).toBeLessThan(outDropIdx);
      expect(inAcceptIdx, `${host}: in-accept before in-drop`).toBeLessThan(inDropIdx);
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — identity waits run before the height
  // wait so a mesh crash fails `up` at once rather than after the
  // 10-minute height wait.
  it('each public mesh node\'s identity wait appears before the height wait', () => {
    runDryOnce();
    const lines = out.split('\n');
    const identityIdx = lines.findIndex((l) => l.startsWith('[wait] each public mesh node prints its identity line'));
    const heightIdx = lines.findIndex((l) => l.startsWith('[wait] every honest node reads /blocks/current.height'));
    expect(identityIdx, 'identity wait present').toBeGreaterThanOrEqual(0);
    expect(heightIdx, 'height wait present').toBeGreaterThanOrEqual(0);
    expect(identityIdx, 'identity wait precedes height wait').toBeLessThan(heightIdx);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — Chromium's housekeeping (safebrowsing,
  // sync, component updates) resolves names and the DNS log catches them;
  // scenario 1 measures the PAGE's DNS traffic, so the browser's own
  // background networking is off. The flags are listed in Chromium's
  // `--help` on this build (ms-playwright chromium-1228, Chromium ≥ 139).
  it('Chromium is launched with background networking disabled', () => {
    runDryOnce();
    const line = out.split('\n').find((l) => l.startsWith('[spawn:chromium]'));
    expect(line, 'chromium spawn is in the dry-run').toBeDefined();
    for (const flag of [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-client-side-phishing-detection',
      '--disable-domain-reliability',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-default-browser-check',
    ]) {
      expect(line, `chromium carries ${flag}`).toContain(flag);
    }
    // The feature-disable flag names three features in one. The entire
    // argument is a single switch; test with its full value.
    expect(line, 'chromium disables OptimizationHints, MediaRouter and Translate').toMatch(/--disable-features=[A-Za-z0-9,]*OptimizationHints/);
    expect(line).toMatch(/--disable-features=[A-Za-z0-9,]*MediaRouter/);
    expect(line).toMatch(/--disable-features=[A-Za-z0-9,]*Translate/);
  }, 30_000);

  // MESH_INTERFACE → Acceptance 8 — the pair's chain grows from
  // genesis, so `miner-lagging` has its own boot phase at
  // `MINER_PCT=100` on `hostile-lagging` (as the honest boot does
  // on pub1), swapped to `MINER_PCT=1` after the pair's node reads
  // height ≥ 50. The pair's duty is HALF the honest chain's steady,
  // so the pair's chain stays lighter.
  it('the pair carries its own boot miner at 100 %, then miner-lagging at 1 %, with a pair height wait between', () => {
    runDryOnce();
    const lines = out.split('\n');
    const laggingBootIdx = lines.findIndex((l) => l.startsWith('[spawn:miner-lagging-boot]') && /MINER_PCT=100\b/.test(l));
    const pairWaitIdx = lines.findIndex((l) => l.startsWith('[wait]') && /pair's node/.test(l) && /\/blocks\/current.height/.test(l) && />=\s*50/.test(l));
    const laggingSteadyIdx = lines.findIndex((l, i) =>
      i > pairWaitIdx &&
      l.startsWith('[spawn:miner-lagging]') &&
      /MINER_PCT=1\b/.test(l),
    );
    expect(laggingBootIdx, 'miner-lagging-boot at 100 % is in the dry-run').toBeGreaterThanOrEqual(0);
    expect(pairWaitIdx, 'pair height wait is in the dry-run').toBeGreaterThan(laggingBootIdx);
    expect(laggingSteadyIdx, 'miner-lagging at 1 % follows the pair height wait').toBeGreaterThan(pairWaitIdx);
  }, 30_000);

  // MESH_INTERFACE → NAT → "A public node announces its listen addresses
  // from the start" / MINING_INTERFACE → The peer-readiness gate — a node
  // that seeds from another dials its seed on boot; a dial on a listener
  // that is not up yet lands on `ECONNREFUSED`, and `net` redials a seed
  // only at its next outbound tick, 30 s on, after a 60 s cooldown. So
  // phase 7 starts each seed before the nodes that seed from it: pub1
  // and pub2 before every non-pair node (`BOOTSTRAP_PEERS` names the
  // publics), with each public's identity line awaited between.
  it("phase 7 starts pub1 and pub2 before the nodes that seed from them, with the identity wait between", () => {
    runDryOnce();
    const lines = out.split('\n');
    const spawnIdxOf = (name: string): number => lines.findIndex((l) => l.startsWith(`[spawn:notis:${name}]`));
    const pub1Idx = spawnIdxOf('pub1');
    const pub2Idx = spawnIdxOf('pub2');
    expect(pub1Idx, 'pub1 notis spawn is in the dry-run').toBeGreaterThanOrEqual(0);
    expect(pub2Idx, 'pub2 notis spawn is in the dry-run').toBeGreaterThanOrEqual(0);
    // The ordered identity waits sit between consecutive serial spawns —
    // `pub1` reads its identity line before `pub2` is started, and `pub2`
    // reads its identity line before any non-pair seed-from-publics host.
    const pub1WaitIdx = lines.findIndex(
      (l, i) => i > pub1Idx && l.startsWith('[wait]') && /\bpub1\b.*identity line/.test(l),
    );
    const pub2WaitIdx = lines.findIndex(
      (l, i) => i > pub2Idx && l.startsWith('[wait]') && /\bpub2\b.*identity line/.test(l),
    );
    expect(pub1WaitIdx, 'pub1 identity wait sits between pub1 and pub2').toBeGreaterThan(pub1Idx);
    expect(pub1WaitIdx, 'pub1 identity wait precedes pub2 spawn').toBeLessThan(pub2Idx);
    expect(pub2WaitIdx, 'pub2 identity wait follows pub2 spawn').toBeGreaterThan(pub2Idx);
    // Every non-pair, seed-from-publics host spawns AFTER both publics.
    for (const name of ['hostile-invalid', 'hostile-publisher', 'priv1', 'priv2', 'lan1']) {
      const idx = spawnIdxOf(name);
      expect(idx, `${name} notis spawn is in the dry-run`).toBeGreaterThanOrEqual(0);
      expect(idx, `${name} spawns after pub1`).toBeGreaterThan(pub1Idx);
      expect(idx, `${name} spawns after pub2`).toBeGreaterThan(pub2Idx);
      expect(idx, `${name} spawns after pub2's identity wait`).toBeGreaterThan(pub2WaitIdx);
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance 8 — the hostile fork pair seeds each
  // other (`BOOTSTRAP_PEERS` names the partner alone), so one has to be
  // listening before the other dials it. MINING_INTERFACE → The
  // peer-readiness gate — `hostile-lagging`'s miner only produces
  // templates when the node holds at least one Active peer. Start
  // `hostile-malformed` first (no miner, boots quickly and listens);
  // `hostile-lagging` second, so its miner finds an Active peer at
  // once instead of waiting out `net`'s 60 s dial cooldown.
  it("the hostile pair starts hostile-malformed before hostile-lagging, with the identity wait between", () => {
    runDryOnce();
    const lines = out.split('\n');
    const malformedIdx = lines.findIndex((l) => l.startsWith('[spawn:notis:hostile-malformed]'));
    const laggingIdx = lines.findIndex((l) => l.startsWith('[spawn:notis:hostile-lagging]'));
    expect(malformedIdx, 'hostile-malformed notis spawn is in the dry-run').toBeGreaterThanOrEqual(0);
    expect(laggingIdx, 'hostile-lagging notis spawn is in the dry-run').toBeGreaterThanOrEqual(0);
    expect(malformedIdx, 'hostile-malformed starts before hostile-lagging').toBeLessThan(laggingIdx);
    const malformedWaitIdx = lines.findIndex(
      (l, i) => i > malformedIdx && l.startsWith('[wait]') && /hostile-malformed.*identity line/.test(l),
    );
    expect(malformedWaitIdx, 'hostile-malformed identity wait sits between pair hosts').toBeGreaterThan(malformedIdx);
    expect(malformedWaitIdx, 'hostile-malformed identity wait precedes hostile-lagging spawn').toBeLessThan(laggingIdx);
  }, 30_000);

  // MESH_INTERFACE → Acceptance 6 — a later phase or step reads a chain
  // from every honest node AND from each hostile-upstream host (the
  // interposer reads its own node's `/nipopow/proof/*` and
  // `/blocks/current`). The height gate has to hold the whole set, each
  // on its own chain: `hostile-invalid` on the honest chain (its
  // `BOOTSTRAP_PEERS` names the publics); `hostile-malformed` on the
  // pair chain (`BOOTSTRAP_PEERS` names `hostile-lagging` alone, the
  // pair runs its own chain from genesis). Without them, the live
  // check in phase 9 lands on a host whose `/blocks/current` the gate
  // never confirmed — the shape that read `hostile-upstream:hostile-invalid
  // did not answer http://127.0.0.1:7000/nipopow/proof/24/20` in the
  // 2026-11-04 stage.
  it("the height gate names hostile-invalid on the honest chain and hostile-malformed on the pair chain", () => {
    runDryOnce();
    const lines = out.split('\n');
    const honestWait = lines.find((l) => l.startsWith('[wait] every honest node reads /blocks/current.height'));
    const pairWait = lines.find((l) => l.startsWith("[wait] the pair's node reads /blocks/current.height"));
    expect(honestWait, 'honest height wait is in the dry-run').toBeDefined();
    expect(pairWait, 'pair height wait is in the dry-run').toBeDefined();
    expect(honestWait!, 'honest height wait names hostile-invalid').toMatch(/\bhostile-invalid\b/);
    for (const name of ['pub1', 'pub2', 'priv1', 'priv2', 'lan1']) {
      expect(honestWait!, `honest height wait names ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(pairWait!, 'pair height wait names hostile-lagging').toMatch(/\bhostile-lagging\b/);
    expect(pairWait!, 'pair height wait names hostile-malformed').toMatch(/\bhostile-malformed\b/);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — a sustained 100 % duty on `pub1`'s
  // miner burns a core for every minute the stage is up. After the
  // height wait, the miner is restarted at a gentle duty so the chain
  // keeps growing for `hostile-lagging` to fall behind of but does not
  // starve the host.
  it('the miner is restarted at a gentle duty after the height wait', () => {
    runDryOnce();
    const lines = out.split('\n');
    const bootIdx = lines.findIndex((l) => l.startsWith('[spawn:miner') && /MINER_PCT=100\b/.test(l));
    const waitIdx = lines.findIndex((l) => l.startsWith('[wait] every honest node reads /blocks/current.height'));
    const steadyIdx = lines.findIndex((l, i) =>
      i > waitIdx &&
      l.startsWith('[spawn:miner') &&
      /MINER_PCT=(?:[1-9]|1\d|2\d)\b/.test(l) &&
      !/MINER_PCT=100\b/.test(l),
    );
    expect(bootIdx, 'boot miner at 100 % is in the dry-run').toBeGreaterThanOrEqual(0);
    expect(waitIdx, 'height wait is in the dry-run').toBeGreaterThan(bootIdx);
    expect(steadyIdx, 'steady miner at a lower duty follows the height wait').toBeGreaterThan(waitIdx);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — "a hostile host's lie outside the node
  // it runs". Each hostile-upstream host runs its own Notis node; the
  // interposer forwards to that node at the namespace's own address, not
  // loopback — the `ip daddr 127.0.0.1` redirect rule the node's mesh
  // endpoint lands on is scoped to loopback, so the interposer reaching
  // the node at `<host.addr>` is free of it.
  it("every hostile-upstream host carries its own Notis node; its interposer forwards to the node at the namespace's own address", () => {
    runDryOnce();
    const hostAddrs: Record<string, string> = {
      'hostile-malformed': '11.100.0.31',
      'hostile-invalid': '11.100.0.32',
    };
    for (const host of Object.keys(hostAddrs)) {
      const notisSpawn = out.split('\n').find((l) => l.startsWith(`[spawn:notis:${host}]`));
      expect(notisSpawn, `[spawn:notis:${host}] is in the dry-run`).toBeDefined();
      expect(notisSpawn, `${host}'s Notis node runs inside its own namespace`).toContain(`ip netns exec notismesh-${host}`);
      const hostileSpawn = out.split('\n').find((l) => l.startsWith(`[spawn:hostile-upstream:${host}]`));
      expect(hostileSpawn, `[spawn:hostile-upstream:${host}] is in the dry-run`).toBeDefined();
      const addr = hostAddrs[host]!;
      expect(hostileSpawn, `${host}'s interposer forwards to the ns address`).toMatch(
        new RegExp(`PUB1_BASE=http://${addr.replace(/\./g, '\\.')}:\\d+\\b`),
      );
      expect(hostileSpawn, `${host}'s interposer does not forward to loopback`).not.toMatch(/PUB1_BASE=http:\/\/127\.0\.0\.1\b/);
    }
  }, 30_000);

  // MESH_INTERFACE → Block gossip → "A router scores its peers by
  // gossipsub's defaults" — Chromium's own start page is where every
  // scenario's cdp.mjs opens its targets from; if it loads the stage
  // page itself, that start-page client stays in the gossip mesh for
  // the whole run. Starting Chromium on `about:blank` keeps the start
  // page out of the mesh — scenarios open their own targets at the
  // stage URL as before.
  it('Chromium starts on about:blank, not the stage page', () => {
    runDryOnce();
    const line = out.split('\n').find((l) => l.startsWith('[spawn:chromium]'));
    expect(line, 'chromium spawn is in the dry-run').toBeDefined();
    expect(line, 'chromium starts on about:blank').toContain(' about:blank');
    expect(line, 'chromium does not open the stage page at launch')
      .not.toMatch(/\bhttp:\/\/localhost:\d+\/(?:\s|$)/);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — scenario 1 runs with the browser's own
  // resolver answering nothing. Chromium's `--host-resolver-rules` reads
  // one rule, and `MAP * ~NOTFOUND , EXCLUDE localhost` tells Chromium
  // to refuse every host but `localhost` (the page itself is at
  // `http://localhost:80/`); every ICE server, every bootstrap address
  // and every background query of the browser's own that goes by name
  // fails before touching DNS, so the DNS log holds only what went
  // around Chromium's resolver.
  it("Chromium carries --host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost", () => {
    runDryOnce();
    const line = out.split('\n').find((l) => l.startsWith('[spawn:chromium]'));
    expect(line, 'chromium spawn is in the dry-run').toBeDefined();
    expect(line, 'the resolver rule is on the Chromium line').toContain(
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost',
    );
  }, 30_000);

  // MESH_INTERFACE → Acceptance — Chromium's quiet set from Playwright and
  // Puppeteer, not Chromium's own `--help` listing. Playwright's switches
  // live at `playwright-core/src/server/chromium/chromiumSwitches.ts` and
  // Puppeteer's at `packages/puppeteer-core/src/node/ChromeLauncher.ts`;
  // the stage adopts the quiet set both tools pass by default.
  it('Chromium carries the quiet switches Playwright and Puppeteer set by default', () => {
    runDryOnce();
    const line = out.split('\n').find((l) => l.startsWith('[spawn:chromium]'));
    expect(line, 'chromium spawn is in the dry-run').toBeDefined();
    for (const flag of [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-breakpad',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--force-color-profile=srgb',
      '--password-store=basic',
      '--use-mock-keychain',
      '--no-service-autorun',
    ]) {
      expect(line, `chromium carries ${flag}`).toContain(flag);
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — before `stage up:` is printed, `up`
  // live-checks every long-lived process on `pids.json`. A `[live-check]`
  // record names what is checked (every PID alive, every listener
  // reachable), so a reader of the dry-run sees the invariant without
  // waiting for the run to show it.
  it('up live-checks every pids.json entry before printing stage up', () => {
    runDryOnce();
    const liveCheckIdx = out.split('\n').findIndex((l) => l.startsWith('[live-check]'));
    expect(liveCheckIdx, '[live-check] is in the dry-run').toBeGreaterThanOrEqual(0);
    const chromiumIdx = out.split('\n').findIndex((l) => l.startsWith('[spawn:chromium]'));
    expect(liveCheckIdx, 'live-check follows every spawn').toBeGreaterThan(chromiumIdx);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — the Pebble v2.8.0 tarball records the
  // binary as mode 0644 (no execute bit). The release's own `tar tvzf`
  // shows `-rw-r--r--`; extracting it leaves `env` unable to run it, so
  // `up` has to set the mode after the checksum passes and the tar runs.
  // The chmod step must appear after `sha256sum --check`.
  it('up chmods the Pebble binary 0755 after the sha256sum check', () => {
    runDryOnce();
    const lines = out.split('\n');
    const shaIdx = lines.findIndex((l) => /echo .* sha256sum --check/.test(l));
    expect(shaIdx, 'sha256sum --check is in the dry-run').toBeGreaterThanOrEqual(0);
    const chmodIdx = lines.findIndex((l, i) => i > shaIdx && /chmod\b.*(?:0?755|\+x).*pebble-linux-amd64\/linux\/amd64\/pebble/.test(l));
    expect(chmodIdx, 'chmod 0755 on the Pebble binary appears after sha256sum').toBeGreaterThan(shaIdx);
  }, 30_000);

  // MESH_INTERFACE → Acceptance 8 — the pair cut runs BEFORE either
  // pair host's Notis node spawns, so the pair's p2p port never sees
  // a packet from an honest host and the pair grows its own chain
  // from genesis.
  it('the pair cut appears BEFORE every pair Notis node spawn', () => {
    runDryOnce();
    const lines = out.split('\n');
    const firstCutIdx = lines.findIndex((l) => l.includes('lag_cut'));
    const pairLagging = lines.findIndex((l) => l.startsWith('[spawn:notis:hostile-lagging]'));
    const pairMalformed = lines.findIndex((l) => l.startsWith('[spawn:notis:hostile-malformed]'));
    expect(firstCutIdx, 'pair cut is in the dry-run').toBeGreaterThanOrEqual(0);
    expect(pairLagging, 'pair notis spawn (lagging) is in the dry-run').toBeGreaterThan(firstCutIdx);
    expect(pairMalformed, 'pair notis spawn (malformed) is in the dry-run').toBeGreaterThan(firstCutIdx);
  }, 30_000);

  // MESH_INTERFACE → The IP certificate — the Pebble root fetch has to reach
  // Pebble's management port; the host has no route into the stage, so the
  // fetch runs inside a stage namespace (`notismesh-browser` reaches the
  // internet segment through natC's masquerade).
  it('the Pebble root fetch runs inside a stage namespace', () => {
    runDryOnce();
    const line = out.split('\n').find((l) => l.includes('curl') && l.includes('/roots/0'));
    expect(line, 'pebble root fetch is in the dry-run').toBeDefined();
    expect(line, `pebble root fetch runs in a namespace: ${line}`).toMatch(/ip netns exec notismesh-/);
  }, 30_000);

  // MESH_INTERFACE → The IP certificate — `certutil -N` creates the NSS
  // database. Running it unconditionally with `|| true` would swallow every
  // failure; create it only when `cert9.db` is absent, and let a real
  // failure stop `up`.
  it('certutil -N only runs when cert9.db is absent, and never swallows failure', () => {
    runDryOnce();
    const line = out.split('\n').find((l) => l.includes('certutil') && l.includes(' -N '));
    expect(line, 'certutil -N is in the dry-run').toBeDefined();
    expect(line, `certutil -N is guarded by a cert9.db test: ${line}`).toMatch(/test -f .*cert9\.db/);
    expect(line, `certutil -N does not swallow failure: ${line}`).not.toMatch(/\|\|\s*true/);
    expect(line, `certutil -N does not throw stderr away: ${line}`).not.toMatch(/2>\s*\/dev\/null/);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — every wait the exec path performs appears
  // in the dry-run as a `[wait]` line, so a reader of the dry-run sees what
  // the real `up` is going to block on.
  it('every wait the exec path performs appears in the dry-run', () => {
    runDryOnce();
    const waits = out.split('\n').filter((l) => l.startsWith('[wait] '));
    const joined = waits.join('\n');
    expect(joined, 'the Pebble directory wait').toMatch(/\[wait\].*pebble.*\/dir/i);
    expect(joined, 'the mesh multiaddr wait').toMatch(/\[wait\].*multiaddr/i);
    expect(joined, 'the height wait').toMatch(/\[wait\].*\/blocks\/current.*>=\s*50/);
    expect(joined, 'the page-server wait').toMatch(/\[wait\].*page.*server/i);
    expect(joined, 'the CDP wait').toMatch(/\[wait\].*(?:cdp|chromium)/i);
  }, 30_000);

  // Linux IFNAMSIZ is 16 — an interface name must fit in 15 bytes plus a
  // trailing NUL. A name over 15 bytes (such as `vp-hostile-malformed`
  // at 20) crashes `ip link add` with status 255. Every `v-X`, `vp-X`,
  // `br-X-in` token the stage uses is ≤ 15 bytes.
  it('every interface name in the dry-run is ≤ 15 bytes', () => {
    runDryOnce();
    const names = new Set<string>();
    const re = /\b(v-[a-zA-Z0-9_-]+|vp-[a-zA-Z0-9_-]+|br-[a-zA-Z0-9_-]+)\b/g;
    for (const line of out.split('\n')) {
      // Skip the config.json preview — the multiaddrs it carries read as
      // tokens but are not interface names.
      if (line.startsWith('{') || line.startsWith(' ')) continue;
      for (const m of line.matchAll(re)) {
        names.add(m[1]!);
      }
    }
    const oversize = [...names].filter((n) => Buffer.byteLength(n, 'utf8') > 15);
    expect(oversize, `interface names over 15 bytes: ${oversize.join(', ')}`).toEqual([]);
  }, 30_000);

  // The same interface name may appear in two namespaces (one end in each),
  // but inside a single namespace the kernel refuses two with the same
  // name. Group tokens by their namespace (the `ip -n <ns>` prefix of the
  // line they are first bound in, or `ip netns exec <ns>` for nft rules)
  // and assert uniqueness.
  it('every interface name is unique within its namespace', () => {
    runDryOnce();
    const perNs = new Map<string, Set<string>>();
    const nameRe = /\b(v-[a-zA-Z0-9_-]+|vp-[a-zA-Z0-9_-]+|br-[a-zA-Z0-9_-]+)\b/g;
    for (const line of out.split('\n')) {
      if (line.startsWith('{') || line.startsWith(' ')) continue;
      // The `-n <ns>` form (`ip -n notismesh-pub1 link ...`) binds a name
      // in `<ns>`. `ip netns exec <ns>` runs a command in `<ns>` and may
      // reference its interfaces.
      const nMatch = /ip\s+(?:-n|netns\s+exec)\s+(notismesh-\S+)/.exec(line);
      if (!nMatch) continue;
      const ns = nMatch[1]!;
      // The `netns <other-ns>` tail on `link add ... peer name <peer-name>
      // netns <other-ns>` places the peer in `<other-ns>`, so bucket it
      // there.
      const peerMatch = /peer\s+name\s+(\S+)\s+netns\s+(notismesh-\S+)/.exec(line);
      if (peerMatch) {
        const peer = peerMatch[1]!;
        const peerNs = peerMatch[2]!;
        const peerBucket = perNs.get(peerNs) ?? new Set<string>();
        if (peerBucket.has(peer)) {
          throw new Error(`duplicate interface in ${peerNs}: ${peer} on line "${line}"`);
        }
        peerBucket.add(peer);
        perNs.set(peerNs, peerBucket);
      }
      // The locally-bound names (every other token in the line, excluding
      // the peer name that lives in another namespace).
      const bucket = perNs.get(ns) ?? new Set<string>();
      for (const m of line.matchAll(nameRe)) {
        const n = m[1]!;
        if (peerMatch && n === peerMatch[1]) continue;
        // `ip -n <ns> link add X ...` and `ip -n <ns> link set X ...`
        // both reference the same name; only the first binds, the rest
        // operate. Skip operational references.
        if (!/link\s+add\s+\S+/.test(line.slice(0, line.indexOf(n) + n.length))) continue;
        if (bucket.has(n)) {
          throw new Error(`duplicate interface in ${ns}: ${n} on line "${line}"`);
        }
        bucket.add(n);
      }
      perNs.set(ns, bucket);
    }
    // At least one bucket must hold at least one name — otherwise the
    // regex missed everything.
    const total = [...perNs.values()].reduce((n, s) => n + s.size, 0);
    expect(total, 'parser must find some interface names').toBeGreaterThan(0);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — every `nft` command the dry-run prints,
  // grouped per namespace into one ruleset in order, passes `nft -c` (check
  // mode, no state change). `unshare -rn` creates an unprivileged user +
  // network namespace, so the check runs without root. On a kernel that
  // disallows unprivileged user namespaces, the case skips with the
  // reason — never silently passes.
  it('every nft ruleset passes nft -c under unshare -rn', () => {
    runDryOnce();
    // Preflight: can we even open an unprivileged user namespace here?
    const preflight = spawnSync('unshare', ['-rn', 'true'], { encoding: 'utf8', timeout: 5_000 });
    if (preflight.status !== 0) {
      const reason = (preflight.stderr || preflight.stdout || `exit ${preflight.status}`).trim();
      // vitest 1.x has no `it.skip` reason inside the callback; log the
      // reason so a CI reader sees why the suite accepted this run.
      process.stdout.write(`[skip] nft ruleset case: unshare -rn is not available (${reason})\n`);
      expect(true).toBe(true);
      return;
    }

    // Group each `[privileged] sudo ip netns exec <ns> nft add ...` line
    // by `<ns>`, strip the privileged + sudo wrapper, concatenate into
    // one ruleset per namespace, and check with `nft -c`.
    const perNs = new Map<string, string[]>();
    for (const raw of out.split('\n')) {
      const m = /^\[privileged\] sudo ip netns exec (notismesh-\S+) nft (add .+)$/.exec(raw);
      if (!m) continue;
      const [, ns, rule] = m;
      const bucket = perNs.get(ns!) ?? [];
      bucket.push(rule!);
      perNs.set(ns!, bucket);
    }
    expect(perNs.size, 'at least one nft ruleset').toBeGreaterThan(0);
    const tmpDir = mkdtempSync(join(tmpdir(), 'mesh-nft-'));
    const failures: Array<{ ns: string; stderr: string; ruleset: string }> = [];
    try {
      for (const [ns, rules] of perNs) {
        const file = join(tmpDir, `${ns}.nft`);
        const ruleset = rules.join('\n') + '\n';
        writeFileSync(file, ruleset);
        const r = spawnSync('unshare', ['-rn', 'nft', '-c', '-f', file], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        if (r.status !== 0) {
          failures.push({ ns, stderr: (r.stderr || r.stdout || '').trim(), ruleset });
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `  ${f.ns}:\n    stderr: ${f.stderr}\n    ruleset:\n      ${f.ruleset.split('\n').join('\n      ')}`)
        .join('\n');
      throw new Error(`nft -c refused these rulesets:\n${detail}`);
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — a failed `up` runs its own teardown
  // unless `--keep-on-failure` is given. A dry-run with
  // `--simulate-failure-after=<N>` aborts after N steps, prints the
  // failure line, and lists the teardown commands (kill lines for any
  // spawn recorded, `ip netns delete` for every namespace it had created,
  // `rm -rf /etc/netns/...`).
  it('a dry-run forced to fail prints its teardown', () => {
    const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run', '--simulate-failure-after=20'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(res.status, `exit code (stderr: ${res.stderr})`).toBe(0);
    const stdout = res.stdout;
    expect(stdout, 'failure line').toMatch(/\[failure\].*simulated failure after step 20/);
    expect(stdout, 'teardown header').toContain('[teardown]');
    // Six namespaces were created in the first 20 commands (the bridge
    // namespace + its first link ops bring us past step 7, then one host's
    // ns per 7 commands or so — 20 commands pass the first few
    // namespaces). The teardown lists `ip netns delete` for each one it
    // had created.
    const deleteLines = stdout.split('\n').filter((l) => /ip netns delete notismesh-/.test(l));
    expect(deleteLines.length, 'teardown deletes the namespaces up had created').toBeGreaterThan(0);
    // No namespace that was not yet created is "undone" — the teardown
    // only names what up itself recorded.
    expect(stdout, 'teardown report').toMatch(/\[teardown complete\]/);
  }, 30_000);
});

// MESH_INTERFACE → Acceptance — "each host one devnet `@dagsocial/node` run
// with a mesh role, a hostile host's lie outside the node it runs". The
// mesh service collapses into the node: every `[spawn:mesh:*]` goes away,
// the node reads the mapped `MESH_*` settings (`NODE_INTERFACE →
// Configuration`), and a hostile host's lie sits outside the node — an
// interposer in the ns at `127.0.0.1:7000`, an nft `nat output` redirect
// rule the node's own loopback forward lands on.
describe('stage up --dry-run — one node per host, no mesh service', () => {
  let out = '';
  function runDryOnce(): void {
    if (out !== '') return;
    const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (res.status !== 0) throw new Error(`up --dry-run exit ${res.status}: ${res.stderr}`);
    out = res.stdout;
  }

  // NODE_INTERFACE → Configuration → "A mesh node prints its identity line" —
  // the mesh service's spawn line is retired because the node is the mesh
  // node. A `[spawn:mesh:*]` line means phase 7 still runs the separate
  // service.
  it('no [spawn:mesh:*] line appears — the mesh service collapses into the node', () => {
    runDryOnce();
    // Control: the dry-run produced output and at least one notis spawn.
    expect(out.length, 'stdout non-empty (control)').toBeGreaterThan(0);
    const notisLines = out.split('\n').filter((l) => l.startsWith('[spawn:notis:'));
    expect(notisLines.length, 'at least one [spawn:notis:*] (control)').toBeGreaterThan(0);
    // The target shape.
    const meshLines = out.split('\n').filter((l) => l.startsWith('[spawn:mesh:'));
    expect(meshLines, `mesh service spawns remain: ${meshLines.join('\n')}`).toEqual([]);
  }, 30_000);

  // NODE_INTERFACE → Configuration — "`MESH_ROLE` … `public` or `private`;
  // unset, the node runs no mesh". The node reads the mesh listens and the
  // STUN setting from its own `MESH_*` env, and the stage maps each public
  // host's listen set accordingly.
  it('a notis spawn on a mesh-public host carries MESH_ROLE=public and the mapped MESH_LISTEN', () => {
    runDryOnce();
    const pub1Line = out.split('\n').find((l) => l.startsWith('[spawn:notis:pub1]'));
    expect(pub1Line, 'pub1 notis spawn line (control)').toBeDefined();
    // Control: the current env already carries NETWORK_TYPE=devnet.
    expect(pub1Line!, 'pub1 names NETWORK_TYPE=devnet (control)').toContain('NETWORK_TYPE=devnet');
    // The target shape.
    expect(pub1Line!, 'MESH_ROLE=public set on the node env').toMatch(/\bMESH_ROLE=public\b/);
    expect(pub1Line!, 'MESH_LISTEN names webrtc-direct + tcp on pub1\'s addr').toMatch(
      /\bMESH_LISTEN=\/ip4\/11\.100\.0\.11\/udp\/4001\/webrtc-direct,\/ip4\/11\.100\.0\.11\/tcp\/4002\b/,
    );
  }, 30_000);

  // MESH_INTERFACE → NAT — "a private node … takes a relay reservation on
  // each public node it is told of — its bootstrap peers, by address and
  // id, over the connection `net` holds to each". A private node's circuit
  // listens come from the connection `net` holds to each seed, not from
  // `MESH_LISTEN`. Phase 7 names both publics with their `/p2p/<peerId>`
  // trailers so the seed table carries ids `net` can dial.
  it('BOOTSTRAP_PEERS on a non-pair notis spawn names both publics with /p2p/<peerId>', () => {
    runDryOnce();
    const priv1Line = out.split('\n').find((l) => l.startsWith('[spawn:notis:priv1]'));
    expect(priv1Line, 'priv1 notis spawn line (control)').toBeDefined();
    const m = /BOOTSTRAP_PEERS=([^\s]+)/.exec(priv1Line!);
    expect(m, 'BOOTSTRAP_PEERS present (control)').not.toBeNull();
    const value = m![1]!;
    const peers = value.split(',');
    // The target shape.
    expect(peers.length, `two seeds (pub1 and pub2), got: ${value}`).toBe(2);
    for (const peer of peers) {
      expect(peer, `each seed names /tcp/ and /p2p/<peerId>: ${peer}`).toMatch(
        /\/ip4\/\d[\d.]*\/tcp\/\d+\/p2p\/[A-Za-z0-9]+/,
      );
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — "a hostile host's lie outside the node
  // it runs". An nft `nat output` rule in the hostile namespace redirects
  // `127.0.0.1:<nodePort>` to the interposer's port, so the node's own
  // mesh endpoint forward (to `http://127.0.0.1:<PORT>`) reaches the
  // interposer. The rule goes in BEFORE the node starts.
  it('each hostile-upstream host carries an nft redirect rule before its notis spawn', () => {
    runDryOnce();
    const lines = out.split('\n');
    // Control: the dry-run names the hostile-malformed host.
    const notisIdx = lines.findIndex((l) => l.startsWith('[spawn:notis:hostile-malformed]'));
    expect(notisIdx, 'hostile-malformed notis spawn present (control)').toBeGreaterThan(-1);
    // The target shape: a redirect rule in the hostile ns, sitting ahead
    // of the notis spawn. The rule names either `redirect to :7000` or
    // `dnat to 127.0.0.1:7000` under the nat output hook.
    const redirectIdx = lines.findIndex(
      (l, i) =>
        i < notisIdx &&
        /ip netns exec notismesh-hostile-malformed/.test(l) &&
        /\bnat\b/.test(l) &&
        /(redirect to :7000|dnat to 127\.0\.0\.1:7000)/.test(l),
    );
    expect(
      redirectIdx,
      `redirect rule for hostile-malformed before its notis spawn (lines around notis spawn: ${lines.slice(Math.max(0, notisIdx - 5), notisIdx).join(' | ')})`,
    ).toBeGreaterThan(-1);
  }, 30_000);
});

function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
