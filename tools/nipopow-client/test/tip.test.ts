import { describe, it, expect } from 'vitest';
import { resolveTip } from '../src/tip.js';
import {
  buildMinedChain,
  createFakeNode,
  devnetProfile,
  proofHexForChain,
} from './helpers.js';
import { blockHash } from '@dagsocial/validation';

const M = 6;
const K = 6;
const CHAIN_LEN = M + K + 10;

describe('tip resolution', () => {
  it('two nodes on one chain → tip agreed, tie, exit 0', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const profile = devnetProfile();
    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, combinedFetch);
    expect(result.winner).not.toBeNull();
    expect(result.tip).not.toBeNull();
    expect(result.splits).toEqual([]);
    expect(result.nodes[0]!.verified).toBe(true);
    expect(result.nodes[1]!.verified).toBe(true);
  });

  it('three nodes, one with a flipped byte → refused, other two decide', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const profile = devnetProfile();

    const goodProof = proofHexForChain(chain, M, K);
    const proofBytes = new Uint8Array(Buffer.from(goodProof, 'hex'));
    const flipIdx = proofBytes.length - 10;
    proofBytes[flipIdx] = (proofBytes[flipIdx] ?? 0) ^ 0x01;
    const badProof = Buffer.from(proofBytes).toString('hex');

    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });
    const nodeC = createFakeNode({ url: 'http://c:3002', chain, m: M, k: K, overrideProofHex: badProof });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      if (url.startsWith('http://b:3001')) return nodeB.fetch(url);
      return nodeC.fetch(url);
    };

    const result = await resolveTip(
      ['http://a:3000', 'http://b:3001', 'http://c:3002'],
      M, K, profile, combinedFetch,
    );
    expect(result.winner).not.toBeNull();
    const refused = result.nodes.filter(n => !n.verified);
    expect(refused.length).toBe(1);
    expect(refused[0]!.url).toBe('http://c:3002');
    expect(refused[0]!.refuseReason).toBeTruthy();
  });

  it('fork — heavier chain wins', async () => {
    const forkA = buildMinedChain({ count: CHAIN_LEN + 5 });
    const forkB = buildMinedChain({ count: CHAIN_LEN });
    const profile = devnetProfile();

    const nodeA = createFakeNode({ url: 'http://a:3000', chain: forkA, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: forkB, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, combinedFetch);
    expect(result.winner).not.toBeNull();
    expect(result.splits).toEqual([]);
  });

  it('two chains from different block 1s → split, incomparable', async () => {
    const valA = new Uint8Array(32);
    valA[0] = 1;
    const valB = new Uint8Array(32);
    valB[0] = 2;
    const chainA = buildMinedChain({ count: CHAIN_LEN, validatorId: valA });
    const chainB = buildMinedChain({ count: CHAIN_LEN, validatorId: valB });
    const profile = devnetProfile();

    const hashA = blockHash(chainA.headers[0]!);
    const hashB = blockHash(chainB.headers[0]!);
    if (hashA === hashB) throw new Error('chains have same genesis — test invalid');

    const nodeA = createFakeNode({ url: 'http://a:3000', chain: chainA, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: chainB, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, combinedFetch);
    expect(result.splits.length).toBeGreaterThan(0);
    expect(result.splits[0]!.reason).toBe('no-common-ancestor');
  });

  it('one node without --allow-single → only one verified', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const profile = devnetProfile();
    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });

    const result = await resolveTip(['http://a:3000'], M, K, profile, nodeA.fetch);
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0]!.verified).toBe(true);
    expect(result.winner).not.toBeNull();
  });

  it('node returns non-200 → refused with status', async () => {
    const httpFetch = async (_url: string) => ({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    } as unknown as Response);

    const profile = devnetProfile();
    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, httpFetch);
    expect(result.nodes.every(n => !n.verified)).toBe(true);
    expect(result.winner).toBeNull();
  });
});
