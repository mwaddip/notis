import { describe, it, expect } from 'vitest';
import {
  INDEX_MARKER,
  LIKE_MARKER,
  PROTOCOL_VERSION,
  boxKey,
  boxRecordBytes,
  bondDueKey,
  castCountBytes,
  castCountKey,
  computeContentHash,
  creditOfKey,
  equalBytes,
  escrowDueKey,
  escrowOfKey,
  hexToBytes,
  holderKey,
  holderRecordBytes,
  identityKey,
  identityRecordBytes,
  karmaOfKey,
  lapsedKey,
  likeKey,
  nameKey,
  nameRecordBytes,
  networkKey,
  networkRecordBytes,
  postKey,
  postRecordBytes,
  vouchPairKey,
  vouchPairValue,
} from '@dagsocial/types';
import type { AnyBox, CreditBox, IdentityRecord, NetworkRecord } from '@dagsocial/types';
import { seedTreeWrites, treeStateView, treeWritesOf } from '@dagsocial/consensus';
import type { BlockEffects, TreeStateView, TreeWrite, UsernameRow } from '@dagsocial/consensus';
import { bondBox, escrowBox, hex, identityRecord, karmaBox, seedProvenance, uid, vouchBox } from './helpers.js';
import { mapSessionFrom } from './tree-session-map.js';

/**
 * The tree writes (CONSENSUS_INTERFACE → The tree writes): genesis as ordered
 * `Insert`s, and a block's effects as its ordered writes over the block's own
 * pre-block view.
 */

const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map((name) => uid(`tree-writes/${name}`)) as [
  Uint8Array, Uint8Array, Uint8Array, Uint8Array,
];

const member = identityRecord({ memberSinceBlock: 1, memberBar: 1, memberVouches: 1 });
const lapsed = identityRecord({ memberSinceBlock: 1, memberBar: 2, memberVouches: 1 });
const invitedAt = (h: number): IdentityRecord => identityRecord({ invitedAtBlock: h });

const idOf = (box: AnyBox): Uint8Array => hexToBytes(box.id!);

const creditOf = (owner: Uint8Array, value: bigint, nonce: number): CreditBox =>
  seedProvenance<CreditBox>({ boxType: 'credit', value, createdAtBlock: 1, owner }, 1, nonce);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const K = karmaBox(alice, 5n, 1);
const C = creditOf(bob, 7n, 2);
const E = escrowBox(carol, 9, 3);

describe('seedTreeWrites', () => {
  it('seeds genesis as Inserts in key order', () => {
    const w = seedTreeWrites([K, C, E], [{ identityId: alice, record: member }], { memberCount: 1 });
    expect(w.every((x) => x.tag === 'Insert')).toBe(true);
    for (let i = 1; i < w.length; i++) expect(compareBytes(w[i - 1]!.key, w[i]!.key)).toBe(-1);
  });

  it('seeds every box with its entries, each voucher\'s cast count, every record with its lapsed entry, and the network record', () => {
    const V = vouchBox(bob, alice, 4);
    const B = bondBox(alice, carol, 5, 1);
    const w = seedTreeWrites(
      [V, B],
      [{ identityId: bob, record: lapsed }, { identityId: carol, record: invitedAt(6) }],
      { memberCount: 2 },
    );
    const insert = (key: Uint8Array, value: Uint8Array): TreeWrite => ({ tag: 'Insert', key, value });
    expect(w).toEqual([
      insert(boxKey(idOf(V)), boxRecordBytes(V, V.txId, V.index)),
      insert(boxKey(idOf(B)), boxRecordBytes(B, B.txId, B.index)),
      insert(identityKey(bob), identityRecordBytes(lapsed)),
      insert(identityKey(carol), identityRecordBytes(invitedAt(6))),
      insert(networkKey(), networkRecordBytes({ memberCount: 2 })),
      insert(bondDueKey(6, idOf(B)), INDEX_MARKER),
      insert(vouchPairKey(bob, alice), vouchPairValue(idOf(V))),
      insert(lapsedKey(bob), INDEX_MARKER),
      insert(castCountKey(bob), castCountBytes(1)),
    ].sort((a, b) => compareBytes(a.key, b.key)));
  });

  it('places no lapsed entry for a lapsed member who casts nothing, nor for a member who casts', () => {
    const V = vouchBox(alice, bob, 6);
    const w = seedTreeWrites([V], [{ identityId: alice, record: member }, { identityId: carol, record: lapsed }], { memberCount: 1 });
    expect(w.some((x) => x.key[0] === lapsedKey(alice)[0])).toBe(false);
  });

  it('refuses a bond whose invitee holds no record among the seed\'s', () => {
    expect(() => seedTreeWrites([bondBox(alice, carol, 7, 1)], [], { memberCount: 0 })).toThrow(/invitee/);
  });

  it('refuses a seed that writes one key twice', () => {
    expect(() => seedTreeWrites([], [
      { identityId: alice, record: member },
      { identityId: new Uint8Array(alice), record: lapsed },
    ], { memberCount: 1 })).toThrow(/two writes/);
  });
});

// ---------------------------------------------------------------------------
// A block's writes
// ---------------------------------------------------------------------------

type Mutation = BlockEffects['mutations'][number];
type Post = BlockEffects['posts'][number];

const effectsOf = (mutations: Mutation[]): BlockEffects =>
  ({ mutations, posts: [], likeRecords: [], withdrawals: [], appliedTxs: [], signatures: 0 });
const insert = (box: AnyBox): Mutation => ({ kind: 'box', op: 'insert', boxId: box.id!, box });
const spend = (box: AnyBox): Mutation => ({ kind: 'box', op: 'remove', boxId: box.id! });
const network = (memberCount: number): Mutation => ({ kind: 'network', record: { memberCount } });
const record = (identityId: Uint8Array, written: IdentityRecord): Mutation => ({ kind: 'record', identityId, record: written });
const postBy = (author: Uint8Array, postId: string): Post => ({
  postId,
  txId: postId,
  post: { contentHash: computeContentHash('a post'), author, parentRefs: [], protocolVersion: PROTOCOL_VERSION, type: 'regular' },
});

/** The block's own view: a tree view over a session holding the pre-block state. */
const viewOf = (
  boxes: AnyBox[],
  records: Array<{ identityId: Uint8Array; record: IdentityRecord }>,
  state: NetworkRecord,
  beside: TreeWrite[] = [],
): TreeStateView => treeStateView(mapSessionFrom([...seedTreeWrites(boxes, records, state), ...beside]));
const viewWithPost = (postId: string, author: Uint8Array, height: number): TreeStateView =>
  viewOf([], [], { memberCount: 0 }, [
    { tag: 'Insert', key: postKey(hexToBytes(postId)), value: postRecordBytes({ author, height, standing: 'live' }) },
  ]);

const writesAt = (w: TreeWrite[], key: Uint8Array): TreeWrite[] => w.filter((x) => equalBytes(x.key, key));
const nameRow = (nameLower: string, owner: Uint8Array, boxId: string, claimedAtBlock: number): UsernameRow =>
  ({ nameLower, name: nameLower, owner: hex(owner), boxId, claimedAtBlock });

const X = uid('tree-writes/author');
const P = hex(uid('tree-writes/post'));

describe('treeWritesOf', () => {
  it('orders every write: removes, inserts, updates, insert-or-updates, each by key', () => {
    // pre-block: credit box C; network record; alice has no record
    const w = treeWritesOf(effectsOf([spend(C), insert(K), network(3), record(alice, member)]), 10, viewOf([C], [], { memberCount: 2 }));
    expect(w.map((x) => x.tag)).toEqual(['Remove', 'Remove', 'Insert', 'Insert', 'Update', 'InsertOrUpdate']);
    expect(w.map((x) => x.key)).toEqual([boxKey(idOf(C)), creditOfKey(C.owner, idOf(C)), boxKey(idOf(K)),
      karmaOfKey(K.owner, idOf(K)), networkKey(), identityKey(alice)]);
    expect(w[2]).toEqual({ tag: 'Insert', key: boxKey(idOf(K)), value: boxRecordBytes(K, K.txId, K.index) });
    expect(w[4]).toEqual({ tag: 'Update', key: networkKey(), value: networkRecordBytes({ memberCount: 3 }) });
    expect(w[5]).toEqual({ tag: 'InsertOrUpdate', key: identityKey(alice), value: identityRecordBytes(member) });
  });

  it('nets a box the block created and spent, index entries included', () => {
    expect(treeWritesOf(effectsOf([insert(K), spend(K)]), 10, viewOf([], [], { memberCount: 0 }))).toEqual([]);
    expect(treeWritesOf(effectsOf([insert(E), spend(E)]), 10, viewOf([], [], { memberCount: 0 }))).toEqual([]);
  });

  it('writes each index entry beside its box: an escrow\'s two, spent and created', () => {
    const E2 = escrowBox(carol, 11, 20);
    const w = treeWritesOf(effectsOf([spend(E), insert(E2)]), 10, viewOf([E], [], { memberCount: 0 }));
    expect(w.map((x) => [x.tag, x.key])).toEqual([
      ['Remove', boxKey(idOf(E))], ['Remove', escrowOfKey(carol, idOf(E))], ['Remove', escrowDueKey(9, idOf(E))],
      ['Insert', boxKey(idOf(E2))], ['Insert', escrowOfKey(carol, idOf(E2))], ['Insert', escrowDueKey(11, idOf(E2))],
    ].sort(([tagA, a], [tagB, b]) => (tagA === tagB ? compareBytes(a as Uint8Array, b as Uint8Array) : tagA === 'Remove' ? -1 : 1)));
  });

  it('keeps a voucher\'s cast count and moves their lapsed entry with it', () => {
    // pre-block: bob lapsed, one vouch V1; the block spends V1 → count 1 → 0 → lapsed entry removed
    const V1 = vouchBox(bob, carol, 21);
    const w = treeWritesOf(effectsOf([spend(V1)]), 10, viewOf([V1], [{ identityId: bob, record: lapsed }], { memberCount: 0 }));
    expect(writesAt(w, castCountKey(bob)).map((x) => x.tag)).toEqual(['Remove']);
    expect(writesAt(w, lapsedKey(bob)).map((x) => x.tag)).toEqual(['Remove']);
    expect(w.map((x) => x.key)).toEqual(
      [boxKey(idOf(V1)), vouchPairKey(bob, carol), lapsedKey(bob), castCountKey(bob)].sort(compareBytes),
    );
  });

  it('counts a cast: an Insert where no count stood, an Update where one did', () => {
    const [V1, V2, V3] = [vouchBox(alice, bob, 22), vouchBox(alice, carol, 23), vouchBox(bob, carol, 24)];
    const view = viewOf([V1], [{ identityId: alice, record: member }, { identityId: bob, record: member }], { memberCount: 2 });
    const w = treeWritesOf(effectsOf([insert(V2), insert(V3)]), 10, view);
    expect(writesAt(w, castCountKey(alice))).toEqual([{ tag: 'Update', key: castCountKey(alice), value: castCountBytes(2) }]);
    expect(writesAt(w, castCountKey(bob))).toEqual([{ tag: 'Insert', key: castCountKey(bob), value: castCountBytes(1) }]);
    expect(writesAt(w, vouchPairKey(alice, carol))).toEqual([
      { tag: 'Insert', key: vouchPairKey(alice, carol), value: vouchPairValue(idOf(V2)) },
    ]);
  });

  it('writes nothing to a cast count whose net change is 0, and leaves its lapsed entry be — the count is still read', () => {
    // pre-block: bob lapsed, one vouch V1 — count 1, lapsed entry standing; the block spends V1 and inserts V2
    const [V1, V2] = [vouchBox(bob, carol, 31), vouchBox(bob, dave, 32)];
    const session = mapSessionFrom(seedTreeWrites([V1], [{ identityId: bob, record: lapsed }], { memberCount: 0 }));
    const w = treeWritesOf(effectsOf([spend(V1), insert(V2)]), 10, treeStateView(session));
    expect(writesAt(w, castCountKey(bob))).toEqual([]);
    expect(writesAt(w, lapsedKey(bob))).toEqual([]);
    expect(w.map((x) => [x.tag, x.key])).toEqual([
      ...[boxKey(idOf(V1)), vouchPairKey(bob, carol)].sort(compareBytes).map((key) => ['Remove', key]),
      ...[boxKey(idOf(V2)), vouchPairKey(bob, dave)].sort(compareBytes).map((key) => ['Insert', key]),
    ]);
    expect(session.lookups.some((k) => equalBytes(k, castCountKey(bob)))).toBe(true);
  });

  it('places a lapsed entry when a record lapses while its vouches stand', () => {
    const V1 = vouchBox(bob, carol, 25);
    const w = treeWritesOf(effectsOf([record(bob, lapsed)]), 10, viewOf([V1], [{ identityId: bob, record: member }], { memberCount: 1 }));
    expect(writesAt(w, lapsedKey(bob)).map((x) => x.tag)).toEqual(['InsertOrUpdate']);
  });

  it('removes a lapsed entry when its member re-qualifies, and moves none for a record that stays on its side', () => {
    const V1 = vouchBox(bob, carol, 26);
    const view = viewOf([V1], [{ identityId: bob, record: lapsed }, { identityId: alice, record: member }], { memberCount: 1 });
    const w = treeWritesOf(effectsOf([record(bob, member), record(alice, identityRecord({ ...member, lastActivityBlock: 9 }))]), 10, view);
    expect(writesAt(w, lapsedKey(bob)).map((x) => x.tag)).toEqual(['Remove']);
    expect(writesAt(w, lapsedKey(alice))).toEqual([]);
  });

  it('reads a written record\'s cast count only where the record is a lapsed member before the block or after it', () => {
    const session = mapSessionFrom(seedTreeWrites([], [{ identityId: alice, record: member }, { identityId: bob, record: member }], { memberCount: 2 }));
    const view = treeStateView(session);
    view.getIdentityRecord(alice); // the rules read each record before they write it
    view.getIdentityRecord(bob);
    treeWritesOf(effectsOf([record(alice, identityRecord({ ...member, lastActivityBlock: 10 })), record(bob, lapsed)]), 10, view);
    expect(session.lookups.some((k) => equalBytes(k, castCountKey(alice)))).toBe(false);
    expect(session.lookups.some((k) => equalBytes(k, castCountKey(bob)))).toBe(true);
  });

  it('writes a record\'s last write once', () => {
    const later = identityRecord({ ...member, lastActivityBlock: 10 });
    const w = treeWritesOf(effectsOf([record(alice, member), record(new Uint8Array(alice), later)]), 10, viewOf([], [], { memberCount: 0 }));
    expect(w).toEqual([{ tag: 'InsertOrUpdate', key: identityKey(alice), value: identityRecordBytes(later) }]);
  });

  it('writes the post record at confirmation and updates it at a later withdrawal', () => {
    const w1 = treeWritesOf({ ...effectsOf([]), posts: [postBy(X, P)] }, 10, viewOf([], [], { memberCount: 0 }));
    expect(w1).toEqual([{ tag: 'Insert', key: postKey(hexToBytes(P)), value: postRecordBytes({ author: X, height: 10, standing: 'live' }) }]);
    // a later block withdraws P: the pre-block view holds the post record
    const w2 = treeWritesOf({ ...effectsOf([]), withdrawals: [P] }, 12, viewWithPost(P, X, 10));
    expect(w2).toEqual([{ tag: 'Update', key: postKey(hexToBytes(P)), value: postRecordBytes({ author: X, height: 10, standing: 'withdrawn' }) }]);
  });

  it('inserts a like record', () => {
    const w = treeWritesOf({ ...effectsOf([]), likeRecords: [{ targetPostId: P, likerId: bob }] }, 10, viewWithPost(P, X, 3));
    expect(w).toEqual([{ tag: 'Insert', key: likeKey(hexToBytes(P), bob), value: LIKE_MARKER }]);
  });

  it('inserts a bond under the block\'s height, the grant\'s', () => {
    const B = bondBox(alice, carol, 27, 3);
    const w = treeWritesOf(effectsOf([insert(B)]), 12, viewOf([], [], { memberCount: 0 }));
    expect(writesAt(w, bondDueKey(12, idOf(B)))).toEqual([{ tag: 'Insert', key: bondDueKey(12, idOf(B)), value: INDEX_MARKER }]);
  });

  it('removes a settled bond under its invitee\'s grant height', () => {
    const B = bondBox(alice, carol, 28, 3);
    const w = treeWritesOf(effectsOf([spend(B)]), 40, viewOf([B], [{ identityId: carol, record: invitedAt(4) }], { memberCount: 0 }));
    expect(w.some((x) => x.tag === 'Remove' && equalBytes(x.key, bondDueKey(4, idOf(B))))).toBe(true);
  });

  it('nets the name and holder records as the block left them', () => {
    const owner = uid('tree-writes/name-owner');
    const [held, fresh] = ['a'.repeat(64), 'b'.repeat(64)];
    const name = (nameLower: string): Uint8Array => nameKey(new TextEncoder().encode(nameLower));
    const w = treeWritesOf(effectsOf([
      // a burn of a name the state held, then its owner's claim of another
      { kind: 'username', nameLower: 'kept', row: null, heldBefore: true },
      { kind: 'holder', owner, record: null, heldBefore: true },
      { kind: 'username', nameLower: 'next', row: nameRow('next', owner, fresh, 10), heldBefore: false },
      { kind: 'holder', owner, record: { claimAvailable: false, boxId: fresh }, heldBefore: false },
      // a name claimed and burned in the block
      { kind: 'username', nameLower: 'gone', row: nameRow('gone', carol, held, 10), heldBefore: false },
      { kind: 'holder', owner: carol, record: { claimAvailable: false, boxId: held }, heldBefore: false },
      { kind: 'username', nameLower: 'gone', row: null, heldBefore: true },
      { kind: 'holder', owner: carol, record: null, heldBefore: true },
    ]), 10, viewOf([], [], { memberCount: 0 }));
    expect(w).toEqual([
      { tag: 'Remove', key: name('kept') },
      ...[
        { tag: 'InsertOrUpdate', key: name('next'), value: nameRecordBytes({ boxId: fresh, claimedAtBlock: 10 }) },
        { tag: 'InsertOrUpdate', key: holderKey(owner), value: holderRecordBytes({ claimAvailable: false, boxId: fresh }) },
      ].sort((a, b) => compareBytes(a.key, b.key)),
    ]);
  });

  it('throws for a key that takes two writes in one block', () => {
    const [before, after] = [vouchBox(bob, carol, 29), vouchBox(bob, carol, 30)];
    const view = viewOf([before], [{ identityId: bob, record: member }], { memberCount: 1 });
    expect(() => treeWritesOf(effectsOf([spend(before), insert(after)]), 10, view)).toThrow(/two writes/);
  });
});
