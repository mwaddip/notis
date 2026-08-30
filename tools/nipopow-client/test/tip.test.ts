import { describe, it, expect } from 'vitest';
import { resolveTip } from '../src/tip.js';
import {
  buildMinedChain,
  createFakeNode,
  devnetProfile,
  proofHexForChain,
  clockAfterChain,
} from './helpers.js';
import { blockHash } from '@dagsocial/validation';
import { MAX_FUTURE_DRIFT_MS } from '@dagsocial/types';
import type { NetworkProfile, ProtocolEra } from '@dagsocial/types';

const M = 6;
const K = 6;
const CHAIN_LEN = M + K + 10;

describe('tip resolution', () => {
  it('two nodes on one chain → tip agreed, tie, exit 0', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const profile = devnetProfile();
    const now = clockAfterChain(chain);
    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.winner).not.toBeNull();
    expect(result.tip).not.toBeNull();
    expect(result.splits).toEqual([]);
    expect(result.nodes[0]!.verified).toBe(true);
    expect(result.nodes[1]!.verified).toBe(true);
  });

  it('three nodes, one with a flipped byte → refused, other two decide', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const now = clockAfterChain(chain);
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
      M, K, profile, now, combinedFetch,
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
    const tipA = forkA.headers[forkA.headers.length - 1]!.createdAt;
    const tipB = forkB.headers[forkB.headers.length - 1]!.createdAt;
    const now = () => Math.max(tipA, tipB) + 1;

    const nodeA = createFakeNode({ url: 'http://a:3000', chain: forkA, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: forkB, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
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

    const tipA = chainA.headers[chainA.headers.length - 1]!.createdAt;
    const tipB = chainB.headers[chainB.headers.length - 1]!.createdAt;
    const now = () => Math.max(tipA, tipB) + 1;

    const nodeA = createFakeNode({ url: 'http://a:3000', chain: chainA, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: chainB, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.splits.length).toBeGreaterThan(0);
    expect(result.splits[0]!.reason).toBe('no-common-ancestor');
  });

  it('one node without --allow-single → only one verified', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const profile = devnetProfile();
    const now = clockAfterChain(chain);
    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });

    const result = await resolveTip(['http://a:3000'], M, K, profile, now, nodeA.fetch);
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
    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes.every(n => !n.verified)).toBe(true);
    expect(result.winner).toBeNull();
  });

  it('proof whose tip is beyond now + drift → refused with clock, advanced clock verifies', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const profile = devnetProfile();
    const tipStamp = chain.headers[chain.headers.length - 1]!.createdAt;

    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const staleNow = () => tipStamp - MAX_FUTURE_DRIFT_MS - 1;
    const staleResult = await resolveTip(
      ['http://a:3000', 'http://b:3001'],
      M, K, profile, staleNow, combinedFetch,
    );
    expect(staleResult.nodes.every(n => !n.verified)).toBe(true);
    expect(staleResult.nodes[0]!.refuseReason).toContain('clock');

    const freshNow = () => tipStamp + 1;
    const freshResult = await resolveTip(
      ['http://a:3000', 'http://b:3001'],
      M, K, profile, freshNow, combinedFetch,
    );
    expect(freshResult.nodes.every(n => n.verified)).toBe(true);
    expect(freshResult.winner).not.toBeNull();
  });

  it('tournament fold still picks heavier proof when clock is valid for both', async () => {
    const forkA = buildMinedChain({ count: CHAIN_LEN + 5 });
    const forkB = buildMinedChain({ count: CHAIN_LEN });
    const profile = devnetProfile();
    const tipA = forkA.headers[forkA.headers.length - 1]!.createdAt;
    const tipB = forkB.headers[forkB.headers.length - 1]!.createdAt;
    const now = () => Math.max(tipA, tipB) + 1;

    const nodeA = createFakeNode({ url: 'http://a:3000', chain: forkA, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: forkB, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.winner).not.toBeNull();
    expect(result.winner!.url).toBe('http://a:3000');
    expect(result.splits).toEqual([]);
  });

  it('proof spanning an era boundary verifies under the scheduled profile, fails "version" under one era', async () => {
    // TYPES_INTERFACE → Version, NIPOPOW_INTERFACE → verifyProof — rule 3 judges each header's version
    // at its own height, so the schedule the client hands the verifier is what decides.
    const boundary = 8;
    const schedule: ProtocolEra[] = [{ version: 1, fromHeight: 0 }, { version: 2, fromHeight: boundary }];
    const chain = buildMinedChain({ count: 15, schedule });
    const now = clockAfterChain(chain);
    const node = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });

    const scheduled: NetworkProfile = { ...devnetProfile(), protocolVersionSchedule: schedule };
    const passed = await resolveTip(['http://a:3000'], M, K, scheduled, now, node.fetch);
    expect(passed.nodes[0]!.verified).toBe(true);
    expect(passed.tip).not.toBeNull();

    // devnetProfile()'s schedule is [1@0]; the header past the boundary declares 2, its era there is 1.
    const oneEra = await resolveTip(['http://a:3000'], M, K, devnetProfile(), now, node.fetch);
    expect(oneEra.nodes[0]!.verified).toBe(false);
    expect(oneEra.nodes[0]!.refuseReason).toContain('version');
  });
});
