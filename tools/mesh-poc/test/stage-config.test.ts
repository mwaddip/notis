// MESH_INTERFACE → Acceptance / Discovery / No anchor reached — the stage's
// unit checks: the topology's shape, the page config holds no DNS and passes
// the client's refusals, the hostile upstream's two bodies, and `--dry-run`
// touches nothing. These run in CI without root, without the stage, and
// without the network beyond loopback.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  // MESH_INTERFACE → Acceptance — the miner reads pub1's HTTP; pub1's HTTP
  // binds pub1's namespace loopback, so the miner runs inside
  // `notismesh-pub1`.
  it('the miner spawn runs inside notismesh-pub1', () => {
    runDryOnce();
    const minerLine = out.split('\n').find((l) => l.startsWith('[spawn:miner]'));
    expect(minerLine, 'miner spawn is present').toBeDefined();
    expect(minerLine).toContain('ip netns exec notismesh-pub1');
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

  // MESH_INTERFACE → Acceptance / The client's node list — scenario 6b's
  // "behind, never blacklisted" needs `hostile-lagging`'s mesh node to answer
  // the browser (`behind` on a valid proof of a lighter chain). An output
  // `policy drop` would drop the mesh node's replies too — the mesh client
  // would read it as unreachable (`retry`), never `behind`. The cut drops
  // only TCP to/from the Notis p2p port, and nothing else.
  it('the hostile-lagging cut is Notis-p2p-only, not an output-drop policy', () => {
    runDryOnce();
    const lagLines = out.split('\n').filter((l) => l.includes('lag_cut'));
    expect(lagLines.length, 'the cut has at least one rule').toBeGreaterThan(0);
    const joined = lagLines.join('\n');
    expect(joined, 'the cut has no output-drop policy').not.toMatch(/policy\s+drop/);
    expect(joined, 'the cut drops TCP to the Notis p2p port').toMatch(/tcp\s+dport\s+9100.*drop/);
    expect(joined, 'the cut drops TCP from the Notis p2p port').toMatch(/tcp\s+sport\s+9100.*drop/);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — the lag cut only after the height wait, so
  // `hostile-lagging` is behind from a synced start, not from a slow sync
  // that may still be running.
  // MESH_INTERFACE → Discovery / Transports — a mesh node bootstraps from
  // other MESH nodes' addresses, not the Notis p2p port. The TCP mesh
  // port is in the topology; the `/p2p/<peer id>` tail is derived from
  // the public mesh node's notisId. The previous commit's mesh nodes all
  // died with `bootstrap address refused: /ip4/10.100.0.11/tcp/9100 has
  // no /p2p/ component`.
  it('every mesh spawn\'s MESH_BOOTSTRAP names a mesh port with a /p2p/ id, not the Notis p2p port', () => {
    runDryOnce();
    const meshSpawnLines = out.split('\n').filter((l) => l.startsWith('[spawn:mesh:'));
    expect(meshSpawnLines.length, 'at least one mesh spawn').toBeGreaterThan(0);
    for (const line of meshSpawnLines) {
      const m = /MESH_BOOTSTRAP=([^\s]+)/.exec(line);
      expect(m, `MESH_BOOTSTRAP is set on ${line.slice(0, 80)}...`).not.toBeNull();
      const value = m![1]!;
      // Each comma-separated address must carry /p2p/<id>.
      const addrs = value.split(',');
      expect(addrs.length, `at least one bootstrap address: ${value}`).toBeGreaterThan(0);
      for (const addr of addrs) {
        expect(addr, `each bootstrap carries /p2p/: ${addr}`).toMatch(/\/p2p\/[A-Za-z0-9]+$/);
        expect(addr, `no Notis p2p port in bootstrap: ${addr}`).not.toMatch(/\/tcp\/9100\b/);
      }
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — identity waits run before the height
  // wait so a mesh crash fails `up` at once; the previous commit waited
  // for identities only in Phase 9, after the 10-minute height wait.
  it('each public mesh node\'s identity wait appears before the height wait', () => {
    runDryOnce();
    const lines = out.split('\n');
    const identityIdx = lines.findIndex((l) => l.startsWith('[wait] each public mesh node prints its identity line'));
    const heightIdx = lines.findIndex((l) => l.startsWith('[wait] every honest node reads /blocks/current.height'));
    expect(identityIdx, 'identity wait present').toBeGreaterThanOrEqual(0);
    expect(heightIdx, 'height wait present').toBeGreaterThanOrEqual(0);
    expect(identityIdx, 'identity wait precedes height wait').toBeLessThan(heightIdx);
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

  it('the hostile-lagging cut appears after the height wait', () => {
    runDryOnce();
    const lines = out.split('\n');
    const waitIdx = lines.findIndex((l) => l.startsWith('[wait]') && l.includes('/blocks/current.height'));
    const cutIdx = lines.findIndex((l) => l.includes('lag_cut'));
    expect(waitIdx, 'height wait is in the dry-run').toBeGreaterThanOrEqual(0);
    expect(cutIdx, 'lag cut is in the dry-run').toBeGreaterThanOrEqual(0);
    expect(cutIdx, 'cut comes after the wait').toBeGreaterThan(waitIdx);
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
  // trailing NUL. The previous commit's `vp-hostile-malformed` (20 bytes)
  // crashed `ip link add` with status 255. Every `v-X`, `vp-X`, `br-X-in`
  // token the stage uses is ≤ 15 bytes.
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
