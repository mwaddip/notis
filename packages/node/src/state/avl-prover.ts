import { BatchAVLProver, PersistentBatchAVLProver } from '@ergots/avltree';
import { SqliteAvlStorage } from './avl-storage.js';
import { RecentRoots } from './recent-roots.js';
import { getDb, isCurrentDb } from '../store/db.js';
import { config } from '../config.js';
import { DivergedStateTreeError } from '../services/corrupt-state.js';
import type { AnyBox, IdentityRecord, NetworkRecord, UserId } from '@dagsocial/types';
import { bytesToHex } from '@dagsocial/types';
import { seedTreeWrites } from '@dagsocial/consensus';
import type { TreeWrite } from '@dagsocial/consensus';

/** Sentinel key for block height metadata in additionalData. */
export const HEIGHT_SENTINEL = new Uint8Array(32); // all zeros

/** Encode a block height as 4-byte big-endian uint32. */
export function encodeHeight(h: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, h, false);
  return buf;
}

let persistentProver: PersistentBatchAVLProver | null = null;
let storage: SqliteAvlStorage | null = null;
/**
 * The global database the singleton was built over. The singleton is that
 * database's prover and no other's: a database closed and opened again is
 * another store, holding its own tree, with no prover until one is created.
 */
let singletonDb: import('better-sqlite3').Database | null = null;

/** The singleton, while the database it was built over is the open one. */
function singleton(): AvlProverHandle | null {
  if (!persistentProver || !storage || !singletonDb || !recentRoots || !isCurrentDb(singletonDb)) return null;
  return { prover: persistentProver, storage, recentRoots };
}

export interface AvlProverHandle {
  prover: PersistentBatchAVLProver;
  storage: SqliteAvlStorage;
  /**
   * The last blocks' roots this node keeps in memory (NODE_INTERFACE → "A
   * proof at an older height restores a kept root"). The ring and the
   * handle live for the same lifetime — the open database's.
   */
  recentRoots: RecentRoots;
}

let recentRoots: RecentRoots | null = null;

/**
 * Create or return the singleton AVL prover.
 * Must be called after initDb().
 *
 * Accepts an optional `db` parameter for testing; when omitted,
 * uses the global database from getDb().
 */
export function createAvlProver(db?: import('better-sqlite3').Database): AvlProverHandle {
  // Singleton only when using the global database (production mode).
  // When an explicit db is passed (testing), always create a fresh prover
  // so callers can get independent provers sharing the same underlying store.
  const live = db ? null : singleton();
  if (live) return live;

  const database = db ?? getDb();
  const keyLength = config.avlKeyLength;
  const valueLengthOpt = null; // variable-length box values

  const newStorage = new SqliteAvlStorage(database, { keyLength, valueLengthOpt });
  const innerProver = new BatchAVLProver(keyLength, valueLengthOpt);

  const newProver = new PersistentBatchAVLProver(innerProver, newStorage, [
    [HEIGHT_SENTINEL, encodeHeight(0)], // initial height, updated on first block
  ]);

  // The ring is per-handle: tests spin up fresh provers over the same store,
  // and a module-level ring would leak between them.
  const newRecentRoots = new RecentRoots(config.proofWindowBlocks);
  // NODE_INTERFACE → "After a restart the node holds its tip's root alone".
  // On a store with a chain, the constructor loaded the prover at the tip; on
  // a fresh store it loaded the empty tree at height 0, which genesis seeding
  // will replace through `bootstrapAvlProver` — the ring is seeded from the
  // version the prover's constructor just resolved to.
  const loadedVersion = newStorage.version();
  if (loadedVersion !== null) {
    const loadedHeight = newStorage.versionHeight(loadedVersion);
    if (loadedHeight !== null && loadedHeight > 0) {
      newRecentRoots.record(loadedHeight, innerProver.root, innerProver.height);
    }
  }

  // Only cache when using the global database
  if (!db) {
    storage = newStorage;
    persistentProver = newProver;
    singletonDb = database;
    recentRoots = newRecentRoots;
  }

  return { prover: newProver, storage: newStorage, recentRoots: newRecentRoots };
}

/**
 * Build a prover's tree from a full set of committed state: the performance of
 * `seedTreeWrites(boxes, records, network)` (CONSENSUS_INTERFACE → The tree
 * writes → "`seedTreeWrites(boxes, records, network)` is genesis") — every write
 * an `Insert`, in the order it answers — then the checkpoint at `height`.
 *
 * ⚠ **Exactly one production caller — `seedGenesisState` — and there must not
 * be a second.** AVL+ tree shape is history-dependent, so a tree rebuilt from a
 * full state set forks against one grown incrementally to the same content
 * (NODE_INTERFACE → AVL+ State Root → "AVL+ tree shape is history-dependent") — which is why **AVL
 * storage must never be wiped independently of the chain**, and why a startup
 * rebuild is not a recovery path.
 *
 * Genesis is not that operation: the tree is empty, so there is no history for a
 * rebuild to lose, and the input is a fixed known set rather than one recovered
 * from SQL. `seedGenesisState` states the distinction in full. Every other
 * caller is test tooling (order-independence, restart-comparison, journal
 * round-trip scaffolding).
 *
 * **`records` and `network` are required, as `seedTreeWrites`' are**: a seed
 * without them is a tree missing the records and a different `stateRoot`. An
 * `Insert` the tree refuses stops the seed (`performTreeWrites`).
 */
export function bootstrapAvlProver(
  handle: AvlProverHandle,
  boxes: readonly AnyBox[],
  height: number,
  records: ReadonlyArray<{ identityId: UserId; record: IdentityRecord }>,
  network: NetworkRecord,
): void {
  const writes = seedTreeWrites(boxes, records, network);
  const other = writes.find((write) => write.tag !== 'Insert');
  if (other !== undefined) {
    throw new Error(`bootstrapAvlProver: seedTreeWrites answered ${other.tag}; a seed is Inserts only`);
  }
  performTreeWrites(handle.prover, height, writes, 'bootstrapAvlProver');
  // The constructor writes the empty tree's version at height 0 on a fresh
  // store; the bootstrap replaces the version at its height — at genesis,
  // that row (NODE_INTERFACE → AVL+ State Root).
  handle.storage.deleteVersionAtHeight(height);
  // Checkpoint at current tip
  handle.prover.generateProofAndUpdateStorage([
    [HEIGHT_SENTINEL, encodeHeight(height)],
  ]);
  // The checkpoint stands — record the kept root (NODE_INTERFACE → "A proof
  // at an older height restores a kept root").
  handle.recentRoots.record(height, handle.prover.prover.root, handle.prover.prover.height);
}

/**
 * Perform tree writes on the prover in the order given and answer the digest
 * they leave — a block's writes are `treeWritesOf`'s, in the order it answers
 * (CONSENSUS_INTERFACE → The tree writes).
 *
 * **The tree is asked, and a refusal stops the node** (NODE_INTERFACE → AVL+
 * State Root → "A box block application SPENDS must already be in the tree, and
 * THE TREE IS ASKED"): a write `performOneOperation` refuses is
 * `DivergedStateTreeError`. The throw is the short-circuit: the first refusal
 * stops the writes, leaving the tree wherever it got to, which is why every
 * caller restores the tree it started from.
 *
 * @param height - the block height the writes belong to, for the diagnostic
 * @param site - the caller, for the diagnostic
 * @returns 33-byte digest (root label || height)
 */
export function performTreeWrites(
  prover: PersistentBatchAVLProver,
  height: number,
  writes: readonly TreeWrite[],
  site: string,
): Uint8Array {
  for (const write of writes) {
    if (!prover.performOneOperation(write).success) {
      throw new DivergedStateTreeError(site, height, write.tag, bytesToHex(write.key));
    }
  }
  return prover.digest();
}

/**
 * Checkpoint the prover state at a block height, once all of the block's
 * operations are performed, and answer the proof the checkpoint makes: every
 * operation since the last proof-cycle boundary, which for a block applied
 * through the recording session is the block's reads, then its writes
 * (NODE_INTERFACE → The block proof).
 */
export function checkpointProver(
  handle: AvlProverHandle,
  height: number,
): Uint8Array {
  const proof = handle.prover.generateProofAndUpdateStorage([
    [HEIGHT_SENTINEL, encodeHeight(height)],
  ]);

  // Prune versions older than the retention window
  const cutoff = height - config.maxProofHistory;
  if (cutoff > 0) {
    handle.storage.pruneVersionsBefore(cutoff);
  }
  return proof;
}

/** Get the singleton prover handle (throws if not initialized). */
export function getAvlProver(): AvlProverHandle {
  const live = singleton();
  if (!live) {
    throw new Error('AVL prover not initialized. Call createAvlProver() first.');
  }
  return live;
}

/** Get the singleton prover handle, or null if not initialized. */
export function tryGetAvlProver(): AvlProverHandle | null {
  return singleton();
}
