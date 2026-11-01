// MESH_INTERFACE → No anchor reached → "The agreement counts" — after
// each check, how many nodes verified a proof on the tip's chain within
// its last `k` headers (agreeing), how many of those are anchors, and
// how many verified a proof off those headers (not agreeing: on another
// chain, or further back than they reach — the client cannot tell them
// apart). A node that did not verify is in no count. Pure, browser-safe
// (`MESH_INTERFACE → Place in the workspace`).

import type { TipResult } from '@dagsocial/nipopow-client';
import { idOfMeshUrl } from '../mesh-url.js';

export interface AgreementCounts {
  agreeing: number;
  agreeingAnchors: number;
  notAgreeing: number;
}

export function agreementCounts(r: TipResult, anchorIds: ReadonlySet<string>): AgreementCounts {
  let agreeing = 0;
  let agreeingAnchors = 0;
  let notAgreeing = 0;
  for (const node of r.nodes) {
    if (!node.verified) continue;
    // On a split (`splits` non-empty) every verified node's `behind`
    // is still measured against the winner's suffix alone (nipopow's
    // `resolveTip` writes `behind` after the tournament fold), so a
    // verified node off the winner's chain reads `behind === null` and
    // lands in `notAgreeing` with no split-specific code here.
    if (node.behind !== null) {
      agreeing += 1;
      if (anchorIds.has(idOfMeshUrl(node.url))) agreeingAnchors += 1;
    } else {
      notAgreeing += 1;
    }
  }
  return { agreeing, agreeingAnchors, notAgreeing };
}
