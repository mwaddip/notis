// MESH_INTERFACE → The client's node list — stub, pending the cases.
// The implementation lands in a later commit; this file carries the names
// and shapes the tests import against.

import type { TipResult } from '@dagsocial/nipopow-client';
import type { FailureKind, LieEvidence } from './node-list.js';

export type TipEvent =
  | { id: string; ev: 'success' }
  | { id: string; ev: 'behind' }
  | { id: string; ev: 'failure'; kind: FailureKind }
  | { id: string; ev: 'lie'; evidence: LieEvidence };

export function tipEvents(_r: TipResult, _nowMs: number): TipEvent[] {
  return [];
}
