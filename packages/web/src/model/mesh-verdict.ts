// The verdict over the mesh client's state — a pure function of `ClientState`
// after a check (WEB_INTERFACE → The extension → "The verified tip"). The
// table's first row that holds answers the verdict; a state whose counts are
// not non-negative integers reads as no check ended. `tipRunOf` lands it
// beside the anchor and the chain name the extension's extension build reads
// (→ "The verified figures" → "The anchor", → "The chain's name").
//
// Stubbed; the implementation lands with the verdict and anchor wiring.

import type { ClientState } from '../mesh/mesh-client.js';
import type { TipRun } from './state.js';
import type { TipVerdict } from './tip-verdict.js';

export function meshVerdict(_s: ClientState): TipVerdict {
  throw new Error('meshVerdict(): not implemented');
}

export function tipRunOf(_s: ClientState): TipRun {
  throw new Error('tipRunOf(): not implemented');
}
