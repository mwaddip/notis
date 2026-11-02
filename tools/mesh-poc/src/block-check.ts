import type { BlockHeader, NetworkProfile, OrderingBlock } from '@dagsocial/types';

// MESH_INTERFACE → Block gossip → "A block is checked before it is forwarded,
// and never applied" — the ordering-block topic's checks of
// `NET_INTERFACE → Stage 1`, in their order, through the same functions. A
// stub answering `ignore` is the shape the cases are flipped against; the
// real check lands in `feat(mesh-poc): the block check — net's Stage 1 for
// the block topic, browser-safe`.

export type BlockVerdict =
  | { result: 'accept'; block: OrderingBlock; hash: string }
  | { result: 'ignore' }
  | { result: 'reject'; lie: boolean; detail: string };

export interface BlockCheckContext {
  profile: NetworkProfile;
  scheduledTargetBits(header: BlockHeader): number | null;
  standing(hash: string, height: number): 'held' | 'refused' | null;
  nowMs(): number;
}

export class BlockCheck {
  // The seen-accepted memory the real check keeps is the instance's; the
  // stub holds no state.
  constructor(_ctx: BlockCheckContext) {}
  check(_raw: Uint8Array): BlockVerdict {
    throw new Error('block-check: not implemented');
  }
}
