import { ByteWriter } from '@dagsocial/wire';
import {
  writeArr,
  writeBool,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeVlqU,
  writeVlqU64OrThrow,
} from './codec.js';
import type { UserId } from './identity.js';
import type { TxId } from './utxo.js';
import type { PruneEntry } from './stump.js';

// ---------------------------------------------------------------------------
// Coinbase output (block reward)
// ---------------------------------------------------------------------------

export interface CoinbaseOutput {
  owner: UserId;              // 32-byte recipient public key
  value: bigint;              // Credits minted (integer base units of 10^-8 credit)
  lockedUntilBlock: number;   // Height at which credits become spendable
  isTreasury: boolean;        // Treasury or miner output
}

/**
 * One coinbase output's positional bytes — `b32(owner)` ‖ `vlqU64(value)` ‖
 * `vlqU(lockedUntilBlock)` ‖ `u8(isTreasury)`.
 *
 * **These bytes are the `'coinbase'` Merkle leaf preimage and the output's wire
 * encoding, and they are the same bytes** (TYPES_INTERFACE → Layout — Merkle
 * leaf preimages). `UtxoTxTree`'s element writer delegates here rather than
 * restating the layout, for the same reason `writePruneEntry` delegates to
 * `serializePruneEntry`: an output's wire form and its committed
 * form must be one statement, because two statements of one layout drift with no
 * compiler signal and a consistent transposition round-trips perfectly — no
 * round-trip test can see it.
 *
 * ⚠ **The `leafHash('coinbase', …)` domain tag stays outside.** This returns the
 * output bytes alone; the caller supplies the tag. That is what makes the wire
 * form and the preimage byte-identical rather than merely parallel.
 *
 * ⚠ **Three of these four rows are where the contract's notation and the field's
 * schema type disagree, and each disagreement points at a different writer.**
 *
 * - `owner` is `UserId` = `Uint8Array`, so `b32` means `writeBytesNOrThrow`, not
 *   the hex writer three of the header's `b32` rows use.
 * - **`value` is `bigint`**, so `vlqU` means `writeVlqU64OrThrow` — the
 *   **throwing** bigint writer, not the total `number` one. The compiler catches
 *   this substitution, which is the only reason it is not the sharpest row here:
 *   `writeVlqU` would have sentinelled every coinbase output in existence.
 * - **`isTreasury` is `boolean`**, so `u8` means `writeBool`, which is total
 *   (`{0,1}` is narrower than a byte, so `0xff` is unreachable from a valid
 *   value and `readBool` refuses it). `writeU8OrThrow` would throw on every
 *   block.
 *
 * ## Domain
 *
 * All four fields have their domain established upstream of this encoder
 * (TYPES_INTERFACE → Totality), in `@dagsocial/validation` —
 * VALIDATION_INTERFACE → `verifyOrderingBlockStructure`.
 *
 * Decode closes the reachable half of each: `readVlqU` throws past
 * `MAX_SAFE_INTEGER`, `readVlqU64` wraps into the u64 domain, `readBool` rejects
 * any byte but `0x00`/`0x01`, and the re-encode compare rejects non-minimal
 * padding. So a peer cannot inject one of these through gossip. What remains is
 * the encode side, which `encodeOrderingBlock`, node's store write and node's
 * `computeUtxoTxRoot` reach without passing a decoder — the last at block
 * *creation* and again at block *apply*.
 *
 * That third reach adds no surface the other two did not already have, in either
 * direction: a gossiped block reaches apply through `decodeOrderingBlock`, which
 * has closed the domain above; a self-produced one carries node's own coinbase
 * construction, which is exactly what `encodeOrderingBlock` already encodes.
 * Neither reach is where the rejection is stated: the upstream domain check
 * above is, and it is what makes this encoder's throw unreachable.
 */
export function coinbaseOutputBytes(o: CoinbaseOutput): Uint8Array {
  const w = new ByteWriter();
  writeBytesNOrThrow(w, o.owner, 32);
  writeVlqU64OrThrow(w, o.value);
  writeVlqU(w, o.lockedUntilBlock);
  writeBool(w, o.isTreasury);
  return w.toBytes();
}

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
 * **The block's one committed body** (TYPES_INTERFACE → OrderingBlock). Posts
 * are transactions, so they ride `utxoTxIds` with everything else and there is no
 * second tree; `pruneEntries` live here because `utxoTxRoot` commits them.
 *
 * ⛔ **Leaf order is NORMATIVE and it is this struct's field order** —
 * `utxoTxIds`, then `pruneEntries`, then `coinbaseOutputs`. `computeUtxoTxRoot`
 * builds its leaves in exactly that sequence; reordering is a consensus change
 * with no compiler signal.
 *
 * What keeps the three kinds apart inside one root is the `leafHash` domain tag —
 * `'utxotx'`, `'prune'`, `'coinbase'`, each NUL-terminated and therefore
 * prefix-free — not their position. The retired `'subblock'` domain is reachable
 * from no leaf here and stays reserved.
 */
export interface UtxoTxTree {
  utxoTxIds: TxId[];            // UTXO transactions — posts and likes included
  utxoTxs: Uint8Array[];        // CBOR-encoded UtxoTransactions (aligned with utxoTxIds)
  pruneEntries: PruneEntry[];   // prune entries committed in this block
  coinbaseOutputs: CoinbaseOutput[];
}

// ---------------------------------------------------------------------------
// Ordering block (validator-produced)
// ---------------------------------------------------------------------------

export interface OrderingBlock {
  header: BlockHeader;
  utxoTxTree: UtxoTxTree;
  validatorSignature: Uint8Array;  // 64 bytes — Ed25519 over header hash
}
