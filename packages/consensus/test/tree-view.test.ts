import { describe, it, expect } from 'vitest';
import {
  INDEX_MARKER,
  LIKE_MARKER,
  bytesToHex,
  equalBytes,
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
  rangeStart,
  vouchPairKey,
  vouchPairRange,
} from '@dagsocial/types';
import type { AnyBox, IdentityRecord, NetworkRecord, UsernameBox } from '@dagsocial/types';
import { TreeInconsistencyError, isSentinel, seedTreeWrites, treeStateView } from '@dagsocial/consensus';
import type { StateView, TreeSession, TreeWrite } from '@dagsocial/consensus';
import {
  MemoryStateView,
  accrualBox,
  bondBox,
  escrowBox,
  hex,
  identityRecord,
  karmaBox,
  labelNonce,
  protocolBox,
  seedProvenance,
  uid,
  vouchBox,
  type Stored,
} from './helpers.js';
import { mapSessionFrom } from './tree-session-map.js';

/**
 * The tree view (CONSENSUS_INTERFACE → The tree view): the `StateView` over a
 * tree session, checked read for read against `MemoryStateView` over the same
 * state, and its walks — where they stop, what they never look up, and what a
 * tree that contradicts itself answers.
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
});
