import { describe, it, expect } from 'vitest';
import { resolveTip } from '../src/tip.js';
import { fetchListing, proveFigures } from '../src/boxes.js';
import type { Anchor } from '../src/boxes.js';
import {
  buildMinedChain,
  buildAvlWithInsertions,
  boxInsertion,
  recordInsertion,
  createFakeNode,
  devnetProfile,
  clockAfterChain,
  suffixHeadForChain,
  hexToBytes,
  jsonResponse,
} from './helpers.js';
import { computeCandidateBoxId, identityRecordKey } from '@dagsocial/types';
import type { AnyBoxCandidate, IdentityRecord, TxId, UserId } from '@dagsocial/types';

const M = 6;
const K = 6;
const CHAIN_LEN = M + K + 10;
const FAKE_USER = 'ab'.repeat(32);
const FAKE_USER_BYTES = hexToBytes(FAKE_USER) as UserId;
const FAKE_TXID = 'cd'.repeat(32) as TxId;
const RECORD_KEY = identityRecordKey(FAKE_USER_BYTES);

const RECORD_STANDING: IdentityRecord = {
  lastActivityBlock: 5,
  lastDecayBlock: 5,
  invitedAtBlock: 1,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 0,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
};

function karmaCandidate(value: bigint): AnyBoxCandidate {
  return {
    boxType: 'karma' as const,
    value,
    createdAtBlock: 1,
    owner: FAKE_USER_BYTES,
  };
}

describe('end-to-end: tip + figures', () => {
  it('proven flow — the CLI\'s composition, all four surfaces wired', async () => {
    const cand = karmaCandidate(100n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(FAKE_USER_BYTES, RECORD_STANDING),
    ]);
    // A mined chain whose header carries the AVL digest — the tip's stateRoot
    // is what proveFigures binds tip proofs to.
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: avl.digest });
    const suffixHead = suffixHeadForChain(chain, M, K);
    const profile = devnetProfile();
    const now = clockAfterChain(chain);

    // Wire the two nodes' figure surface (karma listing, credits 404, proof
    // endpoint, /blocks/current) beside the existing tip endpoints.
    function figureFetch(nodeUrl: string, base: (url: string) => Promise<Response>) {
      return async (url: string): Promise<Response> => {
        const u = new URL(url);
        if (u.origin !== new URL(nodeUrl).origin) return base(url);
        if (u.pathname === `/karma/${FAKE_USER}`) {
          return jsonResponse(200, {
            userId: FAKE_USER, total: '100', effective: '100',
            boxes: [{ boxId, value: '100' }],
            next: null, height: chain.headers.length,
          });
        }
        if (u.pathname === `/credits/${FAKE_USER}`) {
          return jsonResponse(404, { error: 'not found' });
        }
        if (u.pathname === `/api/v1/proof/${boxId}`) {
          const e = avl.entries.get(boxId)!;
          return jsonResponse(200, {
            boxId, atHeight: suffixHead.header.height, stateRoot: avl.digest,
            proof: Buffer.from(e.proof).toString('base64'),
            kind: 'box', value: null,
          });
        }
        if (u.pathname === `/api/v1/proof/${RECORD_KEY}`) {
          const e = avl.entries.get(RECORD_KEY)!;
          return jsonResponse(200, {
            boxId: RECORD_KEY, atHeight: suffixHead.header.height, stateRoot: avl.digest,
            proof: Buffer.from(e.proof).toString('base64'),
            kind: 'record', value: null,
          });
        }
        if (u.pathname === '/blocks/current') {
          return jsonResponse(200, { height: chain.headers.length, hash: null });
        }
        return base(url);
      };
    }

    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });

    const combinedFetch = async (url: string): Promise<Response> => {
      if (url.startsWith('http://a:3000')) return figureFetch('http://a:3000', nodeA.fetch)(url);
      return figureFetch('http://b:3001', nodeB.fetch)(url);
    };

    const tipResult = await resolveTip(
      ['http://a:3000', 'http://b:3001'],
      M, K, profile, now, combinedFetch,
    );
    expect(tipResult.winner).not.toBeNull();
    expect(tipResult.splits).toEqual([]);

    const anchor: Anchor = { tip: tipResult.tip!, suffixHead: tipResult.suffixHead! };
    const listing = await fetchListing(tipResult.winner!.url, FAKE_USER, combinedFetch);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;

    const figures = await proveFigures(
      tipResult.winner!.url, FAKE_USER, listing.listing, anchor, profile, combinedFetch,
    );
    expect(figures.failed).toBe(false);
    expect(figures.karma.proven).toBe(100n);
    expect(figures.boxes[0]!.status).toBe('proven');

    // The --json shape at index.ts: assert the field names and their round-trip.
    const jsonObj: Record<string, unknown> = {
      tip: tipResult.tip ? { height: tipResult.tip.height } : null,
      nodes: tipResult.nodes.map(n => ({ url: n.url, verified: n.verified })),
      splits: tipResult.splits,
      boxes: figures.boxes.map(b => ({
        boxId: b.boxId, class: b.boxClass,
        value: b.value.toString(), lockedUntilBlock: b.lockedUntilBlock,
        status: b.status, verdict: b.verdict,
      })),
      karmaTotal: figures.karma.proven.toString(),
      creditTotal: figures.credits.proven.toString(),
      record: { status: figures.record.status },
      heightAfter: figures.heightAfter,
    };
    const parsed = JSON.parse(JSON.stringify(jsonObj));
    expect(parsed.karmaTotal).toBe('100');
    expect(parsed.boxes[0].status).toBe('proven');
    expect(parsed.record.status).toBe('proven');
    expect(parsed.heightAfter).toBe(chain.headers.length);
  });
});
