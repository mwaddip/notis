import { getDb } from '../store/db.js';
import {
  ensureSystemKarmaBox,
  ensureFaucetCreditBox,
  ensureGenesisProofBox,
} from '../store/system.js';
import { getIdentityRecord, identityRecordKey } from '../store/identity-records.js';
import { getCurrentHeight } from '../store/ordering.js';
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
const GENESIS_HEIGHT = 0;

/** `system_config` key recording that the genesis state has been committed. */
const GENESIS_COMMITTED_KEY = 'genesis_committed';

/** Whether this store has already committed its genesis state. */
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
 * what the recovery lost, and the rebuilt tree forks against the grown one —
 * measured at the time as identical content agreeing on the digest in 6 of 10
 * rounds.
 *
 * Genesis has no history to lose. The tree is **empty**, the input is a
 * **fixed, known set** — the proof box on every network, plus the system karma
 * and faucet credit boxes on the faucet-bearing ones — and the order is
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
 */
export function seedGenesisState(systemPubKey: Uint8Array, currentHeight: number): void {
  if (isGenesisCommitted()) return;

  const handle = getAvlProver();

  getDb().transaction(() => {
    // A store that already holds blocks has a tree grown past genesis. Writing
    // a height-0 version into it would make `versionAtOrBeforeHeight` resolve
    // state that never existed, so record the fact and touch nothing.
    if (getCurrentHeight() > 0) {
      markGenesisCommitted();
      return;
    }

    const boxes: AnyBox[] = [];
    const records: RecordPut[] = [];

    // The faucet-bearing networks alone hold the system karma and faucet credit
    // boxes; the gate is `isFaucetNetwork`, shared with the /faucet mount and
    // the /credits/faucet handler so the three cannot drift (NODE_INTERFACE
    // §Faucet). Mainnet's genesis state is the proof box alone — a faucet there
    // would be a defect.
    if (isFaucetNetwork(config.networkType)) {
      const karma = ensureSystemKarmaBox(systemPubKey, currentHeight);
      boxes.push(karma);
      boxes.push(ensureFaucetCreditBox(systemPubKey, currentHeight));

      // The system identity's decay clock, written by `ensureSystemKarmaBox`
      // because genesis runs outside block application and `insertBox`'s choke
      // point has no open journal to read a settled height from. It is
      // committed state like any box, so it belongs in the same feed — read
      // back rather than reconstructed, so the tree carries the row the store
      // holds and not a second derivation of it.
      const record = getIdentityRecord(karma.owner);
      if (record) {
        records.push({ key: identityRecordKey(karma.owner), record });
      }
    }

    // Every network, mainnet included — this box IS the network axis. The two
    // boxes above are byte-identical on testnet and devnet (one hardcoded system
    // identity, one pair of values), so their ids and their AVL entries match
    // exactly; the proof box's per-network payload is the only thing separating
    // those two genesis roots.
    boxes.push(
      ensureGenesisProofBox(
        new Uint8Array(hexToBuf(config.profile.genesisProofPayload)),
        currentHeight,
      ),
    );

    // Exactly one height-0 version may exist. The `PersistentBatchAVLProver`
    // constructor already wrote the empty tree's, and `version()` resolves ties
    // on height arbitrarily — leaving both would let a restart load the empty
    // tree back over the genesis one.
    handle.storage.deleteVersionAtHeight(GENESIS_HEIGHT);
    bootstrapAvlProver(handle, boxes, GENESIS_HEIGHT, records);

    markGenesisCommitted();
  })();
}
