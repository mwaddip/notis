// MESH_INTERFACE → Acceptance 2 / NAT — "The browser reaches the node
// behind the endpoint-independent NAT over WebRTC signalled through a
// relay, its data direct. The node behind the symmetric NAT has no
// direct path to the browser behind its NAT: it reads `retry`, never
// `blacklisted`, and the client stays on a node it reaches."
//
// Two sub-steps, each writing its own `config.json` variant:
//   priv1 (endpoint-independent NAT) — the single anchor is priv1 by
//     its `/p2p-circuit/webrtc/p2p/<priv1>` address through a public
//     node's WebRTC-direct address. The step polls until the page
//     reads priv1 as the node in use and records
//     `{ nodeId, transport, path, anchorAddrRelayed, connectMs,
//        iceServers }`.
//   priv2 (symmetric NAT) — the single anchor is priv2 by BOTH its
//     `/p2p-circuit/webrtc` and plain `/p2p-circuit` relayed
//     addresses. The step polls priv2's `NodeList` entry and the page
//     state's `nodeId` across the window; PASS when priv2 reads
//     `retry` with ≥1 failure, never `blacklisted` at any poll, and
//     the page's `nodeId` at the end names a node other than priv2.
//
// No stage faults; the NAT is topology. The scenario's `finally`
// restores the stage default so the next scenario starts clean.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS2Priv1, verdictS2Priv2 } from '../lib/verdicts.mjs';
import { execIn } from '../lib/measure.mjs';
import {
  buildPrivateViaAnnouncedRelayVariant,
  buildPrivateViaAnnouncedRelayPairVariant,
} from '../lib/config-variants.mjs';
import { writeConfigVariant, writeStageDefault } from '../lib/scenario-config.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's2';
const PRIV1_WAIT_MS = 120_000;
const PRIV2_WAIT_MS = 120_000;
const POLL_MS = 500;

export function describe() {
  return [
    'priv1 (endpoint-independent NAT) answers over relayed WebRTC',
    'priv2 (symmetric NAT) stays retry with a failure, the client stays on another node',
  ];
}

export function applyFaults(_log, _topology) {
  // s2 reads a NAT the stage already set up; no faults.
}

export async function run(ctx) {
  const log = new FaultLog({ dryRun: ctx.dryRun, scenario: NAME });
  const started = Date.now();
  const rec = new StepRecorder();

  if (ctx.dryRun) {
    for (const name of describe()) rec.skipped(name);
    return { scenario: NAME, startedAt: started, endedAt: Date.now(), steps: rec.steps, faults: log.records };
  }

  // MESH_INTERFACE → Acceptance — s2 reads its base from the stage
  // default (`config.default.json`), not from `config.json` which a
  // previous scenario may have mutated. The scenario's `finally`
  // restores the stage default so the next scenario starts clean.
  const defaultPath = join(ctx.outDir, 'browser', 'config.default.json');
  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  const baseConfig = JSON.parse(readFileSync(defaultPath, 'utf8'));
  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;

  try {
    // --- priv1 ----------------------------------------------------------
    const priv1Row = identities?.priv1;
    if (!priv1Row) {
      rec.skipped(describe()[0]);
    } else {
      await rec.step(describe()[0], async () => {
        const variant = buildPrivateViaAnnouncedRelayVariant(baseConfig, {
          privRow: priv1Row,
          identities,
        });
        writeConfigVariant(ctx.outDir, variant);
        const anchorAddrRelayed = variant.anchors[0]?.addrs?.[0] ?? null;
        const started1 = Date.now();
        // Poll until the page's `nodeId` reads priv1. The ICE record
        // is captured alongside through `cdp.mjs poll-ice`.
        const { value, iceRecord } = await cdpPollIce(ctx, browserUrl,
          "document.getElementById('state')?.textContent ?? null",
          `if (v === null) return false;
           try { const s = JSON.parse(v); return s.nodeId === ${JSON.stringify(priv1Row.notisId)}; }
           catch (_e) { return false; }`,
          PRIV1_WAIT_MS, POLL_MS,
        );
        const connectMs = Date.now() - started1;
        const state = JSON.parse(value);
        const measurement = {
          nodeId: state.nodeId,
          expectedNodeId: priv1Row.notisId,
          transport: state.transport,
          path: state.path,
          anchorAddrRelayed,
          connectMs,
          iceServers: iceRecord,
        };
        return { verdict: verdictS2Priv1(measurement), measurement };
      });
    }

    // --- priv2 ----------------------------------------------------------
    const priv2Row = identities?.priv2;
    if (!priv2Row) {
      rec.skipped(describe()[1]);
    } else {
      await rec.step(describe()[1], async () => {
        const variant = buildPrivateViaAnnouncedRelayPairVariant(baseConfig, {
          privRow: priv2Row,
          identities,
        });
        writeConfigVariant(ctx.outDir, variant);
        const expectedNodeId = priv2Row.notisId;
        // Walk the page's state while priv2's entry collects failures.
        // The predicate stops the poll when priv2 has ≥1 failure AND
        // the page's `nodeId` names a node other than priv2 that is
        // not null (the client reached something else). The record
        // tracks `blacklistedAtAnyPoll` and `everInUse` across the
        // window.
        let priv2Status = 'new';
        let priv2Failures = 0;
        let priv2LastFailure = null;
        let nodeIdInUse = null;
        let everInUse = false;
        let blacklistedAtAnyPoll = false;
        let anyPoll = false;
        const stop = Date.now() + PRIV2_WAIT_MS;
        while (Date.now() < stop) {
          const text = await cdpEval(ctx, browserUrl,
            "document.getElementById('state')?.textContent ?? null");
          if (typeof text !== 'string') {
            await delay(POLL_MS);
            continue;
          }
          const state = JSON.parse(text);
          anyPoll = true;
          nodeIdInUse = state.nodeId ?? null;
          if (nodeIdInUse === expectedNodeId) everInUse = true;
          const entry = Array.isArray(state.nodes)
            ? state.nodes.find((n) => n?.notisId === expectedNodeId)
            : null;
          if (entry) {
            priv2Status = typeof entry.status === 'string' ? entry.status : priv2Status;
            if (typeof entry.failures === 'number') priv2Failures = entry.failures;
            priv2LastFailure = entry.lastFailure ?? null;
            if (priv2Status === 'blacklisted') blacklistedAtAnyPoll = true;
          }
          const satisfied = priv2Failures >= 1
            && nodeIdInUse !== null
            && nodeIdInUse !== expectedNodeId;
          if (satisfied) break;
          await delay(POLL_MS);
        }
        const measurement = anyPoll ? {
          expectedNodeId,
          priv2Status,
          priv2Failures,
          priv2LastFailure,
          nodeIdInUse,
          everInUse,
          blacklistedAtAnyPoll,
        } : null;
        return { verdict: verdictS2Priv2(measurement), measurement };
      });
    }
  } finally {
    try { writeStageDefault(ctx.outDir); }
    catch (err) { process.stderr.write(`[s2 teardown] writeStageDefault: ${err?.message ?? err}\n`); }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdpEval(ctx, url, expression) {
  const argv = [ctx.nodeBin, ctx.cdpScript, 'eval', url, expression];
  const buf = execIn('notismesh-browser', argv, {
    user: ctx.invokingUser,
    timeoutMs: 20_000,
  });
  const text = buf.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text);
}

async function cdpPollIce(ctx, url, expression, predicateBody, timeoutMs, pollMs) {
  const argv = [
    ctx.nodeBin, ctx.cdpScript, 'poll-ice', url, expression, predicateBody,
    String(timeoutMs), String(pollMs),
  ];
  const buf = execIn('notismesh-browser', argv, {
    user: ctx.invokingUser,
    timeoutMs: timeoutMs + 10_000,
  });
  return JSON.parse(buf.toString('utf8'));
}
