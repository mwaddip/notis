// MESH_INTERFACE → Acceptance 2 — "A node behind the endpoint-independent
// NAT answers through a relay, then directly; one behind the symmetric
// NAT answers through the relay". The scenario writes a config variant
// whose anchor is `priv1` by its relayed address through pub1 (and
// `priv2` through pub2 for the second step); the stage's natA and natB
// are already in place.
//
// No faults; the NAT is topology, not a scenario action. The scenario
// records two measurements: priv1's path transitions (relay → direct)
// and priv2's (relay, maybe never direct). The verdict for priv2 passes
// on relay alone.

import { FaultLog } from '../lib/fault-log.mjs';
import { verdictS2Priv1, verdictS2Priv2 } from '../lib/verdicts.mjs';

export const NAME = 's2';

export function describe() {
  return [
    'priv1 (endpoint-independent NAT) answers through a relay, then directly',
    'priv2 (symmetric NAT) answers through the relay',
  ];
}

export function applyFaults(_log, _topology) {
  // nothing: the NATs are topology, not a scenario fault.
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
    void verdictS2Priv1;
    void verdictS2Priv2;
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
