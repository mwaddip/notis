// MESH_INTERFACE → Acceptance 6 — the single-host fork builder's
// pure functions, as the pair's are tested: the nft rules write a
// drop-every-p2p-port table with no accept exceptions (the host has
// no partner), the teardown is a single `delete table`, the miner
// plan names the host's own HTTP port on loopback, and the host's
// Notis `BOOTSTRAP_PEERS` is pub1 alone so the host syncs the honest
// chain before the cut lands.

import { describe, expect, it } from 'vitest';
import {
  buildForkCutArgs,
  buildForkCutTeardownArgs,
  buildForkMinerSpawn,
  forkHostBootstrapPeers,
} from '../stage/lib/hostile-fork-single.mjs';

function fakeTopology() {
  return {
    hosts: {
      'hostile-fork': {
        role: 'hostile',
        addr: '11.100.0.35',
        node: { httpPort: 3100, p2pPort: 9100, role: 'server' },
      },
      pub1: {
        role: 'public',
        addr: '11.100.0.11',
        node: { httpPort: 3100, p2pPort: 9100 },
      },
    },
  } as unknown as Parameters<typeof buildForkCutArgs>[0];
}

describe('hostile-fork-single builder', () => {
  // The cut's own nft rules: table, output chain, input chain, two
  // drop rules on the Notis p2p port. No accept rules for a partner —
  // the host has none.
  it('buildForkCutArgs: table + two chains + two drops, in order', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork');
    expect(rules.map((r) => r.description)).toEqual([
      'hostile-fork-fork-add-table',
      'hostile-fork-fork-add-chain-out',
      'hostile-fork-fork-add-chain-in',
      'hostile-fork-fork-out-drop',
      'hostile-fork-fork-in-drop',
    ]);
  });

  // Each argv runs inside the host's own namespace — a stray `nft add
  // rule` outside the namespace would land on the host.
  it('buildForkCutArgs: every argv is a sudo ip netns exec notismesh-<name> nft command', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork');
    for (const r of rules) {
      expect(r.argv.slice(0, 6)).toEqual([
        'sudo', 'ip', 'netns', 'exec', 'notismesh-hostile-fork', 'nft',
      ]);
    }
  });

  // The two chain declarations name `type filter hook output / input
  // priority 0` — nft -c would refuse anything else.
  it('buildForkCutArgs: table and chains carry the right nft phrases', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork', { table: 'fork_cut' });
    const table = rules.find((r) => r.description === 'hostile-fork-fork-add-table')!;
    const chainOut = rules.find((r) => r.description === 'hostile-fork-fork-add-chain-out')!;
    const chainIn = rules.find((r) => r.description === 'hostile-fork-fork-add-chain-in')!;
    expect(table.argv.join(' ')).toMatch(/\bnft add table ip fork_cut$/);
    expect(chainOut.argv.join(' ')).toMatch(/\bnft add chain ip fork_cut out \{ type filter hook output priority 0 ; \}$/);
    expect(chainIn.argv.join(' ')).toMatch(/\bnft add chain ip fork_cut in \{ type filter hook input priority 0 ; \}$/);
  });

  // The two drop rules name the Notis p2p port on the right direction:
  // outbound keys on dport (where the packet is headed), inbound on
  // sport (where the packet came from).
  it('buildForkCutArgs: the two drops name the Notis p2p port on each direction', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork');
    const outDrop = rules.find((r) => r.description === 'hostile-fork-fork-out-drop')!;
    const inDrop = rules.find((r) => r.description === 'hostile-fork-fork-in-drop')!;
    expect(outDrop.argv.join(' ')).toMatch(/\btcp dport 9100 drop\b/);
    expect(inDrop.argv.join(' ')).toMatch(/\btcp sport 9100 drop\b/);
  });

  // The host has no partner, so no `daddr` or `saddr` accept rule
  // appears. A mutation that added one would open a hole in the cut.
  it('buildForkCutArgs: no daddr/saddr accept rule — the host has no partner', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork');
    for (const r of rules) {
      const joined = r.argv.join(' ');
      expect(joined).not.toMatch(/\baccept\b/);
    }
  });

  it('buildForkCutArgs: a host without node.p2pPort throws naming the host', () => {
    const topo = { hosts: { 'hostile-fork': { node: {} } } } as unknown as Parameters<typeof buildForkCutArgs>[0];
    expect(() => buildForkCutArgs(topo, 'hostile-fork')).toThrow(/p2pPort/);
  });

  it('buildForkCutArgs: a missing host throws naming it', () => {
    const topo = fakeTopology();
    expect(() => buildForkCutArgs(topo, 'nope')).toThrow(/"nope"/);
  });

  it('buildForkCutTeardownArgs: a single delete table, in the host namespace', () => {
    const rules = buildForkCutTeardownArgs('hostile-fork', { table: 'fork_cut' });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.description).toBe('hostile-fork-fork-delete-table');
    expect(rules[0]!.argv.join(' ')).toMatch(/\bnft delete table ip fork_cut$/);
    expect(rules[0]!.argv.slice(0, 5)).toEqual([
      'sudo', 'ip', 'netns', 'exec', 'notismesh-hostile-fork',
    ]);
  });

  // The miner script runs inside the host's namespace as the invoking
  // user, pointed at the host's own HTTP port on loopback. No
  // NODE_ROLE change is needed — `miner.mjs` reads the HTTP mining
  // endpoints a `role: 'server'` node answers.
  it('buildForkMinerSpawn: NODE_URL names loopback + the host httpPort; MINER_PCT comes through', () => {
    const topo = fakeTopology();
    const plan = buildForkMinerSpawn(topo, 'hostile-fork', {
      minerScript: '/repo/packages/node/scripts/miner.mjs',
      minerPct: 1,
      invokingUser: 'mwaddip',
    });
    expect(plan.description).toBe('miner-hostile-fork');
    expect(plan.env.NODE_URL).toBe('http://127.0.0.1:3100');
    expect(plan.env.MINER_PCT).toBe('1');
    expect(plan.argv.slice(0, 7)).toEqual([
      'sudo', 'ip', 'netns', 'exec', 'notismesh-hostile-fork',
      'sudo', '-u',
    ]);
    expect(plan.argv).toContain('mwaddip');
  });

  it('buildForkMinerSpawn: miningSecret, when given, lands in env; absent, no key', () => {
    const topo = fakeTopology();
    const withSecret = buildForkMinerSpawn(topo, 'hostile-fork', {
      minerScript: '/x.mjs',
      invokingUser: 'u',
      miningSecret: 'shh',
    });
    expect(withSecret.env.MINING_SECRET).toBe('shh');
    const withoutSecret = buildForkMinerSpawn(topo, 'hostile-fork', {
      minerScript: '/x.mjs',
      invokingUser: 'u',
    });
    expect(withoutSecret.env.MINING_SECRET).toBeUndefined();
  });

  it('buildForkMinerSpawn: MINER_PCT defaults to 1 (a slow pace, lighter than the honest chain)', () => {
    const topo = fakeTopology();
    const plan = buildForkMinerSpawn(topo, 'hostile-fork', {
      minerScript: '/x.mjs',
      invokingUser: 'u',
    });
    expect(plan.env.MINER_PCT).toBe('1');
  });

  // The host starts synced to the honest chain — its BOOTSTRAP_PEERS
  // names pub1 alone, so it joins the honest side before the cut
  // lands.
  it('forkHostBootstrapPeers: pub1 addr alone', () => {
    const pub1 = '/ip4/11.100.0.11/tcp/9100';
    expect(forkHostBootstrapPeers(pub1)).toBe(pub1);
  });

  it('forkHostBootstrapPeers: a non-string pub1 throws', () => {
    expect(() => forkHostBootstrapPeers('')).toThrow();
    expect(() => forkHostBootstrapPeers(null as unknown as string)).toThrow();
  });
});
