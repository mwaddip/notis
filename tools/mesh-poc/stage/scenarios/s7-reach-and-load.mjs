// MESH_INTERFACE → Acceptance 7 — "Reads that may go to several nodes
// spread across them; a read that needs the tip goes to an `ok` node
// alone; a node slowed well past the others serves no read. A node on
// the browser's own network, named only by a seed, is never dialled;
// added by hand, it is reached at its private address, and
// `anchorReached` reads true from it alone when the reader trusts it
// and false when the reader does not. The page shows the agreement
// counts."
//
// Four sub-steps, in order:
//   1. spread and need — `?reads=20&need=older` then
//     `?reads=10&need=tip` on the stage default; PASS when ≥ 2
//     distinct nodes served the older reads AND every tip read's
//     serving node was `ok` at that read (`verdictS7Spread`).
//   2. the slowed node — `tc qdisc add dev <pub2 outside peer> root
//     netem delay 200ms` inside `notismesh-pub2`, removed in
//     `finally`; wait one completed check; `?reads=20&need=older`;
//     PASS when no read names pub2 (`verdictS7Fastest`).
//   3. the local node — three measurements combined:
//     (a) a variant whose seeds name lan1 at its localAddrs — over
//       two completed checks lan1 never holds a connection
//       (`transport === null` at every poll) AND lan1's mesh log
//       shows no inbound connection from the browser (`10.103.0.11`);
//     (b) a variant with no anchors and `byHand: [lan1, trusted]` —
//       lan1 reads `ok` or `trailing` over `webrtc-direct`,
//       `path: direct`, `anchorReached: true`;
//     (c) the same with `trusted: false` — same reach, `anchorReached:
//       false` (`verdictS7Lan`).
//   4. the counts — on the stage default after a completed check:
//     `agreement.agreeing >= 2`, `agreement.agreeingAnchors >= 1`
//     (`verdictS7Counts`).
//
// Faults are applied inside `run(ctx)` one at a time and the
// scenario's `finally` restores the stage default, removes every
// applied fault, and leaves lan1's qdisc untouched (nothing is set on
// lan1 here).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import {
  verdictS7Spread,
  verdictS7Fastest,
  verdictS7Lan,
  verdictS7Counts,
} from '../lib/verdicts.mjs';
import { execIn } from '../lib/measure.mjs';
import { writeConfigVariant, writeStageDefault } from '../lib/scenario-config.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's7';
const POLL_MS = 1_000;
const LONG_WAIT_MS = 180_000;

export function describe() {
  return [
    'older reads spread across ≥ 2 nodes; tip reads only on ok nodes',
    'pub2 delayed 200ms serves no read',
    'lan1 is never dialled from a seed; by hand it is reached, anchorReached follows the trusted flag',
    'the agreement counts hold agreeing ≥ 2 and agreeingAnchors ≥ 1',
  ];
}

/**
 * MESH_INTERFACE → Acceptance 7 — "a node slowed well past the others
 * serves no read". `tc qdisc add dev <pub2 outside interface> root
 * netem delay 200ms` inside `notismesh-pub2` adds the delay; the
 * matching removal is `tc qdisc del dev <iface> root`. The outside
 * interface's name inside pub2 is the veth peer bound in up.mjs as
 * `vp-<pub2.veth>` (its `addr/24` landed on `peer` at Phase 1).
 */
export function pub2NetemArgs(topology) {
  const pub2 = topology.hosts.pub2;
  if (!pub2 || typeof pub2.veth !== 'string') {
    throw new Error('s7: pub2 is missing from the topology');
  }
  const iface = `vp-${pub2.veth}`;
  const ns = 'notismesh-pub2';
  return {
    iface,
    add: ['sudo', 'ip', 'netns', 'exec', ns, 'tc', 'qdisc', 'add', 'dev', iface, 'root', 'netem', 'delay', '200ms'],
    del: ['sudo', 'ip', 'netns', 'exec', ns, 'tc', 'qdisc', 'del', 'dev', iface, 'root'],
  };
}

export function applyFaults(log, topology) {
  const n = pub2NetemArgs(topology);
  log.apply('pub2-netem-add', n.add, n.del);
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

  const defaultPath = join(ctx.outDir, 'browser', 'config.default.json');
  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  const baseConfig = JSON.parse(readFileSync(defaultPath, 'utf8'));
  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const lan1Row = identities?.lan1 ?? null;
  const lan1NotisId = lan1Row?.notisId ?? null;

  let netemApplied = false;
  const netem = pub2NetemArgs(ctx.topology);

  try {
    // --- Step 1: spread + need ---
    await rec.step(describe()[0], async () => {
      writeStageDefault(ctx.outDir);
      const olderServed = await driveReads(ctx, browserUrl, 20, 'older');
      const tipServed = await driveReads(ctx, browserUrl, 10, 'tip');
      const m = { olderServed, tipServed };
      return { verdict: verdictS7Spread(m), measurement: m };
    });

    // --- Step 2: the slowed node ---
    await rec.step(describe()[1], async () => {
      writeStageDefault(ctx.outDir);
      log.apply('pub2-netem-add', netem.add, netem.del);
      netemApplied = true;
      // One completed check for the fresh page to learn pub2's new
      // speed; the baseline-change predicate handles the first-check
      // and later-check cases alike.
      await waitOneCompletedCheck(ctx, browserUrl);
      const served = await driveReads(ctx, browserUrl, 20, 'older');
      const pub2Id = identities?.pub2?.notisId ?? null;
      if (typeof pub2Id !== 'string') {
        throw new Error('s7 step 2: identities.json has no pub2 row');
      }
      const m = { delayedNodeId: pub2Id, served };
      return { verdict: verdictS7Fastest(m), measurement: m };
    });

    // --- Step 3: the local node ---
    await rec.step(describe()[2], async () => {
      if (typeof lan1NotisId !== 'string') {
        throw new Error('s7 step 3: identities.json has no lan1 row');
      }
      // Remove the netem delay so pub2 is a fast peer again for the
      // seed phase and the hand-added phases. `tc qdisc del` needs
      // `CAP_NET_ADMIN`; the fault log's recorded removal argv runs
      // as root (bare `sudo ip netns exec …`), never under
      // `sudo -u <user>` (the invoking user has no capability).
      if (netemApplied) {
        log.remove('pub2-netem-add');
        netemApplied = false;
      }

      // (a) seed phase — base config, lan1 named only by a seed.
      const seedVariant = buildSeedOnlyLanVariant(baseConfig, lan1Row);
      writeConfigVariant(ctx.outDir, seedVariant);
      await waitOneCompletedCheck(ctx, browserUrl);
      await waitOneCompletedCheck(ctx, browserUrl);
      const seedState = await readState(ctx, browserUrl);
      const lan1Entry = seedState.nodes?.find((n) => n.notisId === lan1NotisId) ?? null;
      const lan1EverConnected = lan1Entry !== null && lan1Entry.transport !== null;
      // lan1's mesh log holds no `/ip4/10.103.0.11/` on an inbound
      // connection line. The log path is standard: stage/out/lan1/mesh:lan1.log.
      const lan1MeshLog = join(ctx.outDir, 'lan1', 'mesh:lan1.log');
      const lan1InboundLogged = existsSync(lan1MeshLog)
        && /10\.103\.0\.11/.test(readFileSync(lan1MeshLog, 'utf8'));
      const seedPhase = { lan1EverConnected, lan1InboundLogged };

      // (b) trusted hand phase — no anchors, byHand=[lan1, trusted:true].
      const trustedVariant = buildByHandLanVariant(baseConfig, lan1Row, true);
      writeConfigVariant(ctx.outDir, trustedVariant);
      const trustedState = await waitLan1Reached(ctx, browserUrl, lan1NotisId);
      const tEntry = trustedState.nodes?.find((n) => n.notisId === lan1NotisId) ?? null;
      const trustedPhase = {
        lan1Status: tEntry?.status ?? null,
        transport: tEntry?.transport ?? null,
        path: tEntry?.path ?? null,
        anchorReached: trustedState.anchorReached === true,
      };

      // (c) untrusted hand phase — no anchors, byHand=[lan1, trusted:false].
      const untrustedVariant = buildByHandLanVariant(baseConfig, lan1Row, false);
      writeConfigVariant(ctx.outDir, untrustedVariant);
      const untrustedState = await waitLan1Reached(ctx, browserUrl, lan1NotisId);
      const uEntry = untrustedState.nodes?.find((n) => n.notisId === lan1NotisId) ?? null;
      const untrustedPhase = {
        lan1Status: uEntry?.status ?? null,
        transport: uEntry?.transport ?? null,
        path: uEntry?.path ?? null,
        anchorReached: untrustedState.anchorReached === true,
      };

      const m = { seedPhase, trustedPhase, untrustedPhase };
      return { verdict: verdictS7Lan(m), measurement: m };
    });

    // --- Step 4: the counts ---
    await rec.step(describe()[3], async () => {
      writeStageDefault(ctx.outDir);
      await waitOneCompletedCheck(ctx, browserUrl);
      const state = await readState(ctx, browserUrl);
      const m = state.agreement ?? { agreeing: 0, agreeingAnchors: 0, notAgreeing: 0 };
      return { verdict: verdictS7Counts(m), measurement: m };
    });
  } finally {
    if (netemApplied) {
      // Same reason as step 3's early removal: `tc qdisc del` is
      // privileged, so the fault log's recorded removal argv runs,
      // not an `execIn` under `sudo -u <user>`.
      log.remove('pub2-netem-add');
      netemApplied = false;
    }
    try { writeStageDefault(ctx.outDir); }
    catch (err) { process.stderr.write(`[s7 teardown] writeStageDefault: ${err?.message ?? err}\n`); }
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

// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — `?reads=<n>&need=<tip|older>` runs n reads
// through `client.read` after the first completed check and writes
// `<pre id="reads">` with `{ need, served }`. The driver reads that
// element and returns the served array.
async function driveReads(ctx, baseUrl, n, need) {
  const url = `${baseUrl}?reads=${n}&need=${need}`;
  const expression = `(function () {
    const el = document.querySelector('pre#reads');
    return el !== null ? el.textContent : null;
  })()`;
  const predicate = `if (typeof v !== 'string') return false;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed.served) && parsed.served.length === ${n};
    } catch (_e) { return false; }`;
  const value = await cdpPoll(ctx, url, expression, predicate, LONG_WAIT_MS, POLL_MS);
  const parsed = JSON.parse(value);
  const served = Array.isArray(parsed.served) ? parsed.served : [];
  // Decorate every entry with its `statusAtRead` — the driver already
  // writes it as `status` per read, so copy that field over.
  return served.map((e) => ({ nodeId: e?.nodeId ?? null, statusAtRead: e?.status ?? null }));
}

// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — "how many checks it has completed, so a
// reader can tell one check's state from the next". The predicate's
// body: `v` is the `#state` text; on the first poll the current
// `checks` lands in `window.__s7CheckBaseline`, on each later poll
// the wait is done when `checks` has grown. The agreement counts
// stay identical across checks when the same nodes answer the same
// way, so a baseline on `agreement` never changes; the counter is
// the one hook this wait has. Exported so the stage test runs the
// same function body a scenario does.
export const S7_WAIT_ONE_COMPLETED_CHECK_PREDICATE = `if (v === null) return false;
    try {
      const s = JSON.parse(v);
      if (typeof s.checks !== 'number') return false;
      window.__s7CheckBaseline = window.__s7CheckBaseline === undefined ? s.checks : window.__s7CheckBaseline;
      return s.checks > window.__s7CheckBaseline;
    } catch (_e) { return false; }`;

async function waitOneCompletedCheck(ctx, url) {
  const expression = "document.getElementById('state')?.textContent ?? null";
  await cdpPoll(ctx, url, expression, S7_WAIT_ONE_COMPLETED_CHECK_PREDICATE, LONG_WAIT_MS, POLL_MS);
}

async function readState(ctx, url) {
  const expression = "document.getElementById('state')?.textContent ?? null";
  const predicate = 'return typeof v === "string" && v !== "";';
  const value = await cdpPoll(ctx, url, expression, predicate, 30_000, 500);
  return JSON.parse(value);
}

async function waitLan1Reached(ctx, url, lan1NotisId) {
  const expression = "document.getElementById('state')?.textContent ?? null";
  const predicate = `if (v === null) return false;
    try {
      const s = JSON.parse(v);
      if (!Array.isArray(s.nodes)) return false;
      const e = s.nodes.find((n) => n.notisId === ${JSON.stringify(lan1NotisId)});
      if (!e) return false;
      if (e.status !== 'ok' && e.status !== 'trailing') return false;
      if (e.transport !== 'webrtc-direct') return false;
      if (e.path !== 'direct') return false;
      return true;
    } catch (_e) { return false; }`;
  const value = await cdpPoll(ctx, url, expression, predicate, LONG_WAIT_MS, POLL_MS);
  return JSON.parse(value);
}

// MESH_INTERFACE → Discovery → "Seeds" — a seed is a contact without
// trust; no answer from it makes `anchorReached` true. The variant
// keeps the stage's own anchors AND names lan1 at its localAddrs as a
// seed. A lan1 row without `localAddrs` fails the step: the fallback
// to the announced relay addresses would measure the relay path, not
// the private one.
export function buildSeedOnlyLanVariant(baseConfig, lan1Row) {
  if (!lan1Row || typeof lan1Row.notisId !== 'string') {
    throw new Error('buildSeedOnlyLanVariant: lan1 identity row is missing');
  }
  if (!Array.isArray(lan1Row.localAddrs) || lan1Row.localAddrs.length === 0) {
    throw new Error('buildSeedOnlyLanVariant: lan1 identity row has no localAddrs');
  }
  return {
    network: baseConfig.network,
    anchors: baseConfig.anchors,
    seeds: [{ notisId: lan1Row.notisId, addrs: lan1Row.localAddrs }],
  };
}

// MESH_INTERFACE → Discovery → "A node added by hand" — a variant
// with no anchors and lan1 added by hand at its localAddrs. `trusted`
// decides whether `anchorReached` reads true from lan1's answer
// alone. A lan1 row without `localAddrs` fails the step: the step
// measures the private address.
export function buildByHandLanVariant(baseConfig, lan1Row, trusted) {
  if (!lan1Row || typeof lan1Row.notisId !== 'string') {
    throw new Error('buildByHandLanVariant: lan1 identity row is missing');
  }
  if (!Array.isArray(lan1Row.localAddrs) || lan1Row.localAddrs.length === 0) {
    throw new Error('buildByHandLanVariant: lan1 identity row has no localAddrs');
  }
  return {
    network: baseConfig.network,
    anchors: [],
    seeds: [],
    byHand: [{ notisId: lan1Row.notisId, addrs: lan1Row.localAddrs, trusted }],
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

