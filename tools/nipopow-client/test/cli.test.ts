import { describe, it, expect } from 'vitest';
import { resolveTip } from '../src/tip.js';
import { proveBoxes } from '../src/boxes.js';
import {
  buildMinedChain,
  buildAvlFixture,
  createFakeNode,
  devnetProfile,
  clockAfterChain,
} from './helpers.js';
import { computeCandidateBoxId } from '@dagsocial/types';
import type { AnyBoxCandidate, TxId } from '@dagsocial/types';

const M = 6;
const K = 6;
const CHAIN_LEN = M + K + 10;
const FAKE_USER = 'ab'.repeat(32);
const FAKE_TXID = 'cd'.repeat(32) as TxId;

function karmaCandidate(value: bigint): AnyBoxCandidate {
  return {
    boxType: 'karma' as const,
    value,
    createdAtBlock: 1,
    owner: new Uint8Array(32),
  };
}

describe('end-to-end: tip + boxes', () => {
  it('--json output parses and carries the same verdicts', async () => {
    const candidate = karmaCandidate(100n);
    const boxId = computeCandidateBoxId(candidate, FAKE_TXID, 0);

    const avl = buildAvlFixture([{ candidate, txId: FAKE_TXID, index: 0 }]);
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: avl.digest });
    const profile = devnetProfile();
    const now = clockAfterChain(chain);

    const nodeA = createFakeNode({
      url: 'http://a:3000',
      chain, m: M, k: K, avl,
      karmaBoxes: { userId: FAKE_USER, boxes: [{ boxId, value: 100 }] },
    });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const tipResult = await resolveTip(
      ['http://a:3000', 'http://b:3001'],
      M, K, profile, now, combinedFetch,
    );

    expect(tipResult.winner).not.toBeNull();
    expect(tipResult.splits).toEqual([]);

    const boxesResult = await proveBoxes(
      tipResult.winner!.url,
      FAKE_USER,
      tipResult.suffixHead!,
      combinedFetch,
    );

    expect(boxesResult.failed).toBe(false);
    expect(boxesResult.karmaTotal).toBe(100n);

    const jsonObj: Record<string, unknown> = {
      tip: tipResult.tip ? { height: tipResult.tip.height } : null,
      nodes: tipResult.nodes.map(n => ({
        url: n.url,
        verified: n.verified,
      })),
      splits: tipResult.splits,
      boxes: boxesResult.boxes.map(b => ({
        boxId: b.boxId,
        class: b.boxClass,
        value: b.value.toString(),
        status: b.status,
        verdict: b.verdict,
      })),
      karmaTotal: boxesResult.karmaTotal.toString(),
      creditTotal: boxesResult.creditTotal.toString(),
    };

    const parsed = JSON.parse(JSON.stringify(jsonObj));
    expect(parsed.karmaTotal).toBe('100');
    expect(parsed.boxes[0].status).toBe('proven');
    expect(parsed.boxes[0].verdict).toBe('proven');
  });

  it('full flow: tip → proven box → totals', async () => {
    const karmaBox = karmaCandidate(50n);
    const creditBox: AnyBoxCandidate = {
      boxType: 'credit' as const,
      value: 200n,
      createdAtBlock: 1,
      owner: new Uint8Array(32),
    };
    const creditTxId = 'ee'.repeat(32) as TxId;

    const karmaBoxId = computeCandidateBoxId(karmaBox, FAKE_TXID, 0);
    const creditBoxId = computeCandidateBoxId(creditBox, creditTxId, 0);

    const avl = buildAvlFixture([
      { candidate: karmaBox, txId: FAKE_TXID, index: 0 },
      { candidate: creditBox, txId: creditTxId, index: 0 },
    ]);
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: avl.digest });
    const profile = devnetProfile();
    const now = clockAfterChain(chain);

    const nodeA = createFakeNode({
      url: 'http://a:3000',
      chain, m: M, k: K, avl,
      karmaBoxes: { userId: FAKE_USER, boxes: [{ boxId: karmaBoxId, value: 50 }] },
      creditBoxes: { userId: FAKE_USER, boxes: [{ boxId: creditBoxId, value: 200 }] },
    });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });

    const combinedFetch = async (url: string) => {
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const tipResult = await resolveTip(
      ['http://a:3000', 'http://b:3001'],
      M, K, profile, now, combinedFetch,
    );

    expect(tipResult.winner).not.toBeNull();

    const boxesResult = await proveBoxes(
      tipResult.winner!.url,
      FAKE_USER,
      tipResult.suffixHead!,
      combinedFetch,
    );

    expect(boxesResult.failed).toBe(false);
    expect(boxesResult.karmaTotal).toBe(50n);
    expect(boxesResult.creditTotal).toBe(200n);
    expect(boxesResult.boxes.length).toBe(2);
    expect(boxesResult.boxes.every(b => b.status === 'proven')).toBe(true);
  });
});
