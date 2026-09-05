// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PendingLedger,
  pendingKeyFor,
  reconcilePost,
  reconcileLike,
  reconcileGrant,
  reconcileVouch,
  reconcileUnvouch,
  reconcileInvite,
  reconcileWithdraw,
  dedupePending,
  pendingLikeTargets,
  pendingVouchTargets,
  pendingWithdrawTargets,
} from '../src/wallet/ledger';
import type { PendingEntry } from '../src/wallet/types';
import type { PostJson, PostResult, StumpJson, PrunedJson, WithdrawnJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';

const KEY = 'aa'.repeat(32); // the identity that owns the ledger
const STORE = pendingKeyFor(KEY)!; // notis.pending.<KEY>

const postEntry: PendingEntry = {
  txId: 't1', kind: 'post', postId: 'p1', inputs: ['in1'],
  change: { boxId: 'chg1', value: 222n, createdAtBlock: 5000 }, expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const likeEntry: PendingEntry = {
  txId: 't2', kind: 'like', postId: 'target1', inputs: ['in2'],
  change: { boxId: 'chg2', value: 226n, createdAtBlock: 5000 }, expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const noChangeEntry: PendingEntry = {
  txId: 't3', kind: 'post', postId: 'p3', inputs: ['in5'], expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const grantEntry: PendingEntry = {
  txId: 'g1', kind: 'grant', postId: KEY, inputs: [], expiresAtHeight: 5900, submittedAtHeight: 5800,
};

const TARGET = '11'.repeat(32); // vouch/unvouch subject
const INVITEE = '22'.repeat(32); // invite subject
const VOUCH_BOX = '33'.repeat(32); // the vouch box an unvouch spends
const vouchEntry: PendingEntry = {
  txId: 'v1', kind: 'vouch', postId: TARGET, inputs: ['in6'],
  change: { boxId: 'chg6', value: 226n, createdAtBlock: 5000 }, expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const unvouchEntry: PendingEntry = {
  txId: 'u1', kind: 'unvouch', postId: TARGET, inputs: [VOUCH_BOX], expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const inviteEntry: PendingEntry = {
  txId: 'i1', kind: 'invite', postId: INVITEE, inputs: ['in7'],
  change: { boxId: 'chg7', value: 127n, createdAtBlock: 5000 }, expiresAtHeight: 5720, submittedAtHeight: 5000,
};

const WITHDRAW_TARGET = 'ee'.repeat(32); // the post a withdrawal empties
const withdrawEntry: PendingEntry = {
  txId: 'w1', kind: 'withdraw', postId: WITHDRAW_TARGET, inputs: ['in8'],
  change: { boxId: 'chg8', value: 227n, createdAtBlock: 5000 }, expiresAtHeight: 5720, submittedAtHeight: 5000,
};

function postResult(over: Partial<PostJson>): PostResult {
  return {
    id: 'p1', content: 'x', contentHash: '00'.repeat(32), author: 'aa'.repeat(32), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 5050, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, likedByViewer: null, confirmedAuthor: 'aa'.repeat(32), ...over,
  };
}

beforeEach(() => localStorage.clear());

describe('PendingLedger — the spendable view', () => {
  it('drops a spent input and adds the predicted change', () => {
    const ledger = new PendingLedger(KEY);
    ledger.add(postEntry);
    const confirmed = [{ boxId: 'in1', value: 100n }, { boxId: 'in3', value: 50n }];
    expect(ledger.spendable(confirmed)).toEqual([
      { boxId: 'in3', value: 50n },
      { boxId: 'chg1', value: 222n },
    ]);
  });

  it('a change already chained into a later pending transaction drops out too', () => {
    const ledger = new PendingLedger(KEY);
    ledger.add(postEntry); // change 'chg1'
    ledger.add({
      txId: 't9', kind: 'post', postId: 'p9', inputs: ['chg1'],
      change: { boxId: 'chg9', value: 217n, createdAtBlock: 5001 }, expiresAtHeight: 5721, submittedAtHeight: 5001,
    });
    // 'chg1' is now an input, so it is not spendable; only 'chg9' remains from the changes.
    expect(ledger.spendable([{ boxId: 'in1', value: 100n }])).toEqual([{ boxId: 'chg9', value: 217n }]);
  });
});

describe('PendingLedger — persistence and removal', () => {
  it('round-trips entries through localStorage with bigints intact', () => {
    const a = new PendingLedger(KEY);
    a.add(postEntry);
    a.add(likeEntry);
    a.add(noChangeEntry);
    const b = new PendingLedger(KEY);
    expect(b.all()).toEqual(a.all());
    const restored = b.all().find((e) => e.txId === 't1');
    expect(restored?.change?.value).toBe(222n);
    expect(b.all().find((e) => e.txId === 't3')?.change).toBeUndefined();
  });

  it('remove() drops an entry and persists the removal — the 409 drop', () => {
    const ledger = new PendingLedger(KEY);
    ledger.add(postEntry);
    expect(ledger.size).toBe(1);
    ledger.remove('t1');
    expect(ledger.size).toBe(0);
    expect(new PendingLedger(KEY).size).toBe(0);
  });

  it('a corrupt store starts the ledger empty rather than throwing', () => {
    localStorage.setItem(STORE, '{ not an array');
    expect(new PendingLedger(KEY).size).toBe(0);
    localStorage.setItem(STORE, JSON.stringify({ notAn: 'array' }));
    expect(new PendingLedger(KEY).size).toBe(0);
  });

  it('a single malformed entry starts the whole ledger empty — all or nothing', () => {
    const good = {
      txId: 't1', kind: 'post', postId: 'p1', inputs: ['in1'],
      change: { boxId: 'chg1', value: '222', createdAtBlock: 5000 }, expiresAtHeight: 5720, submittedAtHeight: 5000,
    };
    // A well-formed array loads.
    localStorage.setItem(STORE, JSON.stringify([good]));
    expect(new PendingLedger(KEY).size).toBe(1);
    // One good entry beside a bad-kind one → the whole ledger is dropped.
    localStorage.setItem(STORE, JSON.stringify([good, { ...good, txId: 't2', kind: 'nope' }]));
    expect(new PendingLedger(KEY).size).toBe(0);
    // Each shape fault drops the ledger: non-string inputs, non-numeric height,
    // and a change whose value is not a decimal string.
    for (const bad of [
      { ...good, inputs: [1, 2] },
      { ...good, expiresAtHeight: 'soon' },
      { ...good, change: { boxId: 'c', value: 5, createdAtBlock: 1 } },
      { ...good, txId: 42 },
    ]) {
      localStorage.setItem(STORE, JSON.stringify([bad]));
      expect(new PendingLedger(KEY).size, JSON.stringify(bad)).toBe(0);
    }
  });

  it('two identities never see each other\'s entries', () => {
    const KEY2 = 'bb'.repeat(32);
    new PendingLedger(KEY).add(postEntry);
    // A ledger for a second key sees none of the first's predicted change.
    const b = new PendingLedger(KEY2);
    expect(b.size).toBe(0);
    b.add({ ...postEntry, txId: 'other' });
    // Each persists under its own key; neither leaks into the other.
    expect(new PendingLedger(KEY).all().map((e) => e.txId)).toEqual(['t1']);
    expect(new PendingLedger(KEY2).all().map((e) => e.txId)).toEqual(['other']);
    expect(localStorage.getItem(pendingKeyFor(KEY)!)).not.toBeNull();
    expect(localStorage.getItem(pendingKeyFor(KEY2)!)).not.toBeNull();
  });

  it('no identity → an empty ledger that persists nothing', () => {
    const before = localStorage.length;
    const l = new PendingLedger(null);
    expect(l.size).toBe(0);
    l.add(postEntry); // held in memory, but nothing is written
    expect(l.size).toBe(1);
    expect(localStorage.length).toBe(before);
  });
});

describe('reconcile', () => {
  it('a post lands when confirmed, expires on 404 or past the tip, else pending', () => {
    expect(reconcilePost(postEntry, postResult({ status: 'confirmed' }), 5100)).toBe('landed');
    expect(reconcilePost(postEntry, null, 5100)).toBe('expired');
    expect(reconcilePost(postEntry, postResult({ status: 'pending', blockHeight: null }), 5100)).toBe('pending');
    expect(reconcilePost(postEntry, postResult({ status: 'pending', blockHeight: null }), 5721)).toBe('expired');
  });

  it('a post that landed then became a tombstone still counts as landed', () => {
    const tomb: WithdrawnJson & { confirmedAuthor: string | null } = {
      kind: 'withdrawn', id: 'p1', author: 'aa'.repeat(32), withdrawnAtHeight: 5050, parentRefs: [], confirmedAuthor: null,
    };
    expect(reconcilePost(postEntry, tomb, 5100)).toBe('landed');
  });

  it('a like lands when likedByViewer turns true, expires past the tip while still false', () => {
    expect(reconcileLike(likeEntry, postResult({ likedByViewer: true }), 5100)).toBe('landed');
    expect(reconcileLike(likeEntry, postResult({ likedByViewer: false }), 5100)).toBe('pending');
    expect(reconcileLike(likeEntry, postResult({ likedByViewer: false }), 5721)).toBe('expired');
    expect(reconcileLike(likeEntry, null, 5100)).toBe('pending');
    expect(reconcileLike(likeEntry, null, 5721)).toBe('expired');
  });
});

describe('dedupe and the pending-like overlay', () => {
  it('drops the node pending rows the ledger holds as posts, keeping the rest', () => {
    const nodePending = [{ id: 'p1' }, { id: 'p9' }, { id: 'target1' }];
    // Only the post entry's postId ('p1') is dropped; a like's target is not a post row.
    expect(dedupePending(nodePending, [postEntry, likeEntry]).map((r) => r.id)).toEqual(['p9', 'target1']);
  });

  it('the overlay names only the like targets', () => {
    const targets = pendingLikeTargets([postEntry, likeEntry, noChangeEntry]);
    expect(targets.has('target1')).toBe(true);
    expect(targets.has('p1')).toBe(false);
    expect(targets.size).toBe(1);
  });
});

describe('the membership reconciles', () => {
  it('a vouch lands when the pair is listed, expires past the tip, else pending', () => {
    expect(reconcileVouch(vouchEntry, [{ targetId: TARGET }], 5100)).toBe('landed');
    expect(reconcileVouch(vouchEntry, [{ targetId: 'ff'.repeat(32) }], 5100)).toBe('pending');
    expect(reconcileVouch(vouchEntry, [], 5721)).toBe('expired');
  });

  it('an unvouch lands on the pair\'s absence alone — the escrow can settle before the poll sees it', () => {
    // The pair still present → the vouch box is unspent → pending.
    expect(reconcileUnvouch(unvouchEntry, [{ targetId: TARGET }], 5100)).toBe('pending');
    // The pair gone → landed, whether or not a cooldown row stands: a vouch held
    // past one cooldown yields an escrow the next block's settlement returns, so
    // the row can stand for a single block the poll never catches.
    expect(reconcileUnvouch(unvouchEntry, [], 5100)).toBe('landed');
    // Never landed, past the tip → expired.
    expect(reconcileUnvouch(unvouchEntry, [{ targetId: TARGET }], 5721)).toBe('expired');
  });

  it('an invite lands when a bond names the invitee, expires past the tip, else pending', () => {
    expect(reconcileInvite(inviteEntry, [{ inviteePublicKey: INVITEE }], 5100)).toBe('landed');
    expect(reconcileInvite(inviteEntry, [{ inviteePublicKey: 'ff'.repeat(32) }], 5100)).toBe('pending');
    expect(reconcileInvite(inviteEntry, [], 5721)).toBe('expired');
  });

  it('pendingVouchTargets names only the vouch entries', () => {
    const targets = pendingVouchTargets([vouchEntry, unvouchEntry, inviteEntry, likeEntry]);
    expect(targets.has(TARGET)).toBe(true);
    expect(targets.has(INVITEE)).toBe(false);
    expect(targets.size).toBe(1);
  });

  it('an unvouch entry does not touch the spendable view — its input is a vouch box', () => {
    const ledger = new PendingLedger(KEY);
    ledger.add(unvouchEntry);
    const confirmed = [{ boxId: 'k1', value: 100n }, { boxId: 'k2', value: 50n }];
    // The vouch box the unvouch spends is not among the confirmed karma boxes, and
    // the entry predicts no change, so the view is unchanged.
    expect(ledger.spendable(confirmed)).toEqual(confirmed);
  });

  it('round-trips the three kinds through localStorage', () => {
    const a = new PendingLedger(KEY);
    a.add(vouchEntry);
    a.add(unvouchEntry);
    a.add(inviteEntry);
    expect(new PendingLedger(KEY).all()).toEqual(a.all());
  });
});

describe('the withdraw reconcile', () => {
  const withdrawnTomb: PostResult = {
    kind: 'withdrawn', id: WITHDRAW_TARGET, author: KEY, withdrawnAtHeight: 5050, parentRefs: [], confirmedAuthor: null,
  } as WithdrawnJson & { confirmedAuthor: string | null };
  const stumpTomb: PostResult = {
    kind: 'stump', id: WITHDRAW_TARGET, author: KEY, replyCount: 2, upvoteCount: 0,
    protocolVersion: 1, compactedAtBlockHeight: 5050, confirmedAuthor: null,
  } as StumpJson & { confirmedAuthor: string | null };
  const prunedTomb: PostResult = {
    kind: 'pruned', id: WITHDRAW_TARGET, author: KEY, rootPostHash: 'aa'.repeat(32),
    compactedAtBlockHeight: 5050, confirmedAuthor: null,
  } as PrunedJson & { confirmedAuthor: string | null };

  it('lands on any tombstone — withdrawn, or a stump/pruned when the thread went first', () => {
    expect(reconcileWithdraw(withdrawEntry, withdrawnTomb, 5100)).toBe('landed');
    expect(reconcileWithdraw(withdrawEntry, stumpTomb, 5100)).toBe('landed');
    expect(reconcileWithdraw(withdrawEntry, prunedTomb, 5100)).toBe('landed');
  });

  it('a live post is still pending — a confirmed live post is not a withdrawal landing', () => {
    const live = postResult({ id: WITHDRAW_TARGET, status: 'confirmed' });
    expect(reconcileWithdraw(withdrawEntry, live, 5100)).toBe('pending');
    expect(reconcileWithdraw(withdrawEntry, live, 5721)).toBe('expired');
  });

  it('a 404 is expired — the post is unknown to this node, so nothing can land', () => {
    // The resolution-order case a pruned descendant can take: a 404 rather than a
    // tombstone (NODE_INTERFACE → Resolution order for a post id) — still a done
    // withdrawal, read as expired.
    expect(reconcileWithdraw(withdrawEntry, null, 5100)).toBe('expired');
  });

  it('pendingWithdrawTargets names only the withdraw entries', () => {
    const targets = pendingWithdrawTargets([withdrawEntry, likeEntry, postEntry]);
    expect(targets.has(WITHDRAW_TARGET)).toBe(true);
    expect(targets.has('target1')).toBe(false);
    expect(targets.size).toBe(1);
  });

  it('round-trips a withdraw entry through localStorage', () => {
    const a = new PendingLedger(KEY);
    a.add(withdrawEntry);
    expect(new PendingLedger(KEY).all()).toEqual(a.all());
  });
});

describe('the faucet grant entry', () => {
  it('lands when /karma boxCount rises, expires past the tip while still zero, else pending', () => {
    expect(reconcileGrant(grantEntry, karmaResult({ boxCount: 1 }), 5850)).toBe('landed');
    expect(reconcileGrant(grantEntry, karmaResult({ boxCount: 0 }), 5850)).toBe('pending');
    expect(reconcileGrant(grantEntry, karmaResult({ boxCount: 0 }), 5901)).toBe('expired');
    // A risen boxCount lands even past the expiry height.
    expect(reconcileGrant(grantEntry, karmaResult({ boxCount: 1 }), 5901)).toBe('landed');
  });

  it('round-trips through localStorage — inputs [], no change, postId the key asked', () => {
    const a = new PendingLedger(KEY);
    a.add(grantEntry);
    expect(new PendingLedger(KEY).all()).toEqual([grantEntry]);
  });

  it('is inert in the spendable view — a grant spends and predicts nothing', () => {
    const ledger = new PendingLedger(KEY);
    ledger.add(grantEntry);
    const confirmed = [{ boxId: 'b1', value: 100n }, { boxId: 'b2', value: 50n }];
    // The same view an empty ledger gives — inputs [] and no change touch nothing.
    expect(ledger.spendable(confirmed)).toEqual(confirmed);
  });

  it('is neither a dedupe target nor a like-overlay target', () => {
    expect(dedupePending([{ id: KEY }], [grantEntry]).map((r) => r.id)).toEqual([KEY]);
    expect(pendingLikeTargets([grantEntry]).size).toBe(0);
  });
});
