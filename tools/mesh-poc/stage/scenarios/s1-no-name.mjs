// MESH_INTERFACE → Acceptance 1 — "No name, no hosted page". The client
// reads a node's API by key from anchors alone; the mesh's answers equal
// the node's direct HTTP answers byte for byte; and the browser host's
// DNS log holds no query (every background query of the browser's own
// goes through Chromium's `--host-resolver-rules` resolver, which
// answers `~NOTFOUND` for every name but `localhost`).
//
// No faults; `applyFaults` is a no-op. The scenario reads the stage's
// own `config.json` as `up` wrote it: anchors = pub1 + pub2.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS1Node, verdictS1Probe, verdictS1DnsSilent } from '../lib/verdicts.mjs';
import { execIn, readDirect, readLineCount, readNftCounterSum } from '../lib/measure.mjs';

export const NAME = 's1';

export function describe() {
  return [
    'nodeId is an anchor within 60 s',
    'probe /blocks/current matches the node direct',
    'probe /nipopow/proof/24/20 matches the node direct',
    'the DNS log holds no line and the nft 53/853 counter did not move',
  ];
}

export function applyFaults(_log, _topology) {
  // s1 reads a clean stage; no faults.
}

/**
 * Pure: given the stage's `identities.json` and a `nodeId`, return the
 * host name that holds the key (or `null` if no row matches).
 */
export function hostOfNodeId(identities, nodeId) {
  if (!identities || typeof identities !== 'object') return null;
  for (const [host, row] of Object.entries(identities)) {
    if (row?.notisId === nodeId) return host;
  }
  return null;
}

/**
 * Pure: the set of `notisId`s that `config.json` lists as anchors.
 */
export function anchorIdSet(config) {
  const out = new Set();
  if (!config || !Array.isArray(config.anchors)) return out;
  for (const a of config.anchors) {
    if (typeof a?.notisId === 'string') out.add(a.notisId);
  }
  return out;
}

export async function run(ctx) {
  const log = new FaultLog({ dryRun: ctx.dryRun, scenario: NAME });
  const started = Date.now();
  const steps = [];
  applyFaults(log, ctx.topology);

  if (ctx.dryRun) {
    for (const name of describe()) {
      steps.push({ name, verdict: 'skipped', measurement: null, timeMs: 0 });
    }
    return { scenario: NAME, startedAt: started, endedAt: Date.now(), steps, faults: log.records };
  }

  // Capture the DNS window boundary BEFORE any CDP call. Chromium's
  // resolver answers `~NOTFOUND` on every host but `localhost`, so a
  // clean run leaves `stage/out/dns.log` unchanged and the browser
  // namespace's nft 53/853 counter at the value it was.
  const dnsLogPath = join(ctx.outDir, 'dns.log');
  const dnsLinesStart = readLineCount(dnsLogPath);
  const nftCounterStart = readNftCounterSum('notismesh-browser', 'dns_witness');

  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const config = JSON.parse(readFileSync(join(ctx.outDir, 'browser', 'config.json'), 'utf8'));
  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  const anchors = anchorIdSet(config);

  try {
    // Step 1 — anchor within 60 s.
    const step1Start = Date.now();
    const stateJson = await cdpPoll(ctx, browserUrl,
      "document.getElementById('state')?.textContent ?? null",
      "if (v === null) return false; try { return JSON.parse(v).nodeId !== null; } catch (_e) { return false; }",
      60_000, 500,
    );
    const step1Time = Date.now() - step1Start;
    const state = JSON.parse(stateJson);
    const nodeId = state.nodeId;
    const step1Measurement = {
      nodeId,
      isAnchor: anchors.has(nodeId),
      timeMs: step1Time,
    };
    steps.push({ name: describe()[0], verdict: verdictS1Node(step1Measurement), measurement: step1Measurement, timeMs: step1Time });

    // Resolve the host that owns the nodeId so direct reads land in
    // the right namespace.
    const hostName = hostOfNodeId(identities, nodeId);
    const hostRow = hostName !== null ? identities[hostName] : null;
    if (hostName === null || hostRow === null) {
      // No way to read direct — the two probe steps read `skipped`.
      for (let i = 1; i <= 2; i += 1) {
        steps.push({ name: describe()[i], verdict: 'skipped', measurement: null, timeMs: 0 });
      }
    } else {
      const nodeNs = `notismesh-${hostName}`;
      for (const [stepIndex, probePath] of [[1, '/blocks/current'], [2, '/nipopow/proof/24/20']]) {
        const probeStart = Date.now();
        const probeUrl = `${browserUrl}?probe=${encodeURIComponent(probePath)}`;
        const probeText = await cdpPoll(ctx, probeUrl,
          "document.getElementById('probe')?.textContent ?? null",
          "return typeof v === 'string' && v !== '';",
          60_000, 500,
        );
        const probe = JSON.parse(probeText);
        const directUrl = `http://127.0.0.1:${hostRow.httpPort}${probePath}`;
        const direct = readDirect(nodeNs, directUrl);
        const measurement = {
          probePath,
          probe: { sha256: probe.sha256, bytes: probe.bytes },
          direct: { sha256: direct.sha256, bytes: direct.bytes },
        };
        if (direct.sha256 !== probe.sha256) {
          // The tip moved between the probe's read and ours; read once
          // more and let the verdict decide.
          const retryDirect = readDirect(nodeNs, directUrl);
          measurement.retryDirect = { sha256: retryDirect.sha256, bytes: retryDirect.bytes };
        }
        const probeTime = Date.now() - probeStart;
        steps.push({
          name: describe()[stepIndex],
          verdict: verdictS1Probe(measurement),
          measurement,
          timeMs: probeTime,
        });
      }
    }

    // Step 4 (index 3) — DNS silent across the window.
    const dnsLinesEnd = readLineCount(dnsLogPath);
    const nftCounterEnd = readNftCounterSum('notismesh-browser', 'dns_witness');
    const dnsMeasurement = {
      dnsLines: dnsLinesEnd - dnsLinesStart,
      nftCounterPackets: nftCounterEnd - nftCounterStart,
    };
    steps.push({
      name: describe()[3],
      verdict: verdictS1DnsSilent(dnsMeasurement),
      measurement: dnsMeasurement,
      timeMs: Date.now() - started,
    });
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

/**
 * Call `cdp.mjs poll` inside `notismesh-browser` as the invoking user,
 * return the parsed JSON value it writes on stdout. The CDP endpoint
 * listens on that namespace's loopback (`127.0.0.1:9222`), so the
 * driver has to run there; the host has no route in.
 */
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
