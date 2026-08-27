import type { BlockHeader } from '@dagsocial/types';
import { blockHash, level } from '@dagsocial/validation';
import { verifyProof } from './verify.js';
import type { NipopowProof, PoPowHeader } from './codec.js';

export type CompareResult =
  | { verdict: 'a' | 'b' | 'tie'; scoreA: bigint; scoreB: bigint; lca: BlockHeader }
  | { verdict: 'incomparable'; reason: 'no-common-ancestor' | 'm-mismatch' | 'invalid' };

interface CompareProfile {
  expectedTarget: (height: number) => number;
  genesisId: string;
  protocolVersion: number;
}

function headersChain(proof: NipopowProof): BlockHeader[] {
  return [
    ...proof.prefix.map((p: PoPowHeader) => p.header),
    proof.suffixHead.header,
    ...proof.suffixTail,
  ];
}

// NIPOPOW_INTERFACE → compareProofs: LCA by blockHash over the two flattened chains
function lowestCommonAncestor(left: BlockHeader[], right: BlockHeader[]): BlockHeader | null {
  const rightSet = new Map<string, BlockHeader>();
  for (const h of right) {
    const hash = blockHash(h);
    if (hash !== null) rightSet.set(hash, h);
  }
  let lca: BlockHeader | null = null;
  for (const h of left) {
    const hash = blockHash(h);
    if (hash !== null && rightSet.has(hash)) lca = h;
  }
  return lca;
}

// NIPOPOW_INTERFACE → compareProofs — bestArg: max over μ ≥ 0 of 2^μ · |{ h ∈ chain : level(h) ≥ μ }|,
// counting a level μ ≥ 1 only while it holds at least m headers
export function bestArg(headers: BlockHeader[], m: number): bigint {
  const levels = headers.map(h => level(h));
  const acc: Array<[number, number]> = [[0, headers.length]];
  let mu = 1;
  for (;;) {
    const count = levels.filter(lvl => lvl !== null && lvl >= mu).length;
    if (count >= m) {
      acc.push([mu, count]);
      mu++;
    } else {
      break;
    }
  }
  let best = 0n;
  for (const [lvl, cnt] of acc) {
    const score = (2n ** BigInt(lvl)) * BigInt(cnt);
    if (score > best) best = score;
  }
  return best;
}

// NIPOPOW_INTERFACE → compareProofs
export function compareProofs(
  a: NipopowProof,
  b: NipopowProof,
  m: number,
  profile: CompareProfile,
): CompareResult {
  const aResult = verifyProof(a, profile);
  const bResult = verifyProof(b, profile);
  if (!aResult.ok || !bResult.ok) {
    return { verdict: 'incomparable', reason: 'invalid' };
  }

  if (a.m !== m || b.m !== m) {
    return { verdict: 'incomparable', reason: 'm-mismatch' };
  }

  const aChain = headersChain(a);
  const bChain = headersChain(b);

  const lca = lowestCommonAncestor(aChain, bChain);
  if (lca === null) {
    return { verdict: 'incomparable', reason: 'no-common-ancestor' };
  }

  const lcaHeight = lca.height;
  const aAbove = aChain.filter(h => h.height > lcaHeight);
  const bAbove = bChain.filter(h => h.height > lcaHeight);

  const scoreA = bestArg(aAbove, m);
  const scoreB = bestArg(bAbove, m);

  if (scoreA > scoreB) return { verdict: 'a', scoreA, scoreB, lca };
  if (scoreB > scoreA) return { verdict: 'b', scoreA, scoreB, lca };
  return { verdict: 'tie', scoreA, scoreB, lca };
}
