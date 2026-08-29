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
        refuseReason: `HTTP ${res.status}: ${res.body}`,
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
      });
      continue;
    }

    nodes.push({
      url,
      verified: true,
      proof,
      verifyResult: vr,
      refuseReason: null,
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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
