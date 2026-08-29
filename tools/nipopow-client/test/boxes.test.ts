import { describe, it, expect } from 'vitest';
import { proveBoxes } from '../src/boxes.js';
import {
  buildMinedChain,
  buildAvlFixture,
  buildAvlExclusionProof,
  buildMismatchedAvlFixture,
  createFakeNode,
  suffixHeadForChain,
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

describe('box proving', () => {
  it('a proven karma box', async () => {
    const candidate = karmaCandidate(100n);
    const boxId = computeCandidateBoxId(candidate, FAKE_TXID, 0);

    const avl = buildAvlFixture([{ candidate, txId: FAKE_TXID, index: 0 }]);
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: avl.digest });
    const suffixHead = suffixHeadForChain(chain, M, K);

    const node = createFakeNode({
      url: 'http://a:3000',
      chain,
      m: M,
      k: K,
      avl,
      karmaBoxes: { userId: FAKE_USER, boxes: [{ boxId, value: 100 }] },
    });

    const result = await proveBoxes('http://a:3000', FAKE_USER, suffixHead, node.fetch);
    expect(result.failed).toBe(false);
    expect(result.boxes.length).toBe(1);
    expect(result.boxes[0]!.status).toBe('proven');
    expect(result.boxes[0]!.verdict).toBe('proven');
    expect(result.boxes[0]!.value).toBe(100n);
    expect(result.karmaTotal).toBe(100n);
  });

  it('404 listing → no boxes, not an error', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const suffixHead = suffixHeadForChain(chain, M, K);

    const node = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const result = await proveBoxes('http://a:3000', FAKE_USER, suffixHead, node.fetch);
    expect(result.failed).toBe(false);
    expect(result.boxes.length).toBe(0);
  });

  it('unconfirmed box (absent at depth k) → not a failure', async () => {
    const absentBoxId = 'bb'.repeat(32);

    const otherCandidate = karmaCandidate(1n);
    const otherTxId = '11'.repeat(32) as TxId;
    const exclusion = buildAvlExclusionProof(
      [{ candidate: otherCandidate, txId: otherTxId, index: 0 }],
      absentBoxId,
    );

    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: exclusion.digest });
    const suffixHead = suffixHeadForChain(chain, M, K);

    const httpFetch = async (url: string) => {
      if (url.includes('/karma/')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            userId: FAKE_USER,
            total: '50',
            boxes: [{ boxId: absentBoxId, value: '50' }],
            lastActivityBlock: 0,
            lastDecayBlock: 0,
            height: chain.headers.length,
          }),
        } as unknown as Response;
      }
      if (url.includes('/credits/')) {
        return { ok: false, status: 404, text: async () => '{}' } as unknown as Response;
      }
      if (url.includes('/api/v1/proof/')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            boxId: absentBoxId,
            atHeight: suffixHead.header.height,
            stateRoot: suffixHead.header.stateRoot,
            proof: Buffer.from(exclusion.proof).toString('base64'),
            kind: null,
            value: null,
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => '{}' } as unknown as Response;
    };

    const result = await proveBoxes('http://a:3000', FAKE_USER, suffixHead, httpFetch);
    expect(result.failed).toBe(false);
    expect(result.boxes[0]!.status).toBe('unconfirmed');
    expect(result.boxes[0]!.verdict).toBe('unconfirmed at depth k');
    expect(result.karmaTotal).toBe(0n);
  });

  it('stateRoot mismatch → unproven, exit 1', async () => {
    const candidate = karmaCandidate(50n);
    const boxId = computeCandidateBoxId(candidate, FAKE_TXID, 0);

    const avl = buildAvlFixture([{ candidate, txId: FAKE_TXID, index: 0 }]);
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: avl.digest });
    const suffixHead = suffixHeadForChain(chain, M, K);

    const wrongStateRoot = '01'.repeat(33);
    const node = createFakeNode({
      url: 'http://a:3000',
      chain,
      m: M,
      k: K,
      avl,
      karmaBoxes: { userId: FAKE_USER, boxes: [{ boxId, value: 50 }] },
      overrideAvlResponses: new Map([[boxId, {
        boxId,
        atHeight: suffixHead.header.height,
        stateRoot: wrongStateRoot,
        proof: Buffer.from(new Uint8Array(0)).toString('base64'),
        kind: 'box',
        value: null,
      }]]),
    });

    const result = await proveBoxes('http://a:3000', FAKE_USER, suffixHead, node.fetch);
    expect(result.failed).toBe(true);
    expect(result.boxes[0]!.verdict).toBe('unproven: stateRoot mismatch');
  });

  it('tampered AVL proof → unproven: proof rejected', async () => {
    const candidate = karmaCandidate(50n);
    const boxId = computeCandidateBoxId(candidate, FAKE_TXID, 0);

    const avl = buildAvlFixture([{ candidate, txId: FAKE_TXID, index: 0 }]);
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: avl.digest });
    const suffixHead = suffixHeadForChain(chain, M, K);

    const entry = avl.entries.get(boxId)!;
    const tampered = Uint8Array.from(entry.proof);
    if (tampered.length > 2) tampered[2] = (tampered[2] ?? 0) ^ 0xff;

    const node = createFakeNode({
      url: 'http://a:3000',
      chain,
      m: M,
      k: K,
      avl,
      karmaBoxes: { userId: FAKE_USER, boxes: [{ boxId, value: 50 }] },
      overrideAvlResponses: new Map([[boxId, {
        boxId,
        atHeight: suffixHead.header.height,
        stateRoot: suffixHead.header.stateRoot,
        proof: Buffer.from(tampered).toString('base64'),
        kind: 'box',
        value: null,
      }]]),
    });

    const result = await proveBoxes('http://a:3000', FAKE_USER, suffixHead, node.fetch);
    expect(result.failed).toBe(true);
    expect(result.boxes[0]!.verdict).toBe('unproven: proof rejected');
  });

  it('value does not hash to key → unproven', async () => {
    const candidate = karmaCandidate(50n);
    const fakeKey = 'aa'.repeat(32);

    const avl = buildMismatchedAvlFixture(fakeKey, candidate, FAKE_TXID, 0);
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: avl.digest });
    const suffixHead = suffixHeadForChain(chain, M, K);

    const entry = avl.entries.get(fakeKey)!;

    const node = createFakeNode({
      url: 'http://a:3000',
      chain,
      m: M,
      k: K,
      avl,
      karmaBoxes: { userId: FAKE_USER, boxes: [{ boxId: fakeKey, value: 50 }] },
      overrideAvlResponses: new Map([[fakeKey, {
        boxId: fakeKey,
        atHeight: suffixHead.header.height,
        stateRoot: suffixHead.header.stateRoot,
        proof: Buffer.from(entry.proof).toString('base64'),
        kind: 'box',
        value: null,
      }]]),
    });

    const result = await proveBoxes('http://a:3000', FAKE_USER, suffixHead, node.fetch);
    expect(result.failed).toBe(true);
    expect(result.boxes[0]!.verdict).toBe('unproven: value does not hash to the key');
  });

  it('window miss (404) → exit 1', async () => {
    const candidate = karmaCandidate(50n);
    const boxId = computeCandidateBoxId(candidate, FAKE_TXID, 0);

    const chain = buildMinedChain({ count: CHAIN_LEN });
    const suffixHead = suffixHeadForChain(chain, M, K);

    const httpFetch = async (url: string) => {
      if (url.includes('/karma/')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            userId: FAKE_USER,
            total: 50,
            boxes: [{ boxId, value: 50 }],
            lastActivityBlock: 0,
            lastDecayBlock: 0,
            height: chain.headers.length,
          }),
        } as unknown as Response;
      }
      if (url.includes('/credits/')) {
        return { ok: false, status: 404, text: async () => '{}' } as unknown as Response;
      }
      if (url.includes('/api/v1/proof/')) {
        return { ok: false, status: 404, text: async () => '{"error":"height not available"}' } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => '{}' } as unknown as Response;
    };

    const result = await proveBoxes('http://a:3000', FAKE_USER, suffixHead, httpFetch);
    expect(result.failed).toBe(true);
    expect(result.boxes[0]!.verdict).toContain('checkpoint window');
  });

  it('kind: record for a box id → finding, unproven', async () => {
    const candidate = karmaCandidate(50n);
    const boxId = computeCandidateBoxId(candidate, FAKE_TXID, 0);

    const avl = buildAvlFixture([{ candidate, txId: FAKE_TXID, index: 0 }]);
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: avl.digest });
    const suffixHead = suffixHeadForChain(chain, M, K);

    const node = createFakeNode({
      url: 'http://a:3000',
      chain,
      m: M,
      k: K,
      avl,
      karmaBoxes: { userId: FAKE_USER, boxes: [{ boxId, value: 50 }] },
      overrideAvlResponses: new Map([[boxId, {
        boxId,
        atHeight: suffixHead.header.height,
        stateRoot: suffixHead.header.stateRoot,
        proof: Buffer.from(new Uint8Array(0)).toString('base64'),
        kind: 'record',
        value: null,
      }]]),
    });

    const result = await proveBoxes('http://a:3000', FAKE_USER, suffixHead, node.fetch);
    expect(result.failed).toBe(true);
    expect(result.boxes[0]!.verdict).toContain('record');
  });

  it('kind: network for a box id → finding, unproven', async () => {
    const candidate = karmaCandidate(50n);
    const boxId = computeCandidateBoxId(candidate, FAKE_TXID, 0);

    const avl = buildAvlFixture([{ candidate, txId: FAKE_TXID, index: 0 }]);
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: avl.digest });
    const suffixHead = suffixHeadForChain(chain, M, K);

    const node = createFakeNode({
      url: 'http://a:3000',
      chain,
      m: M,
      k: K,
      avl,
      karmaBoxes: { userId: FAKE_USER, boxes: [{ boxId, value: 50 }] },
      overrideAvlResponses: new Map([[boxId, {
        boxId,
        atHeight: suffixHead.header.height,
        stateRoot: suffixHead.header.stateRoot,
        proof: Buffer.from(new Uint8Array(0)).toString('base64'),
        kind: 'network',
        value: null,
      }]]),
    });

    const result = await proveBoxes('http://a:3000', FAKE_USER, suffixHead, node.fetch);
    expect(result.failed).toBe(true);
    expect(result.boxes[0]!.verdict).toContain('network');
  });
});
