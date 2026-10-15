import { describe, it, expect } from 'vitest';
import { resolveTip } from '../src/tip.js';
import {
  buildMinedChain,
  clockAfterChain,
  createFakeNode,
  devnetProfile,
  forgeTipStateRoot,
  proofHexForChain,
} from './helpers.js';
import { bytesToHex, EMPTY_STATE_ROOT } from '@dagsocial/types';
import { decodeNipopowProof, encodeNipopowProof } from '@dagsocial/nipopow';

const M = 6;
const K = 20;
const CHAIN_LEN = M + K + 10;
const FORGED_STATE_ROOT = 'aa'.repeat(33);

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// NIPOPOW_INTERFACE → verifyProof rule 1: `m` and `k` equal `params.m` and
// `params.k`, and `suffixTail.length === k − 1`. NIPOPOW_INTERFACE → The
// trust model, rule 4: a proof is held to the client's own parameters,
// so a `stateRoot` chosen by a node stands beneath `k − 1` headers at the
// schedule's targets, on a chain outscoring the honest one.
describe('resolveTip holds every proof to the m and k it asked for', () => {
  it('a proof asked for at k=20 and built at k=1 is refused invalid; the honest node decides and carries the honest stateRoot', async () => {
    const honest = buildMinedChain({ count: CHAIN_LEN });
    const forged = forgeTipStateRoot(honest, FORGED_STATE_ROOT);
    const forgedProofHex = proofHexForChain(forged, M, 1);

    const nodeA = createFakeNode({ url: 'http://a:3000', chain: forged, m: M, k: K, overrideProofHex: forgedProofHex });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: honest, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };
    const profile = devnetProfile();
    const now = clockAfterChain(honest);

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.nodes[0]!.refuseCode).toBe('invalid');
    expect(result.winner).not.toBeNull();
    expect(result.winner!.url).toBe('http://b:3001');
    const honestSuffix = honest.headers[CHAIN_LEN - K]!.stateRoot;
    expect(honestSuffix).toBe(EMPTY_STATE_ROOT);
    expect(result.suffixHead!.header.stateRoot).toBe(honestSuffix);
  });

  it('a proof declaring k=20 with an empty tail is refused invalid; the honest node decides', async () => {
    const honest = buildMinedChain({ count: CHAIN_LEN });
    const forged = forgeTipStateRoot(honest, FORGED_STATE_ROOT);
    const builtAtOne = proofHexForChain(forged, M, 1);
    const parsed = decodeNipopowProof(hexToBytes(builtAtOne));
    const relabelled = { ...parsed, k: K };
    const forgedProofHex = bytesToHex(encodeNipopowProof(relabelled));

    const nodeA = createFakeNode({ url: 'http://a:3000', chain: forged, m: M, k: K, overrideProofHex: forgedProofHex });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: honest, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };
    const profile = devnetProfile();
    const now = clockAfterChain(honest);

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.nodes[0]!.refuseCode).toBe('invalid');
    expect(result.winner).not.toBeNull();
    expect(result.winner!.url).toBe('http://b:3001');
    const honestSuffix = honest.headers[CHAIN_LEN - K]!.stateRoot;
    expect(result.suffixHead!.header.stateRoot).toBe(honestSuffix);
  });
});
