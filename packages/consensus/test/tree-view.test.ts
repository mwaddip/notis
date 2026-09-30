import { describe, it, expect } from 'vitest';
import {
  INDEX_MARKER,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  LIKE_MARKER,
  PROTOCOL_VERSION,
  STORAGE_RENT_PER_BYTE,
  TREE_TAG,
  bondDueKey,
  boxKey,
  boxRecordBytes,
  bytesToHex,
  castCountKey,
  equalBytes,
  escrowDueKey,
  hexToBytes,
  holderKey,
  holderRecordBytes,
  identityKey,
  karmaOfKey,
  karmaOfRange,
  lapsedKey,
  likeKey,
  nameKey,
  nameRecordBytes,
  postKey,
  postRecordBytes,
  profileFor,
  rangeStart,
  vouchPairKey,
  vouchPairRange,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, CreditBox, IdentityRecord, KarmaBox, NetworkRecord, UsernameBox, VouchBox } from '@dagsocial/types';
import { TreeInconsistencyError, applyBlock, isSentinel, seedTreeWrites, treeStateView, treeWritesOf } from '@dagsocial/consensus';
import type { ApplyContext, StateView, TreeSession, TreeWrite } from '@dagsocial/consensus';
import {
  MemoryStateView,
  accrualBox,
  applyContextFor,
  bondBox,
  burnTx,
  candidateBlock,
  changeOf,
  claimTx,
  consolidateTx,
  creditSendTx,
  escrowBox,
  finish,
  hex,
  identityRecord,
  inviteTx,
  karmaBox,
  labelNonce,
  likeTx,
  protocolBox,
  replyTx,
  seedProvenance,
  seededIdentity,
  threadTx,
  uid,
  unvouchTx,
  vouchBox,
  vouchTx,
  withdrawTx,
  writeEffects,
  type Built,
  type Stored,
  type TestIdentity,
} from './helpers.js';
import { mapSessionFrom } from './tree-session-map.js';

/**
 * The tree view (CONSENSUS_INTERFACE → The tree view): the `StateView` over a
 * tree session, checked read for read against `MemoryStateView` over the same
 * state, and its walks — where they stop, what they never look up, and what a
 * tree that contradicts itself answers. Then the round trip: a chain applied
 * over the tree view, each block's writes (CONSENSUS_INTERFACE → The tree
 * writes) applied to the session, against the reference applying the same
 * blocks.
 */

const [alice, bob, carol, dave, erin] = ['alice', 'bob', 'carol', 'dave', 'erin'].map((n) => uid(`tree-view/${n}`)) as [
  Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array,
];
const stranger = uid('tree-view/stranger');

const member = identityRecord({ memberSinceBlock: 1, memberBar: 1, memberVouches: 1 });
const lapsed = identityRecord({ memberSinceBlock: 2, memberBar: 3, memberVouches: 1 });
const invitedAt = (h: number): IdentityRecord => identityRecord({ invitedAtBlock: h });

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const karma = (owner: Uint8Array, value: bigint, label: string): AnyBox => karmaBox(owner, value, labelNonce(label));
const byte32 = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

/** The arguments every read is asked with. */
interface Probes {
  boxIds: readonly string[];
  identities: readonly Uint8Array[];
  names: readonly string[];
  posts: readonly string[];
  heights: readonly number[];
  limits: readonly number[];
}

/**
 * Every one of the 21 `StateView` reads (CONSENSUS_INTERFACE → StateView), asked
 * with every probe that fits it, as one object keyed by the call: two views
 * compare as one `toEqual`, and a difference names the call that answered it.
 */
function readsOf(view: StateView, probes: Probes): Record<string, unknown> {
  const reads: Record<string, unknown> = {};
  for (const id of probes.boxIds) {
    reads[`getBox(${id})`] = view.getBox(id);
    reads[`getBoxProvenance(${id})`] = view.getBoxProvenance(id);
  }
  for (const who of probes.identities) {
    reads[`getIdentityRecord(${hex(who)})`] = view.getIdentityRecord(who);
    reads[`getUsernameByOwner(${hex(who)})`] = view.getUsernameByOwner(who);
    reads[`getKarmaBoxes(${hex(who)})`] = view.getKarmaBoxes(who);
    reads[`getVouchEscrowsFor(${hex(who)})`] = view.getVouchEscrowsFor(who);
    reads[`getLikeAccrualBoxes(${hex(who)})`] = view.getLikeAccrualBoxes(who);
    for (const target of probes.identities) {
      reads[`getVouchBoxes(${hex(who)}, ${hex(target)})`] = view.getVouchBoxes(who, target);
    }
    for (const post of probes.posts) reads[`hasLikeRecord(${post}, ${hex(who)})`] = view.hasLikeRecord(post, who);
  }
  reads['getNetworkRecord()'] = view.getNetworkRecord();
  for (const name of probes.names) reads[`getUsername(${name})`] = view.getUsername(name);
  reads['getEmissionBox()'] = view.getEmissionBox();
  reads['getTreasuryBox()'] = view.getTreasuryBox();
  reads['getKarmaPoolBox()'] = view.getKarmaPoolBox();
  reads['getBackerPoolBox()'] = view.getBackerPoolBox();
  for (const limit of probes.limits) {
    for (const height of probes.heights) {
      reads[`getBondsInvitedAt(${height}, ${limit})`] = view.getBondsInvitedAt(height, limit);
      reads[`getVouchEscrowsReleasableAt(${height}, ${limit})`] = view.getVouchEscrowsReleasableAt(height, limit);
    }
    reads[`getLapsedVouches(${limit})`] = view.getLapsedVouches(limit);
  }
  for (const post of probes.posts) {
    reads[`getTopologyAuthor(${post})`] = view.getTopologyAuthor(post);
    reads[`getTopologyHeight(${post})`] = view.getTopologyHeight(post);
    reads[`getPostStanding(${post})`] = view.getPostStanding(post);
  }
  return reads;
}

// ---------------------------------------------------------------------------
// One state, held both ways: every box type, every record kind, posts and a like
// ---------------------------------------------------------------------------

let nonce = 1000;
const stored = <B extends AnyBox>(candidate: object): Stored<B> => seedProvenance<B>(candidate, 1, nonce++);

const alpha = stored<UsernameBox>({ boxType: 'username', value: 0n, createdAtBlock: 2, owner: alice, name: ascii('Alpha') });
const boxes: AnyBox[] = [
  karmaBox(alice, 5n, 1), karmaBox(alice, 9n, 2), karmaBox(alice, 5n, 3), karmaBox(bob, 4n, 4),
  stored({ boxType: 'credit', value: 7n, createdAtBlock: 1, owner: bob }),
  stored({ boxType: 'credit', value: 8n, createdAtBlock: 1, owner: bob, lockedUntilBlock: 12 }),
  stored({ boxType: 'genesis_proof', value: 0n, createdAtBlock: 0, payload: Uint8Array.of(7, 7) }),
  bondBox(alice, carol, 5, 1), bondBox(alice, dave, 6, 2),
  alpha,
  vouchBox(bob, alice, 7), vouchBox(bob, carol, 8), vouchBox(alice, dave, 9),
  escrowBox(alice, 3, 10), escrowBox(alice, 8, 11), escrowBox(bob, 5, 12),
  accrualBox(dave, 1n, 13), accrualBox(dave, 2n, 14),
  stored({ boxType: 'karma_price', value: 5n, createdAtBlock: 1 }),
  protocolBox('emission', 100n, 15), protocolBox('emission', 90n, 16), protocolBox('treasury', 3n, 17),
  protocolBox('karma_pool', 1000n, 18), protocolBox('backer_pool', 0n, 19),
  stored({ boxType: 'fee', value: 1n, createdAtBlock: 1 }),
  stored({ boxType: 'backer_stake', value: 0n, createdAtBlock: 0, owner: erin, weight: 10n }),
  stored({ boxType: 'backer_unstake', value: 0n, createdAtBlock: 1, owner: erin, weight: 4n }),
];
const records = [
  { identityId: alice, record: member },
  { identityId: bob, record: lapsed },
  { identityId: carol, record: invitedAt(4) },
  { identityId: dave, record: invitedAt(7) },
  { identityId: erin, record: identityRecord() },
];
const network: NetworkRecord = { memberCount: 3 };
const [p1, p2, unknownPost] = ['p1', 'p2', 'unknown'].map((label) => hex(uid(`tree-view/post/${label}`))) as [
  string, string, string,
];

/** The names, the holders — one of them holding no box — the posts and the like, beside the seed. */
const extras: TreeWrite[] = [
  { tag: 'Insert', key: nameKey(ascii('alpha')), value: nameRecordBytes({ boxId: alpha.id, claimedAtBlock: 6 }) },
  { tag: 'Insert', key: holderKey(alice), value: holderRecordBytes({ claimAvailable: false, boxId: alpha.id }) },
  { tag: 'Insert', key: holderKey(erin), value: holderRecordBytes({ claimAvailable: true, boxId: null }) },
  { tag: 'Insert', key: postKey(hexToBytes(p1)), value: postRecordBytes({ author: alice, height: 3, standing: 'live' }) },
  { tag: 'Insert', key: postKey(hexToBytes(p2)), value: postRecordBytes({ author: bob, height: 4, standing: 'withdrawn' }) },
  { tag: 'Insert', key: likeKey(hexToBytes(p1), bob), value: LIKE_MARKER },
];
const fullSession = () => mapSessionFrom([...seedTreeWrites(boxes, records, network), ...extras]);

function reference(): MemoryStateView {
  const view = new MemoryStateView(network);
  for (const box of boxes) view.insertBox(box);
  for (const { identityId, record } of records) view.putIdentityRecord(identityId, record);
  view.putUsername({ nameLower: 'alpha', name: 'Alpha', owner: hex(alice), boxId: alpha.id, claimedAtBlock: 6 });
  view.insertBlockTopology(p1, alice, 3);
  view.confirmPost(p1);
  view.insertBlockTopology(p2, bob, 4);
  view.confirmPost(p2);
  view.withdrawPost(p2);
  view.insertLikeRecord(p1, bob);
  return view;
}

const probes: Probes = {
  boxIds: [...boxes.map((b) => b.id!), hex(uid('tree-view/no-box'))],
  identities: [alice, bob, carol, dave, erin, stranger],
  names: ['alpha', 'nobody'],
  posts: [p1, p2, unknownPost],
  heights: [0, 2, 3, 4, 5, 6, 7, 8, 20],
  limits: [1, 2, 64],
};

describe('treeStateView — every read the reference answers', () => {
  it('answers each of the 21 reads as MemoryStateView answers it over the same state', () => {
    const tree = readsOf(treeStateView(fullSession()), probes);
    const memory = readsOf(reference(), probes);
    expect(Object.keys(tree)).toEqual(Object.keys(memory));
    expect(tree).toEqual(memory);
  });

  it('rebuilds a name row from the tree: the claim height from the name record, the name and owner from the box', () => {
    const view = treeStateView(fullSession());
    const row = { nameLower: 'alpha', name: 'Alpha', owner: hex(alice), boxId: alpha.id, claimedAtBlock: 6 };
    expect(view.getUsername('alpha')).toEqual(row);
    expect(view.getUsernameByOwner(alice)).toEqual(row);
  });

  it('answers null for an absent holder and for a holder holding no box', () => {
    const view = treeStateView(fullSession());
    expect(view.getUsernameByOwner(erin)).toBeNull();
    expect(view.getUsernameByOwner(stranger)).toBeNull();
  });

  it('answers a voucher\'s cast count, and 0 where no entry stands', () => {
    const view = treeStateView(fullSession());
    expect(view.castCountOf(bob)).toBe(2);
    expect(view.castCountOf(alice)).toBe(1);
    expect(view.castCountOf(carol)).toBe(0);
  });
});

describe('treeStateView — the walks', () => {
  it('walks an owner range that ends at the last key without looking the sentinel up', () => {
    const owner = new Uint8Array(32).fill(0xfe);
    const session = mapSessionFrom(seedTreeWrites([karma(owner, 5n, 'aa'), karma(owner, 9n, 'bb')], [], { memberCount: 0 }));
    const view = treeStateView(session);
    expect(view.getKarmaBoxes(owner).map((b) => b.value)).toEqual([9n, 5n]); // value DESC, id
    expect(session.lookups.some(isSentinel)).toBe(false);
  });

  it('looks each key up once per view', () => {
    const session = fullSession();
    const view = treeStateView(session);
    view.getIdentityRecord(alice);
    view.getIdentityRecord(alice);
    view.getBox(alpha.id);
    view.getBoxProvenance(alpha.id);
    view.getUsername('alpha');
    expect(session.lookups.filter((k) => equalBytes(k, identityKey(alice))).length).toBe(1);
    expect(new Set(session.lookups.map(bytesToHex)).size).toBe(session.lookups.length);
    treeStateView(session).getIdentityRecord(alice);
    expect(session.lookups.filter((k) => equalBytes(k, identityKey(alice))).length).toBe(2);
  });

  it('answers the lapses voucher by voucher, target order within, at most the limit', () => {
    const [v1, v2, v3, t1, t2] = [0x11, 0x22, 0x33, 0x44, 0x55].map(byte32) as [
      Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array,
    ];
    const vouches = [v1, v2, v3].flatMap((v, i) => [vouchBox(v, t1, 40 + 2 * i), vouchBox(v, t2, 41 + 2 * i)]);
    const lapses = [v1, v2, v3].map((v) => ({ identityId: v, record: lapsed }));
    const session = mapSessionFrom(seedTreeWrites(vouches, lapses, { memberCount: 0 }));
    const view = treeStateView(session);
    expect(view.getLapsedVouches(4).map((b) => [b.voucherId, b.targetId])).toEqual([[v1, t1], [v1, t2], [v2, t1], [v2, t2]]);
    // The leg reads no more of the tree than its limit takes: the third voucher is never looked up.
    expect(session.lookups.some((k) => equalBytes(k, lapsedKey(v3)) || equalBytes(k, rangeStart(vouchPairRange(v3))))).toBe(false);

    // A limit that ends inside a voucher's range stops that walk there.
    const cut = mapSessionFrom(seedTreeWrites(vouches, lapses, { memberCount: 0 }));
    expect(treeStateView(cut).getLapsedVouches(3).map((b) => [b.voucherId, b.targetId])).toEqual([[v1, t1], [v1, t2], [v2, t1]]);
    expect(cut.lookups.some((k) => equalBytes(k, vouchPairKey(v2, t2)) || equalBytes(k, lapsedKey(v3)))).toBe(false);
  });

  it('stops a due queue at the height and at the limit', () => {
    const owner = uid('tree-view/escrow-owner');
    const escrow = (releaseAtBlock: number): AnyBox => escrowBox(owner, releaseAtBlock, 50 + releaseAtBlock);
    const view = treeStateView(mapSessionFrom(seedTreeWrites([escrow(5), escrow(6), escrow(9)], [], { memberCount: 0 })));
    expect(view.getVouchEscrowsReleasableAt(6, 64).map((e) => e.releaseAtBlock)).toEqual([5, 6]);
    expect(view.getVouchEscrowsReleasableAt(9, 1).map((e) => e.releaseAtBlock)).toEqual([5]);
    expect(view.getVouchEscrowsReleasableAt(4, 64)).toEqual([]);
  });

  it('keys a bond by its invitee\'s grant height, not its declared height', () => {
    const b = bondBox(alice, carol, 60, 1); // declared at the tip before the grant
    const view = treeStateView(mapSessionFrom(seedTreeWrites([b], [{ identityId: carol, record: invitedAt(10) }], { memberCount: 0 })));
    expect(view.getBondsInvitedAt(9, 64)).toEqual([]);
    expect(view.getBondsInvitedAt(10, 64).map((x) => x.id)).toEqual([b.id]);
  });
});

describe("treeStateView — lookupCount (CONSENSUS_INTERFACE → The block's cost)", () => {
  it('counts the distinct keys the view asked its session: a memoised read adds none', () => {
    const session = fullSession();
    const view = treeStateView(session);
    expect(view.lookupCount()).toBe(0);
    view.getIdentityRecord(alice); // identity ‖ alice
    expect(view.lookupCount()).toBe(1);
    view.getIdentityRecord(alice);
    view.getBox(alpha.id); // box ‖ alpha
    view.getBoxProvenance(alpha.id);
    view.getUsername('alpha'); // name ‖ alpha, then box ‖ alpha again
    expect(view.lookupCount()).toBe(3);
    expect(view.lookupCount()).toBe(session.lookups.length);
  });

  it('counts each key a walk looks up: the range start, each next key it follows, and each box an entry names', () => {
    const owner = uid('tree-view/counted-owner');
    const held = [karma(owner, 5n, 'counted-1'), karma(owner, 9n, 'counted-2'), karma(owner, 7n, 'counted-3')];
    const session = mapSessionFrom(seedTreeWrites(held, [], { memberCount: 0 }));
    const view = treeStateView(session);
    expect(view.getKarmaBoxes(owner)).toHaveLength(3);
    // The range's start, absent; its three entries, the last naming the sentinel; the three boxes they name.
    expect(view.lookupCount()).toBe(7);
    expect(new Set(session.lookups.map(bytesToHex)).size).toBe(7);
    view.getKarmaBoxes(owner);
    expect(view.lookupCount()).toBe(7);
  });
});

describe('treeStateView — a tree that contradicts itself', () => {
  it('throws TreeInconsistencyError for a next key the tree holds no leaf for', () => {
    const owner = uid('tree-view/phantom-owner');
    const session = mapSessionFrom(seedTreeWrites([karma(owner, 5n, 'held')], [], { memberCount: 0 }));
    const start = rangeStart(karmaOfRange(owner));
    const phantom = karmaOfKey(owner, byte32(0x01));
    const lying: TreeSession = {
      lookup: (key) => {
        const answer = session.lookup(key);
        return equalBytes(key, start) ? { ...answer, nextKey: phantom } : answer;
      },
    };
    expect(() => treeStateView(lying).getKarmaBoxes(owner)).toThrow(TreeInconsistencyError);
  });

  it('throws TreeInconsistencyError for a lapsed entry over an empty vouch range', () => {
    const session = mapSessionFrom([
      ...seedTreeWrites([], [{ identityId: bob, record: lapsed }], { memberCount: 0 }),
      { tag: 'Insert', key: lapsedKey(bob), value: INDEX_MARKER },
    ]);
    expect(() => treeStateView(session).getLapsedVouches(4)).toThrow(TreeInconsistencyError);
  });

  it('throws TreeInconsistencyError for an index entry naming a box the tree does not hold', () => {
    const owner = uid('tree-view/orphan-owner');
    const session = mapSessionFrom([
      ...seedTreeWrites([], [], { memberCount: 0 }),
      { tag: 'Insert', key: karmaOfKey(owner, byte32(0x02)), value: INDEX_MARKER },
    ]);
    expect(() => treeStateView(session).getKarmaBoxes(owner)).toThrow(TreeInconsistencyError);
  });

  it('throws TreeInconsistencyError for a tree holding no network record', () => {
    expect(() => treeStateView(mapSessionFrom([])).getNetworkRecord()).toThrow(TreeInconsistencyError);
  });

  it('throws TreeInconsistencyError for a next key equal to the one just looked up, never looking it up again', () => {
    const owner = uid('tree-view/stalled-owner');
    const held = escrowBox(owner, 5, 401);
    const heldKey = escrowDueKey(5, hexToBytes(held.id));
    const session = mapSessionFrom(seedTreeWrites([held], [], { memberCount: 0 }));
    const lying: TreeSession = {
      lookup: (key) => {
        const answer = session.lookup(key);
        return equalBytes(key, heldKey) ? { ...answer, nextKey: heldKey } : answer;
      },
    };
    expect(() => treeStateView(lying).getVouchEscrowsReleasableAt(9, 4)).toThrow(TreeInconsistencyError);
    expect(session.lookups.filter((k) => equalBytes(k, heldKey)).length).toBe(1);
  });

  it('throws TreeInconsistencyError for a next key below the one just looked up, never looking it up again', () => {
    const owner = uid('tree-view/stalled-owner-below');
    const low = escrowBox(owner, 5, 402);
    const high = escrowBox(owner, 9, 403);
    const lowKey = escrowDueKey(5, hexToBytes(low.id));
    const highKey = escrowDueKey(9, hexToBytes(high.id));
    const session = mapSessionFrom(seedTreeWrites([low, high], [], { memberCount: 0 }));
    const lying: TreeSession = {
      lookup: (key) => {
        const answer = session.lookup(key);
        return equalBytes(key, highKey) ? { ...answer, nextKey: lowKey } : answer;
      },
    };
    expect(() => treeStateView(lying).getVouchEscrowsReleasableAt(9, 4)).toThrow(TreeInconsistencyError);
    expect(session.lookups.filter((k) => equalBytes(k, lowKey)).length).toBe(1);
  });

  it('throws TreeInconsistencyError for a range-start answer naming a next key below the range', () => {
    const owner = byte32(0x05);
    const before = byte32(0x01);
    const session = mapSessionFrom(seedTreeWrites([karma(owner, 5n, 'below-range')], [], { memberCount: 0 }));
    const start = rangeStart(karmaOfRange(owner));
    const below = karmaOfKey(before, byte32(0x01));
    const lying: TreeSession = {
      lookup: (key) => {
        const answer = session.lookup(key);
        return equalBytes(key, start) ? { ...answer, nextKey: below } : answer;
      },
    };
    expect(() => treeStateView(lying).getKarmaBoxes(owner)).toThrow(TreeInconsistencyError);
  });

  it('throws TreeInconsistencyError for a range-start answer naming the all-0x00 sentinel as its next key', () => {
    const owner = uid('tree-view/sentinel-next-owner');
    const session = mapSessionFrom(seedTreeWrites([karma(owner, 5n, 'sentinel-next')], [], { memberCount: 0 }));
    const start = rangeStart(karmaOfRange(owner));
    const bottom = new Uint8Array(start.length).fill(0x00);
    const lying: TreeSession = {
      lookup: (key) => {
        const answer = session.lookup(key);
        return equalBytes(key, start) ? { ...answer, nextKey: bottom } : answer;
      },
    };
    expect(() => treeStateView(lying).getKarmaBoxes(owner)).toThrow(TreeInconsistencyError);
  });

  it('throws TreeInconsistencyError for a walk at its limit whose last lookup names a backwards next key', () => {
    const owner = uid('tree-view/limit-backwards-owner');
    const low = escrowBox(owner, 5, 501);
    const lowKey = escrowDueKey(5, hexToBytes(low.id));
    const session = mapSessionFrom(seedTreeWrites([low], [], { memberCount: 0 }));
    const lying: TreeSession = {
      lookup: (key) => {
        const answer = session.lookup(key);
        return equalBytes(key, lowKey) ? { ...answer, nextKey: lowKey } : answer;
      },
    };
    // The limit stops the walk at this one entry — it would never follow this next key — yet the check still fires.
    expect(() => treeStateView(lying).getVouchEscrowsReleasableAt(9, 1)).toThrow(TreeInconsistencyError);
  });

  it('throws TreeInconsistencyError for an absent answer whose prevKey is not below the key looked up', () => {
    const who = uid('tree-view/absent-prevkey-owner');
    const key = identityKey(who);
    const session = mapSessionFrom([]);

    const equalPrev: TreeSession = {
      lookup: (k) => {
        const answer = session.lookup(k);
        return equalBytes(k, key) ? { ...answer, prevKey: key } : answer;
      },
    };
    expect(() => treeStateView(equalPrev).getIdentityRecord(who)).toThrow(TreeInconsistencyError);

    const above = Uint8Array.from([...key, 0x00]); // one byte longer, same prefix — strictly greater by length
    const abovePrev: TreeSession = {
      lookup: (k) => {
        const answer = session.lookup(k);
        return equalBytes(k, key) ? { ...answer, prevKey: above } : answer;
      },
    };
    expect(() => treeStateView(abovePrev).getIdentityRecord(who)).toThrow(TreeInconsistencyError);
  });

  it('throws TreeInconsistencyError for a point read whose found answer names a backwards next key', () => {
    const target = karma(uid('tree-view/point-read-owner'), 6n, 'point-read');
    const key = boxKey(hexToBytes(target.id!));
    const session = mapSessionFrom(seedTreeWrites([target], [], { memberCount: 0 }));
    const lying: TreeSession = {
      lookup: (k) => {
        const answer = session.lookup(k);
        return equalBytes(k, key) ? { ...answer, nextKey: key } : answer;
      },
    };
    expect(() => treeStateView(lying).getBox(target.id!)).toThrow(TreeInconsistencyError);
  });
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe('the round trip — applyBlock over the tree view, then its writes to the session', () => {
  /** Devnet's numbers, the timescales shortened so the cooldown, the probation, decay and rent come due within a few blocks. */
  const ctx: ApplyContext = {
    ...applyContextFor(profileFor('devnet')),
    inviteProbationBlocks: 3,
    storageRentPeriodBlocks: 4,
    vouchCooldownBlocks: 3,
    decayCfg: { staleThresholdBlocks: 6, decayIntervalBlocks: 3, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM },
  };
  const CREDIT = 10n ** 8n;
  const named = (label: string): TestIdentity => seededIdentity(`tree-view/round-trip/${label}`);
  const miner = named('miner');
  const [r1, r2, r3] = [named('root-1'), named('root-2'), named('root-3')];
  const [t, x, u, v, w, l1, l2] = ['target', 'second-target', 'name-holder', 'passing-name', 'withdrawer', 'liker-1', 'liker-2'].map(named) as [
    TestIdentity, TestIdentity, TestIdentity, TestIdentity, TestIdentity, TestIdentity, TestIdentity,
  ];
  const [c1, c2, i1] = [named('credit-sender'), named('credit-recipient'), named('invitee')];
  const everyone = [miner, r1, r2, r3, t, x, u, v, w, l1, l2, c1, c2, i1].map((who) => who.userId);

  /** The tree the reference's state seeds, with its names, holders, posts and likes beside it — every leaf, as hex. */
  function canonicalTree(memory: MemoryStateView, probes: Probes): Array<[string, string]> {
    const boxes = probes.boxIds.map((id) => memory.getBox(id)).filter((box): box is AnyBox => box !== null);
    const records = probes.identities.flatMap((identityId) => {
      const record = memory.getIdentityRecord(identityId);
      return record === null ? [] : [{ identityId, record }];
    });
    const writes = seedTreeWrites(boxes, records, memory.getNetworkRecord());
    for (const name of probes.names) {
      const row = memory.getUsername(name);
      if (row !== null) {
        writes.push({ tag: 'Insert', key: nameKey(ascii(name)), value: nameRecordBytes({ boxId: row.boxId, claimedAtBlock: row.claimedAtBlock }) });
      }
    }
    for (const owner of probes.identities) {
      const row = memory.getUsernameByOwner(owner);
      if (row !== null) {
        writes.push({ tag: 'Insert', key: holderKey(owner), value: holderRecordBytes({ claimAvailable: false, boxId: row.boxId }) });
      }
    }
    for (const post of probes.posts) {
      const author = memory.getTopologyAuthor(post);
      const standing = memory.getPostStanding(post);
      if (author === null || standing === 'none') continue;
      writes.push({
        tag: 'Insert',
        key: postKey(hexToBytes(post)),
        value: postRecordBytes({ author, height: memory.getTopologyHeight(post)!, standing }),
      });
      for (const liker of probes.identities) {
        if (memory.hasLikeRecord(post, liker)) writes.push({ tag: 'Insert', key: likeKey(hexToBytes(post), liker), value: LIKE_MARKER });
      }
    }
    return mapSessionFrom(writes).entries();
  }

  it('leaves the tree answering every read the reference answers, and holding the tree the reference\'s state seeds, after every block', () => {
    const boxes: AnyBox[] = [];
    const records: Array<{ identityId: Uint8Array; record: IdentityRecord }> = [];
    let seedNonce = 1;
    for (const [who, values] of [[r1, [1000n]], [r2, [1000n]], [r3, [6n, 6n]]] as const) {
      for (const value of values) boxes.push(karmaBox(who.userId, value, seedNonce++, 0));
      records.push({ identityId: who.userId, record: identityRecord({ memberSinceBlock: 1 }) });
    }
    for (const who of [t, x, u, v, w, l1, l2]) {
      boxes.push(karmaBox(who.userId, 100n, seedNonce++, 0));
      records.push({ identityId: who.userId, record: identityRecord() });
    }
    const c1Credit = seedProvenance<CreditBox>(
      { boxType: 'credit', value: 100n * CREDIT, createdAtBlock: 0, owner: c1.userId },
      0,
      seedNonce++,
    );
    boxes.push(
      c1Credit,
      protocolBox('emission', profileFor('devnet').creditEmissionTotal, seedNonce++),
      protocolBox('karma_pool', 1_000_000n, seedNonce++),
    );
    const genesisNetwork: NetworkRecord = { memberCount: 3 };

    const memory = new MemoryStateView(genesisNetwork);
    for (const box of boxes) memory.insertBox(box);
    for (const { identityId, record } of records) memory.putIdentityRecord(identityId, record);
    const session = mapSessionFrom(seedTreeWrites(boxes, records, genesisNetwork));

    const boxIds = new Set(boxes.map((box) => box.id!));
    const posts = new Set<string>([hex(uid('tree-view/round-trip/no-post'))]);
    const probes = (): Probes => ({
      boxIds: [...boxIds, hex(uid('tree-view/round-trip/no-box'))],
      identities: everyone,
      names: ['pinned', 'fleeting', 'second', 'nobody'],
      posts: [...posts],
      heights: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      limits: [1, 2, 64],
    });
    const writtenBy = new Map<number, TreeWrite[]>();
    const agree = (label: string): void => {
      expect(readsOf(treeStateView(session), probes()), `${label}: the reads`).toEqual(readsOf(memory, probes()));
      expect(session.entries(), `${label}: the tree`).toEqual(canonicalTree(memory, probes()));
    };
    agree('genesis');

    const largest = (who: TestIdentity): KarmaBox => {
      const box = memory.getKarmaBoxes(who.userId)[0];
      if (!box) throw new Error(`${hex(who.userId).slice(0, 8)} holds no karma`);
      return box;
    };
    const step = (height: number, txs: Built[]): void => {
      const block = candidateBlock(treeStateView(session), height, txs, miner.userId, ctx);
      const view = treeStateView(session);
      const result = applyBlock(view, block, ctx);
      if (!result.ok) throw new Error(`block ${height} was refused over the tree view: ${result.reason}`);
      const readByRules = session.lookups.length;
      const writes = treeWritesOf(result.effects, height, view);
      const readByWrites = session.lookups.slice(readByRules);
      expect(readByWrites.every((key) => key[0] === TREE_TAG.castCount), `block ${height}: the writes' own reads are cast counts`).toBe(true);
      session.apply(writes);
      writtenBy.set(height, writes);

      const fromMemory = applyBlock(memory, block, ctx);
      expect(fromMemory, `block ${height}: the same effects over the reference`).toEqual(result);
      if (!fromMemory.ok) throw new Error(`block ${height} was refused over the reference: ${fromMemory.reason}`);
      writeEffects(memory, fromMemory.effects, height);

      for (const m of result.effects.mutations) if (m.kind === 'box' && m.op === 'insert') boxIds.add(m.boxId);
      for (const { postId } of result.effects.posts) posts.add(postId);
      agree(`block ${height}`);
    };

    // 1: a thread, and a reply and a like in the block confirming it; a thread withdrawn at 5.
    const tThread = threadTx(t, largest(t), 'the target opens a thread', 1);
    const wThread = threadTx(w, largest(w), 'a thread its author withdraws', 1);
    step(1, [
      tThread,
      replyTx(r2, largest(r2), 'a reply in the block that confirms its parent', tThread.postId, t.userId, 1),
      likeTx(r1, largest(r1), tThread.postId, t.userId, 1),
      wThread,
    ]);

    // 2: two vouches — the target becomes a member — a like, an invite, a name, credits, a like and a reply.
    const r3Consolidate = consolidateTx(r3, memory.getKarmaBoxes(r3.userId), 2);
    const r1Vouch = vouchTx(r1, largest(r1), t.userId, 2);
    const r2Like = likeTx(r2, largest(r2), tThread.postId, t.userId, 2);
    const uClaim = claimTx(u, largest(u), 'Pinned', 2);
    const c1Send = creditSendTx(c1, c1Credit, 40n * CREDIT, c2.userId, CREDIT, 2);
    const l1Like = likeTx(l1, largest(l1), tThread.postId, t.userId, 2);
    const r2Invite = inviteTx(r2, changeOf(r2Like), i1.userId, 25n, 2);
    step(2, [
      r3Consolidate,
      vouchTx(r3, changeOf(r3Consolidate), x.userId, 2),
      r1Vouch,
      r2Like,
      r2Invite,
      uClaim,
      c1Send,
      l1Like,
      replyTx(l1, changeOf(l1Like), 'a reply paid from its own change', wThread.postId, w.userId, 2),
    ]);

    // 3: a name claimed and burned in one block, and the new member's vouch.
    const vClaim = claimTx(v, largest(v), 'Fleeting', 3);
    step(3, [vClaim, burnTx(v, changeOf(vClaim), vClaim.out[1]!, 3), vouchTx(t, largest(t), w.userId, 3)]);

    // 4: a burn, its owner's next claim, and another's claim of the burned name.
    const uBurn = burnTx(u, largest(u), uClaim.out[1]!, 4);
    step(4, [uBurn, claimTx(u, changeOf(uBurn), 'Second', 4), claimTx(w, largest(w), 'pinned', 4)]);

    // 5: a like and a withdrawal of one post, an unvouch that lapses the target, the invite's bond settling.
    step(5, [
      likeTx(l2, largest(l2), wThread.postId, w.userId, 5),
      withdrawTx(w, largest(w), wThread.postId, 5),
      unvouchTx(r1, r1Vouch.out[1]! as VouchBox, ctx.vouchCooldownBlocks, 5),
    ]);

    // 6: an empty body: the unvouch's escrow releases, and the lapse leg withdraws the lapsed target's vouch.
    step(6, []);

    // 8: decay on the stale owners the body touches, one of them posting; rent from a box dormant since 2.
    const dormant = c1Send.out[0]! as CreditBox;
    const charge = STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(dormant, dormant.txId, dormant.index).length);
    const rent = finish({
      inputs: [dormant.id!],
      outputs: [
        { boxType: 'credit', value: dormant.value - charge, createdAtBlock: 8, owner: dormant.owner } as AnyBoxCandidate,
        { boxType: 'fee', value: charge, createdAtBlock: 8 } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, null);
    step(8, [consolidateTx(l2, memory.getKarmaBoxes(l2.userId), 8), threadTx(x, largest(x), 'a stale owner posts', 8), rent]);

    // What the chain moved: the member's cast counted at 3, their lapsed entry placed at 5 and gone with
    // their last vouch at 6, the invite's bond settled at 5 under its invitee's grant height.
    const tagsAt = (height: number, key: Uint8Array): string[] =>
      writtenBy.get(height)!.filter((write) => equalBytes(write.key, key)).map((write) => write.tag);
    expect(tagsAt(3, castCountKey(t.userId))).toEqual(['Insert']);
    expect(tagsAt(5, lapsedKey(t.userId))).toEqual(['InsertOrUpdate']);
    expect(tagsAt(6, lapsedKey(t.userId))).toEqual(['Remove']);
    expect(tagsAt(6, castCountKey(t.userId))).toEqual(['Remove']);
    expect(tagsAt(5, bondDueKey(2, hexToBytes(r2Invite.out[1]!.id!)))).toEqual(['Remove']);
  });
});
