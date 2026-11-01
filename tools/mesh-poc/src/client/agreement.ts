// MESH_INTERFACE → No anchor reached → "The agreement counts" —
// stub; the rule lands with the test cases that pin it.

import type { TipResult } from '@dagsocial/nipopow-client';

export interface AgreementCounts {
  agreeing: number;
  agreeingAnchors: number;
  notAgreeing: number;
}

export function agreementCounts(_r: TipResult, _anchorIds: ReadonlySet<string>): AgreementCounts {
  return { agreeing: 0, agreeingAnchors: 0, notAgreeing: 0 };
}
