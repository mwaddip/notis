import type { UserId } from './identity.js';
import type { TxId } from './utxo.js';

// ---------------------------------------------------------------------------
// Block header — what gets hashed for block ID and PoW
// ---------------------------------------------------------------------------

/**
 * ⛔ **Nine positional fields, and dropping a field RENUMBERS every one after
 * it** (TYPES_INTERFACE → Layout — Block). There are no keys on the wire, so a
 * reader that skips a field but keeps the old offsets decodes `stateRoot` out of
 * `utxoTxRoot`'s bytes and every later field one slot late — a silently wrong
 * `blockHash`, not a decode error. This declaration, the contract's table and
 * `serialization.ts`'s `HEADER` codec move together or not at all.
 */
export interface BlockHeader {
  protocolVersion: number;
  height: number;
  prevBlockHash: string;        // hex(32) — hash of previous header
  utxoTxRoot: string;           // hex(32) — Merkle root over the block body
  stateRoot: string;            // hex(33) — AVL+ digest (zeroed for MVP)
  validatorId: UserId;
  powNonce: number;
  powTargetBits: number;
  createdAt: number;            // unix ms
}

/** 33 zero bytes — placeholder for future AVL+ state root. */
export const EMPTY_STATE_ROOT = '00'.repeat(33);

// ---------------------------------------------------------------------------
// Body sections (independently requestable)
// ---------------------------------------------------------------------------

/**
 * **The block's one committed body** (TYPES_INTERFACE → Ordering block). Posts
 * and prunes are transactions, so they ride `utxoTxIds` with everything else
 * and there is no second section.
 *
 * ⛔ **ONE LEAF CLASS.** `computeUtxoTxRoot` builds its leaves from `utxoTxIds`
 * alone — `leafHash('utxotx', id)`. Every block carries one settlement
 * transaction, riding `utxoTxIds` / `utxoTxs` like any other, and coinbase
 * outputs are **its outputs** (`ARCHITECTURE` → Block architecture;
 * TYPES_INTERFACE → Ordering block). The leaf domain `'coinbase'` is a tracked
 * reservation (TYPES_INTERFACE → Tracked reservations).
 */
export interface UtxoTxTree {
  utxoTxIds: TxId[];            // UTXO transactions — posts, likes, prunes and the settlement included
  utxoTxs: Uint8Array[];        // encoded UtxoTransactions (aligned with utxoTxIds)
}

// ---------------------------------------------------------------------------
// Ordering block (validator-produced)
// ---------------------------------------------------------------------------

export interface OrderingBlock {
  header: BlockHeader;
  utxoTxTree: UtxoTxTree;
  validatorSignature: Uint8Array;  // 64 bytes — Ed25519 over header hash
}
