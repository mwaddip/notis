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
  reconcileClaim,
  reconcileBurn,
  reconcileSend,
  reconcileCreditGrant,
  pendingUsernameEntry,
  pendingSendEntries,
  dedupePending,
  pendingLikeTargets,
  pendingVouchTargets,
  pendingWithdrawTargets,
} from '../src/wallet/ledger';
import type { PendingEntry } from '../src/wallet/types';
import type { PostJson, PostResult, WithdrawnJson, CreditsResult } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';

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

const claimEntry: PendingEntry = {
  txId: 'c1', kind: 'claim', postId: 'Alice_01', inputs: ['in9'],
  change: { boxId: 'chg9', value: 227n, createdAtBlock: 5000 }, expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const burnEntry: PendingEntry = {
  txId: 'b1', kind: 'burn', postId: 'Alice_01', inputs: ['in10', 'name_box'],
  change: { boxId: 'chg10', value: 217n, createdAtBlock: 5000 }, expiresAtHeight: 5720, submittedAtHeight: 5000,
};

function postResult(over: Partial<PostJson>): PostResult {
  return {
    id: 'p1', content: 'x', contentHash: '00'.repeat(32), author: 'aa'.repeat(32), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 5050, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor: 'aa'.repeat(32), ...over,
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
    // Each shape fault drops the ledger: non-string inputs, a change whose value
    // is not a decimal string, a non-string id, and a submittedAtHeight that is
    // not a number at all — restore holds any number through the bound.
    const { submittedAtHeight: _built, ...unbuilt } = good;
    for (const bad of [
      { ...good, inputs: [1, 2] },
      { ...good, change: { boxId: 'c', value: 5, createdAtBlock: 1 } },
      { ...good, txId: 42 },
      { ...good, submittedAtHeight: 'soon' },
      { ...good, submittedAtHeight: null },
      unbuilt,
    ]) {
      localStorage.setItem(STORE, JSON.stringify([good, bad]));
      expect(new PendingLedger(KEY).size, JSON.stringify(bad)).toBe(0);
    }
  });

  it('restore takes any number as submittedAtHeight — a fraction, a negative and an out-of-range value all restore, bounded', () => {
    const stored = (txId: string, submittedAtHeight: number): Record<string, unknown> => ({
      txId, kind: 'post', postId: 'p-' + txId, inputs: ['in-' + txId],
      submittedAtHeight, expiresAtHeight: 5720,
    });
    localStorage.setItem(STORE, JSON.stringify([
      stored('t1', 5000.5),
      stored('t2', -1),
      stored('t3', 2 ** 53),
    ]));
    const restored = new PendingLedger(KEY).all();
    expect(restored.map((e) => [e.txId, e.submittedAtHeight, e.expiresAtHeight])).toEqual([
      ['t1', 5000.5, Math.min(5720, 5000.5 + MEMPOOL_EXPIRY_BLOCKS)],
      ['t2', -1, Math.min(5720, -1 + MEMPOOL_EXPIRY_BLOCKS)],
      ['t3', 2 ** 53, Math.min(5720, 2 ** 53 + MEMPOOL_EXPIRY_BLOCKS)],
    ]);
  });

  // WEB_INTERFACE → The wallet → "A pending entry's expiry is the client's, and a
  // node's answer can only bring it sooner": the ledger bounds an entry where it
  // enters — added, and restored from storage.
  it('add holds the entry with its expiry bounded and answers the entry it holds', () => {
    const ledger = new PendingLedger(KEY);
    const held = ledger.add({ ...postEntry, expiresAtHeight: 1e15 });
    expect(held.expiresAtHeight).toBe(5720); // 5000 + MEMPOOL_EXPIRY_BLOCKS
    expect(ledger.all()).toEqual([held]);
    expect(ledger.all()[0]).toBe(held);
    // The bounded value is the one persisted.
    expect(new PendingLedger(KEY).all()[0]?.expiresAtHeight).toBe(5720);
    // An answer with no expiry is held at the client's own; one below the bound stays.
    expect(ledger.add({ ...likeEntry, expiresAtHeight: undefined }).expiresAtHeight).toBe(5720);
    expect(ledger.add({ ...noChangeEntry, expiresAtHeight: 5100 }).expiresAtHeight).toBe(5100);
  });

  it('restore bounds a stored entry carrying a later height, none, or one of another shape — the rest of the ledger loads', () => {
    const stored = (txId: string, over: Record<string, unknown>): Record<string, unknown> => ({
      txId, kind: 'post', postId: 'p-' + txId, inputs: ['in-' + txId], submittedAtHeight: 5000, expiresAtHeight: 5720, ...over,
    });
    const { expiresAtHeight: _none, ...noExpiry } = stored('t2', {});
    localStorage.setItem(STORE, JSON.stringify([
      stored('t1', { expiresAtHeight: 1e15 }),
      noExpiry,
      stored('t3', { expiresAtHeight: 'soon' }),
      stored('t4', { expiresAtHeight: 5300 }),
    ]));
    const restored = new PendingLedger(KEY).all();
    expect(restored.map((e) => [e.txId, e.expiresAtHeight])).toEqual([
      ['t1', 5720], ['t2', 5720], ['t3', 5720], ['t4', 5300],
    ]);
  });

  it('a grant stored at submittedAtHeight 0 restores bounded at 720: it still lands on its box, and past 720 without one it expires', () => {
    localStorage.setItem(STORE, JSON.stringify([{ ...grantEntry, submittedAtHeight: 0 }]));
    const [grant] = new PendingLedger(KEY).all();
    expect(grant?.expiresAtHeight).toBe(720);
    expect(reconcileGrant(grant!, karmaResult({ boxCount: 1 }), 5850)).toBe('landed');
    expect(reconcileGrant(grant!, karmaResult({ boxCount: 0 }), 5850)).toBe('expired');
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
      kind: 'withdrawn', id: 'p1', author: 'aa'.repeat(32), withdrawnAtHeight: 5050, parentRefs: [],
      descendantCount: 0, authorName: null, confirmedAuthor: null,
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
    kind: 'withdrawn', id: WITHDRAW_TARGET, author: KEY, withdrawnAtHeight: 5050, parentRefs: [],
    descendantCount: 0, authorName: null, confirmedAuthor: null,
  } as WithdrawnJson & { confirmedAuthor: string | null };

  it('lands on the withdrawn marker', () => {
    expect(reconcileWithdraw(withdrawEntry, withdrawnTomb, 5100)).toBe('landed');
  });

  it('a live post is still pending — a confirmed live post is not a withdrawal landing', () => {
    const live = postResult({ id: WITHDRAW_TARGET, status: 'confirmed' });
    expect(reconcileWithdraw(withdrawEntry, live, 5100)).toBe('pending');
    expect(reconcileWithdraw(withdrawEntry, live, 5721)).toBe('expired');
  });

  it('a 404 is expired — the post is unknown to this node, so nothing can land', () => {
    // An id the node has never heard of (NODE_INTERFACE → Resolution order for a
    // post id) — still a done withdrawal, read as expired.
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

describe('the username reconciles', () => {
  it('a claim lands when the owner holds the name, expires past the tip, else pending', () => {
    expect(reconcileClaim(claimEntry, { name: 'Alice_01', owner: KEY, boxId: 'x', claimedAtBlock: 5050 }, 5100)).toBe('landed');
    expect(reconcileClaim(claimEntry, null, 5100)).toBe('pending');
    expect(reconcileClaim(claimEntry, null, 5721)).toBe('expired');
    expect(reconcileClaim(claimEntry, { name: 'other', owner: KEY, boxId: 'x', claimedAtBlock: 5050 }, 5100)).toBe('pending');
  });

  it('a burn lands when the owner holds no name or a different one, expires past the tip, else pending', () => {
    expect(reconcileBurn(burnEntry, null, 5100)).toBe('landed');
    expect(reconcileBurn(burnEntry, { name: 'other', owner: KEY, boxId: 'x', claimedAtBlock: 5050 }, 5100)).toBe('landed');
    expect(reconcileBurn(burnEntry, { name: 'Alice_01', owner: KEY, boxId: 'x', claimedAtBlock: 5050 }, 5100)).toBe('pending');
    expect(reconcileBurn(burnEntry, { name: 'Alice_01', owner: KEY, boxId: 'x', claimedAtBlock: 5050 }, 5721)).toBe('expired');
  });

  it('pendingUsernameEntry finds the first claim or burn, null otherwise', () => {
    expect(pendingUsernameEntry([postEntry, likeEntry])).toBeNull();
    expect(pendingUsernameEntry([postEntry, claimEntry])).toEqual({ kind: 'claim', name: 'Alice_01' });
    expect(pendingUsernameEntry([burnEntry, postEntry])).toEqual({ kind: 'burn', name: 'Alice_01' });
  });

  it('round-trips claim and burn entries through localStorage', () => {
    const a = new PendingLedger(KEY);
    a.add(claimEntry);
    expect(new PendingLedger(KEY).all()).toEqual([claimEntry]);
    localStorage.clear();
    const b = new PendingLedger(KEY);
    b.add(burnEntry);
    expect(new PendingLedger(KEY).all()).toEqual([burnEntry]);
  });
});

// --------------------------------------------------------------------------
// The credits-side split — WEB_INTERFACE → The wallet ("There are two views
// over one ledger"): a `send` entry's inputs and change count on the credits
// side only, a `creditGrant` on neither, every other kind on the karma side
// only. A send's change is never offered to a post, nor a post's change to a
// send.
// --------------------------------------------------------------------------

const RECIPIENT = '99'.repeat(32);
const PAYMENT_BOX = 'a1'.repeat(32);
const CREDIT_GRANT_BOX = 'a2'.repeat(32);
const sendEntry: PendingEntry = {
  txId: 's1', kind: 'send', postId: RECIPIENT,
  inputs: ['credit_in1'],
  change: { boxId: 'credit_chg', value: 500n, createdAtBlock: 5000 },
  send: { toHex: RECIPIENT, toName: null, amount: 100n, boxId: PAYMENT_BOX },
  expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const sendWithNameEntry: PendingEntry = {
  ...sendEntry,
  txId: 's2',
  send: { toHex: RECIPIENT, toName: 'bob', amount: 250n, boxId: 'a3'.repeat(32) },
};
const creditGrantEntry: PendingEntry = {
  txId: 'cg1', kind: 'creditGrant', postId: CREDIT_GRANT_BOX, inputs: [],
  expiresAtHeight: 5900, submittedAtHeight: 5800,
};

describe('the two views over one ledger', () => {
  it('a send\'s inputs and change count in the credits view — the karma view leaves them alone', () => {
    const ledger = new PendingLedger(KEY);
    ledger.add(sendEntry);
    const credits = [{ boxId: 'credit_in1', value: 600n }, { boxId: 'credit_other', value: 30n }];
    // Credits view: input dropped, change added.
    expect(ledger.spendable(credits, 'credits')).toEqual([
      { boxId: 'credit_other', value: 30n },
      { boxId: 'credit_chg', value: 500n },
    ]);
    // Karma view: the credit input passes through untouched, and no credit change appears.
    const karma = [{ boxId: 'karma_in', value: 100n }];
    expect(ledger.spendable(karma, 'karma')).toEqual(karma);
  });

  it('a post\'s inputs and change count in the karma view — the credits view leaves them alone', () => {
    const ledger = new PendingLedger(KEY);
    ledger.add(postEntry);
    const karma = [{ boxId: 'in1', value: 300n }];
    expect(ledger.spendable(karma, 'karma')).toEqual([{ boxId: 'chg1', value: 222n }]);
    const credits = [{ boxId: 'credit_x', value: 500n }];
    expect(ledger.spendable(credits, 'credits')).toEqual(credits);
  });

  it('a creditGrant is inert on both sides — it spends nothing and predicts no change', () => {
    const ledger = new PendingLedger(KEY);
    ledger.add(creditGrantEntry);
    const credits = [{ boxId: 'c1', value: 100n }];
    const karma = [{ boxId: 'k1', value: 100n }];
    expect(ledger.spendable(credits, 'credits')).toEqual(credits);
    expect(ledger.spendable(karma, 'karma')).toEqual(karma);
  });

  it('the default side is karma — every pre-send caller reads the karma view', () => {
    const ledger = new PendingLedger(KEY);
    ledger.add(postEntry);
    expect(ledger.spendable([{ boxId: 'in1', value: 300n }])).toEqual([{ boxId: 'chg1', value: 222n }]);
  });
});

describe('the credits reconciles', () => {
  it('reconcileSend lands when the recipient\'s boxes list the payment box id', () => {
    expect(reconcileSend(sendEntry, [{ boxId: PAYMENT_BOX }], 5100)).toBe('landed');
    expect(reconcileSend(sendEntry, [{ boxId: 'other' }], 5100)).toBe('pending');
    expect(reconcileSend(sendEntry, [], 5721)).toBe('expired');
  });

  it('reconcileCreditGrant lands when the reader\'s /credits lists the grant\'s box', () => {
    const withBox: CreditsResult = { userId: KEY, total: '10', boxes: [{ boxId: CREDIT_GRANT_BOX, value: '10' }], boxCount: 1, next: null };
    const empty: CreditsResult = { userId: KEY, total: '0', boxes: [], boxCount: 0, next: null };
    expect(reconcileCreditGrant(creditGrantEntry, withBox, 5850)).toBe('landed');
    expect(reconcileCreditGrant(creditGrantEntry, empty, 5850)).toBe('pending');
    expect(reconcileCreditGrant(creditGrantEntry, empty, 5901)).toBe('expired');
    // A key with an unrelated box does not land the grant.
    const other: CreditsResult = { userId: KEY, total: '5', boxes: [{ boxId: 'unrelated', value: '5' }], boxCount: 1, next: null };
    expect(reconcileCreditGrant(creditGrantEntry, other, 5850)).toBe('pending');
  });

  it('pendingSendEntries names the resolved recipient, the handle when one was typed, and the amount', () => {
    const rows = pendingSendEntries([postEntry, sendEntry, sendWithNameEntry]);
    expect(rows).toEqual([
      { toHex: RECIPIENT, toName: null, amount: 100n },
      { toHex: RECIPIENT, toName: 'bob', amount: 250n },
    ]);
  });
});

describe('the send payload — round trip and malformed refusal', () => {
  it('the send payload survives localStorage — bigint amount decoded back', () => {
    const a = new PendingLedger(KEY);
    a.add(sendEntry);
    a.add(sendWithNameEntry);
    const b = new PendingLedger(KEY);
    expect(b.all()).toEqual(a.all());
    const restored = b.all().find((e) => e.txId === 's1');
    expect(restored?.send?.amount).toBe(100n);
    expect(restored?.send?.toName).toBeNull();
  });

  it('a creditGrant entry round-trips through localStorage — inputs [] and no send', () => {
    const a = new PendingLedger(KEY);
    a.add(creditGrantEntry);
    expect(new PendingLedger(KEY).all()).toEqual([creditGrantEntry]);
  });

  it('a malformed send field drops the whole ledger — all or nothing', () => {
    const good = {
      txId: 's1', kind: 'send', postId: RECIPIENT, inputs: ['x'],
      send: { toHex: RECIPIENT, toName: null, amount: '100', boxId: PAYMENT_BOX },
      expiresAtHeight: 5720, submittedAtHeight: 5000,
    };
    localStorage.setItem(STORE, JSON.stringify([good]));
    expect(new PendingLedger(KEY).size).toBe(1);
    for (const bad of [
      { ...good, send: { ...good.send, toHex: 123 } },
      { ...good, send: { ...good.send, amount: 100 } }, // number, not decimal string
      { ...good, send: { ...good.send, boxId: null } },
      { ...good, send: { ...good.send, toName: 5 } }, // not string or null
      { ...good, send: 'nope' },
    ]) {
      localStorage.setItem(STORE, JSON.stringify([bad]));
      expect(new PendingLedger(KEY).size, JSON.stringify(bad)).toBe(0);
    }
  });
});
