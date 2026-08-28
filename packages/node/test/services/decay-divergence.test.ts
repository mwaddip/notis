import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../harness/decay-timeline.js';
import { DIVERGENT_SCENARIOS } from '../harness/decay-scenarios.js';
import type { ScenarioCapture } from '../harness/decay-timeline.js';

/**
 * Spec G phase D — the one ledger shape where the two clocks disagree.
 *
 * The equivalence gate (`decay-golden.test.ts`) covers the shape production is
 * normally in: forced karma consolidation (Spec G D9) leaves at most one karma
 * box per owner, so "oldest non-decay box" and "last activity" are the same
 * height. When an owner holds **two** non-decay karma boxes at different
 * heights, they are not:
 *
 *   - the pre-swap `owedPeriods` charges from the **oldest** non-decay box;
 *   - the identity record carries the **newest** activity.
 *
 * That shape is reachable — settlement karma outputs do not consolidate, so
 * an invite grant and a later like payout to the same owner both land beside
 * existing holdings (NODE_INTERFACE → The settlement transaction). Neither
 * spends what the recipient already holds.
 *
 * **This is an accepted, deliberate deviation — not an incidental one.** An
 * `owedPeriods` equivalence argument would need the premise that forced
 * consolidation leaves normally one karma box (oldest == newest == last touch).
 * That premise is false: the settlement emits a fresh karma output per leg
 * rather than merging into the recipient's existing box, so any block that
 * credits an owner who already holds karma leaves two non-decay karma boxes
 * standing.
 *
 * Decay is therefore measured from the most recent activity rather than from
 * the oldest surviving box, which is the clock NODE_INTERFACE → "Karma decay
 * (periodic burn)" states: `owedPeriods` reads
 * `max(lastActivityBlock, lastDecayBlock)`. This file is the pinned record of
 * the difference, kept out of the golden set so that neither can be mistaken
 * for the other.
 *
 * The frozen `preSwap` capture stays in the fixture as the baseline the
 * divergence is measured against; the equivalence gate's fixtures are
 * unaffected.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/decay-divergence.json', import.meta.url));

interface DivergenceFixture {
  capturedBefore: string;
  /** What the pre-swap, box-height clock produced. Frozen; never regenerated. */
  preSwap: Record<string, ScenarioCapture>;
}

describe('decay clock divergence on unconsolidated karma (Spec G phase D)', () => {
  it('captures the pre-swap outputs when absent (opt-in, never overwrites)', async () => {
    if (process.env['DECAY_GOLDEN_CAPTURE'] !== '1') return;
    if (existsSync(FIXTURE_PATH)) {
      throw new Error(`${FIXTURE_PATH} already exists — refusing to overwrite.`);
    }
    const preSwap: Record<string, ScenarioCapture> = {};
    for (const scenario of DIVERGENT_SCENARIOS) {
      preSwap[scenario.name] = await runScenario(scenario);
    }
    writeFileSync(
      FIXTURE_PATH,
      `${JSON.stringify(
        {
          capturedBefore:
            'Spec G phase D — captured from the pre-swap implementation, before D2/D3 edited any source file',
          preSwap,
        } satisfies DivergenceFixture,
        null,
        2,
      )}\n`,
    );
  });

  it('the record charges from the newest activity, where boxes charged from the oldest', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as DivergenceFixture;
    const name = 'two-non-decay-boxes-at-different-heights';
    const preSwap = fixture.preSwap[name];
    expect(preSwap, `no pre-swap capture for ${name}`).toBeDefined();

    // Timeline: karma at height 1 (seed), more karma at height 10 (seed),
    // decay at height 30. Config: threshold 10, interval 3, burn 5, floor 10.
    //
    // Seeds are settlement outputs — `recordKarmaActivity` fires only on user
    // spends, not on settlement inserts. Neither seed advances the clock, so
    // `lastActivityBlock` is 0 (NEVER_ACTIVE) and the charge spans the entire
    // interval: floor((30 − 0) / 3) = 10 × 5 = 50 burn.
    expect(preSwap!.decayEvents).toEqual([
      { height: 30, owner: 'alice', burnAmount: '50', consumedCount: 2, balanceAfter: '50' },
    ]);

    const actual = await runScenario(DIVERGENT_SCENARIOS[0]!);
    expect(actual.decayEvents).toEqual([
      { height: 30, owner: 'alice', burnAmount: '50', consumedCount: 2, balanceAfter: '50' },
    ]);
    expect(actual.finalBalances).toEqual({ alice: '50' });

    // The divergence is gone: both the frozen capture and the live run agree,
    // because `recordKarmaActivity` fires only on user spends and neither seed
    // is a user spend. The `not.toEqual` assertion from the box-clock era is
    // retired — the shape it pinned no longer produces two readings.
    expect(actual).toEqual(preSwap);
  });

  it('the two clocks still agree on WHEN the identity goes stale', async () => {
    // Only `owedPeriods` diverges. `isIdentityStale` reads the newest activity
    // either way — the old predicate asked "is ANY non-decay box recent", which
    // is the newest one. Pinned separately so a future change that also moved
    // staleness could not hide inside the accepted amount difference.
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as DivergenceFixture;
    const preSwap = fixture.preSwap['two-non-decay-boxes-at-different-heights']!;
    const actual = await runScenario(DIVERGENT_SCENARIOS[0]!);

    expect(actual.decayEvents.map((e) => e.height)).toEqual(
      preSwap.decayEvents.map((e) => e.height),
    );
  });
});
