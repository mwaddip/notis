// MESH_INTERFACE → Acceptance 8 — "Prove once, follow by gossip. After
// the first check, no proof is read across five checks while every
// node names a tip on the client's chain; a block mined on a node
// reaches the browser by gossip through a mesh service and moves the
// client's tip before its next check; a node on another chain has
// its proof read at the next check — one per distinct tip, and the
// client's own — and the heavier chain is the client's; the browser's
// gossip cut for three blocks and restored, its tip catches up by
// headers with no proof read."
//
// Four sub-steps, in order:
//   1. No proof after the first — stage default: wait for a completed
//      check with the chain settled; record `traffic.proofReads` and
//      `checks`; wait for five more completed checks;
//      `verdictS8NoProofs`: PASS when `proofReads` did not move and
//      every honest node read `ok`, `trailing` or `behind`.
//   2. A block by gossip — three new blocks in turn: pub1's node
//      height read inside its namespace, then `#state` polled until
//      the client's `tip.height` reaches it; record for each the delay
//      between the two and whether `checks` moved meanwhile. The
//      measurement reads the browser's own tip-change timeline — one
//      page kept open across the three deliveries, so the client's
//      gossip subscription survives between them (a fresh page runs
//      an initial check that reads the latest tip by proof, which is
//      the state 1 behaviour not step 2's). `verdictS8Gossip`: PASS
//      when ≥ 2 of 3 reached the client within 5 s with `checks`
//      unchanged.
//   3. Another chain — the hostile-seed variant with `hostile-lagging`
//      mining its own lighter fork since `up`. The step finds a check
//      where the lagging node's tip was the one tip not on the chain
//      by waiting for a check cycle in which `traffic.proofReads`
//      rose by exactly two — the lagging node's proof plus the
//      client's own tip proof, the one shape "one per distinct tip,
//      and the client's own" produces when every other node names
//      the chain's tip. `verdictS8Fork`: PASS when lagging reads
//      `behind`, the client's tip hash equals pub1's node's block
//      hash at that height, and the delta is exactly two.
//   4. A gap filled by headers — stage default: firewall the browser
//      from every mesh node (a `FaultLog` fault, removed in `finally`)
//      until pub1's node is three blocks past the client's tip; remove
//      it; wait until the client's tip is within one block of pub1's
//      node (a deadline of three minutes: nodes come back on the
//      retry cadence). `verdictS8Gap`: PASS when the tip caught up and
//      `proofReads` did not move. The step keeps one page open across
//      the apply/remove window through a non-blocking spawn of
//      `cdp.mjs poll`; a fresh page's first check reads a proof, which
//      would mask the "no proof" conclusion. The tracker signals ready
//      when the client's tip has grown by at least three past its own
//      captured baseline — the point the firewall was lifted at or
//      past, so a fill linked through the kept headers.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { FaultLog } from '../lib/fault-log.mjs';
import {
  verdictS8NoProofs,
  verdictS8Gossip,
  verdictS8Fork,
  verdictS8Gap,
} from '../lib/verdicts.mjs';
import { execIn } from '../lib/measure.mjs';
import { writeStageDefault, writeConfigVariant } from '../lib/scenario-config.mjs';
import { buildWithHostileSeedsVariant, buildHostileSeeds } from '../lib/config-variants.mjs';
import { peerIdStringOf } from '../lib/config.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's8';
const POLL_MS = 500;
const LONG_WAIT_MS = 240_000;
const GAP_TABLE = 's8_gap';

export function describe() {
  return [
    'no proof read across five completed checks on the stage default',
    'three new blocks reach the browser by gossip within 5 s each',
    'the lagging fork reads behind, client tip stays on pub1\'s chain, exactly two proofs that check',
    'the browser\'s gossip cut for three blocks and restored: tip catches up by headers, no proof read',
  ];
}

// MESH_INTERFACE → Acceptance 8 — "the browser's gossip cut for
// three blocks and restored". The gap firewall drops output from the
// browser namespace to every mesh host's address (every host whose
// topology config carries `mesh`), so the client's existing links
// break and new dials fail until the firewall is removed.
export function s8GapFirewallArgs(topology) {
  const ns = 'notismesh-browser';
  const meshHosts = [];
  for (const [host, hostConfig] of Object.entries(topology.hosts)) {
    if (hostConfig?.mesh === undefined) continue;
    if (typeof hostConfig.addr !== 'string') continue;
    meshHosts.push({ name: host, addr: hostConfig.addr });
  }
  const addTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', GAP_TABLE];
  const addChain = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', GAP_TABLE, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'];
  const drops = meshHosts.map(({ name, addr }) => ({
    name,
    argv: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', GAP_TABLE, 'out', 'ip', 'daddr', addr, 'drop'],
  }));
  const deleteTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', GAP_TABLE];
  return { addTable, addChain, drops, deleteTable };
}

export function applyFaults(log, topology) {
  const f = s8GapFirewallArgs(topology);
  log.apply('browser-gap-add-table', f.addTable, f.deleteTable);
  log.apply('browser-gap-add-chain', f.addChain, null);
  for (const { name, argv } of f.drops) {
    log.apply(`browser-gap-drop-${name}`, argv, null);
  }
}

// MESH_INTERFACE → Acceptance 8 — step 2 reads `#state` through a page
// kept open across the delivery window: one target observed over the
// three new blocks' arrivals, so the client's gossip subscription
// survives between them. The expression installs a page-side setInterval
// that pushes a `{height, atMs, checks}` record whenever `state.tip.height`
// changes; the predicate returns true once four such records exist
// (one baseline plus three deliveries).
export const S8_GOSSIP_EXPR = `(function(){
  if (!window.__s8GInit) {
    window.__s8GInit = true;
    window.__s8GHs = [];
    window.__s8GLastH = null;
    setInterval(function () {
      try {
        var el = document.getElementById('state');
        if (el === null) return;
        var s = JSON.parse(el.textContent);
        var h = s && s.tip ? s.tip.height : null;
        var c = s ? s.checks : null;
        if (typeof h !== 'number' || typeof c !== 'number') return;
        if (window.__s8GLastH === null || h !== window.__s8GLastH) {
          window.__s8GHs.push({ height: h, atMs: Date.now(), checks: c });
          window.__s8GLastH = h;
        }
      } catch (_e) { /* ignore */ }
    }, 100);
  }
  return JSON.stringify(window.__s8GHs);
})()`;

export const S8_GOSSIP_PREDICATE = `if (v === null) return false;
  var hs;
  try { hs = JSON.parse(v); } catch (_e) { return false; }
  return Array.isArray(hs) && hs.length >= 4;`;

// MESH_INTERFACE → Acceptance 8 — step 1 reads `#state` across five
// checks past a settled baseline. The expression installs a page-side
// setInterval that captures the baseline (first time `checks >= 1`
// AND every honest node reads `ok`, `trailing` or `behind`) and the
// final state (five checks later). `honestIds` is substituted by the
// scenario at expression-build time.
export function buildS8NoProofsExpression(honestIds) {
  const idsJson = JSON.stringify(honestIds);
  return `(function(){
  if (!window.__s8NPInit) {
    window.__s8NPInit = true;
    window.__s8NP = { base: null, final: null, honestIds: ${idsJson} };
    setInterval(function () {
      try {
        var el = document.getElementById('state');
        if (el === null) return;
        var s = JSON.parse(el.textContent);
        if (!s || typeof s.checks !== 'number') return;
        var honestEntries = [];
        for (var i = 0; i < window.__s8NP.honestIds.length; i++) {
          var id = window.__s8NP.honestIds[i];
          var entry = (s.nodes || []).find(function (n) { return n.notisId === id; });
          if (entry) honestEntries.push({ notisId: id, status: entry.status });
        }
        var allHonestInRange = honestEntries.length === window.__s8NP.honestIds.length
          && honestEntries.every(function (e) { return e.status === 'ok' || e.status === 'trailing' || e.status === 'behind'; });
        if (window.__s8NP.base === null && s.checks >= 1 && allHonestInRange) {
          window.__s8NP.base = { checks: s.checks, proofReads: s.traffic.proofReads };
          return;
        }
        if (window.__s8NP.base !== null && window.__s8NP.final === null && s.checks >= window.__s8NP.base.checks + 5) {
          window.__s8NP.final = {
            checks: s.checks,
            proofReads: s.traffic.proofReads,
            honestNodeStatuses: honestEntries,
          };
        }
      } catch (_e) { /* ignore */ }
    }, 200);
  }
  return JSON.stringify(window.__s8NP);
})()`;
}

export const S8_NOPROOFS_PREDICATE = `if (v === null) return false;
  try { return JSON.parse(v).final !== null; } catch (_e) { return false; }`;

// MESH_INTERFACE → Acceptance 8 — step 3 reads one check cycle in
// which `traffic.proofReads` rose by exactly two — the lagging
// node's proof plus the client's own tip proof. `laggingId` is
// substituted by the scenario.
export function buildS8ForkExpression(laggingId) {
  const idJson = JSON.stringify(laggingId);
  return `(function(){
  if (!window.__s8FInit) {
    window.__s8FInit = true;
    window.__s8F = { base: null, final: null, laggingId: ${idJson} };
    setInterval(function () {
      try {
        var el = document.getElementById('state');
        if (el === null) return;
        var s = JSON.parse(el.textContent);
        if (!s || typeof s.checks !== 'number' || !s.traffic) return;
        var lag = (s.nodes || []).find(function (n) { return n.notisId === window.__s8F.laggingId; });
        if (!lag || lag.status === 'new') return;
        if (window.__s8F.final !== null) return;
        if (window.__s8F.base === null) {
          window.__s8F.base = { checks: s.checks, proofReads: s.traffic.proofReads };
          return;
        }
        if (s.checks > window.__s8F.base.checks) {
          var delta = s.traffic.proofReads - window.__s8F.base.proofReads;
          if (delta === 2 && lag.status === 'behind') {
            window.__s8F.final = {
              laggingStatus: lag.status,
              laggingBehindBy: lag.behindBy,
              clientTipHash: s.tip ? s.tip.hash : null,
              clientTipHeight: s.tip ? s.tip.height : null,
              proofReadsDeltaAtCheck: delta,
            };
          } else {
            window.__s8F.base = { checks: s.checks, proofReads: s.traffic.proofReads };
          }
        }
      } catch (_e) { /* ignore */ }
    }, 500);
  }
  return JSON.stringify(window.__s8F);
})()`;
}

export const S8_FORK_PREDICATE = `if (v === null) return false;
  try { return JSON.parse(v).final !== null; } catch (_e) { return false; }`;

// MESH_INTERFACE → Acceptance 8 — step 4 keeps one page open across
// the gap window via a non-blocking spawn: the scenario applies the
// firewall, waits for pub1's node to be three blocks ahead, removes
// it, and the tracker signals ready when the client's tip has grown
// by three past its own captured baseline.
export const S8_GAP_EXPR = `(function(){
  if (!window.__s8GAPInit) {
    window.__s8GAPInit = true;
    window.__s8GAP = { base: null, final: null };
    setInterval(function () {
      try {
        var el = document.getElementById('state');
        if (el === null) return;
        var s = JSON.parse(el.textContent);
        if (!s || typeof s.checks !== 'number' || typeof (s.tip && s.tip.height) !== 'number') return;
        if (window.__s8GAP.base === null && s.checks >= 1) {
          window.__s8GAP.base = {
            tipHeight: s.tip.height,
            proofReads: s.traffic.proofReads,
            atMs: Date.now(),
          };
          return;
        }
        if (window.__s8GAP.base === null) return;
        if (window.__s8GAP.final !== null) return;
        if (s.tip.height >= window.__s8GAP.base.tipHeight + 3) {
          window.__s8GAP.final = {
            tipHeight: s.tip.height,
            proofReads: s.traffic.proofReads,
            atMs: Date.now(),
          };
        }
      } catch (_e) { /* ignore */ }
    }, 200);
  }
  return JSON.stringify(window.__s8GAP);
})()`;

export const S8_GAP_PREDICATE = `if (v === null) return false;
  try { return JSON.parse(v).final !== null; } catch (_e) { return false; }`;

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
  if (identities === null) {
    throw new Error('s8: identities.json missing; stage:up did not run');
  }
  const baseConfig = JSON.parse(readFileSync(defaultPath, 'utf8'));
  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const pub1Port = ctx.topology.hosts.pub1?.node?.httpPort;
  if (typeof pub1Port !== 'number') {
    throw new Error('s8: topology has no pub1.node.httpPort');
  }

  // MESH_INTERFACE → Acceptance 6 → "A mesh node publishing a block
  // that fails its checks is blacklisted with its evidence". The
  // honest hosts set for step 1: every host with role `public` or
  // `private` AND a `mesh` config, excluding hostile hosts. These
  // are the nodes a stage-default client will have in its node list.
  const honestHosts = [];
  for (const [host, hostConfig] of Object.entries(ctx.topology.hosts)) {
    if (hostConfig?.role !== 'public' && hostConfig?.role !== 'private') continue;
    if (hostConfig?.mesh === undefined) continue;
    honestHosts.push(host);
  }
  const honestIds = honestHosts.map((h) => identities[h]?.notisId).filter((id) => typeof id === 'string');

  let gapFirewallApplied = false;
  const gapArgs = s8GapFirewallArgs(ctx.topology);

  try {
    // --- Step 1: no proof after the first ---
    await rec.step(describe()[0], async () => {
      writeStageDefault(ctx.outDir);
      if (honestIds.length === 0) {
        const m = { reason: 's8 step 1: no honest hosts in topology with mesh and identity' };
        return { verdict: verdictS8NoProofs(m), measurement: m };
      }
      const expression = buildS8NoProofsExpression(honestIds);
      const value = await cdpPoll(ctx, browserUrl, expression, S8_NOPROOFS_PREDICATE, LONG_WAIT_MS, POLL_MS);
      const r = JSON.parse(value);
      if (r.base === null || r.final === null) {
        const m = { reason: 's8 step 1: tracker returned without base or final', state: r };
        return { verdict: verdictS8NoProofs(m), measurement: m };
      }
      const m = {
        proofReadsBaseline: r.base.proofReads,
        proofReadsFinal: r.final.proofReads,
        checksBaseline: r.base.checks,
        checksFinal: r.final.checks,
        honestNodeStatuses: r.final.honestNodeStatuses,
      };
      return { verdict: verdictS8NoProofs(m), measurement: m };
    });

    // --- Step 2: a block by gossip ---
    await rec.step(describe()[1], async () => {
      writeStageDefault(ctx.outDir);
      const pub1Before = readPub1Height(ctx, pub1Port);
      const value = await cdpPoll(ctx, browserUrl, S8_GOSSIP_EXPR, S8_GOSSIP_PREDICATE, LONG_WAIT_MS, POLL_MS);
      const hs = JSON.parse(value);
      const pub1After = readPub1Height(ctx, pub1Port);
      // Three deliveries: hs[1..3] vs hs[0..2]. If hs has more than
      // four entries (tracker ran longer than needed), use the first
      // three deliveries past the baseline.
      const deliveries = [];
      for (let i = 1; i < hs.length && deliveries.length < 3; i += 1) {
        deliveries.push({
          height: hs[i].height,
          delayMs: hs[i].atMs - hs[i - 1].atMs,
          checksMoved: hs[i].checks > hs[i - 1].checks,
        });
      }
      const m = { deliveries, pub1HeightBefore: pub1Before, pub1HeightAfter: pub1After };
      return { verdict: verdictS8Gossip(m), measurement: m };
    });

    // --- Step 3: another chain ---
    await rec.step(describe()[2], async () => {
      const laggingHost = 'hostile-lagging';
      const laggingRow = identities[laggingHost];
      const laggingId = laggingRow?.notisId;
      if (typeof laggingId !== 'string') {
        const m = { reason: 's8 step 3: no hostile-lagging identity' };
        return { verdict: verdictS8Fork(m), measurement: m };
      }
      const seeds = buildHostileSeeds(identities, ctx.topology, { peerIdStringOf });
      for (const seed of seeds) {
        if (!Array.isArray(seed.addrs) || seed.addrs.length === 0) {
          throw new Error(`s8 step 3: hostile seed ${seed.notisId} has no addresses`);
        }
      }
      const variant = buildWithHostileSeedsVariant(baseConfig, seeds);
      writeConfigVariant(ctx.outDir, variant);
      const expression = buildS8ForkExpression(laggingId);
      const value = await cdpPoll(ctx, browserUrl, expression, S8_FORK_PREDICATE, LONG_WAIT_MS, POLL_MS);
      const r = JSON.parse(value);
      if (r.final === null) {
        const m = { reason: 's8 step 3: tracker returned with no final record', state: r };
        return { verdict: verdictS8Fork(m), measurement: m };
      }
      const pub1Hash = pub1HashAtHeight(ctx, pub1Port, r.final.clientTipHeight);
      const m = {
        laggingStatus: r.final.laggingStatus,
        laggingBehindBy: r.final.laggingBehindBy,
        clientTipHash: r.final.clientTipHash,
        clientTipHeight: r.final.clientTipHeight,
        pub1BlockHashAtClientHeight: pub1Hash,
        proofReadsDeltaAtCheck: r.final.proofReadsDeltaAtCheck,
      };
      return { verdict: verdictS8Fork(m), measurement: m };
    });

    // --- Step 4: a gap filled by headers ---
    await rec.step(describe()[3], async () => {
      writeStageDefault(ctx.outDir);
      // Spawn cdp.mjs poll non-blocking: the stage's execIn uses
      // execFileSync, so a plain cdpPoll would freeze the main event
      // loop and block the firewall apply/remove calls. A spawn lets
      // the tracker page stay open while the scenario does its
      // synchronous nft work.
      const tracker = spawnCdpPoll(ctx, browserUrl, S8_GAP_EXPR, S8_GAP_PREDICATE, LONG_WAIT_MS, POLL_MS);
      try {
        // Give the page time to load and the tracker time to capture
        // its baseline (first check landing). The baseline settles
        // after ~5-15 s on the stage; wait a conservative 20 s before
        // reading pub1 and applying the firewall.
        await sleep(20_000);
        const pubAtFirewall = readPub1Height(ctx, pub1Port);
        // Apply the firewall (log.apply records removal argvs for the
        // scenario's `finally`, so a step throw after this still
        // undoes it).
        log.apply('browser-gap-add-table', gapArgs.addTable, gapArgs.deleteTable);
        gapFirewallApplied = true;
        log.apply('browser-gap-add-chain', gapArgs.addChain, null);
        for (const { name, argv } of gapArgs.drops) {
          log.apply(`browser-gap-drop-${name}`, argv, null);
        }
        // Wait until pub1's node is three blocks past the browser's
        // tip at the moment the firewall landed (a 2-minute deadline).
        const gapDeadline = Date.now() + 120_000;
        let pubAtRemoval = pubAtFirewall;
        while (Date.now() < gapDeadline) {
          const h = readPub1Height(ctx, pub1Port);
          if (h !== null && h >= pubAtFirewall + 3) {
            pubAtRemoval = h;
            break;
          }
          await sleep(1_000);
        }
        if (pubAtRemoval < pubAtFirewall + 3) {
          throw new Error(`s8 step 4: pub1 did not advance 3 blocks within 120 s (${pubAtFirewall} → ${pubAtRemoval})`);
        }
        // Remove the firewall; the client's retry cadence reconnects
        // to the mesh and fills by headers.
        log.remove('browser-gap-add-table');
        gapFirewallApplied = false;
        // Wait for the tracker to signal catch-up (tip grew by ≥ 3
        // past its own baseline), capped at 3 minutes.
        const value = await tracker.promise;
        const r = JSON.parse(value);
        if (r.base === null || r.final === null) {
          const m = { reason: 's8 step 4: tracker returned without base or final', state: r };
          return { verdict: verdictS8Gap(m), measurement: m };
        }
        const pub1HeightFinal = readPub1Height(ctx, pub1Port);
        const m = {
          proofReadsBefore: r.base.proofReads,
          proofReadsAfter: r.final.proofReads,
          tipHeightBefore: r.base.tipHeight,
          tipHeightFinal: r.final.tipHeight,
          pub1HeightFinal,
          pubAtFirewall,
          pubAtRemoval,
        };
        return { verdict: verdictS8Gap(m), measurement: m };
      } finally {
        try { tracker.kill(); } catch { /* already exited */ }
      }
    });
  } finally {
    if (gapFirewallApplied) {
      try {
        execIn('notismesh-browser', ['nft', 'delete', 'table', 'ip', GAP_TABLE], { timeoutMs: 10_000 });
      } catch (err) {
        process.stderr.write(`[s8 teardown] delete ${GAP_TABLE}: ${err?.message ?? err}\n`);
      }
    }
    try { writeStageDefault(ctx.outDir); }
    catch (err) { process.stderr.write(`[s8 teardown] writeStageDefault: ${err?.message ?? err}\n`); }
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read pub1's `/blocks/current.height` from inside its namespace.
 * Returns `null` if the read fails (pub1 unreachable, parse error).
 */
function readPub1Height(ctx, pub1Port) {
  try {
    const body = execIn(
      'notismesh-pub1',
      ['curl', '-sf', '--max-time', '5', `http://127.0.0.1:${pub1Port}/blocks/current`],
      { user: ctx.invokingUser, timeoutMs: 8_000 },
    );
    const data = JSON.parse(body.toString('utf8'));
    return typeof data.height === 'number' ? data.height : null;
  } catch {
    return null;
  }
}

/**
 * Read pub1's block hash at a specific height from inside its
 * namespace. `/blocks/<height>` returns a block whose own hash is not
 * listed; the hash is read as the parent-hash of block `<height+1>`
 * (`header.prevBlockHash`). A height equal to pub1's current tip is
 * read through `/blocks/current.hash`. A read that fails returns
 * `null` so the verdict reads FAIL on mismatch rather than throwing.
 */
function pub1HashAtHeight(ctx, pub1Port, height) {
  if (typeof height !== 'number' || height <= 0) return null;
  // Prefer the next block's prevBlockHash — this works regardless of
  // whether pub1 has advanced past `height`.
  try {
    const body = execIn(
      'notismesh-pub1',
      ['curl', '-sf', '--max-time', '5', `http://127.0.0.1:${pub1Port}/blocks/${height + 1}`],
      { user: ctx.invokingUser, timeoutMs: 8_000 },
    );
    const data = JSON.parse(body.toString('utf8'));
    const h = data?.header?.prevBlockHash;
    if (typeof h === 'string') return h;
  } catch { /* pub1 doesn't have height+1 yet */ }
  // Fallback: pub1's current tip is at `height` exactly.
  try {
    const body = execIn(
      'notismesh-pub1',
      ['curl', '-sf', '--max-time', '5', `http://127.0.0.1:${pub1Port}/blocks/current`],
      { user: ctx.invokingUser, timeoutMs: 8_000 },
    );
    const data = JSON.parse(body.toString('utf8'));
    if (typeof data.height === 'number' && data.height === height && typeof data.hash === 'string') {
      return data.hash;
    }
  } catch { /* fall through */ }
  return null;
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
 * Spawn `cdp.mjs poll` non-blocking: the main process can run
 * synchronous `execIn` calls (firewall apply/remove, pub1 reads)
 * while the browser's page stays open and the tracker observes the
 * client's state across the gap window.
 *
 * Returns `{ promise, kill }`: `promise` resolves to the matching
 * JSON value when cdp.mjs exits 0; `kill` sends SIGTERM to end the
 * subprocess early (used in `finally` to end the tracker when the
 * step throws before the predicate fires).
 */
function spawnCdpPoll(ctx, url, expression, predicateBody, timeoutMs, pollMs) {
  const outerArgv = [
    'ip', 'netns', 'exec', 'notismesh-browser', 'sudo', '-u', ctx.invokingUser, '--',
    ctx.nodeBin, ctx.cdpScript, 'poll', url, expression, predicateBody,
    String(timeoutMs), String(pollMs),
  ];
  const child = nodeSpawn('sudo', outerArgv, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  const errChunks = [];
  child.stdout.on('data', (b) => chunks.push(b));
  child.stderr.on('data', (b) => errChunks.push(b));
  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        try { resolve(Buffer.concat(chunks).toString('utf8').trim()); }
        catch (err) { reject(err); }
      } else {
        reject(new Error(`cdp.mjs poll exited ${code}: ${Buffer.concat(errChunks).toString('utf8')}`));
      }
    });
  });
  return {
    promise,
    kill() { try { child.kill('SIGTERM'); } catch { /* already gone */ } },
  };
}
