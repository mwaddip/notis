// MESH_INTERFACE → Acceptance 3 — "A node goes away. Killed, then
// firewalled: the client's reads move to other nodes within two
// checks, the node reads `retry`, never `blacklisted`; once it is
// back and within a block of the tip, the next check reads it by its
// tip — `ok` at the tip, `trailing` one block short."
//
// Four sub-steps, in order:
//   1. stop pub1's mesh node (`kill -TERM` the recorded PID);
//      poll until the client's `state.nodes[pub1].status === 'retry'`
//      AND, if pub1 was last named by a routed read,
//      `state.nodeId !== pub1`.
//   2. restart pub1's mesh node from the recorded `argv` and `env`;
//      wait until pub1's own `/blocks/current`, read inside its
//      namespace, is within one block of pub2's; then read the
//      client's state at the next completed check (`agreement`
//      changes), and measure `{ nodeId, status, behindBy,
//      recoveryTimeMs }`.
//   3. apply the firewall rules in pub1's namespace (`s3_fw`) that
//      drop UDP/TCP to pub1's mesh listener; poll same as step 1.
//   4. remove `s3_fw`; wait same as step 2.
//
// Faults are applied inside `run(ctx)` one at a time between the
// measurements, not up front. The dry-run still records every fault so
// a reader of the dry-run sees the whole set.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS3Moved, verdictS3Recovered } from '../lib/verdicts.mjs';
import { writeStageDefault } from '../lib/scenario-config.mjs';
import {
  execIn, findPid, nftApply,
  restartFromEntry, sigterm,
} from '../lib/measure.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's3';
const FW_TABLE = 's3_fw';
const TARGET_HOST = 'pub1';
const TARGET_MESH_DESC = `mesh:${TARGET_HOST}`;
const CHECK_INTERVAL_MS = 30_000;
const RETRY_WAIT_MS = 2 * CHECK_INTERVAL_MS + 10_000; // 2 checks + slack

export function describe() {
  return [
    'pub1 stopped: client moves to another node within 2 checks, pub1 retry',
    'pub1 restarted: pub1 reads ok at a later check',
    'pub1 firewalled: client moves to another node within 2 checks, pub1 retry',
    'pub1 unfirewalled: pub1 reads ok at a later check',
  ];
}

/**
 * The nft argvs the scenario applies and removes inside `notismesh-pub1`.
 * Exported so a case can hold them against the recorded dry-run.
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
  // Dry-run: record every fault the scenario would apply so a reader
  // of the whole output sees the set per scenario. Exec mode applies
  // them inside `run(ctx)` one at a time.
  const f = pub1FirewallArgs(topology);
  log.apply('pub1-fw-add-table', f.addTable, f.deleteTable);
  log.apply('pub1-fw-add-chain', f.addChain, null);
  log.apply('pub1-fw-drop-udp', f.dropUdp, null);
  log.apply('pub1-fw-drop-tcp-mesh', f.dropTcpMesh, null);
  log.apply('pub1-fw-drop-tcp-wss', f.dropTcpWss, null);
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

  // MESH_INTERFACE → Acceptance — s3 reads the stage default; it
  // writes it fresh so the previous scenario's variant (if any) does
  // not leak into the page's state.
  writeStageDefault(ctx.outDir);

  const identities = readIdentities(ctx);
  const pub1Row = identities?.[TARGET_HOST];
  if (!pub1Row) throw new Error(`s3: identities.json has no ${TARGET_HOST} row`);
  const pub1Id = pub1Row.notisId;
  const pub1Entry = findPid(ctx.pids?.pids, TARGET_MESH_DESC);
  if (!pub1Entry) throw new Error(`s3: pids.json has no ${TARGET_MESH_DESC} entry`);

  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const findEntry = (state, id) => state?.nodes?.find((n) => n.notisId === id) ?? null;

  // MESH_INTERFACE → Acceptance 3 — read `#state` through `cdpPoll` the
  // same way s1 does: ONE target held open across polls. `cdpEval` from
  // the earlier version cycled targets, and the target teardown/open
  // raced with the page's render — every poll read `null`. Each
  // `pollUntilCdp` call opens a target, polls the expression against
  // the predicate body JS until it holds, and returns the matching
  // value.
  const pollStateUntil = async (predicateBody, { timeoutMs, pollMs = 1000, name }) => {
    const text = await cdpPoll(ctx, browserUrl,
      "document.getElementById('state')?.textContent ?? null",
      predicateBody,
      timeoutMs, pollMs,
    );
    if (text === null) {
      throw new Error(`pollStateUntil(${name}): read null (expression returned no state element)`);
    }
    return JSON.parse(text);
  };

  // Initial state wait: use `cdpPoll` (one target held open across polls)
  // the same way s1 does, so a slow `cdpEval` cycle does not blow the
  // deadline before the page's first render lands. The predicate is
  // identical to s1's "nodeId is non-null".
  const initialStateJson = await cdpPoll(ctx, browserUrl,
    "document.getElementById('state')?.textContent ?? null",
    "if (v === null) return false; try { return JSON.parse(v).nodeId !== null; } catch (_e) { return false; }",
    60_000, 500,
  );
  const stateBefore = JSON.parse(initialStateJson);
  const oldNodeId = stateBefore.nodeId;

  // Track what we have to roll back on exit, pass or fail.
  let pub1Stopped = false;
  let firewallApplied = false;
  const f = pub1FirewallArgs(ctx.topology);

  try {
    // --- Step 1: stop pub1 ---
    await rec.step(describe()[0], async () => {
      const t0 = Date.now();
      const stopResult = sigterm(pub1Entry.pid);
      pub1Stopped = stopResult.sent;
      log.records.push(`[fault:${NAME}:stop-${TARGET_HOST}-mesh] kill -TERM ${pub1Entry.pid}`);
      const expectMove = oldNodeId === pub1Id ? '!==' : '===';
      const afterStop = await pollStateUntil(
        `if (v === null) return false;
         try {
           const s = JSON.parse(v);
           const e = s.nodes?.find((n) => n.notisId === ${JSON.stringify(pub1Id)});
           if (!e) return false;
           if (e.status === 'blacklisted') return true;
           const moved = ${JSON.stringify(oldNodeId)} === ${JSON.stringify(pub1Id)}
             ? s.nodeId !== ${JSON.stringify(pub1Id)} && s.nodeId !== null
             : true;
           return e.status === 'retry' && moved;
         } catch (_e) { return false; }`,
        { timeoutMs: RETRY_WAIT_MS, pollMs: 1000, name: 'pub1 retry + move' },
      );
      void expectMove;
      const m = {
        oldNodeId,
        newNodeId: afterStop.nodeId,
        oldStatus: findEntry(afterStop, pub1Id)?.status ?? null,
        movedWithinChecks: Math.ceil((Date.now() - t0) / CHECK_INTERVAL_MS),
        checkIntervalMs: CHECK_INTERVAL_MS,
      };
      return { verdict: verdictS3Moved(m), measurement: m };
    });

    // --- Step 2: restart pub1, wait until its own /blocks/current is
    // within one block of pub2's, then read the client's state at the
    // next completed check ---
    await rec.step(describe()[1], async () => {
      const t0 = Date.now();
      // `pidsPath` rewrites `pids.json` with the new pid in place of
      // the old, so `stage:down` signals the live process.
      const newPid = restartFromEntry(pub1Entry, { pidsPath: ctx.pidsPath });
      pub1Entry.pid = newPid;
      pub1Stopped = false;
      await waitPub1WithinOneBlockOfPub2(ctx);
      const after = await pollNextCompletedCheck(pollStateUntil, 'pub1 recovery check landed');
      const entry = findEntry(after, pub1Id);
      const m = {
        nodeId: pub1Id,
        status: entry?.status ?? null,
        behindBy: entry?.behindBy ?? null,
        recoveryTimeMs: Date.now() - t0,
      };
      return { verdict: verdictS3Recovered(m), measurement: m };
    });

    // --- Step 3: firewall pub1 ---
    await rec.step(describe()[2], async () => {
      const t0 = Date.now();
      log.apply('pub1-fw-add-table', f.addTable, f.deleteTable);
      firewallApplied = true;
      log.apply('pub1-fw-add-chain', f.addChain, null);
      log.apply('pub1-fw-drop-udp', f.dropUdp, null);
      log.apply('pub1-fw-drop-tcp-mesh', f.dropTcpMesh, null);
      log.apply('pub1-fw-drop-tcp-wss', f.dropTcpWss, null);
      // Read current nodeId from state (not from a stale closure).
      const beforeText = await cdpEval(ctx, browserUrl, "document.getElementById('state')?.textContent ?? null");
      const beforeState = typeof beforeText === 'string' ? JSON.parse(beforeText) : null;
      const oldNodeId3 = beforeState?.nodeId ?? oldNodeId;
      const afterFw = await pollStateUntil(
        `if (v === null) return false;
         try {
           const s = JSON.parse(v);
           const e = s.nodes?.find((n) => n.notisId === ${JSON.stringify(pub1Id)});
           if (!e) return false;
           if (e.status === 'blacklisted') return true;
           const oldNodeId3 = ${JSON.stringify(oldNodeId3)};
           const pub1Id = ${JSON.stringify(pub1Id)};
           const moved = oldNodeId3 === pub1Id ? s.nodeId !== pub1Id && s.nodeId !== null : true;
           return e.status === 'retry' && moved;
         } catch (_e) { return false; }`,
        { timeoutMs: RETRY_WAIT_MS, pollMs: 1000, name: 'pub1 retry under firewall' },
      );
      const m = {
        oldNodeId: oldNodeId3,
        newNodeId: afterFw.nodeId,
        oldStatus: findEntry(afterFw, pub1Id)?.status ?? null,
        movedWithinChecks: Math.ceil((Date.now() - t0) / CHECK_INTERVAL_MS),
        checkIntervalMs: CHECK_INTERVAL_MS,
      };
      return { verdict: verdictS3Moved(m), measurement: m };
    });

    // --- Step 4: unfirewall, wait until pub1 is within one block of
    // pub2 and read the next completed check ---
    await rec.step(describe()[3], async () => {
      const t0 = Date.now();
      nftApply('notismesh-pub1', ['delete', 'table', 'ip', FW_TABLE]);
      firewallApplied = false;
      log.removals.length = 0;
      log.records.push(`[fault:remove:${NAME}:pub1-fw-add-table] sudo ip netns exec notismesh-pub1 nft delete table ip ${FW_TABLE}`);
      await waitPub1WithinOneBlockOfPub2(ctx);
      const after = await pollNextCompletedCheck(pollStateUntil, 'pub1 unfirewall check landed');
      const entry = findEntry(after, pub1Id);
      const m = {
        nodeId: pub1Id,
        status: entry?.status ?? null,
        behindBy: entry?.behindBy ?? null,
        recoveryTimeMs: Date.now() - t0,
      };
      return { verdict: verdictS3Recovered(m), measurement: m };
    });
  } finally {
    // Teardown: if we stopped pub1 and did not restart it, restart now.
    if (pub1Stopped) {
      try {
        const newPid = restartFromEntry(pub1Entry, { pidsPath: ctx.pidsPath });
        pub1Entry.pid = newPid;
      } catch (err) {
        process.stderr.write(`[s3 teardown] failed to restart ${TARGET_MESH_DESC}: ${err?.message ?? err}\n`);
      }
    }
    if (firewallApplied) {
      try {
        nftApply('notismesh-pub1', ['delete', 'table', 'ip', FW_TABLE]);
      } catch (err) {
        process.stderr.write(`[s3 teardown] failed to remove ${FW_TABLE}: ${err?.message ?? err}\n`);
      }
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

function readIdentities(ctx) {
  const p = join(ctx.outDir, 'identities.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function cdpEval(ctx, url, expression) {
  const argv = [ctx.nodeBin, ctx.cdpScript, 'eval', url, expression];
  const buf = execIn('notismesh-browser', argv, {
    user: ctx.invokingUser,
    timeoutMs: 30_000,
  });
  return JSON.parse(buf.toString('utf8'));
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

/**
 * MESH_INTERFACE → Acceptance 3 — "once it is back and within a block
 * of the tip". Poll pub1's own `/blocks/current` (read inside
 * `notismesh-pub1`) and pub2's (read inside `notismesh-pub2`) until
 * their `height` differs by at most one.
 */
async function waitPub1WithinOneBlockOfPub2(ctx) {
  const pub1Port = String(ctx.topology.hosts.pub1.node.httpPort);
  const pub2Port = String(ctx.topology.hosts.pub2.node.httpPort);
  const read = (ns, port) => {
    const out = execIn(ns, ['curl', '-sf', '--max-time', '5', `http://127.0.0.1:${port}/blocks/current`], {
      user: ctx.invokingUser,
      timeoutMs: 8_000,
    });
    const data = JSON.parse(out.toString('utf8'));
    return typeof data.height === 'number' ? data.height : null;
  };
  const deadline = Date.now() + 180_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const h1 = read('notismesh-pub1', pub1Port);
      const h2 = read('notismesh-pub2', pub2Port);
      last = { h1, h2 };
      if (h1 !== null && h2 !== null && Math.abs(h2 - h1) <= 1) return last;
    } catch {
      // pub1 may still be starting up; keep polling
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`waitPub1WithinOneBlockOfPub2 timed out; last ${JSON.stringify(last)}`);
}

/**
 * MESH_INTERFACE → The client's node list → "A routed read goes to a
 * node its need allows" — "how many checks it has completed, so a
 * reader can tell one check's state from the next". A check is
 * complete when `checks` grows past the baseline. The agreement
 * counts stay identical between checks when the same nodes answer
 * the same way, so a baseline on `agreement` never changes; the
 * counter is the one hook this wait has. The predicate body is
 * exported so a unit case runs the same function body.
 *
 * `buildPredicate` builds this body as `new Function('v', body)`, run
 * in cdp.mjs' Node process — there is no `window` here, so the
 * baseline lives on `globalThis` (one cdp.mjs process per poll, so
 * the state is the poll's). The catch wraps `JSON.parse` alone — any
 * other throw propagates to `main` and fails the poll fast.
 */
export const S3_POLL_NEXT_COMPLETED_CHECK_PREDICATE = `if (v === null) return false;
    let s;
    try { s = JSON.parse(v); } catch (_e) { return false; }
    if (typeof s.checks !== 'number') return false;
    if (globalThis.__s3CheckBaseline === undefined) globalThis.__s3CheckBaseline = s.checks;
    return s.checks > globalThis.__s3CheckBaseline;`;

async function pollNextCompletedCheck(pollStateUntil, name) {
  return pollStateUntil(S3_POLL_NEXT_COMPLETED_CHECK_PREDICATE, { timeoutMs: 180_000, pollMs: 1_000, name });
}
