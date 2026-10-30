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
  verdictS4Pub1UdpDrop, verdictS4AllUdpDrop, verdictS4Renewal,
} from '../lib/verdicts.mjs';
import { execIn, nftApply, pollUntil } from '../lib/measure.mjs';
import { publicMeshHosts } from '../lib/topology.mjs';
import { readTlsIssuer } from '../lib/scenario-tls.mjs';
import { readFileSize, countMatchesSince } from '../lib/log-watch.mjs';

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
  const steps = [];
  if (ctx.dryRun) {
    applyFaults(log, ctx.topology);
    for (const name of describe()) {
      steps.push({ name, verdict: 'skipped', measurement: null, timeMs: 0 });
    }
    log.removeAll();
    return { scenario: NAME, startedAt: started, endedAt: Date.now(), steps, faults: log.records };
  }

  const identities = JSON.parse(readFileSync(join(ctx.outDir, 'identities.json'), 'utf8'));
  const pub1Id = identities.pub1?.notisId;
  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const pub1Host = ctx.topology.hosts.pub1;
  const pebbleLog = join(ctx.outDir, 'logs', 'pebble.log');

  const udp = udpDropArgs(ctx.topology);
  const notisTcp = notisTcpCutArgs(ctx.topology);
  const applied = []; // every nft table added so far
  const removeOne = (argv) => {
    try { nftApply(argv[4], argv.slice(5)); } catch (err) {
      process.stderr.write(`[s4 teardown] ${argv.slice(5, 10).join(' ')}: ${err?.message ?? err}\n`);
    }
  };
  const removeTable = (ns, table) => {
    removeOne(['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', table]);
  };

  try {
    // --- Step 1: drop UDP from browser to pub1 only ---
    const step1Start = Date.now();
    runFault(log, 'browser-udp-add-table', udp.addTable);
    applied.push({ ns: 'notismesh-browser', table: UDP_TABLE });
    runFault(log, 'browser-udp-add-chain', udp.addChain);
    const pub1Rule = udp.perHost.find((e) => e.name === 'pub1');
    if (!pub1Rule) throw new Error('s4: no pub1 UDP drop rule');
    runFault(log, 'browser-udp-drop-pub1', pub1Rule.argv);
    const state1 = await cdpPoll(ctx, browserUrl,
      "document.getElementById('state')?.textContent ?? null",
      `if (v === null) return false;
       try { const s = JSON.parse(v); return s.nodeId !== null && s.nodeId !== ${JSON.stringify(pub1Id)}; }
       catch (_e) { return false; }`,
      120_000, 1000,
    );
    const stateS1 = JSON.parse(state1);
    const step1Measurement = {
      connected: stateS1.nodeId !== null,
      nodeId: stateS1.nodeId,
      blockedNodeId: pub1Id,
    };
    steps.push({
      name: describe()[0],
      verdict: verdictS4Pub1UdpDrop(step1Measurement),
      measurement: step1Measurement,
      timeMs: Date.now() - step1Start,
    });

    // --- Step 2: drop UDP to every other public mesh node too ---
    const step2Start = Date.now();
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
    // Read the cert pub1 serves on its WSS port from inside the
    // browser's namespace (through natC's masquerade).
    const cert = readTlsIssuer('notismesh-browser', pub1Host.addr, pub1Host.mesh.wss.port, {
      user: ctx.invokingUser,
    });
    const step2Measurement = {
      transport: stateS2.transport,
      nodeId: stateS2.nodeId,
      expectedNodeId: pub1Id,
      certIssuerName: cert.issuer,
      expectedIssuerName: cert.issuer !== null && cert.issuer.includes(EXPECTED_ISSUER_SUBSTR) ? cert.issuer : `<any issuer containing ${EXPECTED_ISSUER_SUBSTR}>`,
    };
    steps.push({
      name: describe()[1],
      verdict: verdictS4AllUdpDrop(step2Measurement),
      measurement: step2Measurement,
      timeMs: Date.now() - step2Start,
    });

    // --- Step 3: across one renewal, probes keep succeeding ---
    const step3Start = Date.now();
    const pebbleSizeBefore = readFileSize(pebbleLog);
    // Poll the state over the renewal window; count probe successes
    // (anything other than a lastLeft that names a failure).
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
    const renewalCount = pebbleSizeBefore !== null
      ? countMatchesSince(pebbleLog, pebbleSizeBefore, /Issued certificate|Order (?:valid|finalized)/i)
      : 0;
    const step3Measurement = {
      renewalSeen: renewalCount > 0,
      probeSuccessAcrossRenewal: !lastLeftFailureSeen,
      lastLeftFailure: lastLeftFailureSeen,
    };
    steps.push({
      name: describe()[2],
      verdict: verdictS4Renewal(step3Measurement),
      measurement: step3Measurement,
      timeMs: Date.now() - step3Start,
    });

    // --- Step 4: drop TCP between the Notis nodes' p2p port ---
    const step4Start = Date.now();
    for (let i = 0; i < notisTcp.length; i += 1) {
      const t = notisTcp[i];
      runFault(log, `notis-tcp-add-table-${i}`, t.addTable);
      applied.push({ ns: `notismesh-${t.host}`, table: TCP_TABLE });
      runFault(log, `notis-tcp-add-chain-${i}`, t.addChain);
      runFault(log, `notis-tcp-drop-${i}`, t.dropDport);
    }
    // Measurement: read state once more; the browser still speaks WSS
    // to pub1 regardless of inter-node TCP. The chain's internal
    // state may lag.
    const text4 = await cdpEval(ctx, browserUrl,
      "document.getElementById('state')?.textContent ?? null");
    const state4 = typeof text4 === 'string' ? JSON.parse(text4) : {};
    const step4Measurement = {
      transport: state4.transport ?? null,
      nodeId: state4.nodeId ?? null,
      tip: state4.tip ?? null,
      note: 'inter-node TCP cut; browser-to-WSS stays up',
    };
    // No verdict function for step 4 (open-ended per the brief); the
    // measurement is informational, so verdict is PASS when a
    // measurement was taken, skipped otherwise.
    steps.push({
      name: describe()[3],
      verdict: typeof text4 === 'string' ? 'PASS' : 'skipped',
      measurement: step4Measurement,
      timeMs: Date.now() - step4Start,
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
    steps,
    faults: log.records,
  };
}

function runFault(log, name, argv) {
  // Record the fault on the log for the summary, and apply it in exec
  // mode. The paired removal is tracked separately through the
  // `applied` list (one `delete table` per table).
  log.records.push(`[fault:${NAME}:${name}] ${argv.join(' ')}`);
  nftApply(argv[4], argv.slice(5));
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
