// NET_INTERFACE → The browser entry → "The frame codec is one code with its
// checksum handed in" — BlockCheck is the one copy of the ordering-block
// topic's checks of NET_INTERFACE → Stage 1, called from gossip.ts' validator.
// AHEAD OF CODE: the class answers `{ result: 'accept' }` for every input.
// Each check lands in its own commit as the rule steps in.
import type {
  BlockHeader,
  OrderingBlock,
  ProtocolEra,
} from '@dagsocial/types';

export type BlockVerdict =
  | { result: 'accept'; block: OrderingBlock; hash: string }
  | { result: 'ignore' }
  | { result: 'reject'; lie: boolean; detail: string };

/**
 * The block-topic subset of NetValidators — the functions BlockCheck calls
 * in NET_INTERFACE → Stage 1's order. Handed in at construction, as
 * @dagsocial/validation's for the Node and the same functions for the
 * browser (both packages are browser-safe — ARCHITECTURE → Package
 * boundaries).
 */
export interface BlockValidators {
  verifyHeaderFieldDomains: (header: unknown) => { valid: boolean; error?: string };
  verifyProtocolVersion: (declared: number, height: number, schedule: readonly ProtocolEra[]) => boolean;
  verifyOrderingBlockPoW: (header: BlockHeader) => boolean;
  verifyValidatorSignature: (header: BlockHeader, signature: Uint8Array) => boolean;
  verifyOrderingBlockStructure: (block: OrderingBlock) => { valid: boolean; error?: string };
  verifyUtxoTxRoot: (block: OrderingBlock) => boolean;
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

export class BlockCheck {
  constructor(_v: BlockValidators, _ctx: BlockCheckContext) {
    // AHEAD OF CODE: the stub keeps no state.
  }

  check(_raw: Uint8Array): BlockVerdict {
    // AHEAD OF CODE: every input is accepted at the stub's answer; the
    // cases flip once the rule lands.
    return { result: 'accept' } as BlockVerdict;
  }
}
