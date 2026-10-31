// MESH_INTERFACE → Acceptance 2 / NAT — "The browser reaches the node
// behind the endpoint-independent NAT over WebRTC signalled through a
// relay, its data direct. The node behind the symmetric NAT has no
// direct path to the browser behind its NAT: it reads `retry`, never
// `blacklisted`, and the client stays on a node it reaches."
//
// Two sub-steps, each writing its own `config.json` variant:
//   priv1 (endpoint-independent NAT) — the single anchor is priv1 by
//     its `/p2p-circuit/webrtc/p2p/<priv1>` address through a public
//     node's WebRTC-direct address. The step polls until priv1's own
//     NodeList entry answers (`status` ok or behind, a checked answer
//     — `behind` is ranking, not reach) with a non-null entry
//     transport, and records
//     `{ expectedNodeId, priv1Status, priv1Failures, transport, path,
//        anchorAddrRelayed, connectMs, iceServers, nodeIdInUse }`.
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
        // MESH_INTERFACE → Acceptance 2 — the step measures reach, not
        // ranking. Poll `#state` until priv1's own entry carries a
        // `status` of ok or behind AND a non-null `transport`
        // (`decorateEntries` writes the entry pair from
        // `pickConnectionForLabel` + `classifyConnectionAddr` for each
        // id). The ICE record is captured alongside through
        // `cdp.mjs poll-ice`.
        const expectedNotisId = priv1Row.notisId;
        const { value, iceRecord } = await cdpPollIce(ctx, browserUrl,
          "document.getElementById('state')?.textContent ?? null",
          `if (v === null) return false;
           try {
             const s = JSON.parse(v);
             if (!s || !Array.isArray(s.nodes)) return false;
             const entry = s.nodes.find(function (n) { return n && n.notisId === ${JSON.stringify(expectedNotisId)}; });
             if (!entry) return false;
             if (entry.status !== 'ok' && entry.status !== 'behind') return false;
             return entry.transport !== null && entry.transport !== undefined;
           } catch (_e) { return false; }`,
          PRIV1_WAIT_MS, POLL_MS,
        );
        const connectMs = Date.now() - started1;
        const state = JSON.parse(value);
        const entry = Array.isArray(state.nodes)
          ? state.nodes.find((n) => n?.notisId === expectedNotisId)
          : null;
        const measurement = {
          expectedNodeId: expectedNotisId,
          priv1Status: typeof entry?.status === 'string' ? entry.status : 'new',
          priv1Failures: typeof entry?.failures === 'number' ? entry.failures : 0,
          transport: entry?.transport ?? null,
          path: entry?.path ?? null,
          anchorAddrRelayed,
          connectMs,
          iceServers: iceRecord,
          nodeIdInUse: state.nodeId ?? null,
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
        // MESH_INTERFACE → Acceptance 2 — the step holds ONE page open
        // across the whole window: `cdp.mjs eval` would open a fresh
        // target per call and reset the client to nothing, so priv2's
        // entry could never accumulate a failure on a working stage.
        // The expression runs in the page, parses `#state`, updates an
        // in-page accumulator `window.__s2priv2` (so `everInUse` and
        // `blacklistedAtAnyPoll` ride across polls), and returns
        // `JSON.stringify({ state, acc })` for the driver. The
        // predicate stops polling when priv2 has >= 1 failure, the
        // page's `nodeId` names a non-null node other than priv2, and
        // priv2 is not blacklisted at this poll. A poll timeout
        // propagates to the step recorder as the error it is.
        const expression = `(function () {
          const el = document.getElementById('state');
          const text = el ? el.textContent : null;
          if (typeof text !== 'string' || text === '') return null;
          let state;
          try { state = JSON.parse(text); } catch (_e) { return null; }
          var acc = window.__s2priv2 || { everInUse: false, blacklistedAtAnyPoll: false };
          var expected = ${JSON.stringify(expectedNodeId)};
          if (state && state.nodeId === expected) acc.everInUse = true;
          var entry = (state && Array.isArray(state.nodes))
            ? state.nodes.find(function (n) { return n && n.notisId === expected; })
            : null;
          if (entry && entry.status === 'blacklisted') acc.blacklistedAtAnyPoll = true;
          window.__s2priv2 = acc;
          return JSON.stringify({ state: state, acc: acc });
        })()`;
        const predicateBody = `if (typeof v !== 'string') return false;
          try {
            var o = JSON.parse(v);
            var expected = ${JSON.stringify(expectedNodeId)};
            if (!o || !o.state || !Array.isArray(o.state.nodes)) return false;
            var entry = o.state.nodes.find(function (n) { return n && n.notisId === expected; });
            if (!entry || typeof entry.failures !== 'number' || entry.failures < 1) return false;
            if (entry.status === 'blacklisted') return false;
            if (o.state.nodeId === null || o.state.nodeId === undefined) return false;
            if (o.state.nodeId === expected) return false;
            return true;
          } catch (_e) { return false; }`;
        const matched = await cdpPoll(ctx, browserUrl, expression, predicateBody,
          PRIV2_WAIT_MS, POLL_MS);
        // `matched` is the matching value — a string
        // `JSON.stringify({ state, acc })`. The driver has already
        // JSON.parse-d the stdout once.
        const parsed = JSON.parse(matched);
        const state = parsed.state;
        const acc = parsed.acc;
        const entry = Array.isArray(state.nodes)
          ? state.nodes.find((n) => n?.notisId === expectedNodeId)
          : null;
        const measurement = {
          expectedNodeId,
          priv2Status: typeof entry?.status === 'string' ? entry.status : 'new',
          priv2Failures: typeof entry?.failures === 'number' ? entry.failures : 0,
          priv2LastFailure: entry?.lastFailure ?? null,
          nodeIdInUse: state.nodeId ?? null,
          everInUse: acc?.everInUse === true,
          blacklistedAtAnyPoll: acc?.blacklistedAtAnyPoll === true,
        };
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
