import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import {
  fixtureProvenance,
  labelNonce,
  seedProvenance,
} from '../helpers.js';

/**
 * The decay golden-output harness.
 *
 * Decay is a consensus path (NODE_INTERFACE → Karma decay), so what it needs is
 * a check that the same owners decay at the same heights by the same amounts —
 * a change in any of the three is a fork, never an improvement.
 *
 * This module is that check. It drives a timeline of blocks against the
 * **production** code path — the real store (`insertBox`, `consumeBox`,
 * `getKarmaBoxes`), the real block journal, the real `mintKarma`, and the real
 * `applyKarmaDecay` — and captures burn amounts, balances and heights. The
 * captures are frozen as fixtures, and any edit to the decay path has to
 * reproduce them exactly.
 *
 * **Why the real store and not an in-memory fake.** The behaviour lives in two
 * places at once: `insertBox` records `lastActivityBlock` from the open
 * journal's height, and `decay.ts` reads the record back. A fake store is a
 * reimplementation of the first half, which would leave this harness verifying
 * a mirror rather than the shipped code. Driving SQLite means the height the
 * record gets is the height the journal actually carried.
 *
 * The harness is deliberately blind to *how* the clock is stored: a scenario
 * says "credit this owner at height H" and "run decay at height H", and the
 * capture is burn amounts, balances and heights. Nothing in it names the
 * storage at all, so a scenario stays a valid description across a change of
 * mechanism — which is what lets the fixtures survive one.
 */

// ---------------------------------------------------------------------------
// Scenario description
// ---------------------------------------------------------------------------

export interface DecayCfg {
  staleThresholdBlocks: number;
  decayIntervalBlocks: number;
  decayAmount: bigint;
  karmaMinimum: bigint;
}

/**
 * One thing that happens inside a block, in the order listed.
 *
 * `mint` is the production activity producer: `mintKarma` consumes every
 * existing karma box for the owner and emits one consolidated replacement, so
 * an owner normally holds exactly one. That is the shape the ledger is usually
 * in.
 *
 * `seed` inserts a karma box **without** consolidating — the shape reached when
 * an identity receives karma it did not pay for (invite claim, then a faucet
 * grant: neither transaction spends the recipient's existing karma box). A clock
 * kept on the boxes has to choose between the oldest and the newest here, and
 * the committed record does not, which is why multi-box owners get their own
 * fixture group rather than being folded into the consolidated ones.
 */
export type Step =
  | { at: number; op: 'mint'; owner: string; amount: bigint }
  | { at: number; op: 'seed'; owner: string; amount: bigint; tag: string }
  | { at: number; op: 'decay' };

export interface Scenario {
  name: string;
  cfg: DecayCfg;
  /** Owner labels, in the order the capture reports their balances. */
  owners: string[];
  steps: Step[];
}

// ---------------------------------------------------------------------------
// Capture shape — burn amounts, resulting balances, and the heights decay fired
// ---------------------------------------------------------------------------

export interface DecayEventCapture {
  height: number;
  owner: string;
  /** Decimal string: JSON has no bigint. */
  burnAmount: string;
  /** How many karma boxes the firing consolidated away. */
  consumedCount: number;
  /** The owner's total unspent karma immediately after the firing. */
  balanceAfter: string;
}

export interface ScenarioCapture {
  name: string;
  decayEvents: DecayEventCapture[];
  finalBalances: Record<string, string>;
  finalBoxCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Owner labels → 32-byte identities
// ---------------------------------------------------------------------------

/** Deterministic 32-byte identity for a label. No `Math.random`, no clock. */
export function ownerBytes(label: string): Uint8Array {
  return new Uint8Array(
    createHash('blake2b512').update(`decay-golden:${label}`).digest().subarray(0, 32),
  );
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

/**
 * Load the store/service graph fresh.
 *
 * The store's DB handle and the open-journal slot are module-level singletons,
 * so every scenario resets the registry and re-imports. All modules are pulled
 * after the same reset, which is what keeps them pointing at one DB and one
 * journal.
 */
async function loadModules() {
  vi.resetModules();
  const db = await import('../../src/store/db.js');
  const utxo = await import('../../src/store/utxo.js');
  const journal = await import('../../src/store/journal.js');
  const records = await import('../../src/store/identity-records.js');
  const karma = await import('../../src/services/karma.js');
  const decay = await import('../../src/services/decay.js');
  const provenance = await import('../../src/mint-provenance.js');
  return { db, utxo, journal, records, karma, decay, provenance };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

/**
 * The production decay dependencies, mirroring `block-apply.ts`'s construction
 * (`getKarmaOwners` is the same `SELECT DISTINCT owner` the apply path runs).
 *
 * Kept as one function so the shape the harness injects and the shape block
 * application injects stay visibly the same.
 *
 * `getIdentityRecord`/`putIdentityRecord` are the real store primitives, not
 * stand-ins. A harness-local record map would be a reimplementation of the half
 * `insertBox` owns, and the fixtures would then be checking a mirror.
 */
function decayDeps(m: Modules): Parameters<Modules['decay']['applyKarmaDecay']>[0] {
  return {
    getKarmaBoxes: (owner: Uint8Array) => m.utxo.getKarmaBoxes(owner),
    consumeBox: m.utxo.consumeBox,
    insertBox: m.utxo.insertBox,
    getIdentityRecord: m.records.getIdentityRecord,
    putIdentityRecord: m.records.putIdentityRecord,
    getKarmaOwners: () => {
      const rows = m.db
        .getDb()
        .prepare(
          `SELECT DISTINCT owner FROM utxo_boxes
           WHERE box_type = 'karma' AND spent_at_block IS NULL`,
        )
        .all() as { owner: Buffer }[];
      return rows.map((r) => new Uint8Array(r.owner));
    },
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function totalKarma(m: Modules, owner: Uint8Array): bigint {
  return m.utxo.getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n);
}

/**
 * Run one scenario and capture its outputs.
 *
 * Every block is wrapped in a real `beginBlockJournal(height)` /
 * `finishBlockJournal()` pair, because that is the only place the settled height
 * lives: `insertBox` takes no height argument and a box carries none.
 */
export async function runScenario(scenario: Scenario): Promise<ScenarioCapture> {
  const m = await loadModules();
  m.db.initDb(':memory:');

  const labelOf = new Map<string, string>();
  for (const label of scenario.owners) {
    labelOf.set(Buffer.from(ownerBytes(label)).toString('hex'), label);
  }

  const decayEvents: DecayEventCapture[] = [];

  // Group steps into blocks by height, preserving within-block order. Ordering
  // inside a block is load-bearing: block application runs `applyKarmaDecay`
  // before `processVouchCooldowns`, so a mint can land for an owner decay just
  // fired for, at the same height.
  const heights = [...new Set(scenario.steps.map((s) => s.at))].sort((a, b) => a - b);

  for (const height of heights) {
    m.journal.beginBlockJournal(height);
    try {
      for (const step of scenario.steps.filter((s) => s.at === height)) {
        switch (step.op) {
          case 'mint': {
            const owner = ownerBytes(step.owner);
            m.karma.mintKarma(
              owner,
              step.amount,
              height,
              m.provenance.vouchSettleContext(owner, owner),
            );
            break;
          }
          case 'seed': {
            const owner = ownerBytes(step.owner);
            // A seed step is identified by all four of `at`, `owner`, `amount`
            // and `tag`. The middle two reach `canonicalBoxBytes`; the other two
            // reach the synthetic provenance, so any two distinguishable steps
            // produce distinguishable boxes. Collapsing either onto a constant
            // would make two steps derive one txId and trip
            // `UNIQUE(tx_id, output_index)` at the second insert.
            const box = seedProvenance<KarmaBox>({
              boxType: 'karma',
              value: step.amount,
              owner,
              guard: 'owner_signature',
              proofSource: step.tag,
            }, step.at, labelNonce(step.tag));
            m.utxo.insertBox(box);
            break;
          }
          case 'decay': {
            const entries = m.decay.applyKarmaDecay(decayDeps(m), height, scenario.cfg);
            for (const entry of entries) {
              const ownerHex = Buffer.from(entry.owner).toString('hex');
              decayEvents.push({
                height,
                owner: labelOf.get(ownerHex) ?? `unknown:${ownerHex.slice(0, 8)}`,
                burnAmount: entry.burnAmount.toString(),
                consumedCount: entry.consumedBoxIds.length,
                balanceAfter: totalKarma(m, entry.owner).toString(),
              });
            }
            break;
          }
        }
      }
    } finally {
      m.journal.finishBlockJournal();
    }
  }

  // `getKarmaOwners` returns owners in SQLite's row order, so the journal's
  // per-block entry order is an artifact of insertion. Sort so the fixture pins
  // decay outcomes rather than a storage detail.
  decayEvents.sort((a, b) => a.height - b.height || a.owner.localeCompare(b.owner));

  const finalBalances: Record<string, string> = {};
  const finalBoxCounts: Record<string, number> = {};
  for (const label of scenario.owners) {
    const owner = ownerBytes(label);
    finalBalances[label] = totalKarma(m, owner).toString();
    finalBoxCounts[label] = m.utxo.getKarmaBoxes(owner).length;
  }

  return { name: scenario.name, decayEvents, finalBalances, finalBoxCounts };
}
