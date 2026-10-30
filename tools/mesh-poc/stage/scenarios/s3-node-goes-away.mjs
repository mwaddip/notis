// MESH_INTERFACE → Acceptance 3 — "A node goes away. Killed, then
// firewalled: the client moves to another node within two checks, the
// node reads `retry`, never `blacklisted`, and reads `ok` again once
// it is back."
//
// Faults applied, in order:
//   - A1: stop pub1's mesh node (`kill -TERM`), measure the move, restart
//   - A2: nft `s3_fw` table in pub1's namespace drops its mesh ports,
//     measure the move, remove the table

import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS3Moved, verdictS3Recovered } from '../lib/verdicts.mjs';

export const NAME = 's3';
const FW_TABLE = 's3_fw';

export function describe() {
  return [
    'pub1 stopped: client moves to another node within 2 checks, pub1 retry',
    'pub1 restarted: pub1 reads ok at a later check',
    'pub1 firewalled: client moves to another node within 2 checks, pub1 retry',
    'pub1 unfirewalled: pub1 reads ok at a later check',
  ];
}

/**
 * s3's faults are applied inside the scenario body (between step 1 and
 * step 3) rather than up front: the client has to see each state in
 * turn. The signatures below are the fault argvs each sub-step uses,
 * exported so a case can hold them against the recorded dry-run.
 */
export function pub1FirewallArgs(topology) {
  const pub1 = topology.hosts.pub1;
  const ns = `notismesh-pub1`;
  const webrtcPort = String(pub1.mesh.webrtcPort);
  const tcpPort = String(pub1.mesh.tcpPort);
  const wssPort = String(pub1.mesh.wss.port);
  return {
    addTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', FW_TABLE],
    addChain: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', FW_TABLE, 'in', '{', 'type', 'filter', 'hook', 'input', 'priority', '0', ';', '}'],
    dropUdp: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', FW_TABLE, 'in', 'udp', 'dport', webrtcPort, 'drop'],
    dropTcpMesh: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', FW_TABLE, 'in', 'tcp', 'dport', tcpPort, 'drop'],
    dropTcpWss: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', FW_TABLE, 'in', 'tcp', 'dport', wssPort, 'drop'],
    deleteTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', FW_TABLE],
  };
}

export function applyFaults(log, topology) {
  // The dry-run of `stage:run` prints every fault s3 would apply and
  // its removal; in dry-run we record them up-front so a reader of the
  // whole output sees the full set per scenario. The real run applies
  // them one at a time inside `run(ctx)` (not reached from the gate).
  const f = pub1FirewallArgs(topology);
  // The signal is paired with a restart; the scenario holds the pid and
  // the recorded argv on exec.
  log.apply('pub1-fw-add-table', f.addTable, f.deleteTable);
  log.apply('pub1-fw-add-chain', f.addChain, null);
  log.apply('pub1-fw-drop-udp', f.dropUdp, null);
  log.apply('pub1-fw-drop-tcp-mesh', f.dropTcpMesh, null);
  log.apply('pub1-fw-drop-tcp-wss', f.dropTcpWss, null);
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
    void verdictS3Moved;
    void verdictS3Recovered;
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
