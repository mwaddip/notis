// MESH_INTERFACE → Block gossip → "A block is checked before it is forwarded,
// and never applied" — the ordering-block topic's checks of
// `NET_INTERFACE → Stage 1`, in their order, through the same
// `@dagsocial/types` and `@dagsocial/validation` functions. The verdict's
// `lie` is `true` exactly where `net` records `ProtocolViolation` or
// `Misbehavior` (`NET_INTERFACE → Peer Penalty System`) and `false` for a
// `Transient` reject and a reject that records nothing
// (`NET_INTERFACE → Peer Penalty System → "Refusals that record nothing"`); a
// context provider's throw is `ignore`
// (`NET_INTERFACE → Stage 1 → "A fault of this node's is no peer's"`).

import {
  MAX_ORDERING_BLOCK_BYTES,
  decodeUtxoTxTree,
  readOrderingBlockSections,
} from '@dagsocial/types';
import type {
  BlockHeader,
  NetworkProfile,
  OrderingBlock,
  UtxoTxTree,
} from '@dagsocial/types';
import {
  blockHash,
  verifyHeaderFieldDomains,
  verifyOrderingBlockPoW,
  verifyOrderingBlockStructure,
  verifyProtocolVersion,
  verifyUtxoTxRoot,
  verifyValidatorSignature,
} from '@dagsocial/validation';
import { GOSSIP_SEEN_WINDOW_MS } from './gossip-rules.js';

export type BlockVerdict =
  | { result: 'accept'; block: OrderingBlock; hash: string }
  | { result: 'ignore' }
  | { result: 'reject'; lie: boolean; detail: string };

export interface BlockCheckContext {
  profile: NetworkProfile;
  /**
   * The scheduled target in bits for a header whose parent this receiver
   * holds; `null` for a header whose parent is not held
   * (`NET_INTERFACE → Stage 1`).
   */
  scheduledTargetBits(header: BlockHeader): number | null;
  /**
   * `'held'` or `'refused'` for a header this receiver knows, `null` for
   * one it does not (`NET_INTERFACE → Stage 1 → "A header this node knows
   * is Ignored"`).
   */
  standing(hash: string, height: number): 'held' | 'refused' | null;
  /** The clock the seen-accepted memory reads. Tests drive it. */
  nowMs(): number;
}

export class BlockCheck {
  private readonly ctx: BlockCheckContext;
  // NET_INTERFACE → Stage 1 → "A header this node knows is Ignored" — the
  // memory holds an accepted header's hash with its acceptance time; stale
  // entries are pruned at the next accept so nothing survives past the
  // window.
  private readonly seenAccepted: Map<string, number>;

  constructor(ctx: BlockCheckContext) {
    this.ctx = ctx;
    this.seenAccepted = new Map();
  }

  check(raw: Uint8Array): BlockVerdict {
    // NET_INTERFACE → Validation (and untrusted-input safety) →
    // "A peer's bytes are weighed before they are decoded".
    if (raw.length > MAX_ORDERING_BLOCK_BYTES) {
      return {
        result: 'reject',
        lie: true,
        detail: `ordering block ${raw.length} bytes exceeds MAX_ORDERING_BLOCK_BYTES (${MAX_ORDERING_BLOCK_BYTES})`,
      };
    }

    // NET_INTERFACE → Stage 1 → "A header is read before its body" — the
    // sections read is the one throw ProtocolViolation covers at this
    // boundary; the body section's own decode runs separately below.
    let header: BlockHeader;
    let utxoTxTreeBytes: Uint8Array;
    let validatorSignature: Uint8Array;
    try {
      const sections = readOrderingBlockSections(raw);
      header = sections.header;
      utxoTxTreeBytes = sections.utxoTxTreeBytes;
      validatorSignature = sections.validatorSignature;
    } catch (err) {
      return {
        result: 'reject',
        lie: true,
        detail: `malformed ordering block header: ${String(err)}`,
      };
    }

    // NET_INTERFACE → Stage 1 → "A fault of this node's is no peer's" —
    // everything below is header-only or body-decoded by this function; a
    // throw from a context provider is this receiver's own and is Ignored.
    try {
      const domains = verifyHeaderFieldDomains(header);
      if (!domains.valid) {
        return {
          result: 'reject',
          lie: true,
          detail: domains.error ?? 'invalid ordering block header',
        };
      }
      if (
        !verifyProtocolVersion(
          header.protocolVersion,
          header.height,
          this.ctx.profile.protocolVersionSchedule,
        )
      ) {
        // NET_INTERFACE → Peer Penalty System — a declared version that is
        // not the era at the header's height is a compatibility signal,
        // Transient; this module records it as `lie: false`.
        return {
          result: 'reject',
          lie: false,
          detail: `protocol version ${header.protocolVersion} is not the era at height ${header.height}`,
        };
      }
      // NET_INTERFACE → Consensus parameters net enforces.
      if (header.powTargetBits < this.ctx.profile.orderingBlockPowTargetFloorBits) {
        return {
          result: 'reject',
          lie: true,
          detail: 'ordering block below the network floor',
        };
      }
      if (!verifyOrderingBlockPoW(header)) {
        return {
          result: 'reject',
          lie: true,
          detail: 'ordering block PoW invalid',
        };
      }
      // NET_INTERFACE → Stage 1 →
      // "A scheduled-target mismatch is refused, never forwarded, and never penalised".
      const expected = this.ctx.scheduledTargetBits(header);
      if (expected !== null && header.powTargetBits !== expected) {
        return {
          result: 'reject',
          lie: false,
          detail: `scheduled target mismatch: bits=${header.powTargetBits} expected=${expected}`,
        };
      }
      // NET_INTERFACE → Stage 1 → "A header this node knows is Ignored".
      const hash = blockHash(header);
      if (hash === null) {
        // `verifyHeaderFieldDomains` answered valid, so this is this
        // receiver's own invariant violated — Ignored, no penalty.
        return { result: 'ignore' };
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
      // NET_INTERFACE → Peer Penalty System — an ordering block's validator
      // signature that does not verify is `misbehavior`.
      if (!verifyValidatorSignature(header, validatorSignature)) {
        return {
          result: 'reject',
          lie: true,
          detail: 'ordering block validator signature invalid',
        };
      }
      // The body — a second decode whose throw is `ProtocolViolation`.
      let utxoTxTree: UtxoTxTree;
      try {
        utxoTxTree = decodeUtxoTxTree(utxoTxTreeBytes);
      } catch (err) {
        return {
          result: 'reject',
          lie: true,
          detail: `malformed ordering block body: ${String(err)}`,
        };
      }
      const block: OrderingBlock = { header, utxoTxTree, validatorSignature };
      const vr = verifyOrderingBlockStructure(block);
      if (!vr.valid) {
        return {
          result: 'reject',
          lie: true,
          detail: vr.error ?? 'invalid ordering block',
        };
      }
      // NET_INTERFACE → Stage 1 →
      // "A worked header is forwarded with the body its root commits".
      if (!verifyUtxoTxRoot(block)) {
        return {
          result: 'reject',
          lie: true,
          detail: "ordering block body is not the one the header's root commits",
        };
      }
      // Accept — record and prune so the memory keeps nothing past the
      // seen window.
      this.seenAccepted.set(hash, now);
      for (const [k, t] of this.seenAccepted) {
        if (now - t >= GOSSIP_SEEN_WINDOW_MS) this.seenAccepted.delete(k);
      }
      return { result: 'accept', block, hash };
    } catch {
      return { result: 'ignore' };
    }
  }
}
