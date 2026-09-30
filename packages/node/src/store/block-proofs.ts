import { getDb } from './db.js';

/**
 * Each applied block's AVL+ proof, by height (NODE_INTERFACE → The block proof):
 * `block_proofs (height INTEGER PRIMARY KEY, proof BLOB NOT NULL)`. Apply puts a
 * block's proof in its own transaction, a revert deletes it with the block, and
 * apply prunes below `tip − PROOF_RETENTION_BLOCKS`; `GET /blocks/:height/proof`
 * reads it.
 */

/** The proof at `height`, replacing one the store holds there, as the journal's write does. */
export function putBlockProof(height: number, proof: Uint8Array): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO block_proofs (height, proof) VALUES (?, ?)')
    .run(height, Buffer.from(proof.buffer, proof.byteOffset, proof.byteLength));
}

/** The proof of the block at `height` as a plain `Uint8Array`, or `null` where the store holds none. */
export function getBlockProof(height: number): Uint8Array | null {
  const row = getDb()
    .prepare('SELECT proof FROM block_proofs WHERE height = ?')
    .get(height) as { proof: Buffer } | undefined;
  return row === undefined ? null : new Uint8Array(row.proof);
}

export function deleteBlockProof(height: number): void {
  getDb().prepare('DELETE FROM block_proofs WHERE height = ?').run(height);
}

/** Every proof below `belowHeight`; a cutoff at or below the lowest height removes none. */
export function pruneBlockProofs(belowHeight: number): void {
  getDb().prepare('DELETE FROM block_proofs WHERE height < ?').run(belowHeight);
}
