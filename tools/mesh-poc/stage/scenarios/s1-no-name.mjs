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
import { verdictS1Node, verdictS1Probe, verdictS1DnsSilent, verdictIceServers } from '../lib/verdicts.mjs';
import {
  execIn, readDirect, readLineCount, readNftCounterSum, findPid, signal, leafPids, descendantPids,
} from '../lib/measure.mjs';
import { writeStageDefault } from '../lib/scenario-config.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's1';

export function describe() {
  return [
    'nodeId is an anchor within 60 s',
    'probe /blocks/current matches the node direct',
    'probe /nipopow/proof/24/20 matches the node direct',
    'the DNS log holds no line and the nft 53/853 counter did not move',
    'every RTCPeerConnection the page builds names a STUN by IP, or no STUN at all',
  ];
}

export function applyFaults(log, _topology) {
  // MESH_INTERFACE → Acceptance 1 — the probe window pauses
  // `miner-steady` so `/blocks/current` and the proof route do not
  // move between the bracket and the probe. The dry-run names the
  // leaves of the recorded wrapper PID (the inner Node process is
  // the one SIGSTOP has to reach — sudo does not relay SIGSTOP to
  // its children); exec mode walks `/proc` down to the leaves at
  // pause time and signals each. The dry-run uses a placeholder.
  log.records.push(`[fault:${NAME}:miner-steady-pause] kill -STOP <miner-steady-innermost-pids>`);
  log.records.push(`[fault:remove:${NAME}:miner-steady-pause] kill -CONT <miner-steady-innermost-pids>`);
  if (log.dryRun) {
    process.stdout.write(`[fault:${NAME}:miner-steady-pause] kill -STOP <miner-steady-innermost-pids>\n`);
    process.stdout.write(`[fault:remove:${NAME}:miner-steady-pause] kill -CONT <miner-steady-innermost-pids>\n`);
  }
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
  const rec = new StepRecorder();

  if (ctx.dryRun) {
    // Dry-run surfaces the fault pair so a reader sees what the
    // probe window pauses; exec mode records the live pid alongside.
    applyFaults(log, ctx.topology);
    for (const name of describe()) rec.skipped(name);
    return { scenario: NAME, startedAt: started, endedAt: Date.now(), steps: rec.steps, faults: log.records };
  }

  // Capture the DNS window boundary BEFORE any CDP call. Chromium's
  // resolver answers `~NOTFOUND` on every host but `localhost`, so a
  // clean run leaves `stage/out/dns.log` unchanged and the browser
  // namespace's nft 53/853 counter at the value it was.
  // MESH_INTERFACE → Acceptance — every scenario writes config.json
  // fresh at its start so none inherits a previous scenario's variant.
  // s1 needs no variant — the stage default is what it reads.
  writeStageDefault(ctx.outDir);

  const dnsLogPath = join(ctx.outDir, 'dns.log');
  const dnsLinesStart = readLineCount(dnsLogPath);
  const nftCounterStart = readNftCounterSum('notismesh-browser', 'dns_witness');

  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const config = JSON.parse(readFileSync(join(ctx.outDir, 'browser', 'config.json'), 'utf8'));
  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  const anchors = anchorIdSet(config);

  // Each step is wrapped in `rec.step(name, fn)` so a throw records
  // FAIL for THAT step and the next step still runs (MESH_INTERFACE →
  // Acceptance). The scenario's one `finally` runs `log.removeAll()`
  // whatever each step did AND releases the paused miner.
  let anchorNodeId = null;
  // MESH_INTERFACE → Acceptance 1 — "the mesh's answers equal the node's
  // direct HTTP answers byte for byte". The chain's tip moves at mining
  // speed; the probe and the direct reads both come off a tip that may
  // advance between calls, so a stale read looks like a mesh/direct
  // mismatch. The probe window pauses `miner-steady` by SIGSTOP; the
  // `finally` resumes it with SIGCONT whether every probe passed, raised
  // or timed out. The non-probe steps (step 1, step 4) run while the
  // chain still moves.
  const minerEntry = findPid(ctx.pids?.pids, 'miner-steady');
  // MESH_INTERFACE → Acceptance 1 — the recorded `miner-steady` PID
  // is the outer `sudo ip netns exec ... sudo -u user -- node ...`
  // wrapper. sudo does not relay SIGSTOP to its child, so signalling
  // the recorded PID stops nothing. `leafPids(minerEntry.pid)`
  // walks /proc down to the leaves (the inner Node process is the
  // one that runs the miner); each leaf gets SIGSTOP on pause and
  // SIGCONT on resume.
  let pausedPids = [];
  try {
    const step1 = await rec.step(describe()[0], async () => {
      const step1Start = Date.now();
      const stateJson = await cdpPoll(ctx, browserUrl,
        "document.getElementById('state')?.textContent ?? null",
        "if (v === null) return false; try { return JSON.parse(v).nodeId !== null; } catch (_e) { return false; }",
        60_000, 500,
      );
      const state = JSON.parse(stateJson);
      anchorNodeId = state.nodeId;
      const m = { nodeId: state.nodeId, isAnchor: anchors.has(state.nodeId), timeMs: Date.now() - step1Start };
      return { verdict: verdictS1Node(m), measurement: m };
    });
    void step1;

    // Probe steps 2 and 3 need an identity row. If step 1 failed or
    // the id is not in identities.json, those steps read `skipped`.
    const hostName = anchorNodeId !== null ? hostOfNodeId(identities, anchorNodeId) : null;
    const hostRow = hostName !== null ? identities[hostName] : null;
    if (hostName !== null && hostRow !== null && minerEntry !== null) {
      pausedPids = leafPids(minerEntry.pid);
      for (const leaf of pausedPids) {
        signal(leaf, 'SIGSTOP');
      }
      log.records.push(`[fault:${NAME}:miner-steady-pause] kill -STOP ${pausedPids.join(' ')} (leaves of ${minerEntry.pid})`);
    }
    for (const [stepIndex, probePath] of [[1, '/blocks/current'], [2, '/nipopow/proof/24/20']]) {
      if (hostName === null || hostRow === null) {
        rec.skipped(describe()[stepIndex]);
        continue;
      }
      await rec.step(describe()[stepIndex], async () => {
        const nodeNs = `notismesh-${hostName}`;
        const probeUrl = `${browserUrl}?probe=${encodeURIComponent(probePath)}`;
        const directUrl = `http://127.0.0.1:${hostRow.httpPort}${probePath}`;
        // MESH_INTERFACE → Acceptance 1 — "the mesh's answers equal the
        // node's direct HTTP answers byte for byte". The miner is
        // paused outside the loop, so the chain is still: `directBefore`
        // and `directAfter` bracket the probe for the same tip, and
        // the probe equals both.
        const directBefore = readDirect(nodeNs, directUrl);
        const probeText = await cdpPoll(ctx, probeUrl,
          "document.getElementById('probe')?.textContent ?? null",
          "return typeof v === 'string' && v !== '';",
          60_000, 500,
        );
        const probe = JSON.parse(probeText);
        const directAfter = readDirect(nodeNs, directUrl);
        const measurement = {
          probePath,
          probe: { sha256: probe.sha256, bytes: probe.bytes },
          directBefore: { sha256: directBefore.sha256, bytes: directBefore.bytes },
          directAfter: { sha256: directAfter.sha256, bytes: directAfter.bytes },
        };
        return { verdict: verdictS1Probe(measurement), measurement };
      });
    }

    await rec.step(describe()[3], async () => {
      const dnsLinesEnd = readLineCount(dnsLogPath);
      const nftCounterEnd = readNftCounterSum('notismesh-browser', 'dns_witness');
      // MESH_INTERFACE → Acceptance 1 — "no DNS traffic" is PASS only
      // on positive evidence that the page connected. A page that never
      // reached a node has no DNS traffic vacuously. `anchorNodeId` is
      // the nodeId Step 1 found (null if step 1 FAILed).
      const m = {
        dnsLines: dnsLinesEnd - dnsLinesStart,
        nftCounterPackets: nftCounterEnd - nftCounterStart,
        connected: anchorNodeId !== null,
      };
      return { verdict: verdictS1DnsSilent(m), measurement: m };
    });

    // MESH_INTERFACE → NAT — "every STUN server is a mesh node named by
    // IP ... Only the relayed WebRTC path uses STUN; WebRTC-direct to
    // a public address needs none." s1's path is WebRTC-direct, so the
    // record is expected to be either empty-URL buckets or stun:ip:port
    // URLs — never a host name. Chromium's own `--host-resolver-rules`
    // hides a host-named ICE server from the DNS witness, so the record
    // is where the stage sees it.
    await rec.step(describe()[4], async () => {
      const { value, iceRecord } = await cdpPollIce(ctx, browserUrl,
        "document.getElementById('state')?.textContent ?? null",
        "if (v === null) return false; try { return JSON.parse(v).nodeId !== null; } catch (_e) { return false; }",
        60_000, 500,
      );
      void value;
      return { verdict: verdictIceServers(iceRecord), measurement: { iceServers: iceRecord } };
    });
  } finally {
    // Release the miner whether the probes passed, raised or timed
    // out — a paused miner holds up every other scenario that reads
    // the chain. SIGSTOP on a leaf makes `sudo -u`'s job-control
    // relay suspend the wrapper too (sudo's tcsetpgrp wait path), so
    // SIGCONT on the leaf alone leaves the wrapper `T` and the
    // stage's `down` cannot pass SIGTERM through it. The resume
    // sends SIGCONT to the whole tree: the recorded pid and every
    // descendant, wrappers included. A pid that died mid-run reads
    // ESRCH and is a no-op.
    if (pausedPids.length > 0 && minerEntry !== null) {
      const treePids = [minerEntry.pid, ...descendantPids(minerEntry.pid)];
      for (const pid of treePids) {
        try { signal(pid, 'SIGCONT'); }
        catch (err) { process.stderr.write(`[s1 teardown] SIGCONT ${pid}: ${err?.message ?? err}\n`); }
      }
      log.records.push(`[fault:remove:${NAME}:miner-steady-pause] kill -CONT ${treePids.join(' ')} (tree of ${minerEntry.pid})`);
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

/**
 * MESH_INTERFACE → Acceptance 1 — poll the state through a page the
 * stage opened with the `RTCPeerConnection` wrapper installed, and
 * read the record alongside the state. The sub-command writes
 * `{ value, iceRecord }`.
 */
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
