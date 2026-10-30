// MESH_INTERFACE → Acceptance 4 — "A transport is cut. UDP to one public
// node, then to all: the client gets in through another node, then
// through the secure WebSocket; a renewal replaces the certificate with
// no request dropped".
//
// Four sub-steps:
//   1. Drop UDP from browser to pub1 → client reads nodeId !== pub1.
//   2. Drop UDP from browser to pub2 as well → transport === 'wss',
//      nodeId === pub1, pub1's cert issued by Pebble's intermediate.
//   3. Across one renewal (Pebble `shortlived` profile, 180 s), probes
//      keep succeeding and `lastLeft` names no failure.
//   4. Drop TCP between the Notis nodes' p2p port → record what still
//      answers.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import {
  verdictS4Pub1UdpDrop, verdictS4AllUdpDrop, verdictS4Renewal, verdictS4InterNodeTcp,
} from '../lib/verdicts.mjs';
import { execIn, nftApply, pollUntil } from '../lib/measure.mjs';
import { publicMeshHosts } from '../lib/topology.mjs';
import { readTlsIssuer } from '../lib/scenario-tls.mjs';
import { readFileSize, countMatchesSince } from '../lib/log-watch.mjs';
import { writeStageDefault } from '../lib/scenario-config.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

// MESH_INTERFACE → The client's node list — "A check — `resolveTip` over
// the candidates — runs at start, every `CHECK_INTERVAL_MS`". Step 4
// (inter-node TCP cut) reads the browser's state after a check has
// fired on the cut, so the record carries the post-cut state rather
// than a transient null between checks.
const CHECK_INTERVAL_MS = 30_000;

export const NAME = 's4';
const UDP_TABLE = 's4_udp';
const TCP_TABLE = 's4_tcp';
const EXPECTED_ISSUER_SUBSTR = 'Pebble'; // Pebble's intermediate CN carries "Pebble".
const PROBE_PATH = '/blocks/current';
const RENEWAL_WINDOW_MS = 240_000; // Pebble shortlived is 180 s; renewal at 90 s.

export function describe() {
  return [
    'UDP to pub1 cut: client gets in through another public mesh node',
    'UDP to every public node cut: client connects over WSS to pub1 with the Pebble-issued cert',
    'across one renewal the probes keep succeeding, no lastLeft names a failure',
    'TCP between the Notis nodes p2p port cut: record what still answers',
  ];
}

export function udpDropArgs(topology) {
  const ns = 'notismesh-browser';
  const addTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', UDP_TABLE];
  const addChain = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', UDP_TABLE, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'];
  const perHost = [];
  for (const { host, name } of publicMeshHosts(topology)) {
    perHost.push({
      name,
      argv: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', UDP_TABLE, 'out', 'ip', 'daddr', host.addr, 'meta', 'l4proto', 'udp', 'drop'],
    });
  }
  const deleteTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', UDP_TABLE];
  return { addTable, addChain, perHost, deleteTable };
}

export function notisTcpCutArgs(topology) {
  const out = [];
  for (const { name, host } of publicMeshHosts(topology)) {
    const ns = `notismesh-${name}`;
    const p = String(host.node.p2pPort);
    out.push({
      host: name,
      addTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', TCP_TABLE],
      addChain: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', TCP_TABLE, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'],
      dropDport: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', TCP_TABLE, 'out', 'tcp', 'dport', p, 'drop'],
      deleteTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', TCP_TABLE],
    });
  }
  return out;
}

export function applyFaults(log, topology) {
  // Dry-run records every fault s4 would apply so a reader sees the
  // set per scenario. Exec applies them one at a time in `run(ctx)`.
  const udp = udpDropArgs(topology);
  log.apply('browser-udp-add-table', udp.addTable, udp.deleteTable);
  log.apply('browser-udp-add-chain', udp.addChain, null);
  for (let i = 0; i < udp.perHost.length; i += 1) {
    log.apply(`browser-udp-drop-${i}`, udp.perHost[i].argv, null);
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
  const rec = new StepRecorder();
  if (ctx.dryRun) {
    applyFaults(log, ctx.topology);
    for (const name of describe()) rec.skipped(name);
    log.removeAll();
    return { scenario: NAME, startedAt: started, endedAt: Date.now(), steps: rec.steps, faults: log.records };
  }

  // MESH_INTERFACE → Acceptance — s4 reads the stage default; it
  // writes it fresh so a previous scenario's variant does not leak.
  writeStageDefault(ctx.outDir);

  const identities = JSON.parse(readFileSync(join(ctx.outDir, 'identities.json'), 'utf8'));
  const pub1Id = identities.pub1?.notisId;
  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const pub1Host = ctx.topology.hosts.pub1;
  const pebbleLog = join(ctx.outDir, 'logs', 'pebble.log');

  const udp = udpDropArgs(ctx.topology);
  const notisTcp = notisTcpCutArgs(ctx.topology);
  const applied = []; // every nft table added so far
  const removeOne = (argv) => {
    // argv is `[sudo, ip, netns, exec, <ns>, nft, delete, ...]`;
    // nftApply prepends `nft`, so slice(6).
    try { nftApply(argv[4], argv.slice(6)); } catch (err) {
      process.stderr.write(`[s4 teardown] ${argv.slice(6, 10).join(' ')}: ${err?.message ?? err}\n`);
    }
  };
  const removeTable = (ns, table) => {
    removeOne(['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', table]);
  };

  try {
    // --- Step 1: drop UDP from browser to pub1 only ---
    await rec.step(describe()[0], async () => {
      runFault(log, 'browser-udp-add-table', udp.addTable);
      applied.push({ ns: 'notismesh-browser', table: UDP_TABLE });
      runFault(log, 'browser-udp-add-chain', udp.addChain);
      const pub1Rule = udp.perHost.find((e) => e.name === 'pub1');
      if (!pub1Rule) throw new Error('s4: no pub1 UDP drop rule');
      runFault(log, 'browser-udp-drop-pub1', pub1Rule.argv);
      // MESH_INTERFACE → Acceptance 4 — "the client stays connected,
      // through another node or over that node's secure WebSocket —
      // whichever ranks first". The predicate holds for either path:
      // nodeId is another public, OR nodeId is the blocked node with
      // transport === 'wss'.
      const state1 = await cdpPoll(ctx, browserUrl,
        "document.getElementById('state')?.textContent ?? null",
        `if (v === null) return false;
         try {
           const s = JSON.parse(v);
           if (s.nodeId === null) return false;
           if (s.nodeId !== ${JSON.stringify(pub1Id)}) return true;
           return s.transport === 'wss';
         } catch (_e) { return false; }`,
        120_000, 1000,
      );
      const stateS1 = JSON.parse(state1);
      const m = {
        connected: stateS1.nodeId !== null,
        nodeId: stateS1.nodeId,
        blockedNodeId: pub1Id,
        transport: stateS1.transport ?? null,
      };
      return { verdict: verdictS4Pub1UdpDrop(m), measurement: m };
    });

    // --- Step 2: drop UDP to every other public mesh node too ---
    await rec.step(describe()[1], async () => {
      for (const rule of udp.perHost) {
        if (rule.name === 'pub1') continue;
        runFault(log, `browser-udp-drop-${rule.name}`, rule.argv);
      }
      const state2 = await cdpPoll(ctx, browserUrl,
        "document.getElementById('state')?.textContent ?? null",
        `if (v === null) return false;
         try { const s = JSON.parse(v); return s.transport === 'wss' && s.nodeId === ${JSON.stringify(pub1Id)}; }
         catch (_e) { return false; }`,
        120_000, 1000,
      );
      const stateS2 = JSON.parse(state2);
      const cert = readTlsIssuer('notismesh-browser', pub1Host.addr, pub1Host.mesh.wss.port, {
        user: ctx.invokingUser,
      });
      const m = {
        transport: stateS2.transport,
        nodeId: stateS2.nodeId,
        expectedNodeId: pub1Id,
        certIssuerName: cert.issuer,
        expectedIssuerName: cert.issuer !== null && cert.issuer.includes(EXPECTED_ISSUER_SUBSTR) ? cert.issuer : `<any issuer containing ${EXPECTED_ISSUER_SUBSTR}>`,
      };
      return { verdict: verdictS4AllUdpDrop(m), measurement: m };
    });

    // --- Step 3: across one renewal, probes keep succeeding ---
    await rec.step(describe()[2], async () => {
      const pebbleSizeBefore = readFileSize(pebbleLog);
      // MESH_INTERFACE → The IP certificate — "a renewal replaces the
      // certificate with no request dropped": the connected-before and
      // connected-after reads are PASS evidence (no vacuous pass). The
      // page's `#state` is rewritten whole on every state change, so a
      // one-shot read lands between renders empty; `cdpPoll` with the
      // same predicate step 2 uses waits for a stable state at both
      // boundaries.
      const connectedPredicate = `if (v === null) return false;
         try { const s = JSON.parse(v); return s.nodeId === ${JSON.stringify(pub1Id)} && s.transport === 'wss'; }
         catch (_e) { return false; }`;
      let connectedBeforeWindow = false;
      try {
        await cdpPoll(ctx, browserUrl,
          "document.getElementById('state')?.textContent ?? null",
          connectedPredicate, 30_000, 500);
        connectedBeforeWindow = true;
      } catch { /* no stable connected state inside 30 s; stays false */ }
      let lastLeftFailureSeen = false;
      const probeDeadline = Date.now() + RENEWAL_WINDOW_MS;
      while (Date.now() < probeDeadline) {
        try {
          const text = await cdpEval(ctx, browserUrl,
            "document.getElementById('state')?.textContent ?? null");
          if (typeof text === 'string') {
            const s = JSON.parse(text);
            if (s.lastLeft !== null && typeof s.lastLeft?.reason === 'string') {
              if (/timeout|refused|dropped|transport|lie|malformed|proof-invalid/i.test(s.lastLeft.reason)) {
                lastLeftFailureSeen = true;
              }
            }
          }
        } catch {
          // transient CDP failure; keep probing
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
      let connectedAfterWindow = false;
      try {
        await cdpPoll(ctx, browserUrl,
          "document.getElementById('state')?.textContent ?? null",
          connectedPredicate, 30_000, 500);
        connectedAfterWindow = true;
      } catch { /* no stable connected state at window end; stays false */ }
      const renewalCount = pebbleSizeBefore !== null
        ? countMatchesSince(pebbleLog, pebbleSizeBefore, /Issued certificate|Order (?:valid|finalized)/i)
        : 0;
      const m = {
        renewalSeen: renewalCount > 0,
        probeSuccessAcrossRenewal: !lastLeftFailureSeen,
        lastLeftFailure: lastLeftFailureSeen,
        connectedBeforeWindow,
        connectedAfterWindow,
      };
      return { verdict: verdictS4Renewal(m), measurement: m };
    });

    // --- Step 4: drop TCP between the Notis nodes' p2p port ---
    await rec.step(describe()[3], async () => {
      for (let i = 0; i < notisTcp.length; i += 1) {
        const t = notisTcp[i];
        runFault(log, `notis-tcp-add-table-${i}`, t.addTable);
        applied.push({ ns: `notismesh-${t.host}`, table: TCP_TABLE });
        runFault(log, `notis-tcp-add-chain-${i}`, t.addChain);
        runFault(log, `notis-tcp-drop-${i}`, t.dropDport);
      }
      // MESH_INTERFACE → The client's node list — "A check — resolveTip
      // over the candidates — runs at start, every `CHECK_INTERVAL_MS`,
      // and at once after a failed fetch to the node in use". A read
      // taken immediately after the fault lands between checks; waiting
      // one check interval lets the next tick fire on the cut. The
      // record carries the post-cut state alone — `cdpPoll` with a
      // predicate that holds for a settled state (nodeId AND transport
      // present) returns one of them, never a transient frame.
      await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
      let text4 = null;
      try {
        text4 = await cdpPoll(ctx, browserUrl,
          "document.getElementById('state')?.textContent ?? null",
          `if (v === null) return false;
           try { const s = JSON.parse(v); return s.nodeId !== null && s.transport !== null; }
           catch (_e) { return false; }`,
          30_000, 500,
        );
      } catch { /* no stable state landed within the deadline */ }
      const state4 = typeof text4 === 'string' ? JSON.parse(text4) : {};
      const m = {
        transport: state4.transport ?? null,
        nodeId: state4.nodeId ?? null,
        tip: state4.tip ?? null,
        note: 'inter-node TCP cut; browser-to-WSS stays up',
      };
      return { verdict: verdictS4InterNodeTcp(m), measurement: m };
    });
  } finally {
    // Teardown — remove every applied nft table.
    for (const { ns, table } of applied.slice().reverse()) {
      removeTable(ns, table);
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

function runFault(log, name, argv) {
  // Record the fault on the log for the summary, and apply it in exec
  // mode. The paired removal is tracked separately through the
  // `applied` list (one `delete table` per table).
  //
  // `argv` is `[sudo, ip, netns, exec, <ns>, nft, ...sub]`; `nftApply`
  // prepends `nft` to its own argv, so we hand it `argv.slice(6)` — the
  // subcommand only. slice(5) would double the `nft` token and nft
  // would refuse the ruleset with a syntax error.
  log.records.push(`[fault:${NAME}:${name}] ${argv.join(' ')}`);
  nftApply(argv[4], argv.slice(6));
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

async function cdpEval(ctx, url, expression) {
  const argv = [ctx.nodeBin, ctx.cdpScript, 'eval', url, expression];
  const buf = execIn('notismesh-browser', argv, {
    user: ctx.invokingUser,
    timeoutMs: 30_000,
  });
  return JSON.parse(buf.toString('utf8'));
}
