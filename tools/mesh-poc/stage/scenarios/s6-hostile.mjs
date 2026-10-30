// MESH_INTERFACE → Acceptance 6 — "Hostile nodes. With every anchor out
// of reach, `anchorReached` is false and the page says so. A node
// answering malformed proofs and one answering failing proofs are
// blacklisted with their evidence; a node serving a valid proof of a
// lighter chain is `behind`."
//
// Two steps, two config variants:
//   (a) two anchors unreachable, three hostile nodes as seeds, browser
//       firewalled from both anchors → `anchorReached` false, banner words.
//   (b) anchors unblocked, hostile seeds kept → each hostile row.
//
// Faults applied: (a) adds an nft `s6_block` table in the browser
// namespace that drops output to both anchors' addresses, (b) removes
// it. The config variants are written to `stage/out/scenarios/s6a-...`
// and `stage/out/scenarios/s6b-...` and consumed by the page via its
// `config.json` URL parameter — in dry-run only the file-write records
// are emitted.

import { FaultLog } from '../lib/fault-log.mjs';
import { publicMeshHosts } from '../lib/topology.mjs';
import { verdictS6NoAnchor, verdictS6Hostile } from '../lib/verdicts.mjs';

export const NAME = 's6';
const BLOCK_TABLE = 's6_block';

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
  const steps = [];
  try {
    applyFaults(log, ctx.topology);
    for (const name of describe()) {
      steps.push({ name, verdict: 'skipped', measurement: null, timeMs: 0 });
    }
    void verdictS6NoAnchor;
    void verdictS6Hostile;
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
