// MESH_INTERFACE → Acceptance 4 — "A transport is cut. UDP to one public
// node, then to all: the client gets in through another node, then
// through the secure WebSocket; a renewal replaces the certificate with
// no request dropped".
//
// Faults applied in the browser namespace:
//   - A1: nft `s4_udp` table drops `udp daddr <pub1>` on output
//   - A2: nft adds the same rule for every other public mesh node's address
//   - A3 (step 4): nft `s4_tcp` table drops the TCP mesh port between the
//     Notis nodes themselves (`notismesh-pub1` and `notismesh-pub2`'s inner
//     tables), to record what still answers

import { FaultLog } from '../lib/fault-log.mjs';
import { publicMeshHosts } from '../lib/topology.mjs';
import { verdictS4Pub1UdpDrop, verdictS4AllUdpDrop, verdictS4Renewal } from '../lib/verdicts.mjs';

export const NAME = 's4';
const UDP_TABLE = 's4_udp';
const TCP_TABLE = 's4_tcp';

export function describe() {
  return [
    'UDP to pub1 cut: client gets in through another public mesh node',
    'UDP to every public node cut: client connects over WSS to pub1 with the Pebble-issued cert',
    'across one renewal the probes keep succeeding, no lastLeft names a failure',
    'TCP between the Notis nodes p2p port cut: record what still answers',
  ];
}

/**
 * The browser namespace's outbound-UDP drops, one per public mesh node.
 * The scenario applies them in order (pub1 first); the removal is one
 * `delete table` for each. Returns the full set.
 */
export function udpDropArgs(topology) {
  const ns = 'notismesh-browser';
  const base = [
    ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', UDP_TABLE],
    ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', UDP_TABLE, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'],
  ];
  const perHost = [];
  for (const { host } of publicMeshHosts(topology)) {
    // `meta l4proto udp` matches every UDP packet to the given daddr —
    // every port, so the WebRTC-direct and STUN flows both get dropped.
    perHost.push(['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', UDP_TABLE, 'out', 'ip', 'daddr', host.addr, 'meta', 'l4proto', 'udp', 'drop']);
  }
  const deleteTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', UDP_TABLE];
  return { base, perHost, deleteTable };
}

/**
 * The Notis-p2p-port TCP drop between the Notis nodes themselves, one
 * per public node, in each node's own namespace. Scenario 4's step 4
 * records what still answers; the two Notis nodes still gossip over
 * their WSS and over the mesh p2p port, so a block mined at pub1
 * reaches pub2.
 */
export function notisTcpCutArgs(topology) {
  const out = [];
  for (const { name, host } of publicMeshHosts(topology)) {
    const ns = `notismesh-${name}`;
    const p = String(host.node.p2pPort);
    out.push({
      addTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', TCP_TABLE],
      addChain: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', TCP_TABLE, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'],
      dropDport: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', TCP_TABLE, 'out', 'tcp', 'dport', p, 'drop'],
      deleteTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', TCP_TABLE],
    });
  }
  return out;
}

export function applyFaults(log, topology) {
  const udp = udpDropArgs(topology);
  log.apply('browser-udp-add-table', udp.base[0], udp.deleteTable);
  log.apply('browser-udp-add-chain', udp.base[1], null);
  for (let i = 0; i < udp.perHost.length; i += 1) {
    log.apply(`browser-udp-drop-${i}`, udp.perHost[i], null);
  }
  const notisTcp = notisTcpCutArgs(topology);
  for (let i = 0; i < notisTcp.length; i += 1) {
    const t = notisTcp[i];
    log.apply(`notis-tcp-add-table-${i}`, t.addTable, t.deleteTable);
    log.apply(`notis-tcp-add-chain-${i}`, t.addChain, null);
    log.apply(`notis-tcp-drop-${i}`, t.dropDport, null);
  }
}

export async function run(ctx) {
  const log = new FaultLog({ dryRun: ctx.dryRun, scenario: NAME });
  const started = Date.now();
  const steps = [];
  try {
    applyFaults(log, ctx.topology);
    for (const name of describe()) {
      steps.push({ name, verdict: 'skipped', measurement: null, timeMs: 0 });
    }
    void verdictS4Pub1UdpDrop;
    void verdictS4AllUdpDrop;
    void verdictS4Renewal;
  } finally {
    log.removeAll();
  }
  return {
    scenario: NAME,
    startedAt: started,
    endedAt: Date.now(),
    steps,
    faults: log.records,
  };
}
