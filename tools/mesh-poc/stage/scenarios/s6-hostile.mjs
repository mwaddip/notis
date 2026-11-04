// MESH_INTERFACE → Acceptance 6 — "Hostile nodes. With every anchor out
// of reach, `anchorReached` is false and the page says so. A node
// naming a tip of its own that answers malformed proofs, and one that
// answers failing proofs, are blacklisted with their evidence; a node
// naming the chain's tip is placed there and its proof is never read;
// a node on a lighter chain is `behind`. A mesh node publishing a
// block that fails its checks is blacklisted with its evidence, and
// the client does not forward it."
//
// Three sub-steps:
//   (a) Config variant: pub1 + pub2 as anchors + hostile seeds.
//       Browser firewalled from both anchor IPs. Expected:
//       `anchorReached === false` and the page's banner reads the
//       contract's words exactly.
//   (b) Anchors reachable, hostile seeds kept. Expected:
//       - hostile-malformed → `blacklisted` with evidence `malformed`
//       - hostile-invalid → `blacklisted` with evidence `proof-invalid`
//       - hostile-lagging → `behind`, never blacklisted
//   (c) The gossip publisher: hostile-publisher's bad blocks reach the
//       client, which blacklists it for `gossip-block` and forwards
//       nothing. The honest mesh nodes' logs name only the publisher
//       as the reject source — no line sources the block from the
//       browser's peer id, so `the client forwarded nothing it
//       refused` holds.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS6NoAnchor, verdictS6Hostile, verdictS6Publisher } from '../lib/verdicts.mjs';
import { execIn, nftApply, pollUntil } from '../lib/measure.mjs';
import { publicMeshHosts } from '../lib/topology.mjs';
import { buildWithHostileSeedsVariant, buildHostileSeeds } from '../lib/config-variants.mjs';
import { peerIdStringOf } from '../lib/config.mjs';
import { writeConfigVariant, writeStageDefault } from '../lib/scenario-config.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's6';
const BLOCK_TABLE = 's6_block';
const NO_ANCHOR_WORDS = 'No anchor reached. Nothing shown here is verified.';
// MESH_INTERFACE → Block gossip → "A refused block is evidence as `net`
// weighs it" — the node's journal writes one JSON line per penalty,
// shape { event: peer_penalised, peer_id, kind, detail }
// (JOURNAL_EVENTS → peer_penalised; the handler sits in
// `packages/node/src/index.ts` on `net.onPeerPenalised`, emitted
// through `packages/node/src/journal.ts` `emitPeerPenalised`).
// `BlockCheck` builds every ordering-block refusal detail with the
// phrase `ordering block` in it (`packages/net/src/block-check.ts`'s
// eight reject paths: malformed header, invalid header, below floor,
// PoW invalid, validator signature invalid, malformed body, invalid
// structure, body not committed; a Transient scheduled-target mismatch
// records no penalty). Handshake and tx penalties never carry the
// phrase, so matching on it isolates ordering-block refusals.
const ORDERING_BLOCK_DETAIL_RE = /ordering block/;

export function describe() {
  return [
    'anchors unreachable: anchorReached is false, page shows the contract words',
    'anchors reachable, hostile seeds kept: malformed and invalid blacklisted; lagging behind, not blacklisted',
    'the publisher is blacklisted for gossip-block; the client forwarded nothing',
  ];
}

/**
 * MESH_INTERFACE → Block gossip — read every honest notis-log line
 * carrying a `peer_penalised` event whose detail names an ordering
 * block refusal (`BlockCheck`'s reject paths), and keep those whose
 * source is not the publisher. **A log file that does not exist throws
 * naming the file** — the step measurements rest on these logs, so a
 * missing log is a stage defect, not an empty answer
 * (the retired `stage/out/<host>/mesh:<host>.log` path passed a vacuous
 * empty list on no file). A log line that does not parse as JSON is
 * skipped; a parsed event whose shape is not `peer_penalised` is
 * skipped; a `peer_penalised` whose detail does not match the
 * ordering-block phrase is skipped (handshake and tx refusals land on
 * the same journal with their own detail strings).
 */
export function otherRejectSourcesIn(outDir, honestHosts, publisherPeerIdString) {
  const out = [];
  for (const host of honestHosts) {
    const logPath = join(outDir, host, 'notis.log');
    if (!existsSync(logPath)) {
      throw new Error(`s6: honest notis.log missing — ${logPath}`);
    }
    const body = readFileSync(logPath, 'utf8');
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed[0] !== '{') continue;
      let event;
      try { event = JSON.parse(trimmed); } catch { continue; }
      if (event?.event !== 'peer_penalised') continue;
      if (typeof event.peer_id !== 'string' || event.peer_id === '') continue;
      if (typeof event.detail !== 'string') continue;
      if (!ORDERING_BLOCK_DETAIL_RE.test(event.detail)) continue;
      if (event.peer_id === publisherPeerIdString) continue;
      out.push({ host, peerIdString: event.peer_id });
    }
  }
  return out;
}

export function anchorBlockArgs(topology) {
  const ns = 'notismesh-browser';
  const addTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', BLOCK_TABLE];
  const addChain = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', BLOCK_TABLE, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'];
  const drops = publicMeshHosts(topology).map(({ host }) => [
    'sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', BLOCK_TABLE, 'out', 'ip', 'daddr', host.addr, 'drop',
  ]);
  const deleteTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', BLOCK_TABLE];
  return { addTable, addChain, drops, deleteTable };
}

export function applyFaults(log, topology) {
  const a = anchorBlockArgs(topology);
  log.apply('browser-anchor-block-add-table', a.addTable, a.deleteTable);
  log.apply('browser-anchor-block-add-chain', a.addChain, null);
  for (let i = 0; i < a.drops.length; i += 1) {
    log.apply(`browser-anchor-drop-${i}`, a.drops[i], null);
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

  // MESH_INTERFACE → Acceptance — s6 reads its base from the stage
  // default so a previous scenario's variant does not seep into the
  // seeds list. The variant lands via `writeConfigVariant`; the
  // scenario's `finally` restores the stage default.
  const defaultPath = join(ctx.outDir, 'browser', 'config.default.json');
  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  const baseConfig = JSON.parse(readFileSync(defaultPath, 'utf8'));
  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;

  const seeds = buildHostileSeeds(identities, ctx.topology, { peerIdStringOf });
  // MESH_INTERFACE → Acceptance 6 — a seed with empty addresses dials
  // `NoValidAddressesError` and classifies as a transport failure, so
  // the hostile row never reaches `blacklisted` / `behind`. Fail the
  // scenario's setup loudly rather than measure a vacuous no-op.
  for (const seed of seeds) {
    if (!Array.isArray(seed.addrs) || seed.addrs.length === 0) {
      throw new Error(`s6 setup: hostile seed ${seed.notisId} has no addresses — up.mjs must record every mesh host's printed multiaddrs in identities.json`);
    }
  }
  const variant = buildWithHostileSeedsVariant(baseConfig, seeds);
  const seedsByHost = {};
  for (const [host, row] of Object.entries(identities ?? {})) {
    if (ctx.topology.hosts[host]?.role === 'hostile') {
      seedsByHost[host] = row.notisId;
    }
  }

  // Write the variant fresh — no backup, no rename.
  writeConfigVariant(ctx.outDir, variant);

  // Track applied nft tables for teardown.
  const applied = [];
  const removeTable = (ns, table) => {
    try { nftApply(ns, ['delete', 'table', 'ip', table]); }
    catch (err) { process.stderr.write(`[s6 teardown] delete ${table}: ${err?.message ?? err}\n`); }
  };

  try {
    await rec.step(describe()[0], async () => {
      const a = anchorBlockArgs(ctx.topology);
      runFault(log, 'browser-anchor-block-add-table', a.addTable);
      applied.push({ ns: 'notismesh-browser', table: BLOCK_TABLE });
      runFault(log, 'browser-anchor-block-add-chain', a.addChain);
      for (let i = 0; i < a.drops.length; i += 1) {
        runFault(log, `browser-anchor-drop-${i}`, a.drops[i]);
      }
      // MESH_INTERFACE → Acceptance 6 — with every anchor out of reach,
      // `anchorReached` is false and the page says so. Positive
      // evidence: at least one seed left `new` for `ok`, `behind` or
      // `blacklisted` inside the window. The predicate below holds for
      // the banner + anchorReached=false AND at least one seed
      // classified past `new`.
      const hostileIds = Object.values(seedsByHost).filter((v) => typeof v === 'string');
      const hostileIdsJson = JSON.stringify(hostileIds);
      const bannerText = await cdpPoll(ctx, browserUrl,
        `(function(){
           const banner = document.querySelector('[data-role="banner"]');
           const state = document.getElementById('state');
           if (banner === null || state === null) return null;
           return JSON.stringify({ banner: banner.textContent, state: state.textContent });
         })()`,
        `if (v === null) return false;
         try {
           const obj = JSON.parse(v);
           const s = JSON.parse(obj.state);
           if (s.anchorReached !== false || obj.banner !== ${JSON.stringify(NO_ANCHOR_WORDS)}) return false;
           const hostileIds = ${hostileIdsJson};
           const terminal = ['ok', 'behind', 'blacklisted'];
           return hostileIds.some((id) => {
             const e = s.nodes?.find((n) => n.notisId === id);
             return e !== undefined && terminal.includes(e.status);
           });
         } catch (_e) { return false; }`,
        120_000, 1000,
      );
      const bannerObj = JSON.parse(bannerText);
      const stateA = JSON.parse(bannerObj.state);
      // Find the first seed that answered — positive evidence the page
      // reached nodes, so the "no anchor" verdict is not vacuous.
      const terminal = new Set(['ok', 'behind', 'blacklisted']);
      let answeredSeed = null;
      for (const id of hostileIds) {
        const e = stateA.nodes?.find((n) => n.notisId === id);
        if (e !== undefined && terminal.has(e.status)) {
          answeredSeed = { id, status: e.status };
          break;
        }
      }
      const m = {
        anchorReached: stateA.anchorReached,
        bannerText: bannerObj.banner,
        seedAnswered: answeredSeed !== null,
        seedId: answeredSeed?.id ?? null,
        seedStatus: answeredSeed?.status ?? null,
      };
      return { verdict: verdictS6NoAnchor(m), measurement: m };
    });

    await rec.step(describe()[1], async () => {
      // Remove the s6_block table so anchors reach again.
      removeTable('notismesh-browser', BLOCK_TABLE);
      // Drop the matching entry from `applied` so teardown does not
      // try again.
      const idx = applied.findIndex((e) => e.table === BLOCK_TABLE);
      if (idx >= 0) applied.splice(idx, 1);
      log.records.push(`[fault:remove:${NAME}:browser-anchor-block-add-table] sudo ip netns exec notismesh-browser nft delete table ip ${BLOCK_TABLE}`);
      const malformedId = seedsByHost['hostile-malformed'];
      const invalidId = seedsByHost['hostile-invalid'];
      const laggingId = seedsByHost['hostile-lagging'];
      const stateB = await cdpPoll(ctx, browserUrl,
        "document.getElementById('state')?.textContent ?? null",
        `if (v === null) return false;
         try {
           const s = JSON.parse(v);
           const findEntry = (id) => s.nodes?.find((n) => n.notisId === id);
           const m = findEntry(${JSON.stringify(malformedId)});
           const i = findEntry(${JSON.stringify(invalidId)});
           const l = findEntry(${JSON.stringify(laggingId)});
           if (!m || !i || !l) return false;
           return (m.status === 'blacklisted') && (i.status === 'blacklisted') && (l.status === 'behind' || l.status === 'blacklisted');
         } catch (_e) { return false; }`,
        180_000, 2000,
      );
      const state = JSON.parse(stateB);
      const findEntry = (id) => state.nodes?.find((n) => n.notisId === id) ?? null;
      const mN = findEntry(malformedId);
      const iN = findEntry(invalidId);
      const lN = findEntry(laggingId);
      const m = {
        malformed: mN !== null ? { status: mN.status, evidenceKind: mN.evidence?.kind ?? null } : null,
        invalid: iN !== null ? { status: iN.status, evidenceKind: iN.evidence?.kind ?? null } : null,
        lagging: lN !== null ? { status: lN.status, blacklisted: lN.status === 'blacklisted' } : null,
      };
      return { verdict: verdictS6Hostile(m), measurement: m };
    });

    await rec.step(describe()[2], async () => {
      // MESH_INTERFACE → Acceptance 6 → "A mesh node publishing a
      // block that fails its checks is blacklisted with its evidence,
      // and the client does not forward it." Wait for the publisher's
      // entry to reach `blacklisted` with evidence `gossip-block`
      // (the client's topic validator rejects a bad block from the
      // publisher), then read the honest mesh logs: every reject
      // source they named is the publisher's peer id — the browser
      // forwarded nothing it refused, so no honest mesh ever heard
      // the bad block from the browser.
      const publisherId = seedsByHost['hostile-publisher'];
      if (typeof publisherId !== 'string') {
        const measurement = { reason: 'no hostile-publisher identity in identities.json' };
        return { verdict: verdictS6Publisher(measurement), measurement };
      }
      const publisherPeerIdString = peerIdStringOf(publisherId);
      const stateC = await cdpPoll(ctx, browserUrl,
        "document.getElementById('state')?.textContent ?? null",
        `if (v === null) return false;
         try {
           const s = JSON.parse(v);
           const e = s.nodes?.find((n) => n.notisId === ${JSON.stringify(publisherId)});
           return e !== undefined && e.status === 'blacklisted' && e.evidence?.kind === 'gossip-block';
         } catch (_e) { return false; }`,
        180_000, 2000,
      );
      const state = JSON.parse(stateC);
      const pubEntry = state.nodes?.find((n) => n.notisId === publisherId) ?? null;
      // MESH_INTERFACE → Block gossip → "A refused block is evidence
      // as `net` weighs it" — read the honest mesh logs for the
      // rejection lines each wrote. Honest hosts are every mesh host
      // with role `public` or `private` that is not a hostile host.
      const honestHosts = [];
      for (const [host, hostConfig] of Object.entries(ctx.topology.hosts)) {
        if (hostConfig?.role !== 'public' && hostConfig?.role !== 'private') continue;
        if (hostConfig?.mesh === undefined) continue;
        honestHosts.push(host);
      }
      const otherRejectSources = otherRejectSourcesIn(
        ctx.outDir, honestHosts, publisherPeerIdString,
      );
      const measurement = {
        publisher: pubEntry !== null
          ? { status: pubEntry.status, evidenceKind: pubEntry.evidence?.kind ?? null }
          : null,
        publisherPeerIdString,
        otherRejectSources,
      };
      return { verdict: verdictS6Publisher(measurement), measurement };
    });
  } finally {
    // Teardown: remove any applied nft table, restore the stage
    // default config.json so a later scenario starts clean.
    for (const { ns, table } of applied.slice().reverse()) {
      removeTable(ns, table);
    }
    try { writeStageDefault(ctx.outDir); }
    catch (err) { process.stderr.write(`[s6 teardown] writeStageDefault: ${err?.message ?? err}\n`); }
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
  // `argv` is `[sudo, ip, netns, exec, <ns>, nft, ...sub]`; nftApply
  // prepends `nft`, so we slice(6) to drop the duplicate.
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
