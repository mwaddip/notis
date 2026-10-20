import { profileFor } from '@dagsocial/types';
import { BUILD_NETWORK } from '../prefs';
import type { StatusResult } from '../api/dto';

// WEB_INTERFACE → Invariants → "A per-network number is read, never assumed" —
// the one place every reader of `inviteBondMin`, `inviteBondMax`,
// `vouchCooldownBlocks` and `inviteProbationBlocks` passes through: where the
// build names its network it reads the profile, where it names none it reads
// `/status`.

export interface NetworkNumbers {
  inviteBondMin: string;
  inviteBondMax: string;
  vouchCooldownBlocks: number;
  inviteProbationBlocks: number;
}

export function networkNumbers(status: StatusResult | null): NetworkNumbers | null {
  if (BUILD_NETWORK !== null) {
    const p = profileFor(BUILD_NETWORK);
    return {
      inviteBondMin: p.inviteBondMin.toString(),
      inviteBondMax: p.inviteBondMax.toString(),
      vouchCooldownBlocks: p.vouchCooldownBlocks,
      inviteProbationBlocks: p.inviteProbationBlocks,
    };
  }
  if (status === null) return null;
  return {
    inviteBondMin: status.inviteBondMin,
    inviteBondMax: status.inviteBondMax,
    vouchCooldownBlocks: status.vouchCooldownBlocks,
    inviteProbationBlocks: status.inviteProbationBlocks,
  };
}
