import { describe, it, expect } from 'vitest';
import { canonicalUsernameBytes, identityRecordKey } from '@dagsocial/types';
import type { IdentityRecord } from '@dagsocial/types';
import type { BlockEffects, UsernameRow } from '@dagsocial/consensus';
import { proverFeedFromEffects } from '../../src/services/block-apply.js';
import { holderRecordKey, usernameRecordKey } from '../../src/state/avl-prover.js';
import { networkRecordKey } from '../../src/store/identity-records.js';
import { makeKarmaBox, uid } from '../helpers.js';

/**
 * The prover feed a block's effects imply (NODE_INTERFACE → AVL+ State Root),
 * over effects built by hand: a box inserted and removed in the block nets out;
 * an identity or network record keeps its last write; a name or holder key keeps
 * its last write, and a removal reaches the prover only for a key the state held
 * before the block (NODE_INTERFACE → "A removable record the block creates and
 * removes nets out, as a box does").
 */

type Mutation = BlockEffects['mutations'][number];

const effectsOf = (mutations: Mutation[]): BlockEffects =>
  ({ mutations, posts: [], likeRecords: [], withdrawals: [], appliedTxs: [] });

const [holder, other] = [uid('feed/holder'), uid('feed/other')];
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const identityRecordFor = (fields: Partial<IdentityRecord>): IdentityRecord => ({
  lastActivityBlock: 0,
  lastDecayBlock: 0,
  invitedAtBlock: 0,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 0,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
  ...fields,
});

const row = (nameLower: string, owner: Uint8Array, boxId: string): UsernameRow =>
  ({ nameLower, name: nameLower, owner: hexOf(owner), boxId, claimedAtBlock: 3 });

const nameKey = (nameLower: string): string => usernameRecordKey(canonicalUsernameBytes(Buffer.from(nameLower, 'utf8')));

/** A claim as the effects list it: the name record, then its holder's. */
function claim(r: UsernameRow, heldBefore: { name: boolean; holder: boolean }): Mutation[] {
  const owner = Buffer.from(r.owner, 'hex');
  return [
    { kind: 'username', nameLower: r.nameLower, row: r, heldBefore: heldBefore.name },
    { kind: 'holder', owner, record: { claimAvailable: false, boxId: r.boxId }, heldBefore: heldBefore.holder },
  ];
}

/** A burn as the effects list it: both records removed. */
function burn(r: UsernameRow, heldBefore: { name: boolean; holder: boolean }): Mutation[] {
  return [
    { kind: 'username', nameLower: r.nameLower, row: null, heldBefore: heldBefore.name },
    { kind: 'holder', owner: Buffer.from(r.owner, 'hex'), record: null, heldBefore: heldBefore.holder },
  ];
}

describe('the prover feed from a block\'s effects', () => {
  it('a box inserted and removed in the block nets out; a spend of an earlier box and a surviving insert reach the prover', () => {
    const earlier = makeKarmaBox(5n, holder, 0, 1);
    const passing = makeKarmaBox(6n, holder, 1, 2);
    const kept = makeKarmaBox(7n, other, 1, 3);
    const feed = proverFeedFromEffects(effectsOf([
      { kind: 'box', op: 'remove', boxId: earlier.id! },
      { kind: 'box', op: 'insert', boxId: passing.id!, box: passing },
      { kind: 'box', op: 'insert', boxId: kept.id!, box: kept },
      { kind: 'box', op: 'remove', boxId: passing.id! },
    ]));
    expect(feed.consumed).toEqual([earlier.id]);
    expect(feed.created).toEqual([kept]);
    expect(feed.created[0]).toBe(kept);
  });

  it('an identity record and the network record keep their last write', () => {
    const first = identityRecordFor({ lastActivityBlock: 3 });
    const last = identityRecordFor({ lastActivityBlock: 3, lastDecayBlock: 3 });
    const feed = proverFeedFromEffects(effectsOf([
      { kind: 'record', identityId: holder, record: first },
      { kind: 'network', record: { memberCount: 4 } },
      { kind: 'record', identityId: other, record: first },
      { kind: 'record', identityId: holder, record: last },
      { kind: 'network', record: { memberCount: 5 } },
    ]));
    expect(feed.recordPuts).toEqual([
      { key: identityRecordKey(holder), record: last },
      { key: identityRecordKey(other), record: first },
    ]);
    expect(feed.networkPuts).toEqual([{ key: networkRecordKey(), network: { memberCount: 5 } }]);
  });

  it('a name and a holder key the block creates and removes give the feed nothing', () => {
    const r = row('alpha', holder, 'a'.repeat(64));
    const feed = proverFeedFromEffects(effectsOf([
      ...claim(r, { name: false, holder: false }),
      ...burn(r, { name: true, holder: true }),
    ]));
    expect(feed.usernamePuts).toEqual([]);
    expect(feed.holderPuts).toEqual([]);
    expect(feed.removedRecordKeys).toEqual([]);
  });

  it('a holder key the block creates and removes nets out while the name passes to another owner', () => {
    const first = row('beta', holder, 'b'.repeat(64));
    const second = row('beta', other, 'c'.repeat(64));
    const feed = proverFeedFromEffects(effectsOf([
      ...claim(first, { name: false, holder: false }),
      ...burn(first, { name: true, holder: true }),
      ...claim(second, { name: false, holder: false }),
    ]));
    expect(feed.usernamePuts).toEqual([{ key: nameKey('beta'), username: { boxId: second.boxId } }]);
    expect(feed.holderPuts).toEqual([
      { key: holderRecordKey(other), holder: { claimAvailable: false, boxId: second.boxId } },
    ]);
    expect(feed.removedRecordKeys).toEqual([]);
  });

  it('a name key the block creates and removes nets out while its holder claims another', () => {
    const passing = row('gamma', holder, 'd'.repeat(64));
    const kept = row('delta', holder, 'e'.repeat(64));
    const feed = proverFeedFromEffects(effectsOf([
      ...claim(passing, { name: false, holder: false }),
      ...burn(passing, { name: true, holder: true }),
      ...claim(kept, { name: false, holder: false }),
    ]));
    expect(feed.usernamePuts).toEqual([{ key: nameKey('delta'), username: { boxId: kept.boxId } }]);
    expect(feed.holderPuts).toEqual([
      { key: holderRecordKey(holder), holder: { claimAvailable: false, boxId: kept.boxId } },
    ]);
    expect(feed.removedRecordKeys).toEqual([]);
  });

  it('a burn of keys the state held removes both; a re-claim after it puts', () => {
    const held = row('omega', holder, 'f'.repeat(64));
    const burned = proverFeedFromEffects(effectsOf(burn(held, { name: true, holder: true })));
    expect(burned.usernamePuts).toEqual([]);
    expect(burned.holderPuts).toEqual([]);
    expect([...burned.removedRecordKeys].sort()).toEqual([nameKey('omega'), holderRecordKey(holder)].sort());

    const again = row('omega', holder, '1'.repeat(64));
    const reclaimed = proverFeedFromEffects(effectsOf([
      ...burn(held, { name: true, holder: true }),
      ...claim(again, { name: false, holder: false }),
    ]));
    expect(reclaimed.usernamePuts).toEqual([{ key: nameKey('omega'), username: { boxId: again.boxId } }]);
    expect(reclaimed.holderPuts).toEqual([
      { key: holderRecordKey(holder), holder: { claimAvailable: false, boxId: again.boxId } },
    ]);
    expect(reclaimed.removedRecordKeys).toEqual([]);
  });
});
