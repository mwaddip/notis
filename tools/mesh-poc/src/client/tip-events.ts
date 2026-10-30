// MESH_INTERFACE → The client's node list — one event per node that
// `resolveTip` answers, keyed by the id read from the node's mesh URL:
// the winner is success; a verified non-winner is behind; `too-short`
// is behind, the chain not yet long enough to prove; `unreachable` is a
// failure of kind `transport`; `http` is a failure of kind `refused`;
// `invalid` with a proof is a lie of kind `proof-invalid`, the proof
// verified under the wrong key; `invalid` without a proof is a lie of
// kind `malformed`, the answer not even a proof.
//
// Total over what `resolveTip` answers today: a `refuseCode` outside the
// table above is a change to read, not to guess, and throws. Pure,
// browser-safe (`MESH_INTERFACE → Place in the workspace`).

import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';
import { MeshUrlError } from '../mesh-url.js';
import type { FailureKind, LieEvidence } from './node-list.js';

export type TipEvent =
  | { id: string; ev: 'success' }
  | { id: string; ev: 'behind' }
  | { id: string; ev: 'failure'; kind: FailureKind }
  | { id: string; ev: 'lie'; evidence: LieEvidence };

export function tipEvents(r: TipResult, nowMs: number): TipEvent[] {
  const out: TipEvent[] = [];
  for (let i = 0; i < r.nodes.length; i += 1) {
    const node = r.nodes[i]!;
    out.push(eventFor(idOfMeshUrl(node.url), node, i === r.winnerIndex, nowMs));
  }
  return out;
}

// MESH_INTERFACE → The mesh URL — the shape is `notis-mesh://<64 hex>[path]`;
// `parseMeshUrl` is strict about the path (an empty one is refused for a
// path-expecting URL), while the node URLs `resolveTip` keeps in its answer
// are bases a mesh fetch appends a path to and so may carry no path of their
// own. This helper extracts the id from either shape; the key rule — 64
// lowercase hex characters — is the same.
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

function eventFor(id: string, node: NodeTipResult, isWinner: boolean, nowMs: number): TipEvent {
  if (node.verified) {
    return isWinner ? { id, ev: 'success' } : { id, ev: 'behind' };
  }
  const detail = node.refuseReason ?? '';
  switch (node.refuseCode) {
    case 'too-short':
      return { id, ev: 'behind' };
    case 'unreachable':
      return { id, ev: 'failure', kind: 'transport' };
    case 'http':
      return { id, ev: 'failure', kind: 'refused' };
    case 'invalid':
      return node.proof !== null
        ? { id, ev: 'lie', evidence: { kind: 'proof-invalid', atMs: nowMs, detail } }
        : { id, ev: 'lie', evidence: { kind: 'malformed', atMs: nowMs, detail } };
    default:
      throw new Error(`tipEvents: unknown refuseCode ${JSON.stringify(node.refuseCode)}`);
  }
}
