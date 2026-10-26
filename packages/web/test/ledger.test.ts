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
  pendingLikeTargets,
  pendingVouchTargets,
  pendingWithdrawTargets,
} from '../src/wallet/ledger';
import { pendingWithoutStandingCards } from '../src/model/feed-reconcile';
import type { PendingEntry } from '../src/wallet/types';
import type { PostJson, PostResult, WithdrawnJson, CreditsResult } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';

const KEY = 'aa'.repeat(32); // the identity that owns the ledger
const STORE = pendingKeyFor(KEY)!; // notis.pending.<KEY>

const postEntry: PendingEntry = {
  txId: 't1', kind: 'post', postId: 'p1', expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const likeEntry: PendingEntry = {
  txId: 't2', kind: 'like', postId: 'target1', expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const noChangeEntry: PendingEntry = {
  txId: 't3', kind: 'post', postId: 'p3', expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const grantEntry: PendingEntry = {
  txId: 'g1', kind: 'grant', postId: KEY, expiresAtHeight: 5900, submittedAtHeight: 5800,
};

const TARGET = '11'.repeat(32); // vouch/unvouch subject
const INVITEE = '22'.repeat(32); // invite subject
const vouchEntry: PendingEntry = {
  txId: 'v1', kind: 'vouch', postId: TARGET, expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const unvouchEntry: PendingEntry = {
  txId: 'u1', kind: 'unvouch', postId: TARGET, expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const inviteEntry: PendingEntry = {
  txId: 'i1', kind: 'invite', postId: INVITEE, expiresAtHeight: 5720, submittedAtHeight: 5000,
};

const WITHDRAW_TARGET = 'ee'.repeat(32); // the post a withdrawal empties
const withdrawEntry: PendingEntry = {
  txId: 'w1', kind: 'withdraw', postId: WITHDRAW_TARGET, expiresAtHeight: 5720, submittedAtHeight: 5000,
};

const claimEntry: PendingEntry = {
  txId: 'c1', kind: 'claim', postId: 'Alice_01', expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const burnEntry: PendingEntry = {
  txId: 'b1', kind: 'burn', postId: 'Alice_01', expiresAtHeight: 5720, submittedAtHeight: 5000,
};

function postResult(over: Partial<PostJson>): PostResult {
  return {
    id: 'p1', content: 'x', contentHash: '00'.repeat(32), author: 'aa'.repeat(32), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 5050, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32), confirmedAuthor: 'aa'.repeat(32), ...over,
  };
}

beforeEach(() => localStorage.clear());

describe('PendingLedger — persistence and removal', () => {
  it('round-trips entries through localStorage', () => {
    const a = new PendingLedger(KEY);
    a.add(postEntry);
    a.add(likeEntry);
    a.add(noChangeEntry);
    const b = new PendingLedger(KEY);
    expect(b.all()).toEqual(a.all());
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
      txId: 't1', kind: 'post', postId: 'p1',
      expiresAtHeight: 5720, submittedAtHeight: 5000,
    };
    // A well-formed array loads.
    localStorage.setItem(STORE, JSON.stringify([good]));
    expect(new PendingLedger(KEY).size).toBe(1);
    // One good entry beside a bad-kind one → the whole ledger is dropped.
    localStorage.setItem(STORE, JSON.stringify([good, { ...good, txId: 't2', kind: 'nope' }]));
    expect(new PendingLedger(KEY).size).toBe(0);
    // Each shape fault drops the ledger: a non-string id, and a
    // submittedAtHeight that is not a number at all — restore holds any
    // number through the bound.
    const { submittedAtHeight: _built, ...unbuilt } = good;
    for (const bad of [
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
      txId, kind: 'post', postId: 'p-' + txId,
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
    // A ledger for a second key sees none of the first's entries.
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

  it('a post whose read is withheld stays pending below its expiry height and expires above it', () => {
    // A withheld answer — the extension's post check read it `unbound` or
    // `unserved` — decides nothing: the entry stays pending until the tip
    // passes its `expiresAtHeight`, never expired as on the node's 404
    // (WEB_INTERFACE → The extension → "The post check").
    expect(reconcilePost(postEntry, null, 5100, true)).toBe('pending');
    expect(reconcilePost(postEntry, null, 5721, true)).toBe('expired');
    expect(reconcilePost(postEntry, postResult({ status: 'confirmed' }), 5100, true)).toBe('pending');
  });

  it('a post that landed then became a tombstone still counts as landed', () => {
    const tomb: WithdrawnJson & { confirmedAuthor: string | null } = {
      kind: 'withdrawn', id: 'p1', author: 'aa'.repeat(32), withdrawnAtHeight: 5050, parentRefs: [],
      descendantCount: 0, authorName: null, confirmedAuthor: null, txId: 'ff'.repeat(32),
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

  it('a like whose read is withheld stays pending below its expiry height and expires above it', () => {
    // A withheld answer for a pending like matches what the no-usable-row
    // path already answers; the explicit flag states it (WEB_INTERFACE →
    // The extension → "The post check").
    expect(reconcileLike(likeEntry, null, 5100, true)).toBe('pending');
    expect(reconcileLike(likeEntry, null, 5721, true)).toBe('expired');
    expect(reconcileLike(likeEntry, postResult({ likedByViewer: true }), 5100, true)).toBe('pending');
  });
});

describe('dedupe and the pending-like overlay', () => {
  it('a row a submission card names is dropped; a row only the ledger holds is kept', () => {
    // WEB_INTERFACE → What the feed reads, and what a card shows for it →
    // "The reader's own pending post is drawn once": a submission card
    // standing in the page names 'p1'; 'p9' and 'target1' are only in the
    // pending ledger (postEntry.postId is 'p1'; likeEntry's target is not a
    // post row), and the function reads cardIds alone.
    const nodePending = [{ id: 'p1' }, { id: 'p9' }, { id: 'target1' }];
    const cardIds = new Set<string>(['p1']);
    expect(pendingWithoutStandingCards(nodePending, cardIds).map((r) => r.id)).toEqual(['p9', 'target1']);
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
    descendantCount: 0, authorName: null, confirmedAuthor: null, txId: 'ff'.repeat(32),
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

  it('a withheld read is not expired at once — the withdrawal stays pending until its expiry height', () => {
    // A node that serves the row without bytes is not the 404 (WEB_INTERFACE
    // → The extension → "The post check"): a withdrawal whose read is
    // withheld stays pending until the tip passes its `expiresAtHeight`.
    expect(reconcileWithdraw(withdrawEntry, null, 5100, true)).toBe('pending');
    expect(reconcileWithdraw(withdrawEntry, null, 5721, true)).toBe('expired');
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

  it('round-trips through localStorage — postId the key asked', () => {
    const a = new PendingLedger(KEY);
    a.add(grantEntry);
    expect(new PendingLedger(KEY).all()).toEqual([grantEntry]);
  });

  it('is neither a dedupe target nor a like-overlay target', () => {
    // The feed's pending rule reads the postIds of standing submission cards
    // alone; a grant entry is not a submission card, so a row whose id matches
    // the grant's key passes through under an empty `cardIds`
    // (WEB_INTERFACE → What the feed reads, and what a card shows for it →
    // "The reader's own pending post is drawn once").
    expect(pendingWithoutStandingCards([{ id: KEY }], new Set<string>()).map((r) => r.id)).toEqual([KEY]);
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
// The credits-side split — WEB_INTERFACE → The wallet ("There are two views,
// one per ledger"): a `send` entry rides the credits-side ledger, a
// `creditGrant` on neither, every other kind on the karma-side ledger. A
// send's change is never offered to a post, nor a post's change to a send.
// --------------------------------------------------------------------------

const RECIPIENT = '99'.repeat(32);
const PAYMENT_BOX = 'a1'.repeat(32);
const CREDIT_GRANT_BOX = 'a2'.repeat(32);
const sendEntry: PendingEntry = {
  txId: 's1', kind: 'send', postId: RECIPIENT,
  send: { toHex: RECIPIENT, toName: null, amount: 100n, boxId: PAYMENT_BOX },
  expiresAtHeight: 5720, submittedAtHeight: 5000,
};
const sendWithNameEntry: PendingEntry = {
  ...sendEntry,
  txId: 's2',
  send: { toHex: RECIPIENT, toName: 'bob', amount: 250n, boxId: 'a3'.repeat(32) },
};
const creditGrantEntry: PendingEntry = {
  txId: 'cg1', kind: 'creditGrant', postId: CREDIT_GRANT_BOX,
  expiresAtHeight: 5900, submittedAtHeight: 5800,
};

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

  it('a creditGrant entry round-trips through localStorage — no send', () => {
    const a = new PendingLedger(KEY);
    a.add(creditGrantEntry);
    expect(new PendingLedger(KEY).all()).toEqual([creditGrantEntry]);
  });

  it('a malformed send field drops the whole ledger — all or nothing', () => {
    const good = {
      txId: 's1', kind: 'send', postId: RECIPIENT,
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

