import { describe, it, expect } from 'vitest';
import { proveFigures } from '../src/boxes.js';
import type { Listing } from '../src/boxes.js';
import type { HttpFetch } from '../src/http.js';
import {
  buildAvlWithInsertions,
  boxInsertion,
  recordInsertion,
  avlProofJson,
  hexToBytes,
  jsonResponse,
  makeAnchor,
  devnetProfile,
} from './helpers.js';
import { computeCandidateBoxId, identityRecordKey } from '@dagsocial/types';
import type { AnyBoxCandidate, IdentityRecord, TxId, UserId } from '@dagsocial/types';

// WEB_INTERFACE → The extension → "The verified figures" — the listing is a list
// to prove, never a fact: an id it names more than once is proven once, and a
// value or a lock it states is the box's own or the box is unproven.

const USER_HEX = 'ab'.repeat(32);
const USER_BYTES = hexToBytes(USER_HEX) as UserId;
const RECORD_KEY = identityRecordKey(USER_BYTES);
const TXID = 'cd'.repeat(32) as TxId;
const SUFFIX_H = 100;
const TIP_H = 119;

const RECORD: IdentityRecord = {
  lastActivityBlock: 50,
  lastDecayBlock: 50,
  invitedAtBlock: 10,
  lifetimeLikesReceived: 3n,
  memberSinceBlock: 20,
  memberBar: 5,
  memberVouches: 2,
  memberLikes: 1n,
  invitesUsed: 0,
};

const KARMA: AnyBoxCandidate = { boxType: 'karma', value: 100n, createdAtBlock: 1, owner: USER_BYTES };
const LOCKED: AnyBoxCandidate = {
  boxType: 'credit', value: 40n, createdAtBlock: 1, owner: USER_BYTES, lockedUntilBlock: 500,
};
const UNLOCKED: AnyBoxCandidate = { boxType: 'credit', value: 25n, createdAtBlock: 1, owner: USER_BYTES };
const YOUNG: AnyBoxCandidate = { boxType: 'karma', value: 7n, createdAtBlock: 110, owner: USER_BYTES };

const KARMA_ID = computeCandidateBoxId(KARMA, TXID, 0);
const LOCKED_ID = computeCandidateBoxId(LOCKED, TXID, 1);
const UNLOCKED_ID = computeCandidateBoxId(UNLOCKED, TXID, 2);
const YOUNG_ID = computeCandidateBoxId(YOUNG, TXID, 3);

// suffixHead's state holds three boxes and the record; the tip's adds YOUNG.
const SUFFIX = buildAvlWithInsertions(
  [
    boxInsertion(KARMA, TXID, 0),
    boxInsertion(LOCKED, TXID, 1),
    boxInsertion(UNLOCKED, TXID, 2),
    recordInsertion(USER_BYTES, RECORD),
  ],
  [YOUNG_ID],
);
const TIP = buildAvlWithInsertions([
  boxInsertion(KARMA, TXID, 0),
  boxInsertion(LOCKED, TXID, 1),
  boxInsertion(UNLOCKED, TXID, 2),
  boxInsertion(YOUNG, TXID, 3),
  recordInsertion(USER_BYTES, RECORD),
]);
const ANCHOR = makeAnchor(TIP_H, TIP.digest, SUFFIX_H, SUFFIX.digest);

// An honest node: each height's proofs from that height's tree; each proof
// request's path and query is logged in order.
function node(): { fetch: HttpFetch; proofCalls: string[] } {
  const proofCalls: string[] = [];
  const fetch: HttpFetch = async (url: string) => {
    const u = new URL(url);
    const proofMatch = u.pathname.match(/^\/api\/v1\/proof\/(.+)$/);
    if (proofMatch) {
      proofCalls.push(`${u.pathname}${u.search}`);
      const key = proofMatch[1]!;
      const at = Number(u.searchParams.get('atHeight'));
      const tree = at === SUFFIX_H ? SUFFIX : TIP;
      const entry = tree.entries.get(key);
      if (!entry) return jsonResponse(404, { error: 'height not available' });
      const kind = entry.value === null ? null : key === RECORD_KEY ? 'record' : 'box';
      return jsonResponse(200, avlProofJson(key, at, tree.digest, entry.proof, kind, null));
    }
    if (u.pathname === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
    return jsonResponse(404, { error: 'not found' });
  };
  return { fetch, proofCalls };
}

function prove(karma: unknown[], credits: unknown[], fetch: HttpFetch) {
  const listing: Listing = {
    karma: { boxes: karma as Listing['karma']['boxes'], height: TIP_H, effective: '0' },
    credits: { boxes: credits as Listing['credits']['boxes'] },
  };
  return proveFigures('http://a', USER_HEX, listing, ANCHOR, devnetProfile(), fetch);
}

const boxProofs = (calls: string[], id: string) => calls.filter(c => c.startsWith(`/api/v1/proof/${id}?`));

describe('an id the listing names more than once is unproven from its second place on', () => {
  it('a box listed twice in one ledger is proven once, the second place unproven with no proof asked', async () => {
    const { fetch, proofCalls } = node();
    const result = await prove([{ boxId: KARMA_ID, value: '100' }, { boxId: KARMA_ID, value: '100' }], [], fetch);
    expect(result.boxes.map(b => b.status)).toEqual(['proven', 'unproven']);
    expect(result.boxes[1]!.verdict).toBe(`unproven: the listed boxId is named earlier in the listing: '${KARMA_ID}'`);
    expect(result.karma.proven).toBe(100n);
    expect(result.failed).toBe(true);
    expect(boxProofs(proofCalls, KARMA_ID)).toEqual([`/api/v1/proof/${KARMA_ID}?atHeight=${SUFFIX_H}`]);
  });

  it('an id listed under karma and again under credits is unproven in the credits place, no proof asked', async () => {
    const { fetch, proofCalls } = node();
    const result = await prove([{ boxId: KARMA_ID, value: '100' }], [{ boxId: KARMA_ID, value: '100' }], fetch);
    expect(result.boxes.map(b => [b.boxClass, b.status])).toEqual([['karma', 'proven'], ['credit', 'unproven']]);
    expect(result.boxes[1]!.verdict).toBe(`unproven: the listed boxId is named earlier in the listing: '${KARMA_ID}'`);
    expect(result.credits.proven).toBe(0n);
    expect(boxProofs(proofCalls, KARMA_ID)).toHaveLength(1);
  });

  it('an id named again in another case is the same id, unproven in its second place', async () => {
    const { fetch, proofCalls } = node();
    const upper = KARMA_ID.toUpperCase();
    const result = await prove([{ boxId: KARMA_ID, value: '100' }, { boxId: upper, value: '100' }], [], fetch);
    expect(result.boxes.map(b => b.status)).toEqual(['proven', 'unproven']);
    expect(result.boxes[1]!.verdict).toBe(`unproven: the listed boxId is named earlier in the listing: '${upper}'`);
    expect(boxProofs(proofCalls, upper)).toEqual([]);
  });
});

describe('a listed value or lock that is not the box\'s own is unproven', () => {
  it('a real box listed at another value is unproven, the verdict naming both values', async () => {
    const { fetch } = node();
    const result = await prove([{ boxId: KARMA_ID, value: '500' }], [], fetch);
    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toBe('unproven at suffixHead: candidate value 100 does not match listing 500');
    expect(result.karma.proven).toBe(0n);
    expect(result.failed).toBe(true);
  });

  it('a young box listed at another value is unproven at tip', async () => {
    const { fetch } = node();
    const result = await prove([{ boxId: YOUNG_ID, value: '9' }], [], fetch);
    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toBe('unproven at tip: candidate value 7 does not match listing 9');
    expect(result.karma.young).toBe(0n);
  });

  it('a credit box listed with its own lock is proven, the lock the candidate\'s', async () => {
    const { fetch } = node();
    const result = await prove([], [{ boxId: LOCKED_ID, value: '40', lockedUntilBlock: 500 }], fetch);
    expect(result.boxes[0]!.status).toBe('proven');
    expect(result.boxes[0]!.lockedUntilBlock).toBe(500);
    expect(result.credits.proven).toBe(40n);
    expect(result.failed).toBe(false);
  });

  it('an unlocked credit box listed without a lock is proven', async () => {
    const { fetch } = node();
    const result = await prove([], [{ boxId: UNLOCKED_ID, value: '25' }], fetch);
    expect(result.boxes[0]!.status).toBe('proven');
    expect(result.boxes[0]!.lockedUntilBlock).toBeNull();
  });

  it.each([
    ['without its lock', { boxId: LOCKED_ID, value: '40' }, 'candidate lockedUntilBlock 500 does not match listing none'],
    ['with another lock', { boxId: LOCKED_ID, value: '40', lockedUntilBlock: 499 }, 'candidate lockedUntilBlock 500 does not match listing 499'],
    ['with a lock that is a string', { boxId: LOCKED_ID, value: '40', lockedUntilBlock: '500' }, "candidate lockedUntilBlock 500 does not match listing '500'"],
    ['with a lock that refuses conversion to a string', { boxId: LOCKED_ID, value: '40', lockedUntilBlock: { toString: 1 } }, 'candidate lockedUntilBlock 500 does not match listing an object'],
    ['with a lock it does not carry', { boxId: UNLOCKED_ID, value: '25', lockedUntilBlock: 10 }, 'candidate lockedUntilBlock none does not match listing 10'],
  ])('a credit box listed %s is unproven, the verdict naming both locks', async (_shape, entry, verdict) => {
    const { fetch } = node();
    const result = await prove([], [entry], fetch);
    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toBe(`unproven at suffixHead: ${verdict}`);
    expect(result.credits.proven).toBe(0n);
    expect(result.failed).toBe(true);
  });
});
