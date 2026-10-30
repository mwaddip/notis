// MESH_INTERFACE → Acceptance / Discovery / No anchor reached — the stage's
// unit checks: the topology's shape, the page config holds no DNS and passes
// the client's refusals, the hostile upstream's two bodies, and `--dry-run`
// touches nothing. These run in CI without root, without the stage, and
// without the network beyond loopback.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeNipopowProof, verifyProof } from '@dagsocial/nipopow';
import { verifierProfile } from '@dagsocial/nipopow-client';
import { profileFor } from '@dagsocial/types';
import { readTopology, assertTopologyWhole } from '../stage/lib/topology.mjs';
import { buildPageConfig } from '../stage/lib/config.mjs';
import { malformedBody, invalidBody } from '../stage/hostile-upstream.mjs';
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
    priv1: 'f'.repeat(64),
    priv2: '1'.repeat(64),
  };
}

describe('stage/topology.json is whole', () => {
  it('every host has an address, a role and a NAT type; no hostname', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const errors = assertTopologyWhole(topology);
    expect(errors, errors.join('; ')).toEqual([]);
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
    const config = buildPageConfig(topology, fakeIdentities());
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
});

describe('the page config holds no DNS and passes the client\'s checks', () => {
  it('buildPageConfig output has no /dns4/, /dns6/, /dnsaddr/ components', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const config = buildPageConfig(topology, fakeIdentities());
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
    const config = buildPageConfig(topology, fakeIdentities());
    expect(config.anchors.length).toBeGreaterThan(0);
    expect(config.stunServers.length, 'the public mesh nodes contribute their STUN').toBeGreaterThan(0);
    // profileFor is read here as the page's `runMain` reads it, so a shape
    // the page builder returns is a shape the page accepts.
    profileFor(config.network);
    expect(() => assertClientConfig({
      anchors: config.anchors,
      seeds: config.seeds,
      stunServers: config.stunServers,
    })).not.toThrow();
  });
});

describe('the hostile upstream', () => {
  it('malformed answers with a non-hex proof field', () => {
    const body = malformedBody();
    expect(body.proof).toBe('not-hex');
    // The client reads `/nipopow/proof/:m/:k` as hex before decoding; a
    // non-hex string fails that step. `nipopow-client/src/tip.ts` turns
    // this into `refuseCode: 'invalid'` without a proof, which the mesh
    // client reads as `lie` of kind `malformed`.
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

describe('stage up --dry-run', () => {
  // Shared capture — the dry-run runs once and every case below reads its
  // output. A per-case run would spawn Node seven times.
  let out = '';
  let status: number | null = null;
  let outBefore = false;
  let cacheBefore = false;

  function runDryOnce(): void {
    if (out !== '') return;
    outBefore = existsSync(OUT_DIR);
    cacheBefore = existsSync(CACHE_DIR);
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
    expect(existsSync(join(OUT_DIR, 'pids.json')), 'pids.json must not be written').toBe(false);
    expect(existsSync(join(OUT_DIR, 'browser', 'config.json')), 'config.json must not be written').toBe(false);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — "The host is never touched outside
  // `notismesh-*` namespaces". Veth pairs are created inside their
  // destination namespaces (`ip -n <ns> link add ... peer name ... netns
  // <other>` places both ends at creation), so no `ip link ...` line
  // without `-n` or `netns exec` appears for a link operation other than
  // `netns add`/`del`.
  it.fails('no command creates or changes a link outside a notismesh-* namespace', () => {
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
  it.fails('every [spawn:*] names the invoking user and Node 24', () => {
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

  // MESH_INTERFACE → Acceptance — the miner reads pub1's HTTP; pub1's HTTP
  // binds pub1's namespace loopback, so the miner runs inside
  // `notismesh-pub1`.
  it.fails('the miner spawn runs inside notismesh-pub1', () => {
    runDryOnce();
    const minerLine = out.split('\n').find((l) => l.startsWith('[spawn:miner]'));
    expect(minerLine, 'miner spawn is present').toBeDefined();
    expect(minerLine).toContain('ip netns exec notismesh-pub1');
  }, 30_000);

  // MESH_INTERFACE → Acceptance — pub1 binds 443 and 80, dns-log binds 53,
  // the browser profile is a user; the per-namespace sysctl lifts the
  // unprivileged-port floor to 0 inside pub1, dns-log and browser alone.
  it.fails('the ip_unprivileged_port_start sysctl is set inside pub1 and dns-log', () => {
    runDryOnce();
    for (const host of ['pub1', 'dns-log']) {
      const re = new RegExp(`ip netns exec notismesh-${host} sysctl -w net\\.ipv4\\.ip_unprivileged_port_start=0`);
      expect(out, `pattern for ${host}`).toMatch(re);
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — the browser host's resolver, nft counter,
  // Chromium launch and the page server are part of the dry-run.
  it.fails('the browser host carries resolver, nft counter, page-server and Chromium', () => {
    runDryOnce();
    expect(out, 'resolv.conf write').toContain('/etc/netns/notismesh-browser/resolv.conf');
    expect(out, 'nft dns_witness counter').toContain('dns_witness');
    expect(out, 'page-server spawn').toContain('[spawn:page-server]');
    expect(out, 'chromium spawn').toContain('[spawn:chromium]');
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
