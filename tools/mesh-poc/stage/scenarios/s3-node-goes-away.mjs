// MESH_INTERFACE → Acceptance 3 — "A node goes away. Killed, then
// firewalled: the client's reads move to other nodes within two
// checks, the node reads `retry`, never `blacklisted`; once it is
// back and within a block of the tip, the next check reads it by its
// tip — `ok` at the tip, `trailing` one block short. With every
// first-contact node out of reach, a page that has connected before
// reaches the network through the nodes it remembers and reads its
// chain from them."
//
// Five sub-steps, in order:
//   1. stop pub1's notis node (`stopTree` on the recorded PID of
//      `notis:pub1`; a mesh host carries its mesh functionality inside
//      the node, NODE_INTERFACE → Configuration; the kernel releases
//      pub1's ports before this function returns, so step 2's restart
//      binds the same ports with no `EADDRINUSE`);
//      poll until the client's `state.nodes[pub1].status === 'retry'`
//      AND, if pub1 was last named by a routed read,
//      `state.nodeId !== pub1`.
//   2. restart pub1's notis node from the recorded `argv` and `env`
//      (it restarts on its own store and its `.mesh` directory,
//      NODE_INTERFACE → Configuration);
//      wait until pub1's own `/blocks/current`, read inside its
//      namespace, is within one block of pub2's; then read the
//      client's state at the next completed check (`agreement`
//      changes), and measure `{ nodeId, status, behindBy,
//      recoveryTimeMs }`.
//   3. apply the firewall rules in pub1's namespace (`s3_fw`) that
//      drop UDP/TCP to pub1's mesh listener ports; poll same as step 1.
//   4. remove `s3_fw`; wait same as step 2.
//   5. the known-nodes reach. Two sessions on the same browser
//      profile, over a config variant whose `firstContact` holds pub1
//      ALONE — pub2 is a public mesh host the client discovers through
//      the DHT via pub1, and `onChecked` writes it to memory as a
//      known (non-first-contact) node. Session 1 (`?clearMemory=1`)
//      reaches pub1, then the page polls
//      `localStorage['notis.mesh.memory.<network>']` until the
//      record's `nodes` list carries at least one honest host that is
//      not a first-contact node. An nft table in the browser
//      namespace (`s3_known`) drops pub1's address alone — the one
//      first-contact entry. Session 2 (no clear) reaches the remembered
//      node — the client takes memory's `seeds` at start, dials them,
//      and reads its chain from them. The measurement names the
//      remembered honest ids from session 1, the remembered entries
//      in session 2, pub1's entry, the tip, and `notContinued`.
//
// Faults are applied inside `run(ctx)` one at a time between the
// measurements, not up front. The dry-run still records every fault so
// a reader of the dry-run sees the whole set.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS3Moved, verdictS3Recovered, verdictS3KnownNodes } from '../lib/verdicts.mjs';
import { writeStageDefault, writeConfigVariant } from '../lib/scenario-config.mjs';
import {
  execIn, findPid, nftApply,
  restartFromEntry, stopTree, waitNetworkingUp,
} from '../lib/measure.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's3';
const FW_TABLE = 's3_fw';
const TARGET_HOST = 'pub1';
// MESH_INTERFACE → Acceptance 3 — the target per host is the one
// `notis:<host>` process `stage/up.mjs` spawns.
const TARGET_NOTIS_DESC = `notis:${TARGET_HOST}`;
const CHECK_INTERVAL_MS = 30_000;
const RETRY_WAIT_MS = 2 * CHECK_INTERVAL_MS + 10_000; // 2 checks + slack

export function describe() {
  return [
    'pub1 stopped: client moves to another node within 2 checks, pub1 retry',
    'pub1 restarted: pub1 reads ok at a later check',
    'pub1 firewalled: client moves to another node within 2 checks, pub1 retry',
    'pub1 unfirewalled: pub1 reads ok at a later check',
    'with first contact out of reach, the page reaches the network through the nodes it remembers',
  ];
}

const KNOWN_TABLE = 's3_known';

/**
 * The nft argvs the known-nodes step applies and removes inside
 * `notismesh-browser` to drop every first-contact node's address.
 * Exported so a case can hold them against the recorded dry-run.
 * One `add table` + one `add chain` on output + per-first-contact
 * `add rule out ip daddr <addr> drop` + a single `delete table`
 * cleanup.
 */
export function firstContactBlockArgs(topology, firstContactAddrs) {
  const ns = 'notismesh-browser';
  const addTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', KNOWN_TABLE];
  const addChain = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', KNOWN_TABLE, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'];
  const drops = firstContactAddrs.map((addr) => [
    'sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', KNOWN_TABLE, 'out', 'ip', 'daddr', addr, 'drop',
  ]);
  const deleteTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', KNOWN_TABLE];
  return { addTable, addChain, drops, deleteTable };
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
  const pub1Entry = findPid(ctx.pids?.pids, TARGET_NOTIS_DESC);
  if (!pub1Entry) throw new Error(`s3: pids.json has no ${TARGET_NOTIS_DESC} entry`);

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
  // identical to s1's "nodeId is non-null". The scenario's first page
  // load carries `?clearMemory=1` so a prior scenario's kept proof
  // does not seat this client.
  const initialStateJson = await cdpPoll(ctx, `${browserUrl}?clearMemory=1`,
    "document.getElementById('state')?.textContent ?? null",
    "if (v === null) return false; try { return JSON.parse(v).nodeId !== null; } catch (_e) { return false; }",
    60_000, 500,
  );
  const stateBefore = JSON.parse(initialStateJson);

  // Track what we have to roll back on exit, pass or fail.
  let pub1Stopped = false;
  let firewallApplied = false;
  const f = pub1FirewallArgs(ctx.topology);

  try {
    // --- Step 1: stop pub1 ---
    // MESH_INTERFACE → Acceptance 3 — the step stops pub1; its subject
    // is pub1's status (`retry`, never `blacklisted`) and whether the
    // latest routed read moved off pub1 within two checks. The
    // baseline for `movedWithinChecks` is `state.checks` read before
    // the fault.
    await rec.step(describe()[0], async () => {
      const checksBefore = typeof stateBefore.checks === 'number' ? stateBefore.checks : 0;
      const stopResult = await stopTree(pub1Entry.pid, { timeoutMs: 15_000 });
      pub1Stopped = stopResult.termSent.length > 0 || stopResult.killSent.length > 0;
      log.records.push(`[fault:${NAME}:stop-${TARGET_HOST}-notis] stopTree tree=${stopResult.initialTree.join(',')} term=${stopResult.termSent.length} kill=${stopResult.killSent.length}`);
      const afterStop = await pollStateUntil(
        `if (v === null) return false;
         let s;
         try { s = JSON.parse(v); } catch (_e) { return false; }
         const e = s.nodes?.find((n) => n.notisId === ${JSON.stringify(pub1Id)});
         if (!e) return false;
         if (e.status === 'blacklisted') return true;
         return e.status === 'retry' && s.nodeId !== ${JSON.stringify(pub1Id)} && s.nodeId !== null;`,
        { timeoutMs: RETRY_WAIT_MS, pollMs: 1000, name: 'pub1 retry + move' },
      );
      const stoppedEntry = findEntry(afterStop, pub1Id);
      const m = {
        stoppedNodeId: pub1Id,
        stoppedStatus: stoppedEntry?.status ?? null,
        latestReadNodeId: afterStop.nodeId,
        movedWithinChecks: (typeof afterStop.checks === 'number' ? afterStop.checks : 0) - checksBefore,
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
      // MESH_INTERFACE → Acceptance 3 — before the tip catch-up poll,
      // check pub1's mesh networking is up: a `/health` with
      // `peers_connected >= 1` is positive evidence `net.start()`
      // bound the listen addresses.
      await waitNetworkingUp(`notismesh-${TARGET_HOST}`, ctx.topology.hosts.pub1.node.httpPort + 1, {
        timeoutMs: 60_000,
        user: ctx.invokingUser,
      });
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
    // MESH_INTERFACE → Acceptance 3 — same subject as step 1: pub1
    // reads `retry` (never `blacklisted`), the latest routed read
    // moves off pub1 within two checks. The baseline for
    // `movedWithinChecks` is the current `state.checks` (reads the
    // live state, not a stale closure).
    await rec.step(describe()[2], async () => {
      const beforeText = await cdpEval(ctx, browserUrl, "document.getElementById('state')?.textContent ?? null");
      const beforeState = typeof beforeText === 'string' ? JSON.parse(beforeText) : null;
      const checksBefore = typeof beforeState?.checks === 'number' ? beforeState.checks : 0;
      log.apply('pub1-fw-add-table', f.addTable, f.deleteTable);
      firewallApplied = true;
      log.apply('pub1-fw-add-chain', f.addChain, null);
      log.apply('pub1-fw-drop-udp', f.dropUdp, null);
      log.apply('pub1-fw-drop-tcp-mesh', f.dropTcpMesh, null);
      log.apply('pub1-fw-drop-tcp-wss', f.dropTcpWss, null);
      const afterFw = await pollStateUntil(
        `if (v === null) return false;
         let s;
         try { s = JSON.parse(v); } catch (_e) { return false; }
         const e = s.nodes?.find((n) => n.notisId === ${JSON.stringify(pub1Id)});
         if (!e) return false;
         if (e.status === 'blacklisted') return true;
         return e.status === 'retry' && s.nodeId !== ${JSON.stringify(pub1Id)} && s.nodeId !== null;`,
        { timeoutMs: RETRY_WAIT_MS, pollMs: 1000, name: 'pub1 retry under firewall' },
      );
      const stoppedEntry = findEntry(afterFw, pub1Id);
      const m = {
        stoppedNodeId: pub1Id,
        stoppedStatus: stoppedEntry?.status ?? null,
        latestReadNodeId: afterFw.nodeId,
        movedWithinChecks: (typeof afterFw.checks === 'number' ? afterFw.checks : 0) - checksBefore,
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

    // --- Step 5: the known-nodes reach ---
    // MESH_INTERFACE → Acceptance 3 — "With every first-contact node
    // out of reach, a page that has connected before reaches the
    // network through the nodes it remembers and reads its chain
    // from them." Two sessions on the same browser profile:
    //
    //   (i)  session 1 (`?clearMemory=1`) reaches first contact;
    //        the page polls `localStorage['notis.mesh.memory.<network>']`
    //        until the record's `nodes` list carries at least one
    //        honest non-first-contact node — the client's `onChecked`
    //        wrote it after a check that read the node `ok`/`trailing`.
    //        priv1/priv2 are the two the browser discovers through
    //        the relay; either is enough.
    //   (ii) nft rules in the browser namespace drop every first-
    //        contact address, so the client cannot reach pub1 or
    //        pub2. Session 2 (no clear) opens the page; the client
    //        takes memory's `seeds` at start, dials them through the
    //        relay path, and reads its chain from them. The step
    //        reads `state.tip`, a remembered node's status, and
    //        every first-contact entry's status.
    const browserBlockApplied = { on: false };
    await rec.step(describe()[4], async () => {
      // Read the stage default fresh — the scenario's start wrote it,
      // and the step builds its own variant from the same bytes-for-
      // bytes copy. The default's `firstContact` holds pub1 + pub2 as
      // the browser's two first-contact entries; the step's variant
      // keeps only pub1 as first contact, so pub2 is a public mesh
      // host the browser discovers through the DHT and `onChecked`
      // writes to memory as a known (non-first-contact) node. A
      // session 2 then blocks pub1's address alone and the client
      // reaches the network through pub2.
      const defaultConfig = JSON.parse(readFileSync(
        join(ctx.outDir, 'browser', 'config.default.json'),
        'utf8',
      ));
      const network = defaultConfig.network;
      const defaultFirstContact = Array.isArray(defaultConfig.firstContact)
        ? defaultConfig.firstContact : [];
      if (defaultFirstContact.length < 2) {
        throw new Error('s3 step 5: config.default.json needs at least two firstContact entries (pub1 + pub2)');
      }
      // `firstContactIds` is the step's set — pub1 alone. The variant
      // writes just pub1 into `firstContact`; pub2 reaches the client
      // through DHT discovery via pub1.
      const pub1Id = identities?.pub1?.notisId;
      if (typeof pub1Id !== 'string') {
        throw new Error('s3 step 5: identities.json has no pub1 row');
      }
      const pub1Entry = defaultFirstContact.find((e) => e && e.notisId === pub1Id);
      if (!pub1Entry) {
        throw new Error('s3 step 5: pub1 is not in config.default.json firstContact');
      }
      const firstContactIds = [pub1Id];
      const pub1Addr = ctx.topology.hosts.pub1?.addr;
      if (typeof pub1Addr !== 'string') {
        throw new Error('s3 step 5: topology has no pub1 address');
      }
      // The browser's reach to the fork pair goes through pub1's
      // address alone; session 2 blocks that address alone.
      const firstContactAddrs = [pub1Addr];
      // The honest non-first-contact set holds every mesh-running host
      // that is NOT pub1. pub2 is the public mesh node the client
      // reaches through DHT discovery; priv1 and priv2 run mesh too,
      // and either is a valid remembered node. (The stage's step 5 was
      // seeing an empty set only because the default `firstContact`
      // held every public host.)
      const honestNonFirstContactIds = [];
      for (const [name, h] of Object.entries(ctx.topology.hosts)) {
        if (h.role !== 'public' && h.role !== 'private') continue;
        if (h.mesh === undefined) continue;
        if (name === 'browser') continue;
        const id = identities[name]?.notisId;
        if (typeof id !== 'string') continue;
        if (firstContactIds.includes(id)) continue;
        honestNonFirstContactIds.push(id);
      }
      if (honestNonFirstContactIds.length === 0) {
        throw new Error('s3 step 5: topology has no honest non-first-contact mesh host');
      }

      // ----- (i) first session on pub1 alone -----
      // The variant lands via `writeConfigVariant`; the page fetches
      // the new file at its next load. `clearMemory=1` on session 1
      // removes a prior scenario's record.
      const pub1OnlyVariant = {
        network: defaultConfig.network,
        firstContact: [pub1Entry],
        seeds: [],
      };
      writeConfigVariant(ctx.outDir, pub1OnlyVariant);
      const session1Text = await cdpPoll(ctx, `${browserUrl}?clearMemory=1`,
        `(function () {
           const el = document.getElementById('state');
           if (el === null) return null;
           const raw = localStorage.getItem('notis.mesh.memory.' + ${JSON.stringify(network)});
           return JSON.stringify({ state: el.textContent, memory: raw });
         })()`,
        `if (v === null) return false;
         try {
           const o = JSON.parse(v);
           const s = JSON.parse(o.state);
           if (typeof s.chain !== 'string' || s.chain.length !== 64) return false;
           if (typeof o.memory !== 'string') return false;
           const rec = JSON.parse(o.memory);
           if (!rec || !Array.isArray(rec.nodes)) return false;
           const want = ${JSON.stringify(honestNonFirstContactIds)};
           const firstContactSet = ${JSON.stringify(firstContactIds)};
           return rec.nodes.some((n) => n && typeof n.notisId === 'string'
             && !firstContactSet.includes(n.notisId)
             && want.includes(n.notisId));
         } catch (_e) { return false; }`,
        240_000, 1_000,
      );
      const session1Wrapper = JSON.parse(session1Text);
      const memoryRecord = JSON.parse(session1Wrapper.memory);
      const rememberedHonestIds = (memoryRecord.nodes ?? [])
        .map((n) => (n && typeof n.notisId === 'string') ? n.notisId : null)
        .filter((id) => id !== null && !firstContactIds.includes(id) && honestNonFirstContactIds.includes(id));
      if (rememberedHonestIds.length === 0) {
        throw new Error('s3 step 5: session 1 memory has no honest non-first-contact node');
      }

      // ----- (ii) block first contact, open session 2 -----
      const b = firstContactBlockArgs(ctx.topology, firstContactAddrs);
      runFault(log, 'browser-s3-known-add-table', b.addTable);
      browserBlockApplied.on = true;
      runFault(log, 'browser-s3-known-add-chain', b.addChain);
      for (let i = 0; i < b.drops.length; i += 1) {
        runFault(log, `browser-s3-known-drop-${i}`, b.drops[i]);
      }
      const session2Text = await cdpPoll(ctx, browserUrl,
        "document.getElementById('state')?.textContent ?? null",
        `if (v === null) return false;
         try {
           const s = JSON.parse(v);
           if (!s.tip || typeof s.tip.hash !== 'string' || s.tip.hash.length !== 64) return false;
           if (typeof s.tip.height !== 'number' || s.tip.height <= 0) return false;
           if (s.notContinued !== false) return false;
           const remembered = ${JSON.stringify(rememberedHonestIds)};
           const firstContact = ${JSON.stringify(firstContactIds)};
           const anyRememberedReached = s.nodes?.some((n) => n && remembered.includes(n.notisId)
             && (n.status === 'ok' || n.status === 'trailing'));
           if (!anyRememberedReached) return false;
           const everyFirstContactRetry = firstContact.every((id) => {
             const e = s.nodes?.find((n) => n.notisId === id);
             return e !== undefined && e.status === 'retry';
           });
           return everyFirstContactRetry;
         } catch (_e) { return false; }`,
        240_000, 1_000,
      );
      const session2State = JSON.parse(session2Text);
      const rememberedEntries = (session2State.nodes ?? [])
        .filter((n) => rememberedHonestIds.includes(n.notisId))
        .map((n) => ({ notisId: n.notisId, status: n.status }));
      const firstContactEntries = firstContactIds
        .map((id) => session2State.nodes?.find((n) => n.notisId === id) ?? null)
        .map((n) => (n === null ? null : { notisId: n.notisId, status: n.status }));
      const m = {
        firstContactIds,
        rememberedHonestIds,
        rememberedEntries,
        firstContactEntries,
        tipHeight: typeof session2State.tip?.height === 'number' ? session2State.tip.height : null,
        tipHash: typeof session2State.tip?.hash === 'string' ? session2State.tip.hash : null,
        notContinued: session2State.notContinued === true,
      };
      return { verdict: verdictS3KnownNodes(m), measurement: m };
    });
    // Teardown for step 5 — remove the browser block table.
    if (browserBlockApplied.on) {
      try { nftApply('notismesh-browser', ['delete', 'table', 'ip', KNOWN_TABLE]); }
      catch (err) { process.stderr.write(`[s3 teardown] delete ${KNOWN_TABLE}: ${err?.message ?? err}\n`); }
      log.records.push(`[fault:remove:${NAME}:browser-s3-known-add-table] sudo ip netns exec notismesh-browser nft delete table ip ${KNOWN_TABLE}`);
    }
  } finally {
    // Teardown: if a step stopped pub1 and did not restart it, restart
    // through the same path a step takes — the stop already ran
    // `stopTree`, so the kernel has released the ports before this.
    if (pub1Stopped) {
      try {
        const newPid = restartFromEntry(pub1Entry, { pidsPath: ctx.pidsPath });
        pub1Entry.pid = newPid;
        pub1Stopped = false;
        await waitNetworkingUp(`notismesh-${TARGET_HOST}`, ctx.topology.hosts.pub1.node.httpPort + 1, {
          timeoutMs: 60_000,
          user: ctx.invokingUser,
        });
      } catch (err) {
        process.stderr.write(`[s3 teardown] failed to restart ${TARGET_NOTIS_DESC}: ${err?.message ?? err}\n`);
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

async function cdpEval(ctx, url, expression, { timeoutMs = 30_000 } = {}) {
  const argv = [ctx.nodeBin, ctx.cdpScript, 'eval', url, expression, String(timeoutMs)];
  const buf = execIn('notismesh-browser', argv, {
    user: ctx.invokingUser,
    timeoutMs: timeoutMs + 10_000,
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

function runFault(log, name, argv) {
  // `argv` is `[sudo, ip, netns, exec, <ns>, nft, ...sub]`; nftApply
  // prepends `nft`, so we slice(6) to drop the duplicate.
  log.records.push(`[fault:${NAME}:${name}] ${argv.join(' ')}`);
  nftApply(argv[4], argv.slice(6));
}
