// MESH_INTERFACE → Acceptance — the scenario modules' pure parts and
// their dry-run shape: `describe()`, `applyFaults`, `run({dryRun:true})`
// return results without touching the host. The exec-mode flow runs
// on the real stage (not here).

import { describe, expect, it } from 'vitest';
import * as s1 from '../stage/scenarios/s1-no-name.mjs';
import * as s2 from '../stage/scenarios/s2-nat.mjs';
import * as s3 from '../stage/scenarios/s3-node-goes-away.mjs';
import * as s4 from '../stage/scenarios/s4-transport-cut.mjs';
import * as s5 from '../stage/scenarios/s5-impersonation.mjs';
import * as s6 from '../stage/scenarios/s6-hostile.mjs';
import * as s7 from '../stage/scenarios/s7-reach-and-load.mjs';

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
  it('describe() lists two steps: anchors unreachable, hostile seeds judged', () => {
    const names = s6.describe();
    expect(names.length).toBe(2);
    expect(names[0]).toMatch(/anchors unreachable/);
    expect(names[1]).toMatch(/hostile seeds/);
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
    expect(r.steps.length).toBe(2);
    for (const step of r.steps) expect(step.verdict).toBe('skipped');
    const adds = r.faults.filter((f) => / nft add /.test(f) && !f.includes('[fault:remove'));
    const dels = r.faults.filter((f) => /\[fault:remove/.test(f));
    expect(adds.length, 'one table + one chain + one drop per public mesh host').toBeGreaterThanOrEqual(3);
    expect(dels.length, 'one table delete').toBe(1);
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
