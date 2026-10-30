// MESH_INTERFACE → Acceptance 5 — "A node with its own key and a copy
// of an anchor's certificate, at the anchor's address: refused at the
// link, that address dropped, the anchor not blacklisted."
//
// One step with three measurements:
//   1. Stop pub1's mesh node (`sigterm` the recorded PID).
//   2. Spawn an impostor mesh node whose state dir is a copy of pub1's
//      state dir with a freshly generated `mesh.key` — same WebRTC-direct
//      certificate, different Ed25519 identity. Bind pub1's address.
//   3. Poll `state.nodes[pub1-id].droppedAddrs` for pub1's own address;
//      measure `anchorStatus` from `state.nodes[pub1-id].status`.
//   4. Stop the impostor; restart pub1's mesh from the recorded argv.
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
  execIn, findPid, pollUntil, restartFromEntry, sigterm,
} from '../lib/measure.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's5';
const TARGET_HOST = 'pub1';
const TARGET_MESH_DESC = `mesh:${TARGET_HOST}`;
// RFC 8410 PKCS8 Ed25519 private-key wrapper for a 32-byte seed.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function describe() {
  return [
    'impostor on pub1 address: refused at the link, address dropped, anchor not blacklisted',
  ];
}

/**
 * Pure: write a 48-byte PKCS8 Ed25519 private key file for a fresh
 * random seed. The seed is a cryptographically random 32-byte value;
 * the returned object carries the derived notisId (64 hex of the
 * public key) so the scenario can spot the impostor's identity in
 * the client's node list.
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
  const impostorStateDir = `/home/${invokingUser}/.cache/mesh-poc/s5-impostor`;
  const impostorKey = `${impostorStateDir}/mesh.key`;
  const nodeBin = '/home/mwaddip/.nvm/versions/node/v24.22.1/bin/node';
  const meshMain = '/home/mwaddip/projects/dagsocial/tools/mesh-poc/dist/node/main.js';
  log.records.push(`[fault:${NAME}:stop-${TARGET_HOST}-mesh] kill -TERM <${TARGET_MESH_DESC}-pid>`);
  if (log.dryRun) process.stdout.write(`[fault:${NAME}:stop-${TARGET_HOST}-mesh] kill -TERM <${TARGET_MESH_DESC}-pid>\n`);
  const argv = [
    'sudo', 'ip', 'netns', 'exec', 'notismesh-pub1',
    'sudo', '-u', invokingUser, '--',
    'env',
    `MESH_KEY_PATH=${impostorKey}`,
    `MESH_NETWORK=${topology.network}`,
    'MESH_ROLE=public',
    `MESH_STATE_DIR=${impostorStateDir}`,
    'MESH_UPSTREAM=http://127.0.0.1:3100',
    `MESH_LISTEN=/ip4/${pub1.addr}/udp/${pub1.mesh.webrtcPort}/webrtc-direct,/ip4/${pub1.addr}/tcp/${pub1.mesh.tcpPort}`,
    nodeBin, meshMain,
  ];
  log.spawn('impostor-mesh', argv);
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
  const identities = JSON.parse(readFileSync(join(ctx.outDir, 'identities.json'), 'utf8'));
  const pub1Id = identities.pub1?.notisId;
  const pub1Addr = ctx.topology.hosts.pub1.addr;
  const pub1Mesh = ctx.topology.hosts.pub1.mesh;
  const pub1Entry = findPid(ctx.pids?.pids, TARGET_MESH_DESC);
  if (!pub1Entry) throw new Error(`s5: pids.json has no ${TARGET_MESH_DESC} entry`);

  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const impostorStateDir = join(ctx.outDir, 'scenarios', 's5-impostor');
  const pub1StateDir = join(ctx.outDir, 'pub1');

  // 1. Stop pub1's mesh.
  let pub1Stopped = false;
  let impostorPid = null;
  log.records.push(`[fault:${NAME}:stop-pub1-mesh] kill -TERM ${pub1Entry.pid}`);
  const r = sigterm(pub1Entry.pid);
  pub1Stopped = r.sent;
  // Wait a moment for the OS to free the ports.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    await rec.step(describe()[0], async () => {
      // 2. Prepare impostor state dir: copy pub1's state dir, replace
      //    mesh.key with a fresh one.
      if (existsSync(impostorStateDir)) {
        rmSync(impostorStateDir, { recursive: true, force: true });
      }
      cpSync(pub1StateDir, impostorStateDir, { recursive: true });
      const impostorKey = join(impostorStateDir, 'mesh.key');
      rmSync(impostorKey, { force: true });
      const randomBytes = (n) => {
        const buf = Buffer.alloc(n);
        const nodeCrypto = globalThis.crypto;
        if (nodeCrypto?.getRandomValues) nodeCrypto.getRandomValues(buf);
        else throw new Error('no crypto.getRandomValues available');
        return buf;
      };
      const { notisId: impostorNotisId } = writeFreshMeshKey(impostorKey, { randomBytes });

      // 3. Spawn impostor with pub1's address.
      const impostorArgv = [
        'sudo', 'ip', 'netns', 'exec', 'notismesh-pub1',
        'sudo', '-u', ctx.invokingUser, '--',
        'env',
        `MESH_KEY_PATH=${impostorKey}`,
        `MESH_NETWORK=${ctx.topology.network}`,
        'MESH_ROLE=public',
        `MESH_STATE_DIR=${impostorStateDir}`,
        'MESH_UPSTREAM=http://127.0.0.1:3100',
        `MESH_LISTEN=/ip4/${pub1Addr}/udp/${pub1Mesh.webrtcPort}/webrtc-direct,/ip4/${pub1Addr}/tcp/${pub1Mesh.tcpPort}`,
        ctx.nodeBin, ctx.meshMain,
      ];
      const spawnEntry = {
        argv: impostorArgv,
        env: {},
        logPath: join(ctx.outDir, 'scenarios', 's5-impostor.log'),
      };
      impostorPid = restartFromEntry(spawnEntry);
      log.records.push(`[fault:${NAME}:impostor-mesh:spawn] ${impostorArgv.join(' ')}`);

      // 4. Poll state until pub1's entry has an address in droppedAddrs.
      const stateText = await cdpPoll(ctx, browserUrl,
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
  } finally {
    // Stop impostor, restart pub1.
    if (impostorPid !== null) {
      try { sigterm(impostorPid); } catch (err) {
        process.stderr.write(`[s5 teardown] impostor sigterm: ${err?.message ?? err}\n`);
      }
    }
    if (pub1Stopped) {
      try {
        // Give the impostor a moment to release the ports.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        // `pidsPath` rewrites `pids.json` with the new pid in place of
        // the stale one, so `stage:down` signals the live process.
        const newPid = restartFromEntry(pub1Entry, { pidsPath: ctx.pidsPath });
        pub1Entry.pid = newPid;
      } catch (err) {
        process.stderr.write(`[s5 teardown] pub1 restart: ${err?.message ?? err}\n`);
      }
    }
    if (existsSync(impostorStateDir)) {
      rmSync(impostorStateDir, { recursive: true, force: true });
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
