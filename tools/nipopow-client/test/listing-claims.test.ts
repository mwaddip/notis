import { describe, it, expect } from 'vitest';
import { proveFigures } from '../src/boxes.js';
import type { Listing } from '../src/boxes.js';
import {
  buildHoldingsFixture,
  creditBoxFor,
  devnetProfile,
  hexToBytes,
  karmaBoxFor,
  makeAnchor,
  twoHeightNode,
} from './helpers.js';
import type { IdentityRecord, UserId } from '@dagsocial/types';

// WEB_INTERFACE → The extension → "The verified figures" — the listing is a list
// to prove, never a fact: an id it names more than once is proven once from
// the second place on, and a value or a lock it states is the box's own or
// the box is unproven. The rule stands under the range run: a range already
// fixes a box's owner and type, so the value and lock are what the listing
// must match.

const USER_HEX = 'ab'.repeat(32);
const USER_BYTES = hexToBytes(USER_HEX) as UserId;
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

// The boxes each test's held sets draw from — a karma box held at both heights,
// a locked and an unlocked credit box also held at both, and a `young` karma
// box only at tip. Each test builds its own fixtures from a chosen subset so
// a held box the listing lacks never slips in.
const KARMA = karmaBoxFor(USER_BYTES, 100n, 1);
const LOCKED = creditBoxFor(USER_BYTES, 40n, 2, 1, 500);
const UNLOCKED = creditBoxFor(USER_BYTES, 25n, 3);
const YOUNG = karmaBoxFor(USER_BYTES, 7n, 4, 110);

/**
 * The duplicate-id and value/lock tests set `heightAfter: TIP_H`, build
 * fixtures that hold exactly the boxes they list (plus any `young`-only
 * ones), and name the listed value `TIP_H` for the valuation to run. The
 * caller sets `heldBoxes` so no held box falls outside the listing.
 */
function prove(opts: {
  heldAtSuffix: readonly { id?: string }[];
  heldAtTip: readonly { id?: string }[];
  karma: unknown[];
  credits: unknown[];
}) {
  const suffix = buildHoldingsFixture({
    boxes: opts.heldAtSuffix as Parameters<typeof buildHoldingsFixture>[0]['boxes'],
    records: [{ identityId: USER_BYTES, record: RECORD }],
  });
  const tip = buildHoldingsFixture({
    boxes: opts.heldAtTip as Parameters<typeof buildHoldingsFixture>[0]['boxes'],
    records: [{ identityId: USER_BYTES, record: RECORD }],
  });
  const anchor = makeAnchor(TIP_H, tip.stateRoot, SUFFIX_H, suffix.stateRoot);
  const node = twoHeightNode({ suffix, suffixHeight: SUFFIX_H, tip, tipHeight: TIP_H, heightAfter: TIP_H });
  const listing: Listing = {
    karma: { boxes: opts.karma as Listing['karma']['boxes'], height: TIP_H, effective: '0' },
    credits: { boxes: opts.credits as NonNullable<Listing['credits']>['boxes'] },
  };
  return { fetch: node.fetch, calls: node.calls, result: proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch) };
}

describe('an id the listing names more than once is unproven from its second place on', () => {
  it('a karma box listed twice: first place proven, second unproven, karma.proven = the box\'s value', async () => {
    // KARMA.id listed twice under karma: the first entry proves the box, the
    // second is a duplicate — unproven, the id already in `named`.
    const { result } = prove({
      heldAtSuffix: [KARMA],
      heldAtTip: [KARMA],
      karma: [{ boxId: KARMA.id!, value: '100' }, { boxId: KARMA.id!, value: '100' }],
      credits: [],
    });
    const r = await result;
    expect(r.boxes.map((b) => b.status)).toEqual(['proven', 'unproven']);
    expect(r.boxes[1]!.verdict).toBe(`unproven: the listed boxId is named earlier in the listing: '${KARMA.id!}'`);
    expect(r.karma.proven).toBe(100n);
    expect(r.failed).toBe(true);
  });

  it('an id listed under karma and again under credits: the credits place is unproven, credits.proven zero', async () => {
    const { result } = prove({
      heldAtSuffix: [KARMA],
      heldAtTip: [KARMA],
      karma: [{ boxId: KARMA.id!, value: '100' }],
      credits: [{ boxId: KARMA.id!, value: '100' }],
    });
    const r = await result;
    expect(r.boxes.map((b) => [b.boxClass, b.status])).toEqual([['karma', 'proven'], ['credit', 'unproven']]);
    expect(r.boxes[1]!.verdict).toBe(`unproven: the listed boxId is named earlier in the listing: '${KARMA.id!}'`);
    expect(r.credits.proven).toBe(0n);
  });

  it('an id named again in another case is the same id, unproven in its second place', async () => {
    const upper = KARMA.id!.toUpperCase();
    const { result } = prove({
      heldAtSuffix: [KARMA],
      heldAtTip: [KARMA],
      karma: [{ boxId: KARMA.id!, value: '100' }, { boxId: upper, value: '100' }],
      credits: [],
    });
    const r = await result;
    expect(r.boxes.map((b) => b.status)).toEqual(['proven', 'unproven']);
    expect(r.boxes[1]!.verdict).toBe(`unproven: the listed boxId is named earlier in the listing: '${upper}'`);
  });

  // TYPES_INTERFACE → Export table — hexToBytes is strict, lowercase only.
  // An uppercase listing entry is checked case-insensitively, so it must
  // reach the AVL key decode in its one lowercase form.
  it('an uppercase boxId, listed once, is proven in its one lowercase form', async () => {
    const upper = KARMA.id!.toUpperCase();
    const { result } = prove({
      heldAtSuffix: [KARMA],
      heldAtTip: [KARMA],
      karma: [{ boxId: upper, value: '100' }],
      credits: [],
    });
    const r = await result;
    expect(r.boxes[0]!.status).toBe('proven');
    expect(r.boxes[0]!.boxId).toBe(KARMA.id!);
    expect(r.karma.proven).toBe(100n);
    expect(r.failed).toBe(false);
  });
});

describe('a listed value or lock that is not the box\'s own is unproven', () => {
  it('a real box listed at another value is unproven, the verdict naming both values', async () => {
    const { result } = prove({
      heldAtSuffix: [KARMA],
      heldAtTip: [KARMA],
      karma: [{ boxId: KARMA.id!, value: '500' }],
      credits: [],
    });
    const r = await result;
    expect(r.boxes[0]!.status).toBe('unproven');
    expect(r.boxes[0]!.verdict).toBe('unproven: candidate value 100 does not match listing 500');
    expect(r.karma.proven).toBe(0n);
    expect(r.failed).toBe(true);
  });

  it('a young box listed at another value is unproven', async () => {
    const { result } = prove({
      heldAtSuffix: [],
      heldAtTip: [YOUNG],
      karma: [{ boxId: YOUNG.id!, value: '9' }],
      credits: [],
    });
    const r = await result;
    expect(r.boxes[0]!.status).toBe('unproven');
    expect(r.boxes[0]!.verdict).toBe('unproven: candidate value 7 does not match listing 9');
    expect(r.karma.young).toBe(0n);
  });

  it('a credit box listed with its own lock is proven, the lock the candidate\'s', async () => {
    const { result } = prove({
      heldAtSuffix: [LOCKED],
      heldAtTip: [LOCKED],
      karma: [],
      credits: [{ boxId: LOCKED.id!, value: '40', lockedUntilBlock: 500 }],
    });
    const r = await result;
    expect(r.boxes[0]!.status).toBe('proven');
    expect(r.boxes[0]!.lockedUntilBlock).toBe(500);
    expect(r.credits.proven).toBe(40n);
    expect(r.failed).toBe(false);
  });

  it('an unlocked credit box listed without a lock is proven', async () => {
    const { result } = prove({
      heldAtSuffix: [UNLOCKED],
      heldAtTip: [UNLOCKED],
      karma: [],
      credits: [{ boxId: UNLOCKED.id!, value: '25' }],
    });
    const r = await result;
    expect(r.boxes[0]!.status).toBe('proven');
    expect(r.boxes[0]!.lockedUntilBlock).toBeNull();
  });

  it.each([
    ['without its lock', { boxId: LOCKED.id!, value: '40' }, 'candidate lockedUntilBlock 500 does not match listing none', [LOCKED]],
    ['with another lock', { boxId: LOCKED.id!, value: '40', lockedUntilBlock: 499 }, 'candidate lockedUntilBlock 500 does not match listing 499', [LOCKED]],
    ['with a lock that is a string', { boxId: LOCKED.id!, value: '40', lockedUntilBlock: '500' }, "candidate lockedUntilBlock 500 does not match listing '500'", [LOCKED]],
    ['with a lock that refuses conversion to a string', { boxId: LOCKED.id!, value: '40', lockedUntilBlock: { toString: 1 } }, 'candidate lockedUntilBlock 500 does not match listing an object', [LOCKED]],
    ['with a lock it does not carry', { boxId: UNLOCKED.id!, value: '25', lockedUntilBlock: 10 }, 'candidate lockedUntilBlock none does not match listing 10', [UNLOCKED]],
  ])('a credit box listed %s is unproven, the verdict naming both locks', async (_shape, entry, verdict, held) => {
    const { result } = prove({
      heldAtSuffix: held,
      heldAtTip: held,
      karma: [],
      credits: [entry],
    });
    const r = await result;
    expect(r.boxes[0]!.status).toBe('unproven');
    expect(r.boxes[0]!.verdict).toBe(`unproven: ${verdict}`);
    expect(r.credits.proven).toBe(0n);
    expect(r.failed).toBe(true);
  });
});
