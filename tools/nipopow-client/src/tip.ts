import { verifyProof, compareProofs, decodeNipopowProof } from '@dagsocial/nipopow';
import type { NipopowProof, VerifyResult, CompareResult, PoPowHeader } from '@dagsocial/nipopow';
import type { BlockHeader, NetworkProfile } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type { HttpFetch } from './http.js';
import { capped, fetchJson, isRecord } from './http.js';
import { verifierProfile } from './config.js';

export interface NodeTipResult {
  url: string;
  verified: boolean;
  proof: NipopowProof | null;
  verifyResult: VerifyResult | null;
  refuseReason: string | null;
  // NODE_INTERFACE → Nipopow — the route's documented answers, one code per class
  refuseCode: 'unreachable' | 'too-short' | 'http' | 'invalid' | null;
  // WEB_INTERFACE → The extension → "The verified tip" — blocks from this node's tip
  // to the winner's on the winner's own chain; null on another chain, further back than
  // the suffix reaches, or without a verified verdict.
  behind: number | null;
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
    const res = await fetchJson<unknown>(
      httpFetch,
      `${url}/nipopow/proof/${m}/${k}`,
    );
    if (!res.ok) {
      nodes.push({
        url,
        verified: false,
        proof: null,
        verifyResult: null,
        refuseReason: res.status === 0
          ? `unreachable: ${capped(res.body)}`
          : `HTTP ${res.status}: ${capped(res.body)}`,
        refuseCode: classifyNonOk(res.status, res.body),
        behind: null,
      });
      continue;
    }
    const proofHex = isRecord(res.data) ? res.data['proof'] : undefined;
    if (typeof proofHex !== 'string' || proofHex === '') {
      nodes.push({
        url,
        verified: false,
        proof: null,
        verifyResult: null,
        refuseReason: 'response missing proof field',
        refuseCode: 'invalid',
        behind: null,
      });
      continue;
    }

    let proof: NipopowProof;
    try {
      proof = decodeNipopowProof(hexToBytes(proofHex));
    } catch {
      nodes.push({
        url,
        verified: false,
        proof: null,
        verifyResult: null,
        refuseReason: 'proof decode failed',
        refuseCode: 'invalid',
        behind: null,
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
        behind: null,
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
      behind: null,
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

  // WEB_INTERFACE → The extension → "The verified tip" — measure each verified node's tip
  // against the WINNER's suffix, not against the interim best; the suffix is the winner's
  // last k headers, `[suffixHead.header, ...suffixTail]`.
  const winnerSuffix: BlockHeader[] = [best.proof!.suffixHead.header, ...best.proof!.suffixTail];
  for (const node of nodes) {
    if (!node.verified) continue;
    const nvr = node.verifyResult as VerifyResult & { ok: true };
    node.behind = behindOnWinnerSuffix(nvr.tip, winnerSuffix);
  }

  return {
    winner: best,
    winnerIndex: bestIdx,
    nodes,
    tip: vr.tip,
    suffixHead: vr.suffixHead,
    splits,
  };
}

// WEB_INTERFACE → The extension → "The verified tip" — height narrows the suffix headers
// to hash; the match is equal blockHash at that height, which is what puts the node's tip
// on the winner's chain, and the count is the last suffix index minus the index found. A
// null hash on either side is no match.
function behindOnWinnerSuffix(nodeTip: BlockHeader, suffix: BlockHeader[]): number | null {
  const nodeTipHash = blockHash(nodeTip);
  if (nodeTipHash === null) return null;
  for (let i = 0; i < suffix.length; i++) {
    const h = suffix[i]!;
    if (h.height !== nodeTip.height) continue;
    const suffixHash = blockHash(h);
    if (suffixHash === null) continue;
    if (suffixHash === nodeTipHash) return suffix.length - 1 - i;
  }
  return null;
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
