import { verifyProof, compareProofs, decodeNipopowProof } from '@dagsocial/nipopow';
import type { NipopowProof, VerifyResult, CompareResult, PoPowHeader } from '@dagsocial/nipopow';
import type { BlockHeader, NetworkProfile } from '@dagsocial/types';
import type { HttpFetch } from './http.js';
import { fetchJson } from './http.js';
import { verifierProfile } from './config.js';

export interface NodeTipResult {
  url: string;
  verified: boolean;
  proof: NipopowProof | null;
  verifyResult: VerifyResult | null;
  refuseReason: string | null;
  // NODE_INTERFACE → Nipopow — the route's documented answers, one code per class
  refuseCode: 'unreachable' | 'too-short' | 'http' | 'invalid' | null;
}

export interface TipResult {
  winner: NodeTipResult | null;
  winnerIndex: number;
  nodes: NodeTipResult[];
  tip: BlockHeader | null;
  suffixHead: PoPowHeader | null;
  splits: { indexA: number; indexB: number; reason: string }[];
}

// NIPOPOW_INTERFACE → verifyProof, → compareProofs
export async function resolveTip(
  nodeUrls: string[],
  m: number,
  k: number,
  networkProfile: NetworkProfile,
  now: () => number,
  httpFetch: HttpFetch,
): Promise<TipResult> {
  const nodes: NodeTipResult[] = [];

  for (const url of nodeUrls) {
    const res = await fetchJson<{ proof: string }>(
      httpFetch,
      `${url}/nipopow/proof/${m}/${k}`,
    );
    if (!res.ok) {
      nodes.push({
        url,
        verified: false,
        proof: null,
        verifyResult: null,
        refuseReason: res.status === 0 ? `unreachable: ${res.body}` : `HTTP ${res.status}: ${res.body}`,
        refuseCode: classifyNonOk(res.status, res.body),
      });
      continue;
    }
    if (!res.data.proof || typeof res.data.proof !== 'string') {
      nodes.push({
        url,
        verified: false,
        proof: null,
        verifyResult: null,
        refuseReason: 'response missing proof field',
        refuseCode: 'invalid',
      });
      continue;
    }

    let proof: NipopowProof;
    try {
      proof = decodeNipopowProof(hexToBytes(res.data.proof));
    } catch {
      nodes.push({
        url,
        verified: false,
        proof: null,
        verifyResult: null,
        refuseReason: 'proof decode failed',
        refuseCode: 'invalid',
      });
      continue;
    }

    const vr = verifyProof(proof, verifierProfile(networkProfile, now()));
    if (!vr.ok) {
      nodes.push({
        url,
        verified: false,
        proof,
        verifyResult: vr,
        refuseReason: `verify failed: ${vr.reason}${vr.index !== undefined ? ` at index ${vr.index}` : ''}`,
        refuseCode: 'invalid',
      });
      continue;
    }

    nodes.push({
      url,
      verified: true,
      proof,
      verifyResult: vr,
      refuseReason: null,
      refuseCode: null,
    });
  }

  const verified = nodes.filter(n => n.verified);
  if (verified.length === 0) {
    return { winner: null, winnerIndex: -1, nodes, tip: null, suffixHead: null, splits: [] };
  }

  // NIPOPOW_INTERFACE → compareProofs — tournament fold
  let best = verified[0]!;
  let bestIdx = nodes.indexOf(best);
  const splits: TipResult['splits'] = [];

  for (let i = 1; i < verified.length; i++) {
    const next = verified[i]!;
    const cr: CompareResult = compareProofs(best.proof!, next.proof!, m, verifierProfile(networkProfile, now()));

    if (cr.verdict === 'b') {
      best = next;
      bestIdx = nodes.indexOf(next);
    } else if (cr.verdict === 'incomparable') {
      splits.push({
        indexA: bestIdx,
        indexB: nodes.indexOf(next),
        reason: cr.reason,
      });
    }
    // 'a' or 'tie' → keep best
  }

  const vr = best.verifyResult as VerifyResult & { ok: true };
  return {
    winner: best,
    winnerIndex: bestIdx,
    nodes,
    tip: vr.tip,
    suffixHead: vr.suffixHead,
    splits,
  };
}

// NODE_INTERFACE → Nipopow — 404 with `{ error: 'chain too short' }` is the route's
// answer while the chain is below `m + k`; any other 404 body (a proxy page, an older
// node's `Cannot GET`) is a generic HTTP failure, never parsed as a chain state.
function classifyNonOk(status: number, body: string): 'unreachable' | 'too-short' | 'http' {
  if (status === 0) return 'unreachable';
  if (status === 404) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        parsed !== null && typeof parsed === 'object'
        && (parsed as { error?: unknown }).error === 'chain too short'
      ) {
        return 'too-short';
      }
    } catch {
      // fall through
    }
  }
  return 'http';
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
