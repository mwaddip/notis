// MESH_INTERFACE → Acceptance 2 — "A node behind the endpoint-independent
// NAT answers through a relay, then directly; one behind the symmetric
// NAT answers through the relay".
//
// Two sub-steps. For each, the scenario writes a `config.json` variant
// whose single anchor is the private node reached through a public one:
//   priv1 via pub1 → `path` reads `relay` first, then `direct` as DCUtR
//     or the WebRTC upgrade lands. Record both times.
//   priv2 via pub2 → `path` reads `relay` and stays there. Record
//     whether it ever reads `direct`.
//
// No stage faults; the NAT is topology. The variant is written to
// `stage/out/browser/config.json` (replacing the stage's own file for
// the duration), and restored in `finally`.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS2Priv1, verdictS2Priv2 } from '../lib/verdicts.mjs';
import { execIn, pollUntil } from '../lib/measure.mjs';
import { buildPrivateViaAnnouncedRelayVariant } from '../lib/config-variants.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's2';
const DIRECT_WAIT_MS = 60_000;
const RELAY_WAIT_MS = 60_000;

export function describe() {
  return [
    'priv1 (endpoint-independent NAT) answers through a relay, then directly',
    'priv2 (symmetric NAT) answers through the relay',
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

  const configPath = join(ctx.outDir, 'browser', 'config.json');
  const configBackupPath = `${configPath}.s2.bak`;
  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  const baseConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;

  // Back up the stage's config.json so the scenario's `finally` can
  // put it back whatever happens.
  renameSync(configPath, configBackupPath);
  try {
    const subSteps = [
      {
        name: describe()[0],
        privHost: 'priv1',
        verdict: verdictS2Priv1,
        buildMeasurement: ({ relayedTimeMs, directTimeMs, nodeId, expectedNodeId }) => ({
          nodeId,
          expectedNodeId,
          relayedTimeMs,
          directTimeMs,
        }),
      },
      {
        name: describe()[1],
        privHost: 'priv2',
        verdict: verdictS2Priv2,
        buildMeasurement: ({ relayedTimeMs, everDirect, nodeId, expectedNodeId }) => ({
          nodeId,
          expectedNodeId,
          relayedTimeMs,
          everDirect,
        }),
      },
    ];
    for (const sub of subSteps) {
      const privRow = identities?.[sub.privHost];
      if (!privRow) {
        rec.skipped(sub.name);
        continue;
      }
      // Wrap each sub-step in `rec.step` so a throw in priv1's does
      // not skip priv2's.
      await rec.step(sub.name, async () => {
        // MESH_INTERFACE → NAT — "A private node accepts circuit-relay
        // reservations on `/p2p-circuit`"; which public node holds the
        // reservation is the private node's own run-time choice.
        // Reading the private node's announced circuit address is the
        // one way to learn its real relay — the stage cannot hard-code
        // the via-public id.
        const variant = buildPrivateViaAnnouncedRelayVariant(baseConfig, {
          privRow,
          identities,
        });
        writeFileSync(configPath, JSON.stringify(variant, null, 2));
        const relayStart = Date.now();
        const relayJson = await cdpPoll(ctx, browserUrl,
          "document.getElementById('state')?.textContent ?? null",
          `if (v === null) return false;
           try { const s = JSON.parse(v); return s.nodeId === ${JSON.stringify(privRow.notisId)} && s.path === 'relay'; }
           catch (_e) { return false; }`,
          RELAY_WAIT_MS, 500,
        );
        const relayedTimeMs = Date.now() - relayStart;
        const relayState = JSON.parse(relayJson);
        let directTimeMs = null;
        let everDirect = false;
        const directStart = Date.now();
        try {
          const directJson = await cdpPoll(ctx, browserUrl,
            "document.getElementById('state')?.textContent ?? null",
            `if (v === null) return false;
             try { const s = JSON.parse(v); return s.nodeId === ${JSON.stringify(privRow.notisId)} && s.path === 'direct'; }
             catch (_e) { return false; }`,
            DIRECT_WAIT_MS, 500,
          );
          void JSON.parse(directJson);
          directTimeMs = Date.now() - directStart;
          everDirect = true;
        } catch {
          // priv2 stays here (symmetric NAT); priv1 FAILs on
          // verdictS2Priv1 (needs directTimeMs).
          directTimeMs = null;
          everDirect = false;
        }
        const measurement = sub.buildMeasurement({
          nodeId: relayState.nodeId,
          expectedNodeId: privRow.notisId,
          relayedTimeMs,
          directTimeMs: directTimeMs ?? -1,
          everDirect,
        });
        return { verdict: sub.verdict(measurement), measurement };
      });
    }
  } finally {
    // Restore stage's config.json whatever happened.
    if (existsSync(configBackupPath)) {
      if (existsSync(configPath)) {
        try { renameSync(configPath, `${configPath}.s2.leftover`); }
        catch (err) { process.stderr.write(`[s2 teardown] could not move leftover: ${err?.message ?? err}\n`); }
      }
      renameSync(configBackupPath, configPath);
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
