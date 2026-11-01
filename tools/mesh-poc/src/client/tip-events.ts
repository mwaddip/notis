// MESH_INTERFACE → The client's node list — one event per node that
// `resolveTip` answers, keyed by the id read from the node's mesh URL:
// a verified node with `behind === 0` is success (the winner, or a
// tie with it); `behind === 1` is trailing (one block behind on the
// tip's chain); any other verified node, and `too-short`, is behind,
// the chain not yet at the tip or not long enough to prove;
// `unreachable` is a failure of kind `transport`; `http` is a failure
// of kind `refused`; `invalid` with `verifyResult.reason === 'clock'`
// is a failure of kind `clock` — "a proof refused by the clock check
// alone is a failure, never a lie" (MESH_INTERFACE → The client's
// node list, the clock row); `invalid` with any other proof-verifier
// reason is a lie of kind `proof-invalid`; `invalid` without a proof
// is a lie of kind `malformed`.
//
// Total over what `resolveTip` answers today: a `refuseCode` outside the
// table above is a change to read, not to guess, and throws. Pure,
// browser-safe (`MESH_INTERFACE → Place in the workspace`).

import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';
import { MeshUrlError } from '../mesh-url.js';
import type { FailureKind, LieEvidence } from './node-list.js';

export type TipEvent =
  | { id: string; ev: 'success' }
  | { id: string; ev: 'trailing' }
  | { id: string; ev: 'behind' }
  | { id: string; ev: 'failure'; kind: FailureKind; message?: string }
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
      return { id, ev: 'failure', kind: 'transport', message: detail };
    case 'http':
      return { id, ev: 'failure', kind: 'refused', message: detail };
    case 'invalid': {
      // MESH_INTERFACE → The client's node list, clock row — a proof
      // refused by the client's clock check alone is a failure, never
      // a lie: an honest node's header stamped later than the client's
      // own clock allows would otherwise blacklist every honest node.
      const vr = node.verifyResult;
      if (vr !== null && vr.ok === false && vr.reason === 'clock') {
        return { id, ev: 'failure', kind: 'clock', message: detail };
      }
      return node.proof !== null
        ? { id, ev: 'lie', evidence: { kind: 'proof-invalid', atMs: nowMs, detail } }
        : { id, ev: 'lie', evidence: { kind: 'malformed', atMs: nowMs, detail } };
    }
    default:
      throw new Error(`tipEvents: unknown refuseCode ${JSON.stringify(node.refuseCode)}`);
  }
}
