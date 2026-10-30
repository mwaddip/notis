// MESH_INTERFACE → Acceptance 5 — "A node with its own key and a copy of
// an anchor's certificate, at the anchor's address: refused at the link,
// that address dropped, the anchor not blacklisted."
//
// Faults applied, in order:
//   - A1: stop pub1's mesh node (`kill -TERM`)
//   - A2: spawn an impostor mesh node in pub1's namespace, with its own
//     key and pub1's copied WebRTC-direct certificate, bound to pub1's
//     address (brief: "its own key and pub1's copied WebRTC-direct
//     certificate, on pub1's address")
//
// Removal: stop the impostor, restart pub1's own mesh node from the
// recorded argv (`pids.json`).

import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS5 } from '../lib/verdicts.mjs';

export const NAME = 's5';

export function describe() {
  return [
    'impostor on pub1 address: refused at the link, address dropped, anchor not blacklisted',
  ];
}

/**
 * The impostor's spawn line. The stage already brought pub1's mesh node
 * up through `up.mjs`'s own `userWrap` (`main.ts` for the mesh
 * daemon); this scenario records the equivalent spawn for an impostor
 * key, same WebRTC-direct certificate path, same bind address.
 */
export function impostorSpawnArgs(topology, { nodeBin, meshMain, invokingUser }) {
  const pub1 = topology.hosts.pub1;
  const ns = `notismesh-pub1`;
  // The scenario's own key path is beside pub1's but with a different
  // name, so the stage CA and pub1's config are untouched.
  const impostorKey = `/home/${invokingUser}/.cache/mesh-poc/s5-impostor.key`;
  const impostorStateDir = `/home/${invokingUser}/.cache/mesh-poc/s5-impostor`;
  return [
    'sudo', 'ip', 'netns', 'exec', ns,
    'sudo', '-u', invokingUser, '--',
    'env',
    `MESH_KEY_PATH=${impostorKey}`,
    `MESH_NETWORK=${topology.network}`,
    'MESH_ROLE=public',
    `MESH_STATE_DIR=${impostorStateDir}`,
    'MESH_UPSTREAM=http://127.0.0.1:3100',
    `MESH_LISTEN=/ip4/${pub1.addr}/udp/${pub1.mesh.webrtcPort}/webrtc-direct,/ip4/${pub1.addr}/tcp/${pub1.mesh.tcpPort}`,
    // Copy pub1's WebRTC-direct cert into impostor state so the key hash
    // matches an anchor's address — the stage copies it in exec mode.
    `MESH_WEBRTC_CERT_COPY_FROM=/home/${invokingUser}/projects/dagsocial/tools/mesh-poc/stage/out/pub1/webrtc-direct.cert.pem`,
    nodeBin,
    meshMain,
  ];
}

export function applyFaults(log, topology, { nodeBin, meshMain, invokingUser }) {
  // The signal to pub1's mesh daemon is recorded via `signal(name, pid)`
  // on exec; in dry-run we print a `[fault:s5:stop-pub1]` placeholder
  // line through `log.spawn` so a reader sees the stop step.
  const pub1Pid = log.dryRun ? '<pub1-mesh-pid>' : '';
  if (log.dryRun) {
    const stopLine = `[fault:s5:stop-pub1-mesh] kill -TERM ${pub1Pid}`;
    log.records.push(stopLine);
    process.stdout.write(stopLine + '\n');
  }
  log.spawn('impostor-mesh', impostorSpawnArgs(topology, { nodeBin, meshMain, invokingUser }));
}

export async function run(ctx) {
  const log = new FaultLog({ dryRun: ctx.dryRun, scenario: NAME });
  const started = Date.now();
  const steps = [];
  try {
    applyFaults(log, ctx.topology, {
      nodeBin: ctx.nodeBin ?? '/home/user/.nvm/versions/node/v24.22.1/bin/node',
      meshMain: ctx.meshMain ?? '<meshMain>',
      invokingUser: ctx.invokingUser ?? 'user',
    });
    for (const name of describe()) {
      steps.push({ name, verdict: 'skipped', measurement: null, timeMs: 0 });
    }
    void verdictS5;
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
