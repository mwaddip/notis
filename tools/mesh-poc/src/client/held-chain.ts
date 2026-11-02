// MESH_INTERFACE → The client's node list → "The client's chain" — the
// client holds its chain's last `k` headers (tip highest) and block 1's
// header beside them. The window grows by a gossiped block that extends the
// tip and by a gap fill linked bottom-up to a held header; it shrinks past
// `k` by dropping the lowest. The schedule's anchor is the proof that
// settled the chain (`t_a` = block 1's `createdAt`), the parameters are
// `verifierProfile(profile, 0).retarget`
// (NIPOPOW_INTERFACE → verifyProof — the band and the schedule). The stub
// throws; the implementation lands with the served header reader.

import type { BlockHeader, NetworkProfile } from '@dagsocial/types';

export type Placement =
  | 'tip'
  | 'one-below'
  | 'below'
  | 'above'
  | 'under'
  | 'unplaced';

export class HeldChain {
  constructor(_profile: NetworkProfile, _k: number) {
    // The window and block 1 are empty until the first `settle`.
  }

  settled(): boolean {
    throw new Error('held-chain: not implemented');
  }

  settle(_suffix: BlockHeader[], _block1: BlockHeader): void {
    throw new Error('held-chain: not implemented');
  }

  tip(): BlockHeader | null {
    throw new Error('held-chain: not implemented');
  }

  place(_hash: string | null, _height: number): Placement {
    throw new Error('held-chain: not implemented');
  }

  headerAt(_height: number): BlockHeader | null {
    throw new Error('held-chain: not implemented');
  }

  extend(_header: BlockHeader): 'extended' | 'fork' | 'gap' {
    throw new Error('held-chain: not implemented');
  }

  link(_headers: BlockHeader[]): 'linked' | 'failed' {
    throw new Error('held-chain: not implemented');
  }

  scheduledTargetBits(_header: BlockHeader): number | null {
    throw new Error('held-chain: not implemented');
  }

  standing(_hash: string, _height: number): 'held' | null {
    throw new Error('held-chain: not implemented');
  }
}
