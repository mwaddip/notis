import { describe, it, expect } from 'vitest';
import { resolveTip } from '../src/tip.js';
import { fetchListing, proveFigures } from '../src/boxes.js';
import type { Anchor } from '../src/boxes.js';
import {
  buildHoldingsFixture,
  buildMinedChain,
  clockAfterChain,
  createFakeNode,
  devnetProfile,
  hexToBytes,
  jsonResponse,
  karmaBoxFor,
  rangeAnswerFromProver,
  singleKeyAnswerFromProver,
  suffixHeadForChain,
} from './helpers.js';
import { identityKey } from '@dagsocial/types';
import type { HoldingKind } from '@dagsocial/consensus';
import type { IdentityRecord, UserId } from '@dagsocial/types';

const M = 6;
const K = 6;
const CHAIN_LEN = M + K + 10;
const FAKE_USER = 'ab'.repeat(32);
const FAKE_USER_BYTES = hexToBytes(FAKE_USER) as UserId;
const RECORD_KEY_BYTES = identityKey(FAKE_USER_BYTES);
const RECORD_KEY_HEX = Buffer.from(RECORD_KEY_BYTES).toString('hex');

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

describe('end-to-end: tip + figures', () => {
  it("proven flow — the CLI's composition, all four surfaces wired", async () => {
    // One karma box held in both heights' states, under the chain's stateRoot.
    const karma = karmaBoxFor(FAKE_USER_BYTES, 100n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: FAKE_USER_BYTES, record: RECORD_STANDING }],
    });
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: fixture.stateRoot });
    const suffixHead = suffixHeadForChain(chain, M, K);
    const profile = devnetProfile();
    const now = clockAfterChain(chain);

    // The figure surface served over the chain: /karma listing, /credits
    // 404, the range route for both ledgers at both heights, the single-key
    // route for the identity record, and /blocks/current.
    function figureFetch(nodeUrl: string, base: (url: string) => Promise<Response>) {
      return async (url: string): Promise<Response> => {
        const u = new URL(url);
        if (u.origin !== new URL(nodeUrl).origin) return base(url);
        if (u.pathname === `/karma/${FAKE_USER}`) {
          return jsonResponse(200, {
            userId: FAKE_USER, total: '100', effective: '100',
            boxes: [{ boxId: karma.id!, value: '100' }],
            next: null, height: chain.headers.length,
          });
        }
        if (u.pathname === `/credits/${FAKE_USER}`) {
          return jsonResponse(404, { error: 'not found' });
        }
        const rangeMatch = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/[0-9a-f]{64}$/);
        if (rangeMatch) {
          const kind = rangeMatch[1] as HoldingKind;
          const atHeight = Number(u.searchParams.get('atHeight'));
          const fromHex = u.searchParams.get('from');
          const from = fromHex === null ? null : hexToBytes(fromHex);
          const limit = Number(u.searchParams.get('limit') ?? '256');
          return jsonResponse(200, rangeAnswerFromProver(fixture.prover, fixture.stateRoot, atHeight, kind, FAKE_USER_BYTES, from, limit));
        }
        if (u.pathname === `/api/v1/proof/${RECORD_KEY_HEX}`) {
          const atHeight = Number(u.searchParams.get('atHeight'));
          return jsonResponse(200, singleKeyAnswerFromProver(fixture.prover, fixture.stateRoot, atHeight, RECORD_KEY_BYTES, 'record'));
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
    // Silence an unused warning on `suffixHead` — it's a sanity reference.
    expect(suffixHead.header.height).toBeGreaterThan(0);

    const anchor: Anchor = { tip: tipResult.tip!, suffixHead: tipResult.suffixHead! };
    const listing = await fetchListing(tipResult.winner!.url, FAKE_USER, combinedFetch);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;

    const figures = await proveFigures(
      tipResult.winner!.url, FAKE_USER, listing.listing, anchor, profile, combinedFetch,
    );
    expect(figures.failed).toBe(false);
    expect(figures.karma.proven).toBe(100n);
    expect(figures.karma.holdings).toBe('read');
    expect(figures.credits.holdings).toBe('read');
    expect(figures.boxes[0]!.status).toBe('proven');

    const jsonObj: Record<string, unknown> = {
      tip: tipResult.tip ? { height: tipResult.tip.height } : null,
      nodes: tipResult.nodes.map((n) => ({ url: n.url, verified: n.verified })),
      splits: tipResult.splits,
      boxes: figures.boxes.map((b) => ({
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
