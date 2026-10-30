// MESH_INTERFACE → Acceptance — the scenario modules' pure parts and
// their dry-run shape: `describe()`, `applyFaults`, `run({dryRun:true})`
// return results without touching the host. The exec-mode flow runs
// on the real stage (not here).

import { describe, expect, it } from 'vitest';
import * as s1 from '../stage/scenarios/s1-no-name.mjs';
import * as s3 from '../stage/scenarios/s3-node-goes-away.mjs';

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
  it.fails('describe() lists four steps: node + two probes + DNS silent', () => {
    const names = s1.describe();
    expect(names.length, 'four steps').toBe(4);
    expect(names[0]).toMatch(/anchor within/);
    expect(names[1]).toMatch(/\/blocks\/current/);
    expect(names[2]).toMatch(/\/nipopow\/proof\/24\/20/);
    expect(names[3]).toMatch(/DNS log/);
  });
  it.fails('run({dryRun:true}) returns one result per describe() name, every verdict skipped', async () => {
    const r = await s1.run({ dryRun: true, topology: TOPOLOGY });
    expect(r.scenario).toBe('s1');
    expect(r.steps.length).toBe(4);
    for (const step of r.steps) {
      expect(step.verdict, step.name).toBe('skipped');
      expect(step.measurement).toBe(null);
    }
    expect(r.faults).toEqual([]); // s1 applies no faults.
  });
  it.fails('hostOfNodeId maps a notisId to the host that owns it', () => {
    const identities = {
      pub1: { notisId: 'aa'.repeat(32), meshRole: 'public', addr: '10.100.0.11', httpPort: 3100 },
      pub2: { notisId: 'bb'.repeat(32), meshRole: 'public', addr: '10.100.0.12', httpPort: 3100 },
    };
    expect(s1.hostOfNodeId(identities, 'aa'.repeat(32))).toBe('pub1');
    expect(s1.hostOfNodeId(identities, 'bb'.repeat(32))).toBe('pub2');
    expect(s1.hostOfNodeId(identities, 'cc'.repeat(32))).toBe(null);
    expect(s1.hostOfNodeId(null, 'aa'.repeat(32))).toBe(null);
  });
  it.fails('anchorIdSet reads config.anchors[].notisId into a Set', () => {
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
