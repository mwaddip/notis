// MESH_INTERFACE → Acceptance — the scenario modules' pure parts and
// their dry-run shape: `describe()`, `applyFaults`, `run({dryRun:true})`
// return results without touching the host. The exec-mode flow runs
// on the real stage (not here).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPredicate } from '../stage/cdp.mjs';
import * as s1 from '../stage/scenarios/s1-no-name.mjs';
import * as s2 from '../stage/scenarios/s2-nat.mjs';
import * as s3 from '../stage/scenarios/s3-node-goes-away.mjs';
import * as s4 from '../stage/scenarios/s4-transport-cut.mjs';
import * as s5 from '../stage/scenarios/s5-impersonation.mjs';
import * as s6 from '../stage/scenarios/s6-hostile.mjs';
import * as s7 from '../stage/scenarios/s7-reach-and-load.mjs';
import * as s8 from '../stage/scenarios/s8-prove-once.mjs';

const TOPOLOGY = {
  network: 'devnet',
  hosts: {
    browser: { role: 'browser', nat: 'endpoint-independent', parent: 'natC', addr: '10.103.0.11', veth: 'br', httpPort: 80 },
    pub1: {
      role: 'public', nat: 'none', addr: '10.100.0.11', veth: 'p1',
      mesh: { role: 'public', webrtcPort: 4001, tcpPort: 4002, stunPort: 3478, wss: { port: 443, acmeChallengePort: 5002 } },
      node: { httpPort: 3100, p2pPort: 9100, role: 'miner' },
    },
    pub2: {
      role: 'public', nat: 'none', addr: '10.100.0.12', veth: 'p2',
      mesh: { role: 'public', webrtcPort: 4001, tcpPort: 4002, stunPort: 3478 },
      node: { httpPort: 3100, p2pPort: 9100, role: 'server' },
    },
  },
};

describe('s1 (no name)', () => {
  it('describe() lists five steps: node + two probes + DNS silent + ICE record', () => {
    const names = s1.describe();
    expect(names.length, 'five steps').toBe(5);
    expect(names[0]).toMatch(/anchor within/);
    expect(names[1]).toMatch(/\/blocks\/current/);
    expect(names[2]).toMatch(/\/nipopow\/proof\/24\/20/);
    expect(names[3]).toMatch(/DNS log/);
    expect(names[4]).toMatch(/RTCPeerConnection/);
  });
  it('run({dryRun:true}) returns one result per describe() name, every verdict skipped', async () => {
    const r = await s1.run({ dryRun: true, topology: TOPOLOGY });
    expect(r.scenario).toBe('s1');
    expect(r.steps.length).toBe(5);
    for (const step of r.steps) {
      expect(step.verdict, step.name).toBe('skipped');
      expect(step.measurement).toBe(null);
    }
    // s1 pauses miner-steady with SIGSTOP for the probe window and
    // resumes with SIGCONT in finally (MESH_INTERFACE → Acceptance 1).
    expect(r.faults.some((f: string) => f.includes('miner-steady-pause]') && f.includes('STOP')),
      'STOP record present').toBe(true);
    expect(r.faults.some((f: string) => f.includes('miner-steady-pause]') && f.includes('CONT')),
      'CONT record present').toBe(true);
  });
  it('hostOfNodeId maps a notisId to the host that owns it', () => {
    const identities = {
      pub1: { notisId: 'aa'.repeat(32), meshRole: 'public', addr: '10.100.0.11', httpPort: 3100 },
      pub2: { notisId: 'bb'.repeat(32), meshRole: 'public', addr: '10.100.0.12', httpPort: 3100 },
    };
    expect(s1.hostOfNodeId(identities, 'aa'.repeat(32))).toBe('pub1');
    expect(s1.hostOfNodeId(identities, 'bb'.repeat(32))).toBe('pub2');
    expect(s1.hostOfNodeId(identities, 'cc'.repeat(32))).toBe(null);
    expect(s1.hostOfNodeId(null, 'aa'.repeat(32))).toBe(null);
  });
  it('anchorIdSet reads config.anchors[].notisId into a Set', () => {
    const config = { anchors: [{ notisId: 'a'.repeat(64) }, { notisId: 'b'.repeat(64) }] };
    const s = s1.anchorIdSet(config);
    expect(s.size).toBe(2);
    expect(s.has('a'.repeat(64))).toBe(true);
    expect(s.has('c'.repeat(64))).toBe(false);
  });
});

describe('s3 (node goes away)', () => {
  it('describe() lists four steps: stop, restart, firewall, unfirewall', () => {
    const names = s3.describe();
    expect(names.length).toBe(4);
    expect(names[0]).toMatch(/stopped/);
    expect(names[1]).toMatch(/restarted/);
    expect(names[2]).toMatch(/firewalled/);
    expect(names[3]).toMatch(/unfirewalled/);
  });
  it('run({dryRun:true}) emits the firewall apply + remove and skipped steps', async () => {
    const r = await s3.run({ dryRun: true, topology: TOPOLOGY });
    expect(r.scenario).toBe('s3');
    expect(r.steps.length).toBe(4);
    for (const step of r.steps) {
      expect(step.verdict).toBe('skipped');
    }
    // Fault records: five adds + one delete.
    const adds = r.faults.filter((f) => / nft add /.test(f) && !f.includes('[fault:remove'));
    const dels = r.faults.filter((f) => /\[fault:remove/.test(f));
    expect(adds.length, 'five adds (table, chain, three drops)').toBe(5);
    expect(dels.length, 'one delete (the table)').toBe(1);
  });
  it('pub1FirewallArgs produces nft argvs inside notismesh-pub1 with ports read from the topology', () => {
    const a = s3.pub1FirewallArgs(TOPOLOGY);
    for (const argv of [a.addTable, a.addChain, a.dropUdp, a.dropTcpMesh, a.dropTcpWss, a.deleteTable]) {
      expect(argv.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-pub1']);
    }
    // The three drop rules carry the mesh-webrtc, mesh-tcp and WSS ports.
    expect(a.dropUdp.join(' ')).toContain('udp dport 4001 drop');
    expect(a.dropTcpMesh.join(' ')).toContain('tcp dport 4002 drop');
    expect(a.dropTcpWss.join(' ')).toContain('tcp dport 443 drop');
  });
  // MESH_INTERFACE → The client's node list → "A routed read goes to a
  // node its need allows" — "how many checks it has completed, so a
  // reader can tell one check's state from the next". The recovery
  // step waits on `checks`: a baseline on `agreement` never changes
  // when the same nodes answer the same way. The predicate is built
  // the way cdp.mjs builds it — `buildPredicate(body)`, no `window`
  // in scope — so the test runtime is the live one.
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__s3CheckBaseline;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__s3CheckBaseline;
  });
  it('S3_POLL_NEXT_COMPLETED_CHECK_PREDICATE (via buildPredicate) waits on checks: baseline at first poll, done when greater', () => {
    const fn = buildPredicate(s3.S3_POLL_NEXT_COMPLETED_CHECK_PREDICATE);
    const stateAt = (checks: number): string => JSON.stringify({
      checks,
      agreement: { onChain: 2, onChainAnchors: 2, offChain: 1 },
    });
    expect(fn(stateAt(3))).toBe(false);
    expect(fn(stateAt(3))).toBe(false);
    expect(fn(stateAt(4))).toBe(true);
  });
  it('S3_POLL_NEXT_COMPLETED_CHECK_PREDICATE never ends when `checks` is missing (old `agreement` stamp)', () => {
    const fn = buildPredicate(s3.S3_POLL_NEXT_COMPLETED_CHECK_PREDICATE);
    const stateNoChecks = JSON.stringify({
      agreement: { onChain: 2, onChainAnchors: 2, offChain: 1 },
    });
    expect(fn(stateNoChecks)).toBe(false);
    expect(fn(stateNoChecks)).toBe(false);
  });
  // cdp.mjs' `buildPredicate` runs the body with no `window` in scope.
  // The catch covers `JSON.parse` alone: a predicate body that
  // references a page global throws, cdp.mjs' `main` does not catch
  // it, and the poll fails at once with the error.
  it('a predicate body that references a page global throws (poll fails fast, no silent timeout)', () => {
    const fn = buildPredicate(`let s;
      try { s = JSON.parse(v); } catch (_e) { return false; }
      return s.checks > window.__someBaseline;`);
    expect(() => fn(JSON.stringify({ checks: 1 }))).toThrow(/window is not defined/);
  });
});

describe('s2 (NAT)', () => {
  it('describe() lists two steps: priv1 relay-then-direct, priv2 reached through a relay that carries its data', () => {
    const names = s2.describe();
    expect(names.length).toBe(2);
    expect(names[0]).toMatch(/priv1/);
    expect(names[0]).toMatch(/endpoint-independent/);
    expect(names[1]).toMatch(/priv2/);
    expect(names[1]).toMatch(/symmetric/);
    expect(names[1]).toMatch(/relay/);
  });
  it('run({dryRun:true}) returns two skipped steps and no faults', async () => {
    const r = await s2.run({ dryRun: true, topology: TOPOLOGY });
    expect(r.scenario).toBe('s2');
    expect(r.steps.length).toBe(2);
    for (const step of r.steps) {
      expect(step.verdict).toBe('skipped');
      expect(step.measurement).toBe(null);
    }
    expect(r.faults).toEqual([]);
  });
});

describe('s4 (transport cut)', () => {
  it('describe() lists four steps', () => {
    const names = s4.describe();
    expect(names.length).toBe(4);
    expect(names[0]).toMatch(/UDP to pub1/);
    expect(names[1]).toMatch(/UDP to every public node/);
    expect(names[2]).toMatch(/renewal/);
    expect(names[3]).toMatch(/TCP between the Notis nodes/);
  });
  it('udpDropArgs builds an add-table + add-chain + per-host rule in the browser namespace', () => {
    const a = s4.udpDropArgs(TOPOLOGY);
    expect(a.addTable.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-browser']);
    expect(a.addChain.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-browser']);
    expect(a.deleteTable.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-browser']);
    expect(a.perHost.length, 'one rule per public mesh node').toBeGreaterThan(0);
    for (const { name, argv } of a.perHost) {
      expect(typeof name).toBe('string');
      expect(argv.join(' ')).toContain('meta l4proto udp drop');
    }
  });
  it('notisTcpCutArgs builds a per-public-host rule for each public mesh host', () => {
    const t = s4.notisTcpCutArgs(TOPOLOGY);
    expect(t.length, 'at least one public mesh host').toBeGreaterThan(0);
    for (const row of t) {
      expect(row.addTable[4]).toMatch(/^notismesh-/);
      expect(row.dropDport.join(' ')).toMatch(/tcp dport \d+ drop/);
    }
  });
  it('run({dryRun:true}) emits a UDP table + chain + rules + TCP tables', async () => {
    const r = await s4.run({ dryRun: true, topology: TOPOLOGY });
    expect(r.scenario).toBe('s4');
    expect(r.steps.length).toBe(4);
    for (const step of r.steps) expect(step.verdict).toBe('skipped');
    const adds = r.faults.filter((f) => / nft add table /.test(f) && !f.includes('[fault:remove'));
    const dels = r.faults.filter((f) => /\[fault:remove/.test(f) && / nft delete table /.test(f));
    expect(adds.length, 'at least UDP + two TCP tables').toBeGreaterThanOrEqual(3);
    expect(dels.length, 'each added table has its removal').toBe(adds.length);
  });
});

describe('s5 (impersonation)', () => {
  it('describe() lists one step', () => {
    expect(s5.describe()).toEqual(['impostor on pub1 address: refused at the link, address dropped, anchor not blacklisted']);
  });
  it('run({dryRun:true}) prints the stop + impostor spawn with pub1 bind addr', async () => {
    const r = await s5.run({ dryRun: true, topology: TOPOLOGY });
    expect(r.scenario).toBe('s5');
    expect(r.steps.length).toBe(1);
    const stopLine = r.faults.find((f) => f.includes('stop-pub1-mesh'));
    expect(stopLine, 'stop line').toBeDefined();
    const spawnLine = r.faults.find((f) => f.includes('impostor-mesh'));
    expect(spawnLine, 'impostor spawn line').toBeDefined();
    expect(spawnLine!).toContain('/ip4/10.100.0.11/udp/4001/webrtc-direct');
    expect(spawnLine!).toContain('MESH_LISTEN=');
    expect(spawnLine!).toContain('MESH_KEY_PATH=');
  });
  it('writeFreshMeshKey writes 48 bytes (PKCS8 Ed25519) and returns a 64-hex notisId', () => {
    const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
    const dir = mkdtempSync(require('node:os').tmpdir() + '/mesh-s5-');
    try {
      const path = require('node:path').join(dir, 'mesh.key');
      // Deterministic seed for the test: xor-shift of a fixed byte.
      const seedByte = 0x5a;
      const randomBytes = (n: number): Buffer => Buffer.alloc(n, seedByte);
      const r = s5.writeFreshMeshKey(path, { randomBytes });
      const bytes = readFileSync(path);
      expect(bytes.length).toBe(48);
      expect(bytes.slice(0, 16).toString('hex')).toBe('302e020100300506032b657004220420');
      expect(bytes.slice(16).toString('hex')).toBe(Buffer.alloc(32, seedByte).toString('hex'));
      expect(typeof r.notisId).toBe('string');
      expect(r.notisId).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('s6 (hostile)', () => {
  it('describe() lists three steps: anchors unreachable, hostile seeds judged, publisher blacklisted', () => {
    const names = s6.describe();
    expect(names.length).toBe(3);
    expect(names[0]).toMatch(/anchors unreachable/);
    expect(names[1]).toMatch(/hostile seeds/);
    expect(names[2]).toMatch(/publisher/);
  });
  it('anchorBlockArgs builds an add-table + add-chain + per-anchor drop rule', () => {
    const a = s6.anchorBlockArgs(TOPOLOGY);
    expect(a.addTable[4]).toBe('notismesh-browser');
    expect(a.addChain[4]).toBe('notismesh-browser');
    expect(a.drops.length).toBeGreaterThan(0);
    for (const argv of a.drops) {
      expect(argv[0]).toBe('sudo');
      expect(argv[4]).toBe('notismesh-browser');
      expect(argv.slice(-1)[0]).toBe('drop');
    }
    expect(a.deleteTable[4]).toBe('notismesh-browser');
  });
  it('run({dryRun:true}) emits the block table + drop rules + one delete', async () => {
    const r = await s6.run({ dryRun: true, topology: TOPOLOGY });
    expect(r.scenario).toBe('s6');
    expect(r.steps.length).toBe(3);
    for (const step of r.steps) expect(step.verdict).toBe('skipped');
    const adds = r.faults.filter((f) => / nft add /.test(f) && !f.includes('[fault:remove'));
    const dels = r.faults.filter((f) => /\[fault:remove/.test(f));
    expect(adds.length, 'one table + one chain + one drop per public mesh host').toBeGreaterThanOrEqual(3);
    expect(dels.length, 'one table delete').toBe(1);
  });
  // MESH_INTERFACE → Block gossip → "A refused block is evidence as
  // `net` weighs it" — `otherRejectSourcesIn` reads each honest mesh
  // log for rejection lines and keeps those whose source is not the
  // publisher's peer id. The function is pure; mkdtempSync feeds it
  // a controlled log tree.
  it('otherRejectSourcesIn drops rejections sourced from the publisher and keeps every other', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'notismesh-s6-'));
    try {
      const pubId = '12D3KooWPublisher';
      const browserId = '12D3KooWBrowser';
      mkdirSync(join(dir, 'pub1'), { recursive: true });
      writeFileSync(join(dir, 'pub1', 'mesh:pub1.log'),
        `[mesh] start\n[mesh] ordering block rejected from ${pubId}: malformed ordering block header: ...\n[mesh] peer:connect\n`);
      mkdirSync(join(dir, 'pub2'), { recursive: true });
      writeFileSync(join(dir, 'pub2', 'mesh:pub2.log'),
        `[mesh] start\n[mesh] ordering block rejected from ${browserId}: malformed ordering block header: ...\n`);
      const sources = s6.otherRejectSourcesIn(dir, ['pub1', 'pub2', 'priv1'], pubId);
      expect(sources).toEqual([{ host: 'pub2', peerIdString: browserId }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('s7 (reach and load)', () => {
  it('describe() lists four steps: spread + need, slowed node, local node, counts', () => {
    const names = s7.describe();
    expect(names.length).toBe(4);
    expect(names[0]).toMatch(/spread/);
    expect(names[1]).toMatch(/delayed|slowed/);
    expect(names[2]).toMatch(/lan1/);
    expect(names[3]).toMatch(/agreement|counts/);
  });
  // MESH_INTERFACE → The client's node list → "A routed read goes to a
  // node its need allows" — "how many checks it has completed, so a
  // reader can tell one check's state from the next". The wait reads
  // `checks`, not `agreement`: the agreement counts stay identical
  // across checks when the same nodes answer the same way, so a
  // baseline on `agreement` never changes and the wait never ends.
  // The predicate is built the way cdp.mjs builds it —
  // `buildPredicate(body)`, no `window` in scope — so the test
  // runtime is the live one.
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__s7CheckBaseline;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__s7CheckBaseline;
  });
  it('S7_WAIT_ONE_COMPLETED_CHECK_PREDICATE (via buildPredicate) waits on checks: baseline at first poll, done when greater', () => {
    const fn = buildPredicate(s7.S7_WAIT_ONE_COMPLETED_CHECK_PREDICATE);
    const stateAt = (checks: number): string => JSON.stringify({
      checks,
      agreement: { onChain: 2, onChainAnchors: 2, offChain: 1 },
    });
    // First poll: baseline captured, predicate false.
    expect(fn(stateAt(5))).toBe(false);
    // Second poll at the same baseline value: still false.
    expect(fn(stateAt(5))).toBe(false);
    // Baseline+1: true.
    expect(fn(stateAt(6))).toBe(true);
  });
  it('S7_WAIT_ONE_COMPLETED_CHECK_PREDICATE never ends on `agreement` alone when `checks` is missing', () => {
    const fn = buildPredicate(s7.S7_WAIT_ONE_COMPLETED_CHECK_PREDICATE);
    const stateNoChecks = JSON.stringify({
      agreement: { onChain: 2, onChainAnchors: 2, offChain: 1 },
    });
    expect(fn(stateNoChecks)).toBe(false);
    expect(fn(stateNoChecks)).toBe(false);
  });
  // MESH_INTERFACE → No anchor reached → "The agreement counts" —
  // step 4 polls one page until its state carries `checks >= 1` and
  // reads the counts from the returned value. The predicate is false
  // on a fresh page's first-rendered state (`{ checks: 0, agreement:
  // null }`) and true once the first check has landed (`{ checks: 1,
  // agreement: {...} }`), so the agreement the step records is the
  // same page's own.
  it('S7_WAIT_COMPLETED_CHECK_PREDICATE is false on {checks: 0, agreement: null} and true on {checks: 1, agreement: {...}}', () => {
    const fn = buildPredicate(s7.S7_WAIT_COMPLETED_CHECK_PREDICATE);
    expect(fn(JSON.stringify({ checks: 0, agreement: null }))).toBe(false);
    expect(fn(JSON.stringify({
      checks: 1,
      agreement: { onChain: 2, onChainAnchors: 2, offChain: 1 },
    }))).toBe(true);
  });
  // MESH_INTERFACE → Discovery → "A node added by hand" / "Seeds" —
  // step 3 of s7 measures lan1 at its private address. A lan1 row
  // without `localAddrs` can only be named at its announced
  // (relayed) addresses, which measures the relay path, not the
  // private one; the variant fails with that reason instead of
  // falling back.
  it('buildSeedOnlyLanVariant refuses a lan1 row without localAddrs', () => {
    const baseConfig = { network: 'devnet', anchors: [] };
    const lan1Row = { notisId: 'b'.repeat(64), multiaddrs: ['/relay/addr'], localAddrs: [] };
    expect(() => s7.buildSeedOnlyLanVariant(baseConfig, lan1Row)).toThrow(/localAddrs/);
  });
  it('buildSeedOnlyLanVariant uses the row\'s localAddrs exactly, never multiaddrs', () => {
    const baseConfig = { network: 'devnet', anchors: ['A'] };
    const local = '/ip4/10.103.0.21/udp/4001/webrtc-direct/certhash/uEiA/p2p/PLan';
    const row = { notisId: 'b'.repeat(64), multiaddrs: ['/relay/addr'], localAddrs: [local] };
    const out = s7.buildSeedOnlyLanVariant(baseConfig, row);
    expect(out.seeds).toEqual([{ notisId: 'b'.repeat(64), addrs: [local] }]);
  });
  it('buildByHandLanVariant refuses a lan1 row without localAddrs', () => {
    const baseConfig = { network: 'devnet' };
    const lan1Row = { notisId: 'b'.repeat(64), multiaddrs: ['/relay/addr'], localAddrs: [] };
    expect(() => s7.buildByHandLanVariant(baseConfig, lan1Row, true)).toThrow(/localAddrs/);
    expect(() => s7.buildByHandLanVariant(baseConfig, lan1Row, false)).toThrow(/localAddrs/);
  });
  it('buildByHandLanVariant uses the row\'s localAddrs exactly, never multiaddrs', () => {
    const baseConfig = { network: 'devnet' };
    const local = '/ip4/10.103.0.21/udp/4001/webrtc-direct/certhash/uEiA/p2p/PLan';
    const row = { notisId: 'b'.repeat(64), multiaddrs: ['/relay/addr'], localAddrs: [local] };
    const out = s7.buildByHandLanVariant(baseConfig, row, true);
    expect(out.byHand).toEqual([{ notisId: 'b'.repeat(64), addrs: [local], trusted: true }]);
  });
  it('pub2NetemArgs builds a tc qdisc add + del inside notismesh-pub2 on the outside veth', () => {
    const n = s7.pub2NetemArgs(TOPOLOGY);
    expect(n.add[4]).toBe('notismesh-pub2');
    expect(n.add.join(' ')).toContain('tc qdisc add');
    expect(n.add.join(' ')).toContain('netem delay 200ms');
    expect(n.del[4]).toBe('notismesh-pub2');
    expect(n.del.join(' ')).toContain('tc qdisc del');
    // Interface is the veth peer pub2 holds inside its namespace.
    expect(n.iface).toBe('vp-p2');
  });
  it('run({dryRun:true}) emits the netem add + its removal and four skipped steps', async () => {
    const r = await s7.run({ dryRun: true, topology: TOPOLOGY });
    expect(r.scenario).toBe('s7');
    expect(r.steps.length).toBe(4);
    for (const step of r.steps) expect(step.verdict).toBe('skipped');
    const adds = r.faults.filter((f: string) => / tc qdisc add /.test(f) && !f.includes('[fault:remove'));
    const dels = r.faults.filter((f: string) => /\[fault:remove/.test(f) && / tc qdisc del /.test(f));
    expect(adds.length, 'one netem add').toBe(1);
    expect(dels.length, 'one netem del').toBe(1);
  });
});

describe('s8 (prove once, follow by gossip)', () => {
  it('describe() lists four steps: no proof, gossip delivery, fork, gap filled by headers', () => {
    const names = s8.describe();
    expect(names.length).toBe(4);
    expect(names[0]).toMatch(/no proof/);
    expect(names[1]).toMatch(/gossip/);
    expect(names[2]).toMatch(/lagging/);
    expect(names[3]).toMatch(/catches up by headers|gap/);
  });
  it('s8GapFirewallArgs builds a table + chain + per-mesh-host drop + delete-table inside the browser namespace', () => {
    const a = s8.s8GapFirewallArgs(TOPOLOGY);
    for (const argv of [a.addTable, a.addChain, a.deleteTable]) {
      expect(argv.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-browser']);
    }
    // The test TOPOLOGY carries pub1 and pub2 — both have `mesh` and
    // an `addr`, so two drops are built.
    expect(a.drops.length, 'one drop per mesh host with an addr').toBe(2);
    for (const { name, argv } of a.drops) {
      expect(typeof name).toBe('string');
      expect(argv.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-browser']);
      expect(argv.join(' ')).toMatch(/nft add rule ip s8_gap out ip daddr \d+\.\d+\.\d+\.\d+ drop/);
    }
    expect(a.deleteTable.join(' ')).toContain('nft delete table ip s8_gap');
  });
  it('run({dryRun:true}) emits step 1 hostile firewall + step 4 hostile firewall + gap firewall + their deletes', async () => {
    const r = await s8.run({ dryRun: true, topology: TOPOLOGY });
    expect(r.scenario).toBe('s8');
    expect(r.steps.length).toBe(4);
    for (const step of r.steps) expect(step.verdict).toBe('skipped');
    const adds = r.faults.filter((f: string) => / nft add /.test(f) && !f.includes('[fault:remove'));
    const dels = r.faults.filter((f: string) => /\[fault:remove/.test(f) && / nft delete table /.test(f));
    expect(adds.length, 'three tables + three chains + per-host drops for each').toBeGreaterThanOrEqual(8);
    // Three table deletes — one for s8_step1_hostile, one for
    // s8_step4_hostile, one for s8_gap.
    expect(dels.length, 'one table delete per firewall (removes every drop)').toBe(3);
  });
  // MESH_INTERFACE → Acceptance 8 — step 1 firewalls the browser from
  // every hostile host so the first check reads no hostile proof.
  it('s8Step1HostileFirewallArgs builds a table + chain + per-hostile-host drop + delete-table inside the browser namespace', () => {
    const topologyWithHostile = {
      hosts: {
        pub1: { role: 'public', addr: '11.100.0.11', mesh: { role: 'public' } },
        pub2: { role: 'public', addr: '11.100.0.12', mesh: { role: 'public' } },
        'hostile-malformed': { role: 'hostile', addr: '11.100.0.31', mesh: { role: 'public' } },
        'hostile-invalid': { role: 'hostile', addr: '11.100.0.32', mesh: { role: 'public' } },
        'hostile-lagging': { role: 'hostile', addr: '11.100.0.33', mesh: { role: 'public' } },
        'hostile-publisher': { role: 'hostile', addr: '11.100.0.34', mesh: { role: 'public' } },
      },
    };
    const a = s8.s8Step1HostileFirewallArgs(topologyWithHostile);
    for (const argv of [a.addTable, a.addChain, a.deleteTable]) {
      expect(argv.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-browser']);
    }
    expect(a.drops.length, 'one drop per hostile host').toBe(4);
    const dropNames = a.drops.map((d) => d.name).sort();
    expect(dropNames).toEqual(['hostile-invalid', 'hostile-lagging', 'hostile-malformed', 'hostile-publisher']);
    for (const { argv } of a.drops) {
      expect(argv.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-browser']);
      expect(argv.join(' ')).toMatch(/nft add rule ip s8_step1_hostile out ip daddr 11\.100\.0\.\d+ drop/);
    }
    expect(a.deleteTable.join(' ')).toContain('nft delete table ip s8_step1_hostile');
    // Honest hosts are not dropped — a drop to pub1 would break the
    // step's baseline (no anchor reached).
    for (const { argv } of a.drops) {
      expect(argv.join(' ')).not.toContain('11.100.0.11');
      expect(argv.join(' ')).not.toContain('11.100.0.12');
    }
  });
  // MESH_INTERFACE → Acceptance 8 — step 1's hostile firewall is a
  // FaultLog fault scoped to the step: the drops land once at step
  // start and the table deletion removes them at step end. The
  // dry-run run already asserts the table + delete count above; here
  // we assert the fault NAMES carry the step-1 marker so a reader of
  // `stage/out/scenarios/s8.json`'s `faults` sees which firewall
  // belonged to which step.
  it('run({dryRun:true}) prefixes every step-1 hostile fault with [fault:s8:browser-step1-hostile-', async () => {
    const r = await s8.run({ dryRun: true, topology: TOPOLOGY });
    const step1 = r.faults.filter((f: string) =>
      /\[fault:s8:browser-step1-hostile-/.test(f) || /\[fault:remove:s8:browser-step1-hostile-/.test(f),
    );
    expect(step1.length, 'at least one apply + one remove').toBeGreaterThanOrEqual(2);
    const gap = r.faults.filter((f: string) =>
      /\[fault:s8:browser-gap-/.test(f) || /\[fault:remove:s8:browser-gap-/.test(f),
    );
    expect(gap.length, 'at least one apply + one remove').toBeGreaterThanOrEqual(2);
  });
  // MESH_INTERFACE → Acceptance 8 — step 4 firewalls the browser from
  // every hostile host for its whole duration, beside the gap cut.
  // Without it the client's DHT walk reaches each hostile mesh node
  // and reads its proof at a check, moving `proofReads` beyond the
  // fill — the saved run on `ef19ed10` recorded five proof reads at
  // the check after the cut was removed, which is the hostile set.
  // Same rules as step 1 (a `FaultLog` fault, removed in `finally`).
  it('s8Step4HostileFirewallArgs builds a table + chain + per-hostile-host drop + delete-table inside the browser namespace', () => {
    const topologyWithHostile = {
      hosts: {
        pub1: { role: 'public', addr: '11.100.0.11', mesh: { role: 'public' } },
        pub2: { role: 'public', addr: '11.100.0.12', mesh: { role: 'public' } },
        'hostile-malformed': { role: 'hostile', addr: '11.100.0.31', mesh: { role: 'public' } },
        'hostile-invalid': { role: 'hostile', addr: '11.100.0.32', mesh: { role: 'public' } },
        'hostile-lagging': { role: 'hostile', addr: '11.100.0.33', mesh: { role: 'public' } },
        'hostile-publisher': { role: 'hostile', addr: '11.100.0.34', mesh: { role: 'public' } },
      },
    };
    const a = s8.s8Step4HostileFirewallArgs(topologyWithHostile);
    for (const argv of [a.addTable, a.addChain, a.deleteTable]) {
      expect(argv.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-browser']);
    }
    expect(a.drops.length, 'one drop per hostile host').toBe(4);
    const dropNames = a.drops.map((d) => d.name).sort();
    expect(dropNames).toEqual(['hostile-invalid', 'hostile-lagging', 'hostile-malformed', 'hostile-publisher']);
    for (const { argv } of a.drops) {
      expect(argv.slice(0, 5)).toEqual(['sudo', 'ip', 'netns', 'exec', 'notismesh-browser']);
      expect(argv.join(' ')).toMatch(/nft add rule ip s8_step4_hostile out ip daddr 11\.100\.0\.\d+ drop/);
    }
    expect(a.deleteTable.join(' ')).toContain('nft delete table ip s8_step4_hostile');
    // Honest hosts are not dropped — a drop to pub1 would break the
    // step's baseline, as a drop to a mesh anchor would in step 1.
    for (const { argv } of a.drops) {
      expect(argv.join(' ')).not.toContain('11.100.0.11');
      expect(argv.join(' ')).not.toContain('11.100.0.12');
    }
  });
  // MESH_INTERFACE → Acceptance 8 — step 4's fault list carries two
  // firewalls at once: the step-4 hostile firewall (whole-step) and
  // the gap cut (removed before the fill). A reader of
  // `stage/out/scenarios/s8.json`'s `faults` sees both appliers and
  // both removers.
  it('run({dryRun:true}) step 4\'s fault list carries both the step-4 hostile firewall and the gap cut (apply + remove each)', async () => {
    const r = await s8.run({ dryRun: true, topology: TOPOLOGY });
    const step4Hostile = r.faults.filter((f: string) =>
      /\[fault:s8:browser-step4-hostile-/.test(f) || /\[fault:remove:s8:browser-step4-hostile-/.test(f),
    );
    expect(step4Hostile.length, 'step-4 hostile apply + remove').toBeGreaterThanOrEqual(2);
    const step4HostileRemove = r.faults.filter((f: string) =>
      /\[fault:remove:s8:browser-step4-hostile-/.test(f),
    );
    expect(step4HostileRemove.length, 'step-4 hostile remove present').toBeGreaterThanOrEqual(1);
    const gap = r.faults.filter((f: string) =>
      /\[fault:s8:browser-gap-/.test(f) || /\[fault:remove:s8:browser-gap-/.test(f),
    );
    expect(gap.length, 'gap apply + remove').toBeGreaterThanOrEqual(2);
    const gapRemove = r.faults.filter((f: string) =>
      /\[fault:remove:s8:browser-gap-/.test(f),
    );
    expect(gapRemove.length, 'gap remove present').toBeGreaterThanOrEqual(1);
  });
  // MESH_INTERFACE → Acceptance 8 — steps 1 and 4 poll a page where
  // the client dials hostile hosts the stage DHT names and whose
  // packets drop at the browser's own namespace. A dropped packet is
  // no refusal: libp2p waits `PEER_DIAL_MIN_MS` (20 s, `src/protocols.ts`)
  // per hostile dial until the retry back-off takes those nodes out of
  // the candidates. The cap at 600 s is the deadline a step's poll
  // holds under this cost, not a bound on the stage's own pace. 240 s
  // was the cap before and step 1 timed out at it on `ef19ed10`.
  it('BLACK_HOLE_WAIT_MS caps steps 1 and 4\'s polls at 600 s (argued by one dial deadline per candidate)', () => {
    expect(s8.BLACK_HOLE_WAIT_MS).toBe(600_000);
  });
  // MESH_INTERFACE → Acceptance 8 — the four tracker predicates and
  // their expression-builders run under the live cdp.mjs runtime
  // (`buildPredicate`, no `window` in scope), so a case holds the
  // same JSON shape the live stage would carry on `#state`.
  it('S8_GOSSIP_PREDICATE (via buildPredicate) is false until the tracker has four tip records', () => {
    const fn = buildPredicate(s8.S8_GOSSIP_PREDICATE);
    expect(fn(null)).toBe(false);
    expect(fn(JSON.stringify([]))).toBe(false);
    expect(fn(JSON.stringify([{ height: 1, atMs: 0, checks: 1 }, { height: 2, atMs: 1, checks: 1 }, { height: 3, atMs: 2, checks: 1 }]))).toBe(false);
    expect(fn(JSON.stringify([
      { height: 1, atMs: 0, checks: 1 },
      { height: 2, atMs: 1_000, checks: 1 },
      { height: 3, atMs: 2_000, checks: 1 },
      { height: 4, atMs: 3_000, checks: 1 },
    ]))).toBe(true);
  });
  it('S8_NOPROOFS_PREDICATE is true only once the tracker\'s final record is written', () => {
    const fn = buildPredicate(s8.S8_NOPROOFS_PREDICATE);
    expect(fn(null)).toBe(false);
    expect(fn(JSON.stringify({ base: null, final: null }))).toBe(false);
    expect(fn(JSON.stringify({ base: { checks: 2, proofReads: 4 }, final: null }))).toBe(false);
    expect(fn(JSON.stringify({
      base: { checks: 2, proofReads: 4 },
      final: { checks: 7, proofReads: 4, honestNodeStatuses: [{ notisId: 'a'.repeat(64), status: 'ok' }] },
    }))).toBe(true);
  });
  it('S8_FORK_PREDICATE is true only once the tracker records the two-proof check', () => {
    const fn = buildPredicate(s8.S8_FORK_PREDICATE);
    expect(fn(null)).toBe(false);
    expect(fn(JSON.stringify({ base: null, final: null, laggingId: 'c'.repeat(64) }))).toBe(false);
    expect(fn(JSON.stringify({
      base: { checks: 3, proofReads: 10 },
      final: {
        laggingStatus: 'behind', laggingBehindBy: 2,
        clientTipHash: 'ab'.repeat(32), clientTipHeight: 42,
        proofReadsDeltaAtCheck: 2,
      },
      laggingId: 'c'.repeat(64),
    }))).toBe(true);
  });
  it('S8_GAP_PREDICATE is true only once the tracker records the fill', () => {
    const fn = buildPredicate(s8.S8_GAP_PREDICATE);
    expect(fn(null)).toBe(false);
    expect(fn(JSON.stringify({ base: null, lastTipHeight: null, final: null }))).toBe(false);
    expect(fn(JSON.stringify({ base: { tipHeight: 100, proofReads: 6 }, lastTipHeight: 100, final: null }))).toBe(false);
    expect(fn(JSON.stringify({
      base: { tipHeight: 100, proofReads: 6 },
      lastTipHeight: 104,
      final: { tipHeight: 104, proofReads: 6, jump: 4 },
    }))).toBe(true);
  });
  // MESH_INTERFACE → Acceptance 8 — step 1's expression carries a pure
  // observer that reads a snapshot of `#state` and returns the next
  // tracker state. The observer captures a baseline on the first
  // state with the chain settled (`checks >= 1`, `proofReads >= 1`)
  // where every honest node the list HOLDS reads `ok`, `trailing` or
  // `behind` AND both anchors are held; the final, five completed
  // checks later, the same rule.
  const ANCHOR_A = 'a'.repeat(64);
  const ANCHOR_B = 'b'.repeat(64);
  const PRIV_1 = 'c'.repeat(64);
  const PRIV_2 = 'd'.repeat(64);
  function nodeEntry(id: string, status: string) {
    return { notisId: id, status };
  }
  it('s8NoProofsObserve: baseline captured when checks>=1, proofReads>=1, both anchors held, held honest in range', () => {
    const anchorIds = [ANCHOR_A, ANCHOR_B];
    const honestIds = [ANCHOR_A, ANCHOR_B, PRIV_1, PRIV_2];
    const s = {
      checks: 1,
      traffic: { proofReads: 1 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'ok')],
    };
    const st = s8.s8NoProofsObserve(null, s, honestIds, anchorIds);
    expect(st.base).toEqual({ checks: 1, proofReads: 1 });
    expect(st.final).toBeNull();
  });
  it('s8NoProofsObserve: baseline NOT captured if proofReads is 0 (chain not settled)', () => {
    const anchorIds = [ANCHOR_A, ANCHOR_B];
    const honestIds = [ANCHOR_A, ANCHOR_B];
    const s = {
      checks: 1,
      traffic: { proofReads: 0 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'ok')],
    };
    const st = s8.s8NoProofsObserve(null, s, honestIds, anchorIds);
    expect(st.base).toBeNull();
  });
  it('s8NoProofsObserve: baseline NOT captured if one anchor is missing from the list', () => {
    const anchorIds = [ANCHOR_A, ANCHOR_B];
    const honestIds = [ANCHOR_A, ANCHOR_B];
    const s = {
      checks: 1,
      traffic: { proofReads: 2 },
      nodes: [nodeEntry(ANCHOR_A, 'ok')],
    };
    const st = s8.s8NoProofsObserve(null, s, honestIds, anchorIds);
    expect(st.base).toBeNull();
  });
  it('s8NoProofsObserve: baseline NOT captured if a held honest reads retry', () => {
    const anchorIds = [ANCHOR_A, ANCHOR_B];
    const honestIds = [ANCHOR_A, ANCHOR_B, PRIV_1];
    const s = {
      checks: 1,
      traffic: { proofReads: 2 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'ok'), nodeEntry(PRIV_1, 'retry')],
    };
    const st = s8.s8NoProofsObserve(null, s, honestIds, anchorIds);
    expect(st.base).toBeNull();
  });
  it('s8NoProofsObserve: baseline captured when a non-anchor honest is NOT in the list (held subset)', () => {
    // priv1 and priv2 only come in by DHT; the stage reaches a baseline
    // once both anchors are held and the honest nodes it DOES hold are
    // in range — a honest node absent from the list is not asserted.
    const anchorIds = [ANCHOR_A, ANCHOR_B];
    const honestIds = [ANCHOR_A, ANCHOR_B, PRIV_1, PRIV_2];
    const s = {
      checks: 1,
      traffic: { proofReads: 2 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'trailing')],
    };
    const st = s8.s8NoProofsObserve(null, s, honestIds, anchorIds);
    expect(st.base).toEqual({ checks: 1, proofReads: 2 });
  });
  it('s8NoProofsObserve: final captured at base.checks + 5 when the rule still holds', () => {
    const anchorIds = [ANCHOR_A, ANCHOR_B];
    const honestIds = [ANCHOR_A, ANCHOR_B];
    const base = {
      checks: 1,
      traffic: { proofReads: 3 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'ok')],
    };
    const final = {
      checks: 6,
      traffic: { proofReads: 3 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'trailing')],
    };
    let st = s8.s8NoProofsObserve(null, base, honestIds, anchorIds);
    st = s8.s8NoProofsObserve(st, final, honestIds, anchorIds);
    const fin = st.final;
    expect(fin).not.toBeNull();
    expect(fin!.checks).toBe(6);
    expect(fin!.proofReads).toBe(3);
    expect(fin!.honestNodeStatuses).toEqual([
      { notisId: ANCHOR_A, status: 'ok' },
      { notisId: ANCHOR_B, status: 'trailing' },
    ]);
  });
  it('s8NoProofsObserve: final captured at base.checks + 5 even if an anchor was dropped (status \'absent\' goes into the measurement)', () => {
    const anchorIds = [ANCHOR_A, ANCHOR_B];
    const honestIds = [ANCHOR_A, ANCHOR_B];
    const base = {
      checks: 1,
      traffic: { proofReads: 3 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'ok')],
    };
    const atFinalCount = {
      checks: 6,
      traffic: { proofReads: 3 },
      nodes: [nodeEntry(ANCHOR_A, 'ok')],
    };
    let st = s8.s8NoProofsObserve(null, base, honestIds, anchorIds);
    st = s8.s8NoProofsObserve(st, atFinalCount, honestIds, anchorIds);
    const fin = st.final;
    expect(fin).not.toBeNull();
    expect(fin!.checks).toBe(6);
    expect(fin!.honestNodeStatuses).toEqual([
      { notisId: ANCHOR_A, status: 'ok' },
      { notisId: ANCHOR_B, status: 'absent' },
    ]);
  });
  it('s8NoProofsObserve: final captured at base.checks + 5 even if a held honest reads retry (status \'retry\' goes into the measurement)', () => {
    const anchorIds = [ANCHOR_A, ANCHOR_B];
    const honestIds = [ANCHOR_A, ANCHOR_B, PRIV_1];
    const base = {
      checks: 1,
      traffic: { proofReads: 3 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'ok'), nodeEntry(PRIV_1, 'ok')],
    };
    const atFinalCount = {
      checks: 6,
      traffic: { proofReads: 3 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'ok'), nodeEntry(PRIV_1, 'retry')],
    };
    let st = s8.s8NoProofsObserve(null, base, honestIds, anchorIds);
    st = s8.s8NoProofsObserve(st, atFinalCount, honestIds, anchorIds);
    const fin = st.final;
    expect(fin).not.toBeNull();
    expect(fin!.checks).toBe(6);
    expect(fin!.honestNodeStatuses).toEqual([
      { notisId: ANCHOR_A, status: 'ok' },
      { notisId: ANCHOR_B, status: 'ok' },
      { notisId: PRIV_1, status: 'retry' },
    ]);
  });
  it('s8NoProofsObserve: final captured at exactly base.checks + 5 whatever the statuses are afterward', () => {
    const anchorIds = [ANCHOR_A, ANCHOR_B];
    const honestIds = [ANCHOR_A, ANCHOR_B];
    const base = {
      checks: 1,
      traffic: { proofReads: 3 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'ok')],
    };
    const atFive = {
      checks: 6,
      traffic: { proofReads: 3 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'retry')],
    };
    const atSeven = {
      checks: 8,
      traffic: { proofReads: 3 },
      nodes: [nodeEntry(ANCHOR_A, 'ok'), nodeEntry(ANCHOR_B, 'ok')],
    };
    let st = s8.s8NoProofsObserve(null, base, honestIds, anchorIds);
    st = s8.s8NoProofsObserve(st, atFive, honestIds, anchorIds);
    const fin = st.final;
    expect(fin).not.toBeNull();
    expect(fin!.checks).toBe(6);
    expect(fin!.honestNodeStatuses).toEqual([
      { notisId: ANCHOR_A, status: 'ok' },
      { notisId: ANCHOR_B, status: 'retry' },
    ]);
    // The later state does not re-record a final.
    st = s8.s8NoProofsObserve(st, atSeven, honestIds, anchorIds);
    expect(st.final).toBe(fin);
  });
  // MESH_INTERFACE → Acceptance 8 — step 4's expression carries a pure
  // observer that reads a snapshot of `#state` and returns the next
  // tracker state. The observer captures a baseline on the first
  // completed check, waits for a fill (a jump of three or more at
  // once) and then for one more tip change (gossip extending the tip
  // past the fill — the client is at the head). `final` is captured
  // at the one-block-after-fill point; `jump` keeps the fill's size
  // so `verdictS8Gap` reads `jump >= 3`.
  it('s8GapObserve: a tip that advances one at a time (gossip pace) does not end', () => {
    const sequence = [
      { checks: 1, tip: { height: 100 }, traffic: { proofReads: 5 } },
      { checks: 1, tip: { height: 101 }, traffic: { proofReads: 5 } },
      { checks: 1, tip: { height: 102 }, traffic: { proofReads: 5 } },
      { checks: 2, tip: { height: 103 }, traffic: { proofReads: 5 } },
    ];
    let st: unknown = null;
    let now = 1_000;
    for (const s of sequence) { st = s8.s8GapObserve(st, s, now); now += 100; }
    expect((st as { final: unknown }).final).toBeNull();
    expect((st as { lastTipHeight: number }).lastTipHeight).toBe(103);
    expect((st as { fillJump: unknown }).fillJump).toBeNull();
  });
  it('s8GapObserve: a jump of three or more alone records the fill, final still null (waiting for one-block-after)', () => {
    const sequence = [
      { checks: 1, tip: { height: 100 }, traffic: { proofReads: 5 } },
      { checks: 1, tip: { height: 101 }, traffic: { proofReads: 5 } },
      { checks: 2, tip: { height: 105 }, traffic: { proofReads: 5 } },
    ];
    let st: unknown = null;
    let now = 1_000;
    for (const s of sequence) { st = s8.s8GapObserve(st, s, now); now += 100; }
    expect((st as { final: unknown }).final).toBeNull();
    expect((st as { fillJump: number }).fillJump).toBe(4);
    expect((st as { lastTipHeight: number }).lastTipHeight).toBe(105);
  });
  it('s8GapObserve: fill then one more tip change records final at the head, jump from the fill', () => {
    const sequence = [
      { checks: 1, tip: { height: 100 }, traffic: { proofReads: 5 } },
      { checks: 1, tip: { height: 101 }, traffic: { proofReads: 5 } },
      { checks: 2, tip: { height: 105 }, traffic: { proofReads: 5 } },
      { checks: 2, tip: { height: 106 }, traffic: { proofReads: 5 } },
    ];
    let st: unknown = null;
    let now = 1_000;
    for (const s of sequence) { st = s8.s8GapObserve(st, s, now); now += 100; }
    expect((st as { final: { tipHeight: number; proofReads: number; jump: number } }).final).toEqual({
      tipHeight: 106,
      proofReads: 5,
      jump: 4,
    });
  });
  it('s8GapObserve: fill then one-block-after at any size records final (even a jump of two post-fill)', () => {
    // Once the fill lands, the tracker ends at the FIRST tip change
    // past it — gossip moves one at a time, so the usual post-fill
    // jump is 1; a race between the end of the gap and gossip's own
    // batching may deliver 2 at once, and `final` lands either way.
    const sequence = [
      { checks: 1, tip: { height: 100 }, traffic: { proofReads: 5 } },
      { checks: 2, tip: { height: 103 }, traffic: { proofReads: 5 } },
      { checks: 2, tip: { height: 105 }, traffic: { proofReads: 5 } },
    ];
    let st: unknown = null;
    let now = 1_000;
    for (const s of sequence) { st = s8.s8GapObserve(st, s, now); now += 100; }
    expect((st as { final: { tipHeight: number; jump: number } }).final).toEqual({
      tipHeight: 105,
      proofReads: 5,
      jump: 3,
    });
  });
  it('s8GapObserve: a jump of exactly three (the smallest fill) + one more records final with jump=3', () => {
    const sequence = [
      { checks: 1, tip: { height: 100 }, traffic: { proofReads: 7 } },
      { checks: 2, tip: { height: 103 }, traffic: { proofReads: 7 } },
      { checks: 2, tip: { height: 104 }, traffic: { proofReads: 7 } },
    ];
    let st: unknown = null;
    let now = 1_000;
    for (const s of sequence) { st = s8.s8GapObserve(st, s, now); now += 100; }
    expect((st as { final: { jump: number; tipHeight: number } }).final).toEqual({
      tipHeight: 104,
      proofReads: 7,
      jump: 3,
    });
  });
  it('s8GapObserve: a jump of two does not record a fill (still phase A, final null)', () => {
    const sequence = [
      { checks: 1, tip: { height: 100 }, traffic: { proofReads: 7 } },
      { checks: 2, tip: { height: 102 }, traffic: { proofReads: 7 } },
    ];
    let st: unknown = null;
    let now = 1_000;
    for (const s of sequence) { st = s8.s8GapObserve(st, s, now); now += 100; }
    expect((st as { final: unknown }).final).toBeNull();
    expect((st as { fillJump: unknown }).fillJump).toBeNull();
    expect((st as { lastTipHeight: number }).lastTipHeight).toBe(102);
  });
  it('s8GapObserve: baseline NOT captured before the first completed check', () => {
    const st = s8.s8GapObserve(null, { checks: 0, tip: { height: 100 }, traffic: { proofReads: 0 } }, 1_000);
    expect((st as { base: unknown }).base).toBeNull();
  });
  it('s8GapObserve: tipHist records every tip change after the baseline, carrying height, atMs, checks and proofReads', () => {
    // The tracker keeps the full sequence so a run shows every tip
    // change past the baseline — a fill of three, then a tip that
    // went back by one, shows both moves.
    const sequence = [
      { snap: { checks: 1, tip: { height: 100 }, traffic: { proofReads: 5 } }, nowMs: 1_000 }, // baseline
      { snap: { checks: 1, tip: { height: 100 }, traffic: { proofReads: 5 } }, nowMs: 1_100 }, // same height — no record
      { snap: { checks: 2, tip: { height: 103 }, traffic: { proofReads: 5 } }, nowMs: 1_200 }, // fill
      { snap: { checks: 2, tip: { height: 102 }, traffic: { proofReads: 5 } }, nowMs: 1_300 }, // one more change — tip went back
      { snap: { checks: 2, tip: { height: 104 }, traffic: { proofReads: 6 } }, nowMs: 1_400 }, // past final — no record
    ];
    let st: unknown = null;
    for (const r of sequence) st = s8.s8GapObserve(st, r.snap, r.nowMs);
    const tipHist = (st as { tipHist: Array<{ height: number; atMs: number; checks: number; proofReads: number }> }).tipHist;
    expect(tipHist).toEqual([
      { height: 103, atMs: 1_200, checks: 2, proofReads: 5 },
      { height: 102, atMs: 1_300, checks: 2, proofReads: 5 },
    ]);
    // The end condition is unchanged: a fill of three then one more
    // tip change — regardless of direction — locks final with the
    // fill's jump.
    expect((st as { final: { jump: number; tipHeight: number; proofReads: number } }).final).toEqual({
      tipHeight: 102,
      proofReads: 5,
      jump: 3,
    });
  });
  // MESH_INTERFACE → Acceptance 8 — the expression-builders substitute
  // the honest-id set, the anchor set and the lagging node's id into
  // the live page's tracker; the substitutions use `JSON.stringify` so
  // a notisId with special characters cannot break the expression. A
  // hex notisId round-trips through `JSON.stringify` as a quoted
  // string.
  it('buildS8NoProofsExpression embeds the honestIds and anchorIds as JSON arrays', () => {
    const honestIds = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const anchorIds = ['a'.repeat(64), 'b'.repeat(64)];
    const expr = s8.buildS8NoProofsExpression(honestIds, anchorIds);
    expect(expr).toContain(JSON.stringify(honestIds));
    expect(expr).toContain(JSON.stringify(anchorIds));
    expect(expr).toContain('__s8NP');
  });
  it('buildS8ForkExpression embeds the laggingId as a JSON string', () => {
    const id = 'c'.repeat(64);
    const expr = s8.buildS8ForkExpression(id);
    expect(expr).toContain(JSON.stringify(id));
    expect(expr).toContain('__s8F');
  });
  it('buildS8GapExpression contains the gap tracker namespace and the observer source', () => {
    const expr = s8.buildS8GapExpression();
    expect(expr).toContain('__s8GAP');
    // The observer is inlined by `.toString()` so a browser-side
    // tracker runs the same transition the Node suite drove.
    expect(expr).toContain('lastTipHeight');
  });
  // MESH_INTERFACE → Acceptance 8 — step 1 and step 4's baseline reads
  // the honest mesh hosts the stage-default config can reach. A host
  // the stage-default never dials — lan1 (browser's own network, s7
  // joins it by hand), every hostile host — is left out, so the base
  // of each tracker is not held forever by an entry that never
  // answers.
  it('honestMeshHosts picks pub/private mesh hosts, excludes lan1 (browser-net) and hostile hosts', () => {
    const topology = {
      hosts: {
        browser: { role: 'browser', parent: 'natC', addr: '10.103.0.11' },
        pub1: { role: 'public', addr: '11.100.0.11', mesh: { role: 'public' } },
        pub2: { role: 'public', addr: '11.100.0.12', mesh: { role: 'public' } },
        priv1: { role: 'private', parent: 'natA', addr: '10.101.0.11', mesh: { role: 'private' } },
        priv2: { role: 'private', parent: 'natB', addr: '10.102.0.11', mesh: { role: 'private' } },
        lan1: { role: 'private', parent: 'natC', addr: '10.103.0.21', mesh: { role: 'private' } },
        'hostile-publisher': { role: 'hostile', addr: '11.100.0.34', mesh: { role: 'public', publisher: true } },
        'hostile-lagging': { role: 'hostile', addr: '11.100.0.33', mesh: { role: 'public' } },
      },
    };
    expect(s8.honestMeshHosts(topology)).toEqual(['pub1', 'pub2', 'priv1', 'priv2']);
  });
  it('honestMeshHosts: a host without a mesh config is left out even if its role is public or private', () => {
    const topology = {
      hosts: {
        browser: { role: 'browser', parent: 'natC', addr: '10.103.0.11' },
        pub1: { role: 'public', addr: '11.100.0.11', mesh: { role: 'public' } },
        'pub-no-mesh': { role: 'public', addr: '11.100.0.13' },
      },
    };
    expect(s8.honestMeshHosts(topology)).toEqual(['pub1']);
  });
  // MESH_INTERFACE → Acceptance 8 — the pure delivery read: given the
  // tracker's clientHist (tip-change records) and the scenario's
  // pub1Hist (first-seen atMs per height), computeDeliveries pairs
  // each pub1 height past the baseline with the client's first atMs
  // at or above it. Three deliveries, each under 1 s, checksMoved
  // false — the data the saved run on `af9541f8` carried, had step 2
  // parsed its tracker value as an array instead of a string.
  it('computeDeliveries over the saved run\'s clientHist (parsed) and pub1Hist arrays answers three deliveries, each under 1 s, checksMoved false', () => {
    const clientHist = [
      { height: 2132, atMs: 1793623452426, checks: 1 },
      { height: 2133, atMs: 1793623453726, checks: 1 },
      { height: 2134, atMs: 1793623456726, checks: 1 },
      { height: 2135, atMs: 1793623458726, checks: 1 },
    ];
    const pub1Hist = [
      { height: 2132, atMs: 1793623452004 },
      { height: 2133, atMs: 1793623453110 },
      { height: 2134, atMs: 1793623456364 },
      { height: 2135, atMs: 1793623458345 },
    ];
    const deliveries = s8.computeDeliveries(clientHist, pub1Hist);
    expect(deliveries).toEqual([
      { height: 2133, delayMs: 616, checksMoved: false },
      { height: 2134, delayMs: 362, checksMoved: false },
      { height: 2135, delayMs: 381, checksMoved: false },
    ]);
    for (const d of deliveries) {
      expect(d.delayMs).toBeLessThan(1_000);
      expect(d.checksMoved).toBe(false);
    }
  });
  it('computeDeliveries over a string clientHist answers an empty list (the shape saved as `clientHist` in the run)', () => {
    // The saved run on `af9541f8` recorded `clientHist` as a JSON
    // string — cdp.mjs' stdout is `JSON.stringify(result)` where the
    // expression's `result` is itself the `JSON.stringify(...)` of
    // the tracker. One `JSON.parse` leaves a string; the step must
    // parse it to an array before calling `computeDeliveries`.
    const clientHistString = '[{"height":2132,"atMs":1793623452426,"checks":1},{"height":2133,"atMs":1793623453726,"checks":1}]';
    const pub1Hist = [{ height: 2132, atMs: 1793623452004 }, { height: 2133, atMs: 1793623453110 }];
    expect(s8.computeDeliveries(clientHistString, pub1Hist)).toEqual([]);
  });
  it('computeDeliveries over a non-array pub1Hist answers an empty list', () => {
    const clientHist = [{ height: 2132, atMs: 1793623452426, checks: 1 }];
    expect(s8.computeDeliveries(clientHist, 'not-an-array')).toEqual([]);
    expect(s8.computeDeliveries(clientHist, null)).toEqual([]);
  });

  // MESH_INTERFACE → Acceptance 8 — the earlier `af9541f8` test paired
  // pub1 heights with the client's; a run with pub1 missing one of the
  // three heights (the poll's 250 ms cadence skipped it) returned two
  // deliveries, verdict FAIL. The rule the brief states — "one delivery
  // per client tip change after its baseline" — pairs each new client
  // height with pub1's first record AT OR ABOVE it, so a pub1 height
  // the poll missed does not drop the client's own change. The data
  // below is pasted whole from a saved run on `41de7dc4` where pub1
  // never saw height 922 (921 and 923 only, 2 s apart); the three
  // client changes still land as three deliveries, each within the
  // 5 s bound and with `checksMoved` false.
  it("computeDeliveries over a run's clientHist and pub1Hist with pub1 missing one height answers one delivery per client change past baseline", () => {
    const clientHist = [
      { height: 920, atMs: 1793631574361, checks: 1 },
      { height: 921, atMs: 1793631579468, checks: 1 },
      { height: 922, atMs: 1793631582561, checks: 1 },
      { height: 923, atMs: 1793631582661, checks: 1 },
    ];
    const pub1Hist = [
      { height: 920, atMs: 1793631574011 },
      { height: 921, atMs: 1793631579690 },
      { height: 923, atMs: 1793631582672 },
    ];
    const deliveries = s8.computeDeliveries(clientHist, pub1Hist);
    expect(deliveries).toEqual([
      { height: 921, delayMs: -222, checksMoved: false },
      { height: 922, delayMs: -111, checksMoved: false },
      { height: 923, delayMs: -11, checksMoved: false },
    ]);
    for (const d of deliveries) {
      expect(d.delayMs).toBeLessThanOrEqual(5_000);
      expect(d.checksMoved).toBe(false);
    }
  });

  // MESH_INTERFACE → Acceptance 8 — `checksMoved === true` when the
  // client's `checks` advanced between pub1's atMs for the delivery's
  // height (or the first pub1 record at or above it) and the client's
  // own tip-change atMs. A check that ran mid-window carried the block
  // by proof, not gossip; `verdictS8Gossip` reads this field.
  it('computeDeliveries marks checksMoved true when a check ran between pub1\'s atMs and the client\'s tip change', () => {
    const clientHist = [
      { height: 100, atMs: 1_000, checks: 5 },
      { height: 101, atMs: 2_000, checks: 6 }, // pub1 saw 101 at 1_500; checks went 5 → 6
    ];
    const pub1Hist = [{ height: 101, atMs: 1_500 }];
    const deliveries = s8.computeDeliveries(clientHist, pub1Hist);
    expect(deliveries).toEqual([
      { height: 101, delayMs: 500, checksMoved: true },
    ]);
  });

  // MESH_INTERFACE → Acceptance 8 — the step reads the FIRST three
  // deliveries past the baseline. A fourth client change does not
  // enter the verdict's read; `verdictS8Gossip` keyed on
  // `deliveries.length === 3`.
  it('computeDeliveries caps at three deliveries', () => {
    const clientHist = [
      { height: 10, atMs: 0, checks: 0 },
      { height: 11, atMs: 100, checks: 0 },
      { height: 12, atMs: 200, checks: 0 },
      { height: 13, atMs: 300, checks: 0 },
      { height: 14, atMs: 400, checks: 0 },
    ];
    const pub1Hist = [
      { height: 11, atMs: 50 },
      { height: 12, atMs: 150 },
      { height: 13, atMs: 250 },
      { height: 14, atMs: 350 },
    ];
    const deliveries = s8.computeDeliveries(clientHist, pub1Hist);
    expect(deliveries.length).toBe(3);
    expect(deliveries.map((d) => d.height)).toEqual([11, 12, 13]);
  });
});

// MESH_INTERFACE → Acceptance 8 — step 4's tracker exits with the
// first tip jump of three or more and the gossip-poll scenario writes
// a report on its own clock. `cdp.mjs poll`'s stdout is
// `JSON.stringify(result)` where `result` is itself the expression's
// `JSON.stringify(window.__s8GAP)`: one JSON.parse unwraps the stdout
// to a JSON STRING of the inner payload, a second parse reads it as
// an object. Step 2 has done the double parse for weeks; step 4's
// single parse left `r` a string and `r.base.proofReads` threw
// `Cannot read properties of undefined (reading 'proofReads')`.
// `parseTrackerValue` is the shared parser extracted from the step; the
// case below reproduces the throw against a single parse and asserts
// the shared parser answers an object.
describe("s8 — parseTrackerValue reads cdp.mjs' double-encoded stdout", () => {
  it('parses a double-encoded tracker value as the inner object', () => {
    const inner = { base: { tipHeight: 100, proofReads: 1 }, lastTipHeight: 103, final: { tipHeight: 103, proofReads: 1, jump: 3 } };
    const stdout = JSON.stringify(JSON.stringify(inner));
    const r = s8.parseTrackerValue(stdout);
    expect(r).toEqual(inner);
    // The run's throw: a single JSON.parse of the double-encoded
    // stdout returns a string; dereferencing `.base.proofReads` throws
    // the "undefined" message the saved run holds.
    const once = JSON.parse(stdout);
    expect(typeof once).toBe('string');
    expect(() => once.base.proofReads).toThrow(/Cannot read properties of undefined/);
    // Confirming the shape of the thrown message so a reader of the
    // saved run finds the match the test asserts.
    try { void (once as any).base.proofReads; }
    catch (err) {
      expect((err as Error).message).toContain("reading 'proofReads'");
    }
  });

  it('parses a once-encoded tracker value as the inner object (idempotent)', () => {
    // The scenario's cdpPoll helper does one parse before resolving;
    // the shared parser is safe to call on both an already-parsed
    // object and a once-encoded string.
    const inner = { base: null, final: null };
    const r1 = s8.parseTrackerValue(JSON.stringify(inner));
    expect(r1).toEqual(inner);
  });

  it('answers null on a non-string input', () => {
    expect(s8.parseTrackerValue(null)).toBeNull();
    expect(s8.parseTrackerValue(42 as any)).toBeNull();
    expect(s8.parseTrackerValue({} as any)).toBeNull();
  });
});
