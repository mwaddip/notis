import { profileFor, type NetworkType } from '@dagsocial/types';
import type { StatusResult } from '../api/dto';

// WEB_INTERFACE → Invariants → "A per-network number is read, never assumed" —
// the one place every reader of `inviteBondMin`, `inviteBondMax`,
// `vouchCooldownBlocks` and `inviteProbationBlocks` passes through: where the
// build names its network it reads the profile, where it names none it reads
// `/status`. The network is passed in — the caller holds it (the App through
// `prefs`' `BUILD_NETWORK`, the submit flows through `SubmitDeps.network`) —
// so this module imports nothing that reads the document at load, and the
// wallet's flows import under Node for the extension-check bundle.

export interface NetworkNumbers {
  inviteBondMin: string;
  inviteBondMax: string;
  vouchCooldownBlocks: number;
  inviteProbationBlocks: number;
}

export function networkNumbers(
  network: NetworkType | null,
  status: StatusResult | null,
): NetworkNumbers | null {
  if (network !== null) {
    const p = profileFor(network);
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
