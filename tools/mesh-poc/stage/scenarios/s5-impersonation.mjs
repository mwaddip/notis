// MESH_INTERFACE → Acceptance 5 — "A node with its own key and a copy
// of a first-contact node's certificate, at that node's address: refused
// at the link, that address dropped, the node not blacklisted."
//
// Two steps. The first measures the impostor (1-3), the second restores
// pub1 (4):
//   1. Stop pub1's notis node and wait for its tree to be gone before
//      the impostor binds its ports (`stopTree` on the recorded PID of
//      `notis:pub1`; the mesh functionality lives in the integrated
//      node, NODE_INTERFACE → Configuration).
//   2. Spawn an impostor notis node whose `.mesh` directory is a copy
//      of pub1's and whose node key is fresh — so the WebRTC-direct
//      certificate's hash in the printed multiaddr matches pub1's and
//      the Ed25519 identity does not
//      (MESH_INTERFACE → Transports → "Every link is authenticated by
//      the key it was dialled for"). Bind pub1's address.
//   3. Poll `state.nodes[pub1-id].droppedAddrs` for pub1's own address;
//      measure `anchorStatus` from `state.nodes[pub1-id].status`.
//   4. Stop the impostor through `stopTree` so the kernel has released
//      its sockets, restart pub1's notis from the recorded argv, and
//      check pub1's `/health` reads `peers_connected >= 1` before this
//      step returns.
//
// Pass condition: pub1's status is not `blacklisted` (an impostor on
// a key-authenticated link is a key mismatch, not a lie); the dropped
// address list includes pub1's own.

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS5 } from '../lib/verdicts.mjs';
import {
  execIn, findPid, restartFromEntry, stopTree, waitNetworkingUp,
} from '../lib/measure.mjs';
import { writeStageDefault } from '../lib/scenario-config.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's5';
const TARGET_HOST = 'pub1';
// MESH_INTERFACE → Acceptance 5 — the stop target is the one integrated
// `notis:<host>` process that `up.mjs` spawns.
const TARGET_NOTIS_DESC = `notis:${TARGET_HOST}`;
// RFC 8410 PKCS8 Ed25519 private-key wrapper for a 32-byte seed.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function describe() {
  return [
    'impostor on pub1 address: refused at the link, address dropped, anchor not blacklisted',
    'impostor stopped and pub1 restarted, mesh networking up',
  ];
}

/**
 * Pure: write a 48-byte PKCS8 Ed25519 private key file for a fresh
 * random seed. The seed is a cryptographically random 32-byte value;
 * the returned object carries the derived notisId (64 hex of the
 * public key) so the scenario can spot the impostor's identity in
 * the client's node list.
 *
 * Writes the integrated node's key file (`NODE_KEY_PATH`): the one
 * Ed25519 key that drives the libp2p peer identity. Pairing it with
 * a copy of pub1's `.mesh` directory keeps the WebRTC-direct
 * certificate's hash matching pub1's advertised multiaddr while the
 * node's identity differs (MESH_INTERFACE → Transports → "Every link
 * is authenticated by the key it was dialled for"; NODE_INTERFACE →
 * Configuration → "The mesh state directory is named for the store").
 */
export function writeFreshMeshKey(path, { randomBytes }) {
  const seed = randomBytes(32);
  const bytes = Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]);
  if (bytes.length !== 48) throw new Error(`PKCS8 Ed25519 private key must be 48 bytes, got ${bytes.length}`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, notisId: Buffer.from(pub).toString('hex') };
}

export function applyFaults(log, topology) {
  // Dry-run records the stop + spawn so a reader sees the shape.
  const pub1 = topology.hosts.pub1;
  const invokingUser = 'mwaddip';
  const impostorRoot = `/home/${invokingUser}/.cache/mesh-poc/s5-impostor`;
  const impostorKey = `${impostorRoot}/notis.key`;
  const impostorDb = `${impostorRoot}/notis.db`;
  const nodeBin = '/home/mwaddip/.nvm/versions/node/v24.22.1/bin/node';
  const notisMain = '/home/mwaddip/projects/dagsocial/packages/node/dist/index.js';
  log.records.push(`[fault:${NAME}:stop-${TARGET_HOST}-notis] kill -TERM <${TARGET_NOTIS_DESC}-pid>`);
  if (log.dryRun) process.stdout.write(`[fault:${NAME}:stop-${TARGET_HOST}-notis] kill -TERM <${TARGET_NOTIS_DESC}-pid>\n`);
  const argv = [
    'sudo', 'ip', 'netns', 'exec', 'notismesh-pub1',
    'sudo', '-u', invokingUser, '--',
    'env',
    `NETWORK_TYPE=${topology.network}`,
    'NODE_ROLE=server',
    `PORT=${pub1.node.httpPort}`,
    `ADMIN_PORT=${pub1.node.httpPort + 1}`,
    `DB_PATH=${impostorDb}`,
    `NODE_KEY_PATH=${impostorKey}`,
    `LISTEN_ADDRS=/ip4/${pub1.addr}/tcp/${pub1.node.p2pPort}`,
    'MESH_ROLE=public',
    `MESH_LISTEN=/ip4/${pub1.addr}/udp/${pub1.mesh.webrtcPort}/webrtc-direct,/ip4/${pub1.addr}/tcp/${pub1.mesh.tcpPort}`,
    nodeBin, notisMain,
  ];
  log.spawn('impostor-notis', argv);
}

export async function run(ctx) {
  const log = new FaultLog({ dryRun: ctx.dryRun, scenario: NAME });
  const started = Date.now();
  const rec = new StepRecorder();
  if (ctx.dryRun) {
    applyFaults(log, ctx.topology);
    for (const name of describe()) rec.skipped(name);
    log.removeAll();
    return { scenario: NAME, startedAt: started, endedAt: Date.now(), steps: rec.steps, faults: log.records };
  }

  // Exec-mode flow.
  // MESH_INTERFACE → Acceptance — s5 reads the stage default; it
  // writes it fresh so a previous scenario's variant does not leak.
  writeStageDefault(ctx.outDir);

  const identities = JSON.parse(readFileSync(join(ctx.outDir, 'identities.json'), 'utf8'));
  const pub1Id = identities.pub1?.notisId;
  const pub1Host = ctx.topology.hosts.pub1;
  const pub1Addr = pub1Host.addr;
  const pub1Mesh = pub1Host.mesh;
  const pub1Entry = findPid(ctx.pids?.pids, TARGET_NOTIS_DESC);
  if (!pub1Entry) throw new Error(`s5: pids.json has no ${TARGET_NOTIS_DESC} entry`);

  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  // The impostor's root: a fresh dir holding the `.mesh` copy, its
  // fresh node key and its own empty `.db` file, laid out the way
  // config.ts' `meshStateDirFor(dbPath)` and `parseNodeKeyPath` expect
  // (NODE_INTERFACE → Configuration → "The mesh state directory is
  // named for the store"). `notis.db` → `notis.mesh` (directory) →
  // `notis.key` (file).
  const impostorRoot = join(ctx.outDir, 'scenarios', 's5-impostor');
  const impostorDb = join(impostorRoot, 'notis.db');
  const impostorKey = join(impostorRoot, 'notis.key');
  const impostorMeshDir = join(impostorRoot, 'notis.mesh');
  // pub1's `.mesh` directory sits beside its `DB_PATH`
  // (`stage/out/pub1/notis.db` → `stage/out/pub1/notis.mesh`).
  const pub1MeshDir = join(ctx.outDir, 'pub1', 'notis.mesh');

  // 1. Stop pub1's notis node and wait for its tree to be gone, so the
  //    kernel has released pub1's mesh and HTTP ports before the
  //    impostor binds them.
  let pub1Stopped = false;
  let impostorPid = null;
  log.records.push(`[fault:${NAME}:stop-pub1-notis] kill -TERM ${pub1Entry.pid}`);
  const stopResult = await stopTree(pub1Entry.pid, { timeoutMs: 15_000 });
  pub1Stopped = stopResult.termSent.length > 0 || stopResult.killSent.length > 0;
  log.records.push(`[fault:${NAME}:stop-pub1-notis:gone] tree ${stopResult.initialTree.join(',')} (term ${stopResult.termSent.length}, kill ${stopResult.killSent.length})`);

  try {
    await rec.step(describe()[0], async () => {
      // 2. Prepare impostor root: copy pub1's `.mesh` directory into
      //    the impostor's own layout, write a fresh node key. The
      //    WebRTC-direct certificate lives in the libp2p datastore
      //    under `.mesh/`; copying it keeps the cert hash matching
      //    pub1's multiaddr while a fresh NODE_KEY_PATH gives the
      //    impostor a different Ed25519 identity.
      if (existsSync(impostorRoot)) {
        rmSync(impostorRoot, { recursive: true, force: true });
      }
      mkdirSync(impostorRoot, { recursive: true });
      if (existsSync(pub1MeshDir)) {
        cpSync(pub1MeshDir, impostorMeshDir, { recursive: true });
      }
      const randomBytes = (n) => {
        const buf = Buffer.alloc(n);
        const nodeCrypto = globalThis.crypto;
        if (nodeCrypto?.getRandomValues) nodeCrypto.getRandomValues(buf);
        else throw new Error('no crypto.getRandomValues available');
        return buf;
      };
      const { notisId: impostorNotisId } = writeFreshMeshKey(impostorKey, { randomBytes });

      // 3. Spawn impostor on pub1's addresses. The notis binary's
      //    MESH_* env drives its mesh entity's listen set
      //    (NODE_INTERFACE → Configuration); NODE_KEY_PATH selects
      //    the fresh key.
      const impostorArgv = [
        'sudo', 'ip', 'netns', 'exec', 'notismesh-pub1',
        'sudo', '-u', ctx.invokingUser, '--',
        'env',
        `NETWORK_TYPE=${ctx.topology.network}`,
        'NODE_ROLE=server',
        `PORT=${pub1Host.node.httpPort}`,
        `ADMIN_PORT=${pub1Host.node.httpPort + 1}`,
        `DB_PATH=${impostorDb}`,
        `NODE_KEY_PATH=${impostorKey}`,
        `LISTEN_ADDRS=/ip4/${pub1Addr}/tcp/${pub1Host.node.p2pPort}`,
        'MESH_ROLE=public',
        `MESH_LISTEN=/ip4/${pub1Addr}/udp/${pub1Mesh.webrtcPort}/webrtc-direct,/ip4/${pub1Addr}/tcp/${pub1Mesh.tcpPort}`,
        ctx.nodeBin, ctx.notisMain,
      ];
      const spawnEntry = {
        argv: impostorArgv,
        env: {},
        logPath: join(ctx.outDir, 'scenarios', 's5-impostor.log'),
      };
      impostorPid = restartFromEntry(spawnEntry);
      log.records.push(`[fault:${NAME}:impostor-notis:spawn] ${impostorArgv.join(' ')}`);

      // 4. Poll state until pub1's entry has an address in droppedAddrs.
      // The scenario's first page load carries `?clearMemory=1` so a
      // prior scenario's kept proof does not seat this client.
      const stateText = await cdpPoll(ctx, `${browserUrl}?clearMemory=1`,
        "document.getElementById('state')?.textContent ?? null",
        `if (v === null) return false;
         try {
           const s = JSON.parse(v);
           const pub1 = s.nodes?.find((n) => n.notisId === ${JSON.stringify(pub1Id)});
           if (!pub1) return false;
           return Array.isArray(pub1.droppedAddrs) && pub1.droppedAddrs.length > 0;
         } catch (_e) { return false; }`,
        120_000, 1000,
      );
      const state = JSON.parse(stateText);
      const pub1Node = state.nodes?.find((n) => n.notisId === pub1Id);
      const blockedAddr = pub1Node?.droppedAddrs?.[0] ?? null;
      const m = {
        impostorNotisId,
        anchorStatus: pub1Node?.status ?? null,
        droppedAddrs: pub1Node?.droppedAddrs ?? [],
        blockedAddr: blockedAddr ?? '<none>',
      };
      return { verdict: verdictS5(m), measurement: m };
    });

    // MESH_INTERFACE → Acceptance 5 — hand the stage back with pub1
    // reachable: stop the impostor through `stopTree` (the kernel
    // releases its sockets before the function returns, so pub1's
    // `net.start()` binds the same ports with no `EADDRINUSE`),
    // restart pub1 from its recorded argv, and check its networking
    // is up. A failure here fails the step: a scenario after s5 reads
    // a mesh with pub1 or it reads a FAIL this scenario surfaced.
    await rec.step(describe()[1], async () => {
      const t0 = Date.now();
      let impostorStop = null;
      if (impostorPid !== null) {
        impostorStop = await stopTree(impostorPid, { timeoutMs: 20_000 });
        impostorPid = null;
      }
      let pub1Restart = null;
      let pub1Health = null;
      if (pub1Stopped) {
        // `pidsPath` rewrites `pids.json` with the new pid in place of
        // the stale one, so `stage:down` signals the live process.
        const newPid = restartFromEntry(pub1Entry, { pidsPath: ctx.pidsPath });
        pub1Entry.pid = newPid;
        pub1Stopped = false;
        pub1Restart = { pid: newPid };
        pub1Health = await waitNetworkingUp(`notismesh-${TARGET_HOST}`, pub1Host.node.httpPort + 1, {
          timeoutMs: 60_000,
          user: ctx.invokingUser,
        });
      }
      const measurement = {
        impostorStop: impostorStop === null ? null : {
          initialTree: impostorStop.initialTree,
          termSent: impostorStop.termSent.length,
          killSent: impostorStop.killSent.length,
        },
        pub1Restart,
        pub1Health,
        timeMs: Date.now() - t0,
      };
      return { verdict: 'PASS', measurement };
    });
  } finally {
    // Safety only — the step above does the stop-then-start on the
    // happy path. If the step threw before reaching the restart, stop
    // the impostor and restart pub1 here so the stage is handed back.
    if (impostorPid !== null) {
      try { await stopTree(impostorPid, { timeoutMs: 20_000 }); } catch (err) {
        process.stderr.write(`[s5 teardown] impostor stopTree: ${err?.message ?? err}\n`);
      }
    }
    if (pub1Stopped) {
      try {
        const newPid = restartFromEntry(pub1Entry, { pidsPath: ctx.pidsPath });
        pub1Entry.pid = newPid;
        pub1Stopped = false;
      } catch (err) {
        process.stderr.write(`[s5 teardown] pub1 restart: ${err?.message ?? err}\n`);
      }
    }
    if (existsSync(impostorRoot)) {
      rmSync(impostorRoot, { recursive: true, force: true });
    }
    log.removeAll();
  }
  return {
    scenario: NAME,
    startedAt: started,
    endedAt: Date.now(),
    steps: rec.steps,
    faults: log.records,
  };
}

async function cdpPoll(ctx, url, expression, predicateBody, timeoutMs, pollMs) {
  const argv = [
    ctx.nodeBin, ctx.cdpScript, 'poll', url, expression, predicateBody,
    String(timeoutMs), String(pollMs),
  ];
  const buf = execIn('notismesh-browser', argv, {
    user: ctx.invokingUser,
    timeoutMs: timeoutMs + 10_000,
  });
  return JSON.parse(buf.toString('utf8'));
}
