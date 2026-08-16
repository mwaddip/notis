import { getDb } from '../store/db.js';
import {
  ensureSystemKarmaBox,
  ensureFaucetCreditBox,
  ensureGenesisProofBox,
  ensureEmissionBox,
} from '../store/system.js';
import { emissionTotal } from './block-creator.js';
import { getAllIdentityRecords, identityRecordKey } from '../store/identity-records.js';
import { getCurrentHeight } from '../store/ordering.js';
import { getUnspentBoxes } from '../store/utxo.js';
import { bootstrapAvlProver, getAvlProver } from '../state/avl-prover.js';
import type { RecordPut } from '../state/avl-prover.js';
import { config, isFaucetNetwork } from '../config.js';
import { hexToBuf } from '@dagsocial/types';
import type { AnyBox } from '@dagsocial/types';

/**
 * The height the genesis state sits at. **Genesis is state, not a block** —
 * height 1 is the first mined block, and height 0 is the state that exists
 * before any block does.
 *
 * Distinct from the height that reaches a genesis box's *mint provenance*,
 * which `ensureSystemKarmaBox` and its siblings clamp to `>= 1`: a synthetic
 * mint txId commits to a height, and 0 is not one a block ever settles at.
 */
export const GENESIS_HEIGHT = 0;

/** `system_config` key recording that the genesis state has been committed. */
const GENESIS_COMMITTED_KEY = 'genesis_committed';

/**
 * Refuse a genesis state that is not the one this network agreed on.
 *
 * The height-0 root the tree now holds must equal the profile's
 * `genesisStateRoot` (ARCHITECTURE → "What varies per network"). A divergent
 * root is not a local anomaly: it is a chain that forks from every honest peer
 * at height 1, discovered later and somewhere else. Refusal rather than a
 * warning follows `loadConfig`'s precedent for a below-floor ordering target —
 * silently proceeding runs against a parameter nobody configured.
 *
 * **This is a seeding postcondition, not a boot invariant, and the difference
 * is not stylistic.** `seedGenesisState` is keyed on the committed flag, so a
 * node that has ever applied a block does not re-seed and its prover holds the
 * root of whatever height it stopped at, which is not this one. A boot-time
 * comparison against the genesis pin therefore fails on every node with a
 * chain, and the only place the comparison means anything is the path that
 * just built the state it is checking. `test/services/genesis-state.test.ts`
 * pins that with a mined block rather than leaving it as an argument.
 *
 * Called inside the seeding transaction rather than after it, so a mismatched
 * genesis is never committed: the throw rolls the boxes, the records, the tree
 * rows and the committed flag back together. Asserting after the commit would
 * fail exactly once — the next start would find the flag set, skip seeding, and
 * run on the divergent genesis with nothing left to check it.
 */
export function assertGenesisRoot(): void {
  const digest = getAvlProver().prover.digest();
  const seeded = digest === null ? null : Buffer.from(digest).toString('hex');
  if (seeded !== config.profile.genesisStateRoot) {
    throw new Error(
      `Genesis state root mismatch on network "${config.networkType}": seeded ` +
      `${seeded ?? 'null'}, profile pins ${config.profile.genesisStateRoot}. ` +
      'Refusing to start — this node would fork from every peer at height 1.',
    );
  }
}

/**
 * Whether this store has already committed its genesis state.
 *
 * ⚠ **Only authoritative when read under the seeding transaction's write lock.**
 * Called anywhere else it answers about a moment already past, which is why
 * `seedGenesisState` reads it twice — once outside as a fast path, once inside
 * `BEGIN IMMEDIATE` as the claim it acts on.
 */
export function isGenesisCommitted(): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS present FROM system_config WHERE key = ?')
    .get(GENESIS_COMMITTED_KEY) as { present: number } | undefined;
  return row !== undefined;
}

function markGenesisCommitted(): void {
  getDb()
    .prepare('INSERT INTO system_config (key, value) VALUES (?, ?)')
    .run(GENESIS_COMMITTED_KEY, Buffer.from([1]));
}

/**
 * Seed the genesis state and commit it to the AVL+ tree, in one transaction.
 *
 * ⚠ **This is NOT the superseded rebuild-from-UTXO-set path** (`NODE_INTERFACE`
 * → the SUPERSEDED note on `bootstrapAvlProver`), and the difference is what
 * makes this sound rather than a rediscovery of the unsound one. That note
 * refuses re-inserting *an arbitrary set recovered from SQL into a tree that
 * already had history*: AVL+ shape is history-dependent, the history is exactly
 * what the recovery lost, and the rebuilt tree forks against the grown one. The
 * note carries the measurement behind that.
 *
 * Genesis has no history to lose. The tree is **empty**, the input is a
 * **fixed, known set** — the proof box and the emission box on every network,
 * plus the system karma and faucet credit boxes on the faucet-bearing ones —
 * and the order is
 * specified rather than whatever a set read produced. Every node on a network
 * performs the identical operation on an identical empty tree, so the resulting
 * root is reproducible by construction.
 *
 * **The insertion order is normative and is NOT this function's to choose.**
 * AVL+ shape is order-dependent, so "the genesis set is these boxes" does not
 * determine a root — "these boxes, in this order" does. The order is the
 * canonical prover-feed order already binding on every block (M-12,
 * `NODE_INTERFACE` → "AVL+ State Root"): **all boxes lexicographically by hex
 * box id, then all identity records lexicographically by hex key.**
 * `bootstrapAvlProver` sorts the feed itself, so the order in which the calls
 * below happen to run is deliberately not consensus-visible — genesis and block
 * application share one ordering rule rather than agreeing by coincidence.
 * `test/services/genesis-state.test.ts` pins that by seeding a reversed feed and
 * asserting the same root.
 *
 * Everything is inside one SQLite transaction because it is a multi-table
 * mutation: `utxo_boxes`, `identity_records`, `avl_tree_versions` and
 * `avl_tree_nodes` all move together or none do. A crash between the box rows
 * and the tree rows would otherwise leave a store whose UTXO set the state root
 * does not cover, which no later run can detect — the seeders would find their
 * boxes present and skip.
 *
 * Idempotent on the committed flag, Ergo's shape: cold start is keyed on
 * "has genesis been committed", never on a height.
 *
 * **`BEGIN IMMEDIATE`, and the committed flag is read inside it.** Two processes
 * opening one database file both see an uncommitted flag if either reads it
 * outside the write lock, and both proceed to seed; the loser's bare
 * `INSERT INTO system_config` then fails on the primary key, so a plain
 * concurrency collision surfaces as a constraint trace with nothing in it about
 * genesis. Taking the write lock at `BEGIN` rather than at the first write
 * serialises the two before either decides, and the second one finds the flag
 * set and returns. The read outside the transaction is a fast path only — it
 * keeps every start after the first from taking a write lock — and is not what
 * the seeding decision rests on.
 *
 * **The mint height is `GENESIS_HEIGHT`, not the store's current height.** The
 * refusal above establishes that the store is at height 0, so a passed-in
 * height could only ever be that same 0; the seeders clamp it to the `>= 1`
 * their synthetic mint txIds require. Deriving it here rather than accepting it
 * removes a parameter whose only admissible value the function already knows.
 */
export function seedGenesisState(systemPubKey: Uint8Array): void {
  if (isGenesisCommitted()) return;

  const handle = getAvlProver();

  // A store that holds blocks but has never committed a genesis state cannot be
  // made correct in place, and must not be run.
  //
  // Seeding it is not available: its tree has grown past genesis, and writing a
  // height-0 version into one would make `versionAtOrBeforeHeight` resolve state
  // that never existed. Neither is proceeding. Such a tree lacks the genesis
  // leaves that every node started against this seeder holds, so its state root
  // differs from its network's at every height — `block-apply` answers every
  // inbound block with a root mismatch and every block it mines is rejected
  // elsewhere, while the message names two truncated digests and nothing about
  // genesis.
  //
  // ⚠ **Recording the flag and carrying on is the worst of the three**, which is
  // why this is a refusal and not a warning: the flag is what `seedGenesisState`
  // keys on, so setting it means no later start re-seeds *and* none reaches
  // `assertGenesisRoot`. The one comparison that could name the fault is
  // disabled by the act of skipping it, permanently and on every subsequent run.
  //
  // Refusal follows `loadConfig`'s precedent for a below-floor ordering target
  // (`config.ts` → the ordering-floor assertion): put the verdict where a human
  // is reading it, rather than running against a state nobody configured. The
  // remedy is in the message because the operator has exactly one — the chain
  // and the AVL store share a SQLite file and must be wiped together.
  if (getCurrentHeight() > 0) {
    throw new Error(
      `Store at height ${getCurrentHeight()} has no committed genesis state. Its ` +
      'AVL+ tree is missing the genesis leaves every peer holds, so its state root ' +
      `diverges from network "${config.networkType}" at every height. Refusing to ` +
      'start — delete the database and resync; the chain and the AVL store share one ' +
      'file and must go together.',
    );
  }

  // The prover is not covered by the transaction below, so its pre-seed digest
  // is captured here and restored if anything in the seeding throws.
  //
  // `bootstrapAvlProver` runs a `performOneOperation` per leaf against the
  // module-global prover's **in-memory** tree. SQLite's rollback reaches
  // `utxo_boxes`, `identity_records`, `avl_tree_versions` and `avl_tree_nodes`
  // — every row — and reaches none of that memory. Without this, a refused
  // genesis leaves a prover holding the genesis tree over a store that holds no
  // genesis, which is the one combination no later run can detect: the flag is
  // unset so seeding re-runs, and it re-runs against a tree that is no longer
  // empty. `reorg` and the apply funnel both carry this snapshot; this path is
  // the third that mutates the prover outside a block.
  const preDigest = handle.prover.digest();

  try {
    getDb().transaction(() => {
      // The authoritative read, under the write lock the docblock describes. A
      // second process that raced this far finds the flag set and leaves the
      // store to the one that won.
      if (isGenesisCommitted()) return;

      // Genesis is defined as an operation on an EMPTY store, and the digest
      // pinned in the profile is only reproducible if that holds. Asserting it
      // is what makes every failure below say what is actually wrong.
      //
      // Left unasserted, a pre-existing box does not produce a clear refusal —
      // it produces a wrong one. The `ensure*` helpers each return a *single*
      // representative (`ensureFaucetCreditBox` returns `existing[0]` of a
      // `value DESC` read, so a split credit box hands back the largest), the
      // feed built from those returns is then a strict subset of what the store
      // holds, and `assertGenesisRoot` reports the profile pin — which reads as
      // a bad pin or a wrong network rather than as a store that was never
      // empty. ⚠ **And the rollback restores exactly the state that caused it**,
      // so every subsequent start fails the same way with the same wrong
      // diagnosis, and the node is unbootable with nothing pointing at the
      // cause.
      assertEmptyBeforeGenesis();

      // The faucet-bearing networks alone hold the system karma and faucet credit
      // boxes; the gate is `isFaucetNetwork`, shared with the /faucet mount and
      // the /credits/faucet handler so the three cannot drift (NODE_INTERFACE
      // §Faucet). Mainnet's genesis state is the proof box alone — a faucet there
      // would be a defect.
      if (isFaucetNetwork(config.networkType)) {
        ensureSystemKarmaBox(systemPubKey, GENESIS_HEIGHT);
        ensureFaucetCreditBox(systemPubKey, GENESIS_HEIGHT);
      }

      // Every network, mainnet included — this box IS the network axis. The two
      // boxes above are byte-identical on testnet and devnet (one hardcoded system
      // identity, one pair of values), so their ids and their AVL entries match
      // exactly; and testnet and devnet share mainnet's economics while
      // compressing only its timescale, so the emission box below separates them
      // by value but leaves testnet's identical to mainnet's. The proof box's
      // per-network payload is the only thing separating testnet's genesis root
      // from mainnet's.
      ensureGenesisProofBox(
        new Uint8Array(hexToBuf(config.profile.genesisProofPayload)),
        GENESIS_HEIGHT,
      );

      // Every network too, and for a sharper reason than the proof box's: this
      // is what every block's coinbase is paid out of (TYPES_INTERFACE →
      // EmissionBox). A network seeded without it releases nothing and produces
      // no block at all.
      //
      // `emissionTotal()` rather than a per-profile constant — the box's value
      // and `computeBlockReward` read the same two profile fields, so they
      // cannot disagree about where the schedule ends.
      ensureEmissionBox(emissionTotal(), GENESIS_HEIGHT);

      // ⛔ **No treasury box.** It would hold `0`, and a zero-value box is not
      // created (TYPES_INTERFACE → EmissionBox's rule, which TreasuryBox
      // inherits). The first block whose `split.treasury` is nonzero creates it.

      // **The feed is read back from the store, never assembled from what the
      // seeders returned.** What the state root must cover is the UTXO set, so
      // reading the set is what makes the tree cover it *by construction*
      // rather than by each helper happening to hand back everything it wrote.
      // The two differ in both directions: a helper returns one box where the
      // store may hold several, and `ensureSystemKarmaBox` writes the system
      // identity record only on its create path, so the branch that returns a
      // pre-existing box is exactly the one that cannot promise the record the
      // tree needs. `bootstrapAvlProver` sorts the feed (M-12), so reading in
      // store order is not a second ordering rule.
      const boxes: AnyBox[] = getUnspentBoxes();
      const records: RecordPut[] = getAllIdentityRecords().map((r) => ({
        key: identityRecordKey(r.identityId),
        record: r.record,
      }));

      // Exactly one height-0 version may exist. The `PersistentBatchAVLProver`
      // constructor already wrote the empty tree's, and `version()` resolves ties
      // on height arbitrarily — leaving both would let a restart load the empty
      // tree back over the genesis one.
      handle.storage.deleteVersionAtHeight(GENESIS_HEIGHT);
      bootstrapAvlProver(handle, boxes, GENESIS_HEIGHT, records);

      // The postcondition of the two lines above: the genesis this node just
      // built is the genesis its network pins. Inside the transaction, so a
      // divergent one is refused *and* rolled back rather than committed and
      // then complained about once.
      assertGenesisRoot();

      markGenesisCommitted();
    }).immediate();
  } catch (err) {
    // The rows are already back; put the tree back with them, so the store and
    // the prover fail together rather than the prover surviving the store.
    if (preDigest) handle.prover.rollback(preDigest);
    throw err;
  }
}

/**
 * Genesis seeding requires a store holding nothing yet.
 *
 * Stated as its own precondition rather than left to `assertGenesisRoot` to
 * discover, because the two failures need different messages: a root mismatch
 * says "this is not your network's genesis", which is the right thing to say
 * about a divergent *payload* and the wrong thing to say about a store that had
 * boxes in it before genesis ever ran.
 */
function assertEmptyBeforeGenesis(): void {
  const boxes = getUnspentBoxes().length;
  const records = getAllIdentityRecords().length;
  if (boxes === 0 && records === 0) return;
  throw new Error(
    `Genesis has not been committed, but the store already holds ${boxes} unspent ` +
    `box(es) and ${records} identity record(s). Genesis is the state of an empty ` +
    'store, so this node cannot reproduce the root network ' +
    `"${config.networkType}" pins. Refusing to start — delete the database and ` +
    'resync; the chain and the AVL store share one file and must go together.',
  );
}
