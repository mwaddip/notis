import { getDb } from './db.js';

/**
 * Each applied block's AVL+ proof, by height (NODE_INTERFACE → The block proof):
 * `block_proofs (height INTEGER PRIMARY KEY, proof BLOB NOT NULL)`. Apply puts a
 * block's proof in its own transaction, a revert deletes it with the block, and
 * apply prunes below `tip − PROOF_RETENTION_BLOCKS`, then the oldest while the
 * proofs kept exceed `PROOF_RETENTION_BYTES` — the tighter of the two wins, and
 * the tip's proof is kept whatever either says; `GET /blocks/:height/proof`
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

/**
 * The newest proofs whose total stored length is at most `capBytes`, deleting
 * every older one; the tip — the highest height the table holds — is kept
 * whatever its own length (NODE_INTERFACE → The block proof). A proof's size
 * comes from SQLite's `length()` over the BLOB column, which answers from the
 * record header and never loads the blob's bytes. One `SELECT` sizes every
 * row in one bounded pass — at most `PROOF_RETENTION_BLOCKS` of them, since
 * this always runs after the height-based prune — and one `DELETE` applies
 * the cutoff it finds.
 */
export function pruneBlockProofsByBytes(capBytes: number): void {
  const rows = getDb()
    .prepare('SELECT height, length(proof) AS len FROM block_proofs ORDER BY height DESC')
    .all() as Array<{ height: number; len: number }>;
  if (rows.length === 0) return;

  let total = 0;
  let cutoffHeight = rows[0]!.height;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i > 0 && total + row.len > capBytes) break;
    total += row.len;
    cutoffHeight = row.height;
  }
  getDb().prepare('DELETE FROM block_proofs WHERE height < ?').run(cutoffHeight);
}
