// MESH_INTERFACE → No anchor reached → "The agreement counts" — after
// each check, how many nodes verified a proof on the tip's chain within
// its last `k` headers (agreeing), how many of those are anchors, and
// how many verified a proof off those headers (not agreeing: on another
// chain, or further back than they reach — the client cannot tell them
// apart). A node that did not verify is in no count. Pure, browser-safe
// (`MESH_INTERFACE → Place in the workspace`).

import type { TipResult } from '@dagsocial/nipopow-client';
import { MeshUrlError } from '../mesh-url.js';

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

// The URLs `resolveTip` keeps are bases a mesh fetch appends a path to
// and so may carry no path of their own, which `parseMeshUrl` refuses;
// this helper extracts the id either way. Same rule — 64 lowercase hex
// characters — as `parseMeshUrl` and `tipEvents`' own id reader.
const SCHEME = 'notis-mesh://';
const NOTIS_ID_RE = /^[0-9a-f]{64}$/;
function idOfMeshUrl(url: string): string {
  if (!url.startsWith(SCHEME)) {
    throw new MeshUrlError(`url must start with "${SCHEME}"`);
  }
  const rest = url.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  const id = slash === -1 ? rest : rest.slice(0, slash);
  if (!NOTIS_ID_RE.test(id)) {
    throw new MeshUrlError('notisId must be 64 lowercase hex characters');
  }
  return id;
}
