// NET_INTERFACE → The browser entry → "The frame codec is one code with
// its checksum handed in" — BlockCheck is the one copy of the
// ordering-block topic's checks of NET_INTERFACE → Stage 1, its checks in
// their order. The node's own validator calls it; the browser and the mesh
// service share the same code.
//
// The verdict carries the penalty the net validator records for the
// refusal, so the gossip.ts validator reads one field rather than
// classifying by detail string. `lie` is kept from the PoC shape and is
// derived: `true` for ProtocolViolation and Misbehavior, `false` for
// Transient and a refusal that records nothing
// (NET_INTERFACE → Peer Penalty System,
// NET_INTERFACE → Stage 1 → "A refusal that rests on this node's state
// records nothing").
import {
  MAX_ORDERING_BLOCK_BYTES,
  decodeUtxoTxTree,
  protocolVersionAt,
  readOrderingBlockSections,
} from '@dagsocial/types';
import type {
  BlockHeader,
  OrderingBlock,
  ProtocolEra,
  UtxoTxTree,
} from '@dagsocial/types';
import { GOSSIP_SEEN_WINDOW_MS } from './gossip-rules.js';
import { PenaltyKind } from './types.js';

export type BlockVerdict =
  | { result: 'accept'; block: OrderingBlock; hash: string }
  // NET_INTERFACE → Stage 1 → "A fault of this node's is no peer's" —
  // when `fault` is a string, it names this receiver's fault for the
  // operator; the standing `ignore` cases (header held or refused, inside
  // the seen window) carry no fault.
  | { result: 'ignore'; fault?: string }
  | {
      result: 'reject';
      lie: boolean;
      penalty: PenaltyKind | null;
      detail: string;
    };

/**
 * The block-topic subset of NetValidators — the functions BlockCheck calls
 * in NET_INTERFACE → Stage 1's order. Handed in at construction, as
 * @dagsocial/validation's for the Node and the same functions for the
 * browser (both packages are browser-safe — ARCHITECTURE → Package
 * boundaries). `blockHash` is passed in beside them for the same reason.
 */
export interface BlockValidators {
  verifyHeaderFieldDomains: (header: unknown) => { valid: boolean; error?: string };
  verifyProtocolVersion: (declared: number, height: number, schedule: readonly ProtocolEra[]) => boolean;
  verifyOrderingBlockPoW: (header: BlockHeader) => boolean;
  verifyValidatorSignature: (header: BlockHeader, signature: Uint8Array) => boolean;
  verifyOrderingBlockStructure: (block: OrderingBlock) => { valid: boolean; error?: string };
  verifyUtxoTxRoot: (block: OrderingBlock) => boolean;
  /** Returns the block hash hex, or `null` when the header is outside the encodable domain. */
  blockHash: (header: BlockHeader) => string | null;
}

export interface BlockCheckContext {
  // The ProtocolEra table of the network, keyed per header's own height
  // (NET_INTERFACE → Stage 1).
  schedule: readonly ProtocolEra[];
  // The network's PoW floor. A header below is rejected 'misbehavior'
  // (NET_INTERFACE → Consensus parameters net enforces).
  floorBits: number;
  /**
   * The scheduled target in bits for a header whose parent this receiver
   * holds; `null` for one whose parent is not held
   * (NET_INTERFACE → Stage 1 → "A scheduled-target mismatch is refused,
   * never forwarded, and never penalised").
   */
  scheduledTargetBits(header: BlockHeader): number | null;
  /**
   * `'held'` or `'refused'` for a header this receiver knows, `null` for
   * one it does not (NET_INTERFACE → Stage 1 → "A header this node knows
   * is Ignored").
   */
  standing(hash: string, height: number): 'held' | 'refused' | null;
  /** The clock behind the seen-accepted memory. Tests drive it. */
  nowMs(): number;
}

function reject(
  lie: boolean,
  penalty: PenaltyKind | null,
  detail: string,
): BlockVerdict {
  return { result: 'reject', lie, penalty, detail };
}

export class BlockCheck {
  private readonly v: BlockValidators;
  private readonly ctx: BlockCheckContext;
  // NET_INTERFACE → Stage 1 → "A header this node knows is Ignored" — the
  // memory holds an accepted header's hash with its acceptance time;
  // stale entries are pruned at the next Accept so nothing survives past
  // the window.
  private readonly seenAccepted: Map<string, number>;

  constructor(v: BlockValidators, ctx: BlockCheckContext) {
    this.v = v;
    this.ctx = ctx;
    this.seenAccepted = new Map();
  }

  check(raw: Uint8Array): BlockVerdict {
    // NET_INTERFACE → Validation (and untrusted-input safety) →
    // "A peer's bytes are weighed before they are decoded".
    if (raw.length > MAX_ORDERING_BLOCK_BYTES) {
      return reject(
        true,
        PenaltyKind.ProtocolViolation,
        `ordering block ${raw.length} bytes exceeds MAX_ORDERING_BLOCK_BYTES (${MAX_ORDERING_BLOCK_BYTES})`,
      );
    }

    // NET_INTERFACE → Stage 1 → "A header is read before its body".
    let header: BlockHeader;
    let utxoTxTreeBytes: Uint8Array;
    let validatorSignature: Uint8Array;
    try {
      const sections = readOrderingBlockSections(raw);
      header = sections.header;
      utxoTxTreeBytes = sections.utxoTxTreeBytes;
      validatorSignature = sections.validatorSignature;
    } catch (err) {
      return reject(
        true,
        PenaltyKind.ProtocolViolation,
        `malformed ordering block header: ${String(err)}`,
      );
    }

    // NET_INTERFACE → Stage 1 → "A fault of this node's is no peer's" —
    // a context provider's throw is this receiver's own and Ignored.
    try {
      const domains = this.v.verifyHeaderFieldDomains(header);
      if (!domains.valid) {
        return reject(
          true,
          PenaltyKind.Misbehavior,
          domains.error ?? 'invalid ordering block header',
        );
      }
      if (
        !this.v.verifyProtocolVersion(
          header.protocolVersion,
          header.height,
          this.ctx.schedule,
        )
      ) {
        // NET_INTERFACE → Peer Penalty System — a declared version that
        // is not the era at the header's height is Transient.
        const era = protocolVersionAt(this.ctx.schedule, header.height);
        return reject(
          false,
          PenaltyKind.Transient,
          `protocol version ${header.protocolVersion} != era ${era} at height ${header.height}`,
        );
      }
      // NET_INTERFACE → Consensus parameters net enforces.
      if (header.powTargetBits < this.ctx.floorBits) {
        return reject(
          true,
          PenaltyKind.Misbehavior,
          'ordering block below the network floor',
        );
      }
      if (!this.v.verifyOrderingBlockPoW(header)) {
        return reject(
          true,
          PenaltyKind.Misbehavior,
          'ordering block PoW invalid',
        );
      }
      // NET_INTERFACE → Stage 1 →
      // "A scheduled-target mismatch is refused, never forwarded, and
      // never penalised".
      const expected = this.ctx.scheduledTargetBits(header);
      if (expected !== null && header.powTargetBits !== expected) {
        return reject(
          false,
          null,
          `scheduled target mismatch: height=${header.height} bits=${header.powTargetBits} expected=${expected}`,
        );
      }
      // NET_INTERFACE → Stage 1 → "A header this node knows is Ignored".
      const hash = this.v.blockHash(header);
      if (hash === null) {
        // `verifyHeaderFieldDomains` answered valid, so this is this
        // receiver's own invariant violated — Ignored, no penalty.
        return { result: 'ignore', fault: 'blockHash null on a header verifyHeaderFieldDomains accepted' };
      }
      const st = this.ctx.standing(hash, header.height);
      if (st === 'held' || st === 'refused') {
        return { result: 'ignore' };
      }
      const now = this.ctx.nowMs();
      const previous = this.seenAccepted.get(hash);
      if (previous !== undefined && now - previous < GOSSIP_SEEN_WINDOW_MS) {
        return { result: 'ignore' };
      }
      // NET_INTERFACE → Peer Penalty System — an ordering block's
      // validator signature that does not verify is `misbehavior`.
      if (!this.v.verifyValidatorSignature(header, validatorSignature)) {
        return reject(
          true,
          PenaltyKind.Misbehavior,
          'ordering block validator signature invalid',
        );
      }
      // The body — a second decode whose throw is `ProtocolViolation`.
      let utxoTxTree: UtxoTxTree;
      try {
        utxoTxTree = decodeUtxoTxTree(utxoTxTreeBytes);
      } catch (err) {
        return reject(
          true,
          PenaltyKind.ProtocolViolation,
          `malformed ordering block body: ${String(err)}`,
        );
      }
      const block: OrderingBlock = { header, utxoTxTree, validatorSignature };
      const vr = this.v.verifyOrderingBlockStructure(block);
      if (!vr.valid) {
        return reject(
          true,
          PenaltyKind.Misbehavior,
          vr.error ?? 'invalid ordering block',
        );
      }
      // NET_INTERFACE → Stage 1 →
      // "A worked header is forwarded with the body its root commits".
      if (!this.v.verifyUtxoTxRoot(block)) {
        return reject(
          true,
          PenaltyKind.Misbehavior,
          "ordering block body is not the one the header's root commits",
        );
      }
      // Accept — record and prune so the memory keeps nothing past the
      // seen window.
      this.seenAccepted.set(hash, now);
      for (const [k, t] of this.seenAccepted) {
        if (now - t >= GOSSIP_SEEN_WINDOW_MS) this.seenAccepted.delete(k);
      }
      return { result: 'accept', block, hash };
    } catch (err) {
      return { result: 'ignore', fault: `block validator fault (ignored): ${String(err)}` };
    }
  }
}
