// MESH_INTERFACE → Acceptance 8 — "After the first check, no proof is
// read across five checks while every node names a tip on the client's
// chain; a block mined on a node reaches the browser by gossip through
// a mesh service and moves the client's tip before its next check; a
// node on another chain … has its proof read when its tip moves, with
// the client's own, and the client's tip stays the honest chain's; the
// browser's gossip cut for three blocks and restored, its tip catches
// up by headers with no proof read."
//
// Four sub-steps, in order:
//   1. No proof after the first — stage default + a step-scoped
//      firewall from the browser to every hostile host (a `FaultLog`
//      fault, removed in a `finally` inside the step). The firewall
//      keeps "every node names a tip on the client's chain" true: a
//      hostile mesh node discovered through the DHT names a tip of
//      its own and its proof would be read on the first check,
//      moving `proofReads`. The baseline is the first state with the
//      chain settled (`checks >= 1`, `proofReads >= 1`) where every
//      honest node the list HOLDS reads `ok`, `trailing` or `behind`
//      and both anchors are held; the final, five completed checks
//      later, the same rule. `verdictS8NoProofs`: PASS when
//      `proofReads` did not move and every held honest node read
//      `ok`, `trailing` or `behind`.
//   2. A block by gossip — the held-page tracker records
//      `{ height, atMs, checks }` at each client tip change; beside
//      it the scenario reads pub1's `/blocks/current` inside its
//      namespace every 250 ms and records the first `atMs` it sees
//      each height. For three heights pub1 reaches past the tracker's
//      baseline height, `delayMs` = the client's first `atMs` at or
//      above that height − pub1's first `atMs` at it, and
//      `checksMoved` = whether the client's `checks` advanced in
//      that window (comparing the latest clientHist record at or
//      before pub1's atMs with clientHist's record for the delivery).
//      Both clocks are this machine's wall clock (the page's
//      `Date.now()` and Node's). `verdictS8Gossip`: PASS when ≥ 2 of
//      3 reached the client within 5 s with `checks` unchanged.
//   3. Another chain — the hostile-seed variant with `hostile-lagging`
//      and `hostile-malformed` on the pair's own chain from genesis.
//      The step finds a check where the lagging node's tip was the
//      one tip not on the chain by waiting for a check cycle in which
//      `traffic.proofReads` rose by exactly two — the lagging node's
//      proof plus the client's own tip proof, the one shape "one per
//      distinct tip, and the client's own" produces when every other
//      node names the chain's tip. The pair's chain shares no block
//      with the honest one; devnet pins no `genesisId` (TYPES_INTERFACE
//      → `profileFor`), so the lagging node's proof verifies and
//      `compareProofs` answers `incomparable / no-common-ancestor`
//      (NIPOPOW_INTERFACE → compareProofs). `resolveTip` is handed the
//      client's own tip's proof first (MESH_INTERFACE → The client's
//      node list → "A check"), and on an `incomparable` verdict it
//      keeps the proof it already holds — the client's chain stands.
//      `resolveTip` then measures each verified node's tip against the
//      winner's suffix: the lagging tip is not on it, so it reads
//      `behind: null`, and `tipEvent` turns `node.verified &&
//      node.behind === null` into `{ ev: 'behind' }`. The client's tip
//      stays its own — pub1's. `splits` records only on an
//      `incomparable` verdict, so it carries the lagging node's proof
//      paired with the client's. `verdictS8Fork`: PASS when lagging
//      reads `behind`, the client's tip hash equals pub1's node's
//      block hash at that height, and the delta is exactly two.
//   4. A gap filled by headers — stage default plus a step-scoped
//      hostile firewall from the browser to every hostile host
//      (same rule as step 1, a `FaultLog` fault, removed in `finally`).
//      The hostile firewall keeps the gap-fill measurement honest:
//      without it the client's DHT walk reaches each hostile mesh
//      node and its proof is read at a check — one proof read per
//      hostile host, which would mask the fill. Beside the hostile
//      firewall, the gap cut: firewall the browser from every mesh
//      node until pub1's node is three blocks past the client's tip
//      at the moment the cut landed; remove the cut; wait for the
//      tracker to signal a fill followed by one more gossip-paced
//      tip change. The cut is short — gossip moves the tip one
//      block at a time, so the cut ends before any check sees it.
//      The tracker ends at the first one-block tip change AFTER its
//      first jump of three or more (the fill, then gossip extending
//      the tip it reached — the client is at the head), recording
//      `proofReads` and the tip at that one-block-after point; the
//      scenario then reads pub1. `verdictS8Gap`: PASS when
//      `proofReads` did not move, the fill `jump` was three or more,
//      and the tip is within two of pub1's read. The step keeps one
//      page open through a non-blocking spawn of `cdp.mjs poll`; a
//      fresh page's first check reads a proof, which would mask the
//      "no proof" conclusion. The pure `s8GapObserve` carries the
//      state transition; `buildS8GapExpression` inlines it so the
//      live tracker and the Node tests run the same logic.

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
import { publicMeshHosts } from '../lib/topology.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's8';
const POLL_MS = 500;
const LONG_WAIT_MS = 240_000;
// MESH_INTERFACE → Acceptance 8 — steps 1 and 4 poll a page while the
// client's own namespace black-holes every hostile host. A dropped
// packet is no refusal: libp2p waits `PEER_DIAL_MIN_MS` (20 s, from
// `src/protocols.ts`) per hostile dial until the retry back-off takes
// those nodes out of the candidates. A check runs one dial deadline
// per candidate; step 1's five completed checks past settlement, and
// step 4's 20 s warmup, up-to-120 s of pub1 advancement and ~3 min of
// fill signalling, run minutes rather than 30 s. The cap at 600 s is
// the deadline each poll holds under this cost — a floor on the
// step's wait, not a bound on the stage's own pace.
export const BLACK_HOLE_WAIT_MS = 600_000;
const GAP_TABLE = 's8_gap';
const STEP1_HOSTILE_TABLE = 's8_step1_hostile';
const STEP4_HOSTILE_TABLE = 's8_step4_hostile';

export function describe() {
  return [
    'no proof read across five completed checks on the stage default',
    'three new blocks reach the browser by gossip within 5 s each',
    'the lagging fork reads behind, client tip stays on pub1\'s chain, exactly two proofs that check',
    'the browser\'s gossip cut for three blocks and restored: tip catches up by headers, no proof read',
  ];
}

// MESH_INTERFACE → Acceptance 8 — step 1 and step 4 each keep "every
// node names a tip on the client's chain" true by firewalling the
// browser from every hostile host for the step's duration. Without
// the firewall the client's DHT walk reaches each hostile mesh node,
// each of which names a tip of its own (`hostile-lagging` on the
// pair's chain, `hostile-malformed` / `hostile-invalid` with lies,
// the publisher likewise), and the first check reads their proofs —
// moving `proofReads` and breaking "no proof is read across five
// checks" (step 1) or masking the gap's own fill with hostile reads
// (step 4). The firewall is a `FaultLog` fault, applied at step start
// and removed in the step's own `finally`, so the firewall does not
// spill into the next step. `tableName` is each step's own table
// (`s8_step1_hostile`, `s8_step4_hostile`) so one step's remove does
// not drop the other's rules.
function hostileFirewallArgs(topology, tableName) {
  const ns = 'notismesh-browser';
  const hostileHosts = [];
  for (const [host, hostConfig] of Object.entries(topology.hosts)) {
    if (hostConfig?.role !== 'hostile') continue;
    if (typeof hostConfig.addr !== 'string') continue;
    hostileHosts.push({ name: host, addr: hostConfig.addr });
  }
  const addTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', tableName];
  const addChain = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', tableName, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'];
  const drops = hostileHosts.map(({ name, addr }) => ({
    name,
    argv: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', tableName, 'out', 'ip', 'daddr', addr, 'drop'],
  }));
  const deleteTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', tableName];
  return { addTable, addChain, drops, deleteTable };
}

export function s8Step1HostileFirewallArgs(topology) {
  return hostileFirewallArgs(topology, STEP1_HOSTILE_TABLE);
}

export function s8Step4HostileFirewallArgs(topology) {
  return hostileFirewallArgs(topology, STEP4_HOSTILE_TABLE);
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
  const h1 = s8Step1HostileFirewallArgs(topology);
  log.apply('browser-step1-hostile-add-table', h1.addTable, h1.deleteTable);
  log.apply('browser-step1-hostile-add-chain', h1.addChain, null);
  for (const { name, argv } of h1.drops) {
    log.apply(`browser-step1-hostile-drop-${name}`, argv, null);
  }
  // The step-scoped firewalls are removed inside each step's own
  // finally (log.remove('browser-step1-hostile-add-table') and
  // log.remove('browser-step4-hostile-add-table')), but dry-run never
  // runs a step: the scenario-wide removeAll in run() still writes a
  // record for every applied fault, which is what this listing is for.
  const h4 = s8Step4HostileFirewallArgs(topology);
  log.apply('browser-step4-hostile-add-table', h4.addTable, h4.deleteTable);
  log.apply('browser-step4-hostile-add-chain', h4.addChain, null);
  for (const { name, argv } of h4.drops) {
    log.apply(`browser-step4-hostile-drop-${name}`, argv, null);
  }
  const f = s8GapFirewallArgs(topology);
  log.apply('browser-gap-add-table', f.addTable, f.deleteTable);
  log.apply('browser-gap-add-chain', f.addChain, null);
  for (const { name, argv } of f.drops) {
    log.apply(`browser-gap-drop-${name}`, argv, null);
  }
}

// MESH_INTERFACE → Acceptance 8 — step 2 reads `#state` through a page
// kept open across the delivery window: one target observed over three
// new blocks' arrivals, so the client's gossip subscription survives
// between them. The expression installs a page-side setInterval that
// pushes a `{height, atMs, checks}` record whenever `state.tip.height`
// changes; the predicate returns true once four records exist (one
// baseline plus three deliveries). The scenario's own pub1 polling
// (every 250 ms, inside pub1's namespace) carries the pub1 side of the
// delay; `computeDeliveries` matches the two timelines by height.
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

/**
 * Match each client tip change past the baseline with pub1's first
 * record AT OR ABOVE that height. `clientHist` is the tracker's
 * tip-change records (an array of `{height, atMs, checks}`); the
 * baseline is `clientHist[0]`, the first state the tracker captured.
 * `pub1Hist` is the first-seen atMs per height (an array of
 * `{height, atMs}`). Both inputs are held to arrays — a string, a
 * Map or any other shape answers an empty list, so the step's
 * `m.deliveries` reads short of three and the verdict
 * `verdictS8Gossip` FAILs naming the field.
 *
 * One delivery per client tip change past the baseline, capped at
 * three — the earliest three client heights after `baseline.height`.
 * Keying on the client's changes rather than pub1's heights lets a
 * pub1 height the 250 ms poll missed through: the client's own tip
 * change still records a delivery against pub1's next-reached height.
 *
 * `delayMs` = `clientRec.atMs - pub1 first atMs at or above the
 * client's height`. A negative delayMs says gossip beat the poll (the
 * client learnt the height before the poll's next tick); the verdict
 * reads `delayMs <= 5000` so a negative value is a delivery within
 * the bound.
 *
 * `checksMoved` = whether the client's `checks` advanced between
 * pub1's atMs for the delivery and the client's own atMs; compared
 * against the latest clientHist record whose atMs is at or before
 * pub1's atMs. A check that ran mid-window carried the block by
 * proof, not gossip — the verdict refuses it.
 *
 * Pure, Node-safe; drives the step 2 measurement and is testable on
 * simulated histories.
 */
export function computeDeliveries(clientHist, pub1Hist) {
  if (!Array.isArray(clientHist) || clientHist.length === 0) return [];
  if (!Array.isArray(pub1Hist)) return [];
  const baseline = clientHist[0];
  const baselineHeight = baseline?.height;
  if (typeof baselineHeight !== 'number') return [];
  const sortedPub1 = pub1Hist
    .filter((p) => p !== null && typeof p === 'object'
      && typeof p.height === 'number'
      && typeof p.atMs === 'number')
    .sort((a, b) => a.height - b.height);
  const deliveries = [];
  for (let i = 1; i < clientHist.length && deliveries.length < 3; i += 1) {
    const c = clientHist[i];
    if (c === null || typeof c !== 'object') continue;
    if (typeof c.height !== 'number' || c.height <= baselineHeight) continue;
    if (typeof c.atMs !== 'number' || typeof c.checks !== 'number') continue;
    const pubRec = sortedPub1.find((p) => p.height >= c.height);
    if (pubRec === undefined) continue;
    let checksAtPub = typeof baseline.checks === 'number' ? baseline.checks : 0;
    for (const cr of clientHist) {
      if (cr === null || typeof cr !== 'object') continue;
      if (typeof cr.atMs !== 'number' || typeof cr.checks !== 'number') continue;
      if (cr.atMs > pubRec.atMs) break;
      checksAtPub = cr.checks;
    }
    deliveries.push({
      height: c.height,
      delayMs: c.atMs - pubRec.atMs,
      checksMoved: c.checks > checksAtPub,
    });
  }
  return deliveries;
}

/**
 * Parse `cdp.mjs poll`'s stdout as the tracker's inner object. The
 * `poll` command writes `JSON.stringify(result)` where `result` is
 * itself the expression's `JSON.stringify(window.__s8*)` — so the
 * stdout is a JSON string of a JSON string of the tracker's state.
 * One `JSON.parse` unwraps the outer encoding to the inner string; a
 * second parse reads the object. Step 2's inline logic did this with
 * a `typeof outer === 'string' ? JSON.parse(outer) : outer` dance;
 * step 4's inline `JSON.parse(value)` did only one parse and threw
 * `Cannot read properties of undefined (reading 'proofReads')` when
 * the single parse left `r` a string and the step read `r.base`.
 *
 * Returns the parsed object, `null` when the input is not a string
 * or either parse fails. Pure, no DOM, no clock.
 */
export function parseTrackerValue(value) {
  if (typeof value !== 'string') return null;
  let outer;
  try { outer = JSON.parse(value); } catch { return null; }
  if (typeof outer !== 'string') return outer;
  try { return JSON.parse(outer); } catch { return null; }
}

/**
 * The honest mesh hosts the stage-default config can reach — step 1
 * reads each one's status past a settled baseline, and step 4 reads
 * each one's status across a firewall window. The rule from topology:
 *   - role is `public` or `private` (a hostile host carries role
 *     `hostile`, excluded here);
 *   - a `mesh` config is present (a host without one is not a mesh
 *     node);
 *   - the host does not sit on the browser's own network — lan1
 *     shares `parent: natC` with the browser and is in no stage
 *     default config (`MESH_INTERFACE → Discovery → "A node added by
 *     hand"`, s7 joins it), so a tracker that waits for its status
 *     past `new` would never advance.
 */
export function honestMeshHosts(topology) {
  const browserParent = topology?.hosts?.browser?.parent;
  const hosts = [];
  for (const [host, hostConfig] of Object.entries(topology?.hosts ?? {})) {
    if (hostConfig?.role !== 'public' && hostConfig?.role !== 'private') continue;
    if (hostConfig?.mesh === undefined) continue;
    if (typeof browserParent === 'string' && hostConfig.parent === browserParent) continue;
    hosts.push(host);
  }
  return hosts;
}

// MESH_INTERFACE → Acceptance 8 — step 1 reads `#state` across five
// completed checks past a settled baseline. The pure observer below
// captures the baseline — first state with the chain settled
// (`checks >= 1`, `proofReads >= 1`) where every honest node the list
// HOLDS reads `ok`, `trailing` or `behind` AND both anchors are held;
// final records at `base.checks + 5` whatever the statuses are, and
// every honest id's status at that moment — 'absent' when the list
// does not hold it — goes into the measurement so `verdictS8NoProofs`
// names the one that is not on the chain.
// `buildS8NoProofsExpression` inlines the observer with `.toString()`
// so the live tracker and the Node tests run the same transition.
export function s8NoProofsObserve(prev, s, honestIds, anchorIds) {
  if (s === null || typeof s !== 'object') return prev;
  if (typeof s.checks !== 'number') return prev;
  if (s.traffic === null || typeof s.traffic !== 'object') return prev;
  if (typeof s.traffic.proofReads !== 'number') return prev;
  var next = prev === null || typeof prev !== 'object'
    ? { base: null, final: null }
    : { base: prev.base, final: prev.final };
  var nodes = Array.isArray(s.nodes) ? s.nodes : [];
  var heldHonest = [];
  var allHonestStatuses = [];
  for (var i = 0; i < honestIds.length; i += 1) {
    var hid = honestIds[i];
    var he = null;
    for (var j = 0; j < nodes.length; j += 1) {
      if (nodes[j] && nodes[j].notisId === hid) { he = nodes[j]; break; }
    }
    if (he !== null) {
      heldHonest.push({ notisId: hid, status: he.status });
      allHonestStatuses.push({ notisId: hid, status: he.status });
    } else {
      allHonestStatuses.push({ notisId: hid, status: 'absent' });
    }
  }
  var anchorsHeld = 0;
  for (var k = 0; k < anchorIds.length; k += 1) {
    var aid = anchorIds[k];
    for (var m = 0; m < nodes.length; m += 1) {
      if (nodes[m] && nodes[m].notisId === aid) { anchorsHeld += 1; break; }
    }
  }
  var allAnchorsHeld = anchorsHeld === anchorIds.length;
  var allHeldInRange = heldHonest.every(function (e) {
    return e.status === 'ok' || e.status === 'trailing' || e.status === 'behind';
  });
  if (next.base === null
      && s.checks >= 1
      && s.traffic.proofReads >= 1
      && allAnchorsHeld
      && allHeldInRange) {
    next.base = { checks: s.checks, proofReads: s.traffic.proofReads };
    return next;
  }
  if (next.base === null) return next;
  if (next.final !== null) return next;
  if (s.checks >= next.base.checks + 5) {
    next.final = {
      checks: s.checks,
      proofReads: s.traffic.proofReads,
      honestNodeStatuses: allHonestStatuses,
    };
  }
  return next;
}

export function buildS8NoProofsExpression(honestIds, anchorIds) {
  const honestJson = JSON.stringify(honestIds);
  const anchorJson = JSON.stringify(anchorIds);
  const observerSrc = s8NoProofsObserve.toString();
  return `(function(){
  if (!window.__s8NPInit) {
    window.__s8NPInit = true;
    window.__s8NP = { base: null, final: null };
    window.__s8NPHonest = ${honestJson};
    window.__s8NPAnchors = ${anchorJson};
    window.__s8NPObserve = ${observerSrc};
    setInterval(function () {
      try {
        var el = document.getElementById('state');
        if (el === null) return;
        var s = JSON.parse(el.textContent);
        window.__s8NP = window.__s8NPObserve(window.__s8NP, s, window.__s8NPHonest, window.__s8NPAnchors);
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

// MESH_INTERFACE → Acceptance 8 — step 4's tracker captures a baseline
// on the first completed check, then waits for a fill (a tip change
// of three or more blocks at once, since gossip moves the tip one
// block at a time) followed by one more tip change (the client is at
// the head: gossip extends past the fill as pub1 keeps mining).
// `final` is captured at that one-block-after-fill point, so the
// measurement reads `proofReads` and `tipHeight` at the head — not at
// the moment the fill landed, when pub1 is still ahead by the chain's
// own pace. `jump` keeps the fill's size (`verdictS8Gap` reads
// `jump >= 3`); `fillJump` is the intermediate the state carries
// between the fill and the next tip change.
//
// `s8GapObserve` is pure (no DOM, no `window` access; the wall clock
// is `nowMs`, read once per call by the caller) so the Node suite
// drives it with a sequence of simulated `#state` snapshots and
// reads the resulting state's `tipHist` and `final` fields.
// `tipHist` records every tip change past the baseline — height,
// atMs, checks, proofReads — so a run shows the whole sequence,
// including a tip that goes back.
export function s8GapObserve(prev, s, nowMs) {
  if (s === null || typeof s !== 'object') return prev;
  if (typeof s.checks !== 'number') return prev;
  if (s.traffic === null || typeof s.traffic !== 'object') return prev;
  if (typeof s.traffic.proofReads !== 'number') return prev;
  if (s.tip === null || typeof s.tip !== 'object' || typeof s.tip.height !== 'number') return prev;
  if (typeof nowMs !== 'number') return prev;
  var next = prev === null || typeof prev !== 'object'
    ? { base: null, lastTipHeight: null, fillJump: null, tipHist: [], final: null }
    : {
        base: prev.base,
        lastTipHeight: prev.lastTipHeight,
        fillJump: prev.fillJump,
        tipHist: Array.isArray(prev.tipHist) ? prev.tipHist.slice() : [],
        final: prev.final,
      };
  if (next.base === null && s.checks >= 1) {
    next.base = { tipHeight: s.tip.height, proofReads: s.traffic.proofReads };
    next.lastTipHeight = s.tip.height;
    return next;
  }
  if (next.base === null) return next;
  if (next.final !== null) return next;
  if (s.tip.height === next.lastTipHeight) return next;
  var jump = s.tip.height - next.lastTipHeight;
  next.lastTipHeight = s.tip.height;
  next.tipHist.push({
    height: s.tip.height,
    atMs: nowMs,
    checks: s.checks,
    proofReads: s.traffic.proofReads,
  });
  if (next.fillJump === null) {
    // Phase A: waiting for the fill — a tip change of three or more
    // at once names the headers-driven catch-up.
    if (jump >= 3) next.fillJump = jump;
    return next;
  }
  // Phase B: fill reached, waiting for one more tip change — gossip
  // extending the tip past the fill. The client is at the head.
  next.final = { tipHeight: s.tip.height, proofReads: s.traffic.proofReads, jump: next.fillJump };
  return next;
}

export function buildS8GapExpression() {
  const observerSrc = s8GapObserve.toString();
  return `(function(){
  if (!window.__s8GAPInit) {
    window.__s8GAPInit = true;
    window.__s8GAP = { base: null, lastTipHeight: null, fillJump: null, tipHist: [], final: null };
    window.__s8GAPObserve = ${observerSrc};
    setInterval(function () {
      try {
        var el = document.getElementById('state');
        if (el === null) return;
        var s = JSON.parse(el.textContent);
        window.__s8GAP = window.__s8GAPObserve(window.__s8GAP, s, Date.now());
      } catch (_e) { /* ignore */ }
    }, 200);
  }
  return JSON.stringify(window.__s8GAP);
})()`;
}

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

  // The honest set for steps 1 and 4 — the honest mesh hosts the
  // stage-default config can reach, excluding `lan1` (browser's own
  // network) and every hostile host. See `honestMeshHosts` above for
  // the rule. The anchor set is the subset the client's config.json
  // names (every public mesh node) — step 1's baseline requires both
  // anchors to be in the state's node list.
  const honestHosts = honestMeshHosts(ctx.topology);
  const honestIds = honestHosts.map((h) => identities[h]?.notisId).filter((id) => typeof id === 'string');
  const anchorHosts = publicMeshHosts(ctx.topology).map(({ name }) => name);
  const anchorIds = anchorHosts.map((h) => identities[h]?.notisId).filter((id) => typeof id === 'string');

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
      if (anchorIds.length === 0) {
        const m = { reason: 's8 step 1: no public anchors in topology with identity' };
        return { verdict: verdictS8NoProofs(m), measurement: m };
      }
      // MESH_INTERFACE → Acceptance 8 — "every node names a tip on the
      // client's chain". The stage DHT names every hostile mesh node,
      // and each one's first-check proof would move `proofReads`
      // before the baseline settles. Firewall the browser from every
      // hostile host for the step; remove the firewall in this step's
      // own `finally` so step 2's gossip read is not blocked. The
      // delete-table alone removes every drop (nftables cascades on
      // table delete).
      const hostileArgs = s8Step1HostileFirewallArgs(ctx.topology);
      log.apply('browser-step1-hostile-add-table', hostileArgs.addTable, hostileArgs.deleteTable);
      log.apply('browser-step1-hostile-add-chain', hostileArgs.addChain, null);
      for (const { name, argv } of hostileArgs.drops) {
        log.apply(`browser-step1-hostile-drop-${name}`, argv, null);
      }
      try {
        const expression = buildS8NoProofsExpression(honestIds, anchorIds);
        // 600 s cap: a check with black-holed hostile candidates
        // runs one dial deadline per candidate until retry backs
        // them off (`BLACK_HOLE_WAIT_MS` at the top of this file).
        const value = await cdpPoll(ctx, browserUrl, expression, S8_NOPROOFS_PREDICATE, BLACK_HOLE_WAIT_MS, POLL_MS);
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
      } finally {
        log.remove('browser-step1-hostile-add-table');
      }
    });

    // --- Step 2: a block by gossip ---
    await rec.step(describe()[1], async () => {
      writeStageDefault(ctx.outDir);
      // Spawn the tracker non-blocking so the scenario can read pub1
      // beside it; the tracker's `{height, atMs, checks}` records
      // land on the page's wall clock (Date.now()), the pub1 poll's
      // atMs on this process's wall clock — same machine, same clock
      // domain.
      const tracker = spawnCdpPoll(ctx, browserUrl, S8_GOSSIP_EXPR, S8_GOSSIP_PREDICATE, LONG_WAIT_MS, POLL_MS);
      const pub1FirstAtMs = new Map();
      let polling = true;
      try {
        const pub1Poll = (async () => {
          while (polling) {
            const h = readPub1Height(ctx, pub1Port);
            if (typeof h === 'number' && !pub1FirstAtMs.has(h)) {
              pub1FirstAtMs.set(h, Date.now());
            }
            await sleep(250);
          }
        })();
        const value = await tracker.promise;
        polling = false;
        await pub1Poll;
        // cdp.mjs' stdout is `JSON.stringify(result)` where `result`
        // is itself the expression's `JSON.stringify(window.__s8GHs)`
        // — one parse unwraps the stdout to the inner JSON string,
        // a second parses that string to the array of records.
        const outer = JSON.parse(value);
        const clientHist = typeof outer === 'string' ? JSON.parse(outer) : outer;
        const pub1Hist = Array.from(pub1FirstAtMs.entries()).map(([height, atMs]) => ({ height, atMs }));
        if (!Array.isArray(clientHist)) {
          const m = {
            reason: 's8 step 2: clientHist did not parse to an array',
            clientHist: outer,
            pub1Hist,
          };
          return { verdict: verdictS8Gossip(m), measurement: m };
        }
        const deliveries = computeDeliveries(clientHist, pub1Hist);
        const m = { deliveries, clientHist, pub1Hist };
        return { verdict: verdictS8Gossip(m), measurement: m };
      } finally {
        polling = false;
        try { tracker.kill(); } catch { /* already exited */ }
      }
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
      // MESH_INTERFACE → Acceptance 8 — "every node names a tip on
      // the client's chain". Without this firewall the client's DHT
      // walk reaches each hostile mesh node, and a check reads its
      // proof — moving `proofReads` beyond the fill (one per hostile
      // host). Same rule as step 1: a `FaultLog` fault, applied
      // at step start and removed in this step's own `finally`, so
      // it does not spill out. The delete-table alone removes every
      // drop (nftables cascades on table delete).
      const hostileArgs = s8Step4HostileFirewallArgs(ctx.topology);
      log.apply('browser-step4-hostile-add-table', hostileArgs.addTable, hostileArgs.deleteTable);
      log.apply('browser-step4-hostile-add-chain', hostileArgs.addChain, null);
      for (const { name, argv } of hostileArgs.drops) {
        log.apply(`browser-step4-hostile-drop-${name}`, argv, null);
      }
      // Spawn cdp.mjs poll non-blocking: the stage's execIn uses
      // execFileSync, so a plain cdpPoll would freeze the main event
      // loop and block the firewall apply/remove calls. A spawn lets
      // the tracker page stay open while the scenario does its
      // synchronous nft work.
      // 600 s cap: a check with black-holed hostile candidates runs
      // one dial deadline per candidate until retry backs them off
      // (`BLACK_HOLE_WAIT_MS` at the top of this file).
      const tracker = spawnCdpPoll(ctx, browserUrl, buildS8GapExpression(), S8_GAP_PREDICATE, BLACK_HOLE_WAIT_MS, POLL_MS);
      try {
        // Give the page time to load and the tracker time to capture
        // its baseline (first check landing). The baseline settles
        // after ~5-15 s on the stage; wait a conservative 20 s before
        // reading pub1 and applying the firewall.
        await sleep(20_000);
        const pubAtFirewall = readPub1Height(ctx, pub1Port);
        // Apply the firewall (log.apply records removal argvs for the
        // scenario's `finally`, so a step throw after this still
        // undoes it). The firewall drops output to every mesh host,
        // so the client's tip stops advancing from here on.
        log.apply('browser-gap-add-table', gapArgs.addTable, gapArgs.deleteTable);
        gapFirewallApplied = true;
        log.apply('browser-gap-add-chain', gapArgs.addChain, null);
        for (const { name, argv } of gapArgs.drops) {
          log.apply(`browser-gap-drop-${name}`, argv, null);
        }
        // Wait until pub1 has advanced three blocks past its own
        // tip at firewall moment — pub1 ≥ pubAtFirewall + 3. Blocks
        // propagate from pub1 fast, so the client's tip at the firewall
        // moment is at or within one block of `pubAtFirewall`; a pub1
        // that advances three past itself is at least three past the
        // client's tip, the fill the tracker is waiting for. A 2-minute
        // deadline is far longer than the chain's own ~5 s to move
        // three blocks on this stage.
        const gapDeadline = Date.now() + 120_000;
        let pubAtRemoval = pubAtFirewall;
        while (Date.now() < gapDeadline) {
          const h = readPub1Height(ctx, pub1Port);
          if (h !== null && pubAtFirewall !== null && h >= pubAtFirewall + 3) {
            pubAtRemoval = h;
            break;
          }
          await sleep(1_000);
        }
        if (pubAtFirewall === null
            || pubAtRemoval === null
            || pubAtRemoval < pubAtFirewall + 3) {
          throw new Error(`s8 step 4: pub1 did not advance 3 blocks within 120 s (${pubAtFirewall} → ${pubAtRemoval})`);
        }
        // Remove the firewall; the client's retry cadence reconnects
        // to the mesh and fills by headers.
        log.remove('browser-gap-add-table');
        gapFirewallApplied = false;
        // Wait for the tracker to signal a fill (a tip change of ≥ 3
        // at once past its baseline), capped at 3 minutes.
        const value = await tracker.promise;
        const r = parseTrackerValue(value);
        if (r === null) {
          const m = { reason: 's8 step 4: tracker returned a value that did not parse', value };
          return { verdict: verdictS8Gap(m), measurement: m };
        }
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
          jump: r.final.jump,
          pub1HeightFinal,
          pubAtFirewall,
          pubAtRemoval,
          tipHist: Array.isArray(r.tipHist) ? r.tipHist : [],
        };
        return { verdict: verdictS8Gap(m), measurement: m };
      } finally {
        try { tracker.kill(); } catch { /* already exited */ }
        // Step-scoped: the step-4 hostile firewall does not spill
        // into any later work; the outer `finally`'s `log.removeAll`
        // is a backstop if this call throws.
        log.remove('browser-step4-hostile-add-table');
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
