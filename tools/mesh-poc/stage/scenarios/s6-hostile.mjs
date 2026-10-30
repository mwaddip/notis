// MESH_INTERFACE → Acceptance 6 — "Hostile nodes. With every anchor out
// of reach, `anchorReached` is false and the page says so. A node
// answering malformed proofs and one answering failing proofs are
// blacklisted with their evidence; a node serving a valid proof of a
// lighter chain is `behind`."
//
// Two sub-steps:
//   (a) Config variant: pub1 + pub2 as anchors + three hostile seeds.
//       Browser firewalled from both anchor IPs. Expected:
//       `anchorReached === false` and the page's banner reads the
//       contract's words exactly.
//   (b) Anchors reachable, hostile seeds kept. Expected:
//       - hostile-malformed → `blacklisted` with evidence `malformed`
//       - hostile-invalid → `blacklisted` with evidence `proof-invalid`
//       - hostile-lagging → `behind`, never blacklisted

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS6NoAnchor, verdictS6Hostile } from '../lib/verdicts.mjs';
import { execIn, nftApply, pollUntil } from '../lib/measure.mjs';
import { publicMeshHosts } from '../lib/topology.mjs';
import { buildWithHostileSeedsVariant, buildHostileSeeds } from '../lib/config-variants.mjs';
import { peerIdStringOf } from '../lib/config.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's6';
const BLOCK_TABLE = 's6_block';
const NO_ANCHOR_WORDS = 'No anchor reached. Nothing shown here is verified.';

export function describe() {
  return [
    'anchors unreachable: anchorReached is false, page shows the contract words',
    'anchors reachable, hostile seeds kept: malformed and invalid blacklisted; lagging behind, not blacklisted',
  ];
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

  const configPath = join(ctx.outDir, 'browser', 'config.json');
  const configBackupPath = `${configPath}.s6.bak`;
  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  const baseConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;

  const seeds = buildHostileSeeds(identities, ctx.topology, { peerIdStringOf });
  const variant = buildWithHostileSeedsVariant(baseConfig, seeds);
  const seedsByHost = {};
  for (const [host, row] of Object.entries(identities ?? {})) {
    if (ctx.topology.hosts[host]?.role === 'hostile') {
      seedsByHost[host] = row.notisId;
    }
  }

  // Back up + write variant.
  renameSync(configPath, configBackupPath);
  writeFileSync(configPath, JSON.stringify(variant, null, 2));

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
           return s.anchorReached === false && obj.banner === ${JSON.stringify(NO_ANCHOR_WORDS)};
         } catch (_e) { return false; }`,
        120_000, 1000,
      );
      const bannerObj = JSON.parse(bannerText);
      const stateA = JSON.parse(bannerObj.state);
      const m = { anchorReached: stateA.anchorReached, bannerText: bannerObj.banner };
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
  } finally {
    // Teardown: remove any applied nft table, restore config.json.
    for (const { ns, table } of applied.slice().reverse()) {
      removeTable(ns, table);
    }
    if (existsSync(configBackupPath)) {
      if (existsSync(configPath)) {
        try { renameSync(configPath, `${configPath}.s6.leftover`); } catch { /* ignore */ }
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

function runFault(log, name, argv) {
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
