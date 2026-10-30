// MESH_INTERFACE → Acceptance 1 — "No name, no hosted page". The client
// reads a node's API by key from anchors alone; the mesh's answers equal
// the node's direct HTTP answers byte for byte; and the browser host's
// DNS log holds no query (every background query of the browser's own
// goes through Chromium's `--host-resolver-rules` resolver, which
// answers `~NOTFOUND` for every name but `localhost`).
//
// No faults; `applyFaults` is a no-op and `removeFaults` has nothing to
// undo. The scenario writes no config variant: it uses the stage's own
// `stage/out/browser/config.json` as `up` wrote it.

import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS1Node, verdictS1Probe, verdictS1DnsSilent } from '../lib/verdicts.mjs';

export const NAME = 's1';

export function describe() {
  return [
    'nodeId is an anchor within 60 s',
    'probe /blocks/current and /nipopow/proof/24/20 match the node direct',
    'the DNS log holds no line and the nft counter did not move',
  ];
}

/**
 * `applyFaults` for s1 is a no-op; the scenario reads the clean stage
 * as `up` left it. The `log.removeAll()` call in `finally` runs over
 * an empty removals list.
 */
export function applyFaults(_log, _topology) {
  // nothing: scenario 1 reads a clean stage.
}

// STUB — the real exports land in the next commit.
export function hostOfNodeId(_identities, _nodeId) {
  throw new Error('s1.hostOfNodeId: not implemented');
}
export function anchorIdSet(_config) {
  throw new Error('s1.anchorIdSet: not implemented');
}

/**
 * `run(ctx)`: in dry-run, record every step as `skipped` (no
 * measurement). In exec mode (not reached from the dry-run gate), it
 * would open the page via `ctx.cdp.evaluate`, poll `#state` for a
 * non-null `nodeId`, probe each path, and read `stage/out/dns.log`.
 */
export async function run(ctx) {
  const log = new FaultLog({ dryRun: ctx.dryRun, scenario: NAME });
  const started = Date.now();
  const steps = [];
  try {
    applyFaults(log, ctx.topology);
    const stepsSpec = describe();
    for (const name of stepsSpec) {
      steps.push({ name, verdict: 'skipped', measurement: null, timeMs: 0 });
    }
    // Pass measurements through the verdict functions so a reader of a
    // real run can see the pass conditions; in dry-run every verdict is
    // `skipped`.
    void verdictS1Node;
    void verdictS1Probe;
    void verdictS1DnsSilent;
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
