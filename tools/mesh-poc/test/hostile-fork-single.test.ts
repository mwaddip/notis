// MESH_INTERFACE → Acceptance 6 — the single-host fork builder's
// pure functions, as the pair's are tested: the nft rules write a
// `policy drop` cut whose only accepts are loopback, the partner's
// address and the browser's address; the teardown is a single
// `delete table`; the miner plan names the host's own HTTP port on
// loopback with env INLINED via `env VAR=VAL ...` so `sudo -u`'s
// environment stripping does not leave the miner with defaults; the
// host's Notis `BOOTSTRAP_PEERS` is pub1 alone so the host syncs the
// honest chain before the cut lands.

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
        node: { httpPort: 3100, p2pPort: 9100, role: 'miner' },
      },
      'hostile-fork-peer': {
        role: 'hostile',
        addr: '11.100.0.36',
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

const DEFAULT_OPTS = {
  partner: { addr: '11.100.0.36' },
  browserAddr: '11.100.0.103',
};

describe('hostile-fork-single builder', () => {
  // The cut's own nft rules: table, output chain with policy drop,
  // input chain with policy drop, two loopback accepts, two partner
  // accepts, two browser accepts. Every other packet drops at the
  // kernel — WebRTC-direct (UDP), relayed WebRTC, secure WebSocket,
  // DHT, gossipsub, Notis p2p.
  it('buildForkCutArgs: table + two policy-drop chains + loopback + partner + browser accepts', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork', DEFAULT_OPTS);
    expect(rules.map((r) => r.description)).toEqual([
      'hostile-fork-fork-add-table',
      'hostile-fork-fork-add-chain-out',
      'hostile-fork-fork-add-chain-in',
      'hostile-fork-fork-out-accept-lo',
      'hostile-fork-fork-in-accept-lo',
      'hostile-fork-fork-out-accept-partner',
      'hostile-fork-fork-in-accept-partner',
      'hostile-fork-fork-out-accept-browser',
      'hostile-fork-fork-in-accept-browser',
    ]);
  });

  it('buildForkCutArgs: each chain declares `policy drop`', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork', DEFAULT_OPTS);
    const chainOut = rules.find((r) => r.description === 'hostile-fork-fork-add-chain-out')!;
    const chainIn = rules.find((r) => r.description === 'hostile-fork-fork-add-chain-in')!;
    expect(chainOut.argv.join(' ')).toMatch(/\btype filter hook output priority 0 ; policy drop ; \}$/);
    expect(chainIn.argv.join(' ')).toMatch(/\btype filter hook input priority 0 ; policy drop ; \}$/);
  });

  // Each argv runs inside the host's own namespace — a stray `nft add
  // rule` outside the namespace would land on the host.
  it('buildForkCutArgs: every argv is a sudo ip netns exec notismesh-<name> nft command', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork', DEFAULT_OPTS);
    for (const r of rules) {
      expect(r.argv.slice(0, 6)).toEqual([
        'sudo', 'ip', 'netns', 'exec', 'notismesh-hostile-fork', 'nft',
      ]);
    }
  });

  it('buildForkCutArgs: loopback accepts name oif/iif lo (not an address)', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork', DEFAULT_OPTS);
    const outLo = rules.find((r) => r.description === 'hostile-fork-fork-out-accept-lo')!;
    const inLo = rules.find((r) => r.description === 'hostile-fork-fork-in-accept-lo')!;
    expect(outLo.argv.join(' ')).toMatch(/\boif lo accept\b/);
    expect(inLo.argv.join(' ')).toMatch(/\biif lo accept\b/);
  });

  // The partner accept rule names only the partner's address (any
  // protocol, no port) — libp2p peers over several transports and the
  // cut must leave every one of them open between the pair, so a
  // port-keyed accept would leak traffic through the drop policy.
  it('buildForkCutArgs: partner accepts name the partner address alone (no port, no protocol)', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork', DEFAULT_OPTS);
    const outPartner = rules.find((r) => r.description === 'hostile-fork-fork-out-accept-partner')!;
    const inPartner = rules.find((r) => r.description === 'hostile-fork-fork-in-accept-partner')!;
    expect(outPartner.argv.join(' ')).toMatch(/\bip daddr 11\.100\.0\.36 accept$/);
    expect(inPartner.argv.join(' ')).toMatch(/\bip saddr 11\.100\.0\.36 accept$/);
    // No TCP/UDP qualifier — any protocol.
    expect(outPartner.argv.join(' ')).not.toMatch(/\btcp |\budp /);
    expect(inPartner.argv.join(' ')).not.toMatch(/\btcp |\budp /);
  });

  // The browser accept rule names the browser's address as seen from
  // this host — natC's outside address (`11.100.0.103`) for a public
  // fork host, `10.103.0.11` for a private fork host behind natC.
  it('buildForkCutArgs: browser accepts name the browser address alone', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork', {
      ...DEFAULT_OPTS,
      browserAddr: '11.100.0.103',
    });
    const outBrowser = rules.find((r) => r.description === 'hostile-fork-fork-out-accept-browser')!;
    const inBrowser = rules.find((r) => r.description === 'hostile-fork-fork-in-accept-browser')!;
    expect(outBrowser.argv.join(' ')).toMatch(/\bip daddr 11\.100\.0\.103 accept$/);
    expect(inBrowser.argv.join(' ')).toMatch(/\bip saddr 11\.100\.0\.103 accept$/);
  });

  // The policy and the rules together close every other packet
  // path between the fork host and any other address — there is no
  // accept keyed on TCP p2p port, UDP WebRTC-direct port or secure
  // WebSocket port, so a mutation adding such a port-keyed accept
  // for a honest address would leak.
  it('buildForkCutArgs: no port-keyed accept for anyone — the cut is address-only + loopback', () => {
    const topo = fakeTopology();
    const rules = buildForkCutArgs(topo, 'hostile-fork', DEFAULT_OPTS);
    for (const r of rules) {
      if (r.description.endsWith('add-table') || r.description.endsWith('add-chain-out') || r.description.endsWith('add-chain-in')) continue;
      const joined = r.argv.join(' ');
      // The one `drop` rule from an earlier shape is retired — the
      // policy itself drops, so no explicit drop rule stands.
      expect(joined, `${r.description}: no drop rule`).not.toMatch(/\bdrop$/);
      // No accept keyed on a port.
      if (!joined.match(/\bdaddr|saddr/) && !joined.match(/\boif lo|iif lo/)) {
        expect(joined, `${r.description}: no port-keyed rule`).not.toMatch(/\btcp (dport|sport)\b|\budp (dport|sport)\b/);
      }
    }
  });

  it('buildForkCutArgs: a host without node.p2pPort throws naming the host', () => {
    const topo = { hosts: { 'hostile-fork': { node: {} } } } as unknown as Parameters<typeof buildForkCutArgs>[0];
    expect(() => buildForkCutArgs(topo, 'hostile-fork', DEFAULT_OPTS)).toThrow(/p2pPort/);
  });

  it('buildForkCutArgs: a missing host throws naming it', () => {
    const topo = fakeTopology();
    expect(() => buildForkCutArgs(topo, 'nope', DEFAULT_OPTS)).toThrow(/"nope"/);
  });

  it('buildForkCutArgs: a missing partner throws', () => {
    const topo = fakeTopology();
    expect(() => buildForkCutArgs(topo, 'hostile-fork', { browserAddr: '11.100.0.103' } as unknown as typeof DEFAULT_OPTS)).toThrow(/partner/);
    expect(() => buildForkCutArgs(topo, 'hostile-fork', { partner: { addr: '' }, browserAddr: '11.100.0.103' })).toThrow(/partner\.addr/);
  });

  it('buildForkCutArgs: a missing browserAddr throws', () => {
    const topo = fakeTopology();
    expect(() => buildForkCutArgs(topo, 'hostile-fork', { partner: { addr: '11.100.0.36' } } as unknown as typeof DEFAULT_OPTS)).toThrow(/browserAddr/);
    expect(() => buildForkCutArgs(topo, 'hostile-fork', { partner: { addr: '11.100.0.36' }, browserAddr: '' })).toThrow(/browserAddr/);
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
  // user, with env INLINED via `env NAME=VALUE ...` so `sudo -u`'s
  // environment stripping does not leave the miner with the defaults
  // (an earlier shape passed env through `process.env` and the miner
  // logged `node=http://localhost:3000 cpu=25%` — the defaults).
  it('buildForkMinerSpawn: NODE_URL/MINER_PCT/MINING_SECRET land on the command line as env VAR=VAL', () => {
    const topo = fakeTopology();
    const plan = buildForkMinerSpawn(topo, 'hostile-fork', {
      minerScript: '/repo/packages/node/scripts/miner.mjs',
      minerPct: 1,
      invokingUser: 'mwaddip',
      miningSecret: 'shh',
    });
    expect(plan.description).toBe('miner-hostile-fork');
    const joined = plan.argv.join(' ');
    // The env lands AFTER `env` and BEFORE the node binary — the
    // shape the pair's miner uses too.
    expect(joined).toContain('env NODE_URL=http://127.0.0.1:3100 MINER_PCT=1 MINING_SECRET=shh');
    expect(plan.argv.slice(0, 9)).toEqual([
      'sudo', 'ip', 'netns', 'exec', 'notismesh-hostile-fork',
      'sudo', '-u', 'mwaddip', '--',
    ]);
    // `env` is the tenth element, before the env pairs.
    expect(plan.argv[9]).toBe('env');
    expect(plan.env.NODE_URL).toBe('http://127.0.0.1:3100');
    expect(plan.env.MINER_PCT).toBe('1');
    expect(plan.env.MINING_SECRET).toBe('shh');
  });

  it('buildForkMinerSpawn: a nodeBin overrides the default `node`', () => {
    const topo = fakeTopology();
    const plan = buildForkMinerSpawn(topo, 'hostile-fork', {
      minerScript: '/repo/packages/node/scripts/miner.mjs',
      invokingUser: 'u',
      nodeBin: '/home/u/.nvm/versions/node/v24.22.1/bin/node',
    });
    // The second-to-last element is the Node binary; last is the script.
    expect(plan.argv.slice(-2)).toEqual([
      '/home/u/.nvm/versions/node/v24.22.1/bin/node',
      '/repo/packages/node/scripts/miner.mjs',
    ]);
  });

  it('buildForkMinerSpawn: MINER_PCT defaults to 1', () => {
    const topo = fakeTopology();
    const plan = buildForkMinerSpawn(topo, 'hostile-fork', {
      minerScript: '/x.mjs',
      invokingUser: 'u',
    });
    expect(plan.env.MINER_PCT).toBe('1');
  });

  it('forkHostBootstrapPeers: pub1 addr alone', () => {
    const pub1 = '/ip4/11.100.0.11/tcp/9100';
    expect(forkHostBootstrapPeers(pub1)).toBe(pub1);
  });

  it('forkHostBootstrapPeers: a non-string pub1 throws', () => {
    expect(() => forkHostBootstrapPeers('')).toThrow();
    expect(() => forkHostBootstrapPeers(null as unknown as string)).toThrow();
  });
});
