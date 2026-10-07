import { describe, it, expect } from 'vitest';
import { BatchAVLVerifier, StrictBatchAVLVerifier } from '@dagsocial/avltree';
import {
  TREE_KEY_LENGTH,
  boxKey,
  bytesToHex,
  creditOfRange,
  karmaOfKey,
  karmaOfRange,
  rangeStart,
} from '@dagsocial/types';
import type { AnyBox, CreditBox, IdentityRecord, NetworkRecord, VouchBox } from '@dagsocial/types';
import {
  TreeInconsistencyError,
  holdingsPage,
  isSentinel,
  seedTreeWrites,
  treeStateView,
  verifierSession,
} from '@dagsocial/consensus';
import type { HoldingKind, HoldingsPage } from '@dagsocial/consensus';
import {
  accrualBox,
  escrowBox,
  identityRecord,
  karmaBox,
  seedProvenance,
  uid,
  vouchBox,
} from './helpers.js';
import { TREE_CONFIG, loggingSession, proverFrom, recordingSession } from './block-proof.js';
import { mapSessionFrom } from './tree-session-map.js';

/**
 * `holdingsPage` (CONSENSUS_INTERFACE → The holdings page) over a tree view:
 * every kind's whole range, paging, next-key semantics, the three `RangeError`s,
 * a tree that contradicts itself, and the lookup bound. Then the same pages
 * replayed from a proof, over a plain and a strict step-by-step verifier.
 */

const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => uid(`holdings/${n}`)) as [Uint8Array, Uint8Array, Uint8Array];
// A key that sorts past every other 32-byte key: the "range at the tree's last".
const omega = new Uint8Array(32).fill(0xff);

/** Alice holds 5 credit boxes (for the paging case), one of every other kind; Bob holds one of each; Carol holds nothing. */
function fixtureBoxes(): AnyBox[] {
  let nonce = 1;
  const boxes: AnyBox[] = [];
  // Alice's five credit boxes — the paging target.
  for (let i = 0; i < 5; i++) {
    boxes.push(seedProvenance<CreditBox>({ boxType: 'credit', value: BigInt(100 + i), createdAtBlock: 1, owner: alice }, 1, nonce++));
  }
  // One of each other kind for Alice.
  boxes.push(karmaBox(alice, 10n, nonce++));
  boxes.push(escrowBox(alice, 20, nonce++));
  boxes.push(accrualBox(alice, 7n, nonce++));
  boxes.push(vouchBox(alice, bob, nonce++)); // Alice -> Bob
  // Bob holds one of each kind.
  boxes.push(karmaBox(bob, 11n, nonce++));
  boxes.push(seedProvenance<CreditBox>({ boxType: 'credit', value: 42n, createdAtBlock: 1, owner: bob }, 1, nonce++));
  boxes.push(escrowBox(bob, 25, nonce++));
  boxes.push(accrualBox(bob, 2n, nonce++));
  boxes.push(vouchBox(bob, alice, nonce++)); // Bob -> Alice
  return boxes;
}

function fixtureRecords(): Array<{ identityId: Uint8Array; record: IdentityRecord }> {
  return [
    { identityId: alice, record: identityRecord({ memberSinceBlock: 1 }) },
    { identityId: bob, record: identityRecord({ memberSinceBlock: 1 }) },
  ];
}

const network: NetworkRecord = { memberCount: 2 };
const seed = () => seedTreeWrites(fixtureBoxes(), fixtureRecords(), network);

const BOX_TYPE_OF: Readonly<Record<HoldingKind, AnyBox['boxType']>> = {
  karma: 'karma',
  credit: 'credit',
  escrow: 'vouch_escrow',
  vouch: 'vouch',
  accrual: 'like_accrual',
};

/** Alice's boxes of `kind`, taken from the fixture; keyed by box id ascending to match the walk. */
function aliceHoldings(kind: HoldingKind): string[] {
  const boxType = BOX_TYPE_OF[kind];
  const owner = alice;
  return fixtureBoxes()
    .filter((b) => b.boxType === boxType)
    .filter((b) => {
      if (kind === 'vouch') return (b as VouchBox).voucherId.every((byte, i) => byte === owner[i]);
      if (kind === 'accrual') return (b as { author: Uint8Array }).author.every((byte, i) => byte === owner[i]);
      return (b as { owner: Uint8Array }).owner.every((byte, i) => byte === owner[i]);
    })
    .map((b) => b.id!)
    .sort();
}

describe('holdingsPage — one kind at a time', () => {
  for (const kind of ['karma', 'credit', 'escrow', 'vouch', 'accrual'] as const) {
    it(`${kind}: answers Alice's boxes, in key order, next null`, () => {
      const view = treeStateView(mapSessionFrom(seed()));
      const page = holdingsPage(view, kind, alice, null, 256);
      expect(page.boxes.length).toBe(kind === 'credit' ? 5 : 1);
      expect(page.boxes.map((b) => b.id!)).toEqual(aliceHoldings(kind));
      expect(page.next).toBeNull();
      for (const box of page.boxes) expect(box.boxType).toBe(BOX_TYPE_OF[kind]);
    });
  }
});

describe('holdingsPage — paging over Alice\'s five credit boxes', () => {
  it('three pages of limit 2 chained by `next` answer the same five, the third holds one, its `next` null', () => {
    const view = treeStateView(mapSessionFrom(seed()));
    const expected = aliceHoldings('credit');
    expect(expected.length).toBe(5);
    const first = holdingsPage(view, 'credit', alice, null, 2);
    expect(first.boxes.length).toBe(2);
    expect(first.next).not.toBeNull();
    const second = holdingsPage(view, 'credit', alice, first.next, 2);
    expect(second.boxes.length).toBe(2);
    expect(second.next).not.toBeNull();
    const third = holdingsPage(view, 'credit', alice, second.next, 2);
    expect(third.boxes.length).toBe(1);
    expect(third.next).toBeNull();
    expect([...first.boxes, ...second.boxes, ...third.boxes].map((b) => b.id!)).toEqual(expected);
  });

  it('limit equal to the range\'s length answers next: null — never a key of the next owner\'s range', () => {
    const view = treeStateView(mapSessionFrom(seed()));
    const page = holdingsPage(view, 'credit', alice, null, 5);
    expect(page.boxes.length).toBe(5);
    expect(page.next).toBeNull();
  });
});

describe('holdingsPage — empty ranges', () => {
  it('an owner holding nothing answers { boxes: [], next: null } for every kind', () => {
    const view = treeStateView(mapSessionFrom(seed()));
    for (const kind of ['karma', 'credit', 'escrow', 'vouch', 'accrual'] as const) {
      expect(holdingsPage(view, kind, carol, null, 10)).toEqual({ boxes: [], next: null });
    }
  });

  // The holdings kinds in ascending tag order:
  //   karma 0x10, credit 0x11, escrow 0x12, vouch 0x15, accrual 0x17.
  // The tree the fixture seeds also carries `type` (0x18) and `castCount` (0x19)
  // entries where the state has them, so a holdings range at the fixture's
  // state is never the tree's last. These two cases carry a stripped-down state
  // in which an `accrual` range IS last.
  it('a non-empty range at the tree\'s last — the last entry\'s `nextKey` is the all-`0xff` sentinel — answers next: null and never looks a sentinel up', () => {
    // The tree holds Alice's two accrual boxes, their `box` entries and the
    // network record — nothing of a higher tag than 0x17, so Alice's accrual
    // range is at the tree's last.
    const author = alice;
    const held = [accrualBox(author, 1n, 100), accrualBox(author, 2n, 101)];
    const session = mapSessionFrom(seedTreeWrites(held, [], { memberCount: 1 }));
    const view = treeStateView(session);
    const page = holdingsPage(view, 'accrual', author, null, 10);
    expect(page.boxes.length).toBe(2);
    expect(page.next).toBeNull();
    expect(session.lookups.some(isSentinel)).toBe(false);
  });

  it('an empty range at the tree\'s last — the range\'s start\'s `nextKey` is the sentinel — answers { boxes: [], next: null } and never looks a sentinel up', () => {
    // Same stripped-down state, but query an owner whose accrual range is PAST
    // every leaf: owner = all-0xff bytes. The accrual range's start is then
    // `0x17 ‖ 0xff^32 ‖ 0^32`, past every leaf, and its `nextKey` is the
    // past-last sentinel.
    const otherAuthor = alice;
    const held = [accrualBox(otherAuthor, 1n, 110), accrualBox(otherAuthor, 2n, 111)];
    const session = mapSessionFrom(seedTreeWrites(held, [], { memberCount: 1 }));
    const view = treeStateView(session);
    const page = holdingsPage(view, 'accrual', omega, null, 10);
    expect(page.boxes).toEqual([]);
    expect(page.next).toBeNull();
    expect(session.lookups.some(isSentinel)).toBe(false);
  });
});

describe('holdingsPage — `from`', () => {
  it('`from` a leaf yields that leaf first', () => {
    const view = treeStateView(mapSessionFrom(seed()));
    const ids = aliceHoldings('credit');
    // The second credit box's key: tag 0x11 ‖ alice ‖ b32(id).
    const second = creditOfRange(alice).prefix;
    const key = new Uint8Array(TREE_KEY_LENGTH);
    key.set(second, 0);
    key.set(hexBytes(ids[1]!), 33);
    const page = holdingsPage(view, 'credit', alice, key, 2);
    expect(page.boxes.map((b) => b.id!)).toEqual([ids[1], ids[2]]);
  });

  it('`from` an absent key inside the range resumes at the next leaf — the page is the next two, `next` is the key of the one after', () => {
    const view = treeStateView(mapSessionFrom(seed()));
    const ids = aliceHoldings('credit');
    expect(ids.length).toBe(5);
    // Between the second and the third leaf: the second's id with its last byte
    // bumped one position past itself — still strictly below the third id.
    const second = hexBytes(ids[1]!);
    const bumped = new Uint8Array(second);
    for (let i = bumped.length - 1; i >= 0; i--) {
      if (bumped[i]! < 0xff) { bumped[i]!++; break; }
      bumped[i] = 0;
    }
    expect(bytesToHex(bumped) < ids[2]!).toBe(true);
    const key = new Uint8Array(TREE_KEY_LENGTH);
    key.set(creditOfRange(alice).prefix, 0);
    key.set(bumped, 33);
    const page = holdingsPage(view, 'credit', alice, key, 2);
    expect(page.boxes.map((b) => b.id!)).toEqual([ids[2], ids[3]]);
    const expectedNext = new Uint8Array(TREE_KEY_LENGTH);
    expectedNext.set(creditOfRange(alice).prefix, 0);
    expectedNext.set(hexBytes(ids[4]!), 33);
    expect(page.next).toEqual(expectedNext);
  });
});

describe('pageRange — the arguments it refuses', () => {
  const view = () => treeStateView(mapSessionFrom(seed()));
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    it(`\`limit\` ${String(limit)} — a RangeError naming the argument`, () => {
      const call = () => view().pageRange(karmaOfRange(alice), null, limit);
      expect(call).toThrow(RangeError);
      expect(call).toThrow(/^pageRange: limit/);
    });
  }
  it('`from` of 40 bytes — a RangeError naming the length', () => {
    const forty = new Uint8Array(40);
    forty.set(karmaOfRange(alice).prefix, 0);
    const call = () => view().pageRange(karmaOfRange(alice), forty, 2);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/^pageRange: from must be \d+ bytes, got 40/);
  });
  it(`\`from\` outside the range — a RangeError naming the prefix`, () => {
    const outside = new Uint8Array(TREE_KEY_LENGTH);
    outside.set(karmaOfRange(bob).prefix, 0); // Bob's karma range, not Alice's
    const call = () => view().pageRange(karmaOfRange(alice), outside, 2);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/^pageRange: from .* does not carry the range's prefix/);
  });
});

describe('holdingsPage — the arguments it refuses', () => {
  const view = () => treeStateView(mapSessionFrom(seed()));
  it('an `owner` of 31 bytes — a RangeError naming the argument', () => {
    const call = () => holdingsPage(view(), 'karma', new Uint8Array(31), null, 2);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/^holdingsPage: owner/);
  });
  it('`limit` and `from` are the view\'s to refuse: a `limit` of 0 reaches `pageRange`\'s message', () => {
    const call = () => holdingsPage(view(), 'karma', alice, null, 0);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/^pageRange: limit/);
  });
  it('a 40-byte `from` carrying the prefix reaches `pageRange`\'s length message', () => {
    const forty = new Uint8Array(40);
    forty.set(karmaOfRange(alice).prefix, 0);
    const call = () => holdingsPage(view(), 'karma', alice, forty, 2);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/^pageRange: from must be \d+ bytes, got 40/);
  });
  it('a `from` outside the kind\'s range for the owner reaches `pageRange`\'s prefix message', () => {
    const outside = new Uint8Array(TREE_KEY_LENGTH);
    outside.set(karmaOfRange(bob).prefix, 0);
    const call = () => holdingsPage(view(), 'karma', alice, outside, 2);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/^pageRange: from .* does not carry the range's prefix/);
  });
});

describe('holdingsPage — a tree that contradicts itself', () => {
  it('an entry naming a box that is not live is a TreeInconsistencyError', () => {
    // One Alice karma entry over an unseeded box: the entry stands, the box does not.
    const forged = new Uint8Array(TREE_KEY_LENGTH);
    forged.set(karmaOfRange(alice).prefix, 0);
    forged.set(hexBytes('a'.repeat(64)), 33);
    const writes = [...seed(), { tag: 'Insert' as const, key: forged, value: new Uint8Array(0) }];
    const view = treeStateView(mapSessionFrom(writes));
    expect(() => holdingsPage(view, 'karma', alice, null, 10)).toThrow(TreeInconsistencyError);
  });

  it('an entry naming a box of another type is a TreeInconsistencyError', () => {
    // Alice's karma box id, re-indexed as a credit entry for Alice.
    const aliceKarmaBoxId = fixtureBoxes().find((b) => b.boxType === 'karma')!.id!;
    const forged = new Uint8Array(TREE_KEY_LENGTH);
    forged.set(creditOfRange(alice).prefix, 0);
    forged.set(hexBytes(aliceKarmaBoxId), 33);
    const writes = [...seed(), { tag: 'Insert' as const, key: forged, value: new Uint8Array(0) }];
    const view = treeStateView(mapSessionFrom(writes));
    // Walking Alice's credits: the five legitimate entries, then the forged one.
    expect(() => holdingsPage(view, 'credit', alice, null, 10)).toThrow(TreeInconsistencyError);
  });
});

describe('holdingsPage — the lookup bound', () => {
  it('looks up at most 1 + 2 * limit keys through the view', () => {
    for (const limit of [1, 2, 3, 5]) {
      const view = treeStateView(mapSessionFrom(seed()));
      const before = view.lookupCount();
      holdingsPage(view, 'credit', alice, null, limit);
      const consumed = view.lookupCount() - before;
      expect(consumed, `limit ${limit}`).toBeLessThanOrEqual(1 + 2 * limit);
    }
  });
});

describe('holdingsPage — the order of a page\'s lookups is a rule', () => {
  // Three karma boxes for one owner. The sequence a page's lookups follow is
  // the walk's keys in key order, then each entry's box in the entries' order
  // (CONSENSUS_INTERFACE → The holdings page → "The order of the lookups is
  // the rule itself"). A node and a client of different builds meet over one
  // proof, so this order stands.
  const orderOwner = uid('holdings/order-owner');
  function fixtureThree(): AnyBox[] {
    return [karmaBox(orderOwner, 10n, 1), karmaBox(orderOwner, 20n, 2), karmaBox(orderOwner, 30n, 3)];
  }

  it('three karma entries, `from: null`: `rangeStart`, then each entry key in key order, then each box key in the entries\' order', () => {
    const boxes = fixtureThree();
    const prover = proverFrom(seedTreeWrites(boxes, [], { memberCount: 0 }));
    const parentDigest = prover.digest();
    const log = loggingSession(recordingSession(prover));
    const view = treeStateView(log);
    const page = holdingsPage(view, 'karma', orderOwner, null, 3);
    const sortedIds = page.boxes.map((b) => b.id!);
    const expected = [
      bytesToHex(rangeStart(karmaOfRange(orderOwner))),
      ...sortedIds.map((id) => bytesToHex(karmaOfKey(orderOwner, hexBytes(id)))),
      ...sortedIds.map((id) => bytesToHex(boxKey(hexBytes(id)))),
    ];
    expect(log.keys).toEqual(expected);
    // The replay reads the same sequence from the proof.
    const proof = prover.generateProof();
    const replayLog = loggingSession(verifierSession(new BatchAVLVerifier(parentDigest, proof, TREE_CONFIG)));
    const replayView = treeStateView(replayLog);
    const replayed = holdingsPage(replayView, 'karma', orderOwner, null, 3);
    expect(replayed.boxes.map((b) => b.id!)).toEqual(sortedIds);
    expect(replayLog.keys).toEqual(expected);
  });

  it('a `from` that is a leaf: the sequence opens with `from`', () => {
    const boxes = fixtureThree();
    const prover = proverFrom(seedTreeWrites(boxes, [], { memberCount: 0 }));
    const sortedIds = [...boxes.map((b) => b.id!)].sort();
    const fromKey = karmaOfKey(orderOwner, hexBytes(sortedIds[0]!));
    const parentDigest = prover.digest();
    const log = loggingSession(recordingSession(prover));
    const view = treeStateView(log);
    const page = holdingsPage(view, 'karma', orderOwner, fromKey, 2);
    expect(page.boxes.map((b) => b.id!)).toEqual([sortedIds[0], sortedIds[1]]);
    const expected = [
      bytesToHex(fromKey),
      bytesToHex(karmaOfKey(orderOwner, hexBytes(sortedIds[1]!))),
      bytesToHex(boxKey(hexBytes(sortedIds[0]!))),
      bytesToHex(boxKey(hexBytes(sortedIds[1]!))),
    ];
    expect(log.keys).toEqual(expected);
    // The replay reads the same sequence.
    const proof = prover.generateProof();
    const replayLog = loggingSession(verifierSession(new BatchAVLVerifier(parentDigest, proof, TREE_CONFIG)));
    const replayView = treeStateView(replayLog);
    const replayed = holdingsPage(replayView, 'karma', orderOwner, fromKey, 2);
    expect(replayed.boxes.map((b) => b.id!)).toEqual([sortedIds[0], sortedIds[1]]);
    expect(replayLog.keys).toEqual(expected);
  });
});

describe('holdingsPage — replayed over a verifier', () => {
  function provePage(kind: HoldingKind, owner: Uint8Array, from: Uint8Array | null, limit: number): {
    page: HoldingsPage;
    parentDigest: Uint8Array;
    proof: Uint8Array;
  } {
    const prover = proverFrom(seed());
    const parentDigest = prover.digest();
    const view = treeStateView(recordingSession(prover));
    const page = holdingsPage(view, kind, owner, from, limit);
    const proof = prover.generateProof();
    return { page, parentDigest, proof };
  }

  it("over `verifierSession(new BatchAVLVerifier(digest, proof, TREE_CONFIG))` answers the same boxes and the same `next`", () => {
    const ids = aliceHoldings('credit');
    expect(ids.length).toBe(5);
    const pages: HoldingsPage[] = [];
    let from: Uint8Array | null = null;
    for (let i = 0; i < 3; i++) {
      const { page, parentDigest, proof } = provePage('credit', alice, from, 2);
      const view = treeStateView(verifierSession(new BatchAVLVerifier(parentDigest, proof, TREE_CONFIG)));
      const replayed = holdingsPage(view, 'credit', alice, from, 2);
      expect(replayed.boxes.map((b) => b.id!)).toEqual(page.boxes.map((b) => b.id!));
      expect(replayed.next).toEqual(page.next);
      pages.push(replayed);
      from = replayed.next;
      if (from === null) break;
    }
    expect(pages.flatMap((p) => p.boxes.map((b) => b.id!))).toEqual(ids);
  });

  it('one byte of the proof altered: the replay throws rather than answering', () => {
    const { parentDigest, proof } = provePage('credit', alice, null, 2);
    const altered = Uint8Array.from(proof);
    const position = Math.floor(altered.length / 2);
    altered[position] = (altered[position] ?? 0) ^ 0x01;
    const view = treeStateView(verifierSession(new BatchAVLVerifier(parentDigest, altered, TREE_CONFIG)));
    expect(() => holdingsPage(view, 'credit', alice, null, 2)).toThrow();
  });

  it('a proof made for one `from` replayed with another: the replay throws', () => {
    const ids = aliceHoldings('credit');
    const atId = (id: string): Uint8Array => {
      const key = new Uint8Array(TREE_KEY_LENGTH);
      key.set(creditOfRange(alice).prefix, 0);
      key.set(hexBytes(id), 33);
      return key;
    };
    const aFrom = atId(ids[1]!);
    const bFrom = atId(ids[2]!);
    const { parentDigest, proof } = provePage('credit', alice, aFrom, 2);
    const view = treeStateView(verifierSession(new BatchAVLVerifier(parentDigest, proof, TREE_CONFIG)));
    expect(() => holdingsPage(view, 'credit', alice, bFrom, 2)).toThrow();
  });

  it('over a `StrictBatchAVLVerifier`: the same answer, and `isFullyConsumed()` is `true` after the page', () => {
    const { page, parentDigest, proof } = provePage('karma', alice, null, 4);
    const verifier = new StrictBatchAVLVerifier(parentDigest, proof, TREE_CONFIG);
    const view = treeStateView(verifierSession(verifier));
    const replayed = holdingsPage(view, 'karma', alice, null, 4);
    expect(replayed.boxes.map((b) => b.id!)).toEqual(page.boxes.map((b) => b.id!));
    expect(replayed.next).toEqual(page.next);
    expect(verifier.isFullyConsumed()).toBe(true);
  });
});

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
