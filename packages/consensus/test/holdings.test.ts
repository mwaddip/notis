import { describe, it, expect } from 'vitest';
import { BatchAVLVerifier, StrictBatchAVLVerifier } from '@ergots/avltree';
import {
  TREE_KEY_LENGTH,
  creditOfRange,
  karmaOfRange,
} from '@dagsocial/types';
import type { AnyBox, CreditBox, IdentityRecord, NetworkRecord, VouchBox } from '@dagsocial/types';
import {
  TreeInconsistencyError,
  holdingsPage,
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
import { TREE_CONFIG, proverFrom, recordingSession } from './block-proof.js';
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

  it('an owner whose range is the tree\'s last — the range\'s start past every leaf — answers { boxes: [], next: null }', () => {
    const view = treeStateView(mapSessionFrom(seed()));
    // omega = all 0xff: `karmaOfRange(omega).prefix` = `0x10 || 0xff^32`, past every other karma key in the fixture.
    for (const kind of ['karma', 'credit', 'escrow', 'vouch', 'accrual'] as const) {
      const page = holdingsPage(view, kind, omega, null, 10);
      expect(page.boxes).toEqual([]);
      expect(page.next).toBeNull();
    }
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

  it('`from` an absent key inside the range resumes at the next leaf', () => {
    const view = treeStateView(mapSessionFrom(seed()));
    const ids = aliceHoldings('credit');
    // Between the second and the third leaf: the second's id with a bit flipped past its last.
    const second = hexBytes(ids[1]!);
    const bumped = new Uint8Array(second);
    for (let i = bumped.length - 1; i >= 0; i--) {
      if (bumped[i]! < 0xff) { bumped[i]!++; break; }
      bumped[i] = 0;
    }
    const key = new Uint8Array(TREE_KEY_LENGTH);
    key.set(creditOfRange(alice).prefix, 0);
    key.set(bumped, 33);
    const page = holdingsPage(view, 'credit', alice, key, 2);
    // Between `second` and `third` lives nothing — the walk resumes at the next leaf,
    // which the fixture's lexicographic order makes the next of the sorted five.
    const nextId = page.boxes[0]?.id;
    expect(nextId !== undefined && nextId >= ids[2]!).toBe(true);
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
