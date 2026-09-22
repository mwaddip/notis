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

  // Asking independent nodes is the eclipse defence: one node throwing on the
  // wire must not sink the run — it is refused, and the reachable node decides.
  it('a node whose transport fails is refused, and the reachable node still decides', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const profile = devnetProfile();
    const now = clockAfterChain(chain);
    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      throw new TypeError('fetch failed');
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.nodes[1]!.verified).toBe(false);
    expect(result.nodes[1]!.refuseReason).toContain('fetch failed');
    expect(result.nodes[0]!.verified).toBe(true);
    expect(result.winner).not.toBeNull();
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

// WEB_INTERFACE → The extension → "The verified tip" — losing the comparison is not being
// outworked; standing on another chain is. `behind` names the distance on the winner's chain.
describe('NodeTipResult.behind', () => {
  const profile = devnetProfile();

  it('two nodes on one chain, same tip → both behind: 0', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const now = clockAfterChain(chain);
    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.nodes[0]!.behind).toBe(0);
    expect(result.nodes[1]!.behind).toBe(0);
  });

  it('the first reads behind: d when it stands d = 1 blocks behind on the same chain', async () => {
    const d = 1;
    const chainFull = buildMinedChain({ count: CHAIN_LEN });
    const chainShort = buildMinedChain({ count: CHAIN_LEN - d });
    const now = clockAfterChain(chainFull);
    const shortProofHex = proofHexForChain(chainShort, M, K);
    const nodeA = createFakeNode({ url: 'http://a:3000', chain: chainShort, m: M, k: K, overrideProofHex: shortProofHex });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: chainFull, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.winnerIndex).toBe(1);
    expect(result.nodes[0]!.behind).toBe(d);
    expect(result.nodes[1]!.behind).toBe(0);
  });

  it('the first reads behind: k − 1 when it stands the deepest a suffix reaches on the same chain', async () => {
    const d = K - 1;
    const chainFull = buildMinedChain({ count: CHAIN_LEN });
    const chainShort = buildMinedChain({ count: CHAIN_LEN - d });
    const now = clockAfterChain(chainFull);
    const shortProofHex = proofHexForChain(chainShort, M, K);
    const nodeA = createFakeNode({ url: 'http://a:3000', chain: chainShort, m: M, k: K, overrideProofHex: shortProofHex });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: chainFull, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.winnerIndex).toBe(1);
    expect(result.nodes[0]!.behind).toBe(d);
    expect(result.nodes[1]!.behind).toBe(0);
  });

  it('the first reads behind: null when it stands k blocks behind — the suffix no longer reaches its tip', async () => {
    const d = K;
    const chainFull = buildMinedChain({ count: CHAIN_LEN });
    const chainShort = buildMinedChain({ count: CHAIN_LEN - d });
    const now = clockAfterChain(chainFull);
    const shortProofHex = proofHexForChain(chainShort, M, K);
    const nodeA = createFakeNode({ url: 'http://a:3000', chain: chainShort, m: M, k: K, overrideProofHex: shortProofHex });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain: chainFull, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const result = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(result.winnerIndex).toBe(1);
    expect(result.nodes[0]!.behind).toBeNull();
    expect(result.nodes[1]!.behind).toBe(0);
  });

  it('a node standing on another chain reads behind: null though the winner has more work', async () => {
    const valA = new Uint8Array(32);
    valA[0] = 1;
    const valB = new Uint8Array(32);
    valB[0] = 2;
    // A is asked first, so a compareProofs 'incomparable' verdict keeps A as best; A carries the
    // longer chain to make the "more work" branch of the property meaningful.
    const chainA = buildMinedChain({ count: CHAIN_LEN + 5, validatorId: valA });
    const chainB = buildMinedChain({ count: CHAIN_LEN, validatorId: valB });
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
    expect(result.winner).not.toBeNull();
    expect(result.nodes[0]!.behind).toBe(0);
    expect(result.nodes[1]!.behind).toBeNull();
  });

  it('an unverified node reads behind: null; with no verified node every behind is null', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const now = clockAfterChain(chain);
    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      throw new TypeError('fetch failed');
    };

    const mixed = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, now, combinedFetch);
    expect(mixed.nodes[0]!.behind).toBe(0);
    expect(mixed.nodes[1]!.verified).toBe(false);
    expect(mixed.nodes[1]!.behind).toBeNull();

    const allDown = async (_url: string) => {
      throw new TypeError('fetch failed');
    };
    const none = await resolveTip(['http://a:3000', 'http://b:3001'], M, K, profile, Date.now, allDown);
    expect(none.winner).toBeNull();
    expect(none.nodes.every(n => n.behind === null)).toBe(true);
  });

  it('a three-node fold measures each behind against the FINAL winner, not the interim best', async () => {
    // The fold walks first → best = first; second is longer → best = second; third is longer → best = third.
    // The first was folded out while second was best, but its `behind` is set against the third.
    const d1 = 3;
    const d2 = 1;
    const chainFull = buildMinedChain({ count: CHAIN_LEN });
    const chainD1 = buildMinedChain({ count: CHAIN_LEN - d1 });
    const chainD2 = buildMinedChain({ count: CHAIN_LEN - d2 });
    const now = clockAfterChain(chainFull);
    const nodeA = createFakeNode({
      url: 'http://a:3000', chain: chainD1, m: M, k: K, overrideProofHex: proofHexForChain(chainD1, M, K),
    });
    const nodeB = createFakeNode({
      url: 'http://b:3001', chain: chainD2, m: M, k: K, overrideProofHex: proofHexForChain(chainD2, M, K),
    });
    const nodeC = createFakeNode({ url: 'http://c:3002', chain: chainFull, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      if (url.startsWith('http://b:3001')) return nodeB.fetch(url);
      return nodeC.fetch(url);
    };

    const result = await resolveTip(
      ['http://a:3000', 'http://b:3001', 'http://c:3002'],
      M, K, profile, now, combinedFetch,
    );
    expect(result.winnerIndex).toBe(2);
    expect(result.nodes[0]!.behind).toBe(d1);
    expect(result.nodes[1]!.behind).toBe(d2);
    expect(result.nodes[2]!.behind).toBe(0);
  });
});
