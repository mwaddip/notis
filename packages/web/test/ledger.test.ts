// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PendingLedger,
  PENDING_KEY,
  reconcilePost,
  reconcileLike,
  dedupePending,
  pendingLikeTargets,
} from '../src/wallet/ledger';
import type { PendingEntry } from '../src/wallet/types';
import type { PostJson, PostResult, WithdrawnJson } from '../src/api/dto';

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
    const ledger = new PendingLedger();
    ledger.add(postEntry);
    const confirmed = [{ boxId: 'in1', value: 100n }, { boxId: 'in3', value: 50n }];
    expect(ledger.spendable(confirmed)).toEqual([
      { boxId: 'in3', value: 50n },
      { boxId: 'chg1', value: 222n },
    ]);
  });

  it('a change already chained into a later pending transaction drops out too', () => {
    const ledger = new PendingLedger();
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
    const a = new PendingLedger();
    a.add(postEntry);
    a.add(likeEntry);
    a.add(noChangeEntry);
    const b = new PendingLedger();
    expect(b.all()).toEqual(a.all());
    const restored = b.all().find((e) => e.txId === 't1');
    expect(restored?.change?.value).toBe(222n);
    expect(b.all().find((e) => e.txId === 't3')?.change).toBeUndefined();
  });

  it('remove() drops an entry and persists the removal — the 409 drop', () => {
    const ledger = new PendingLedger();
    ledger.add(postEntry);
    expect(ledger.size).toBe(1);
    ledger.remove('t1');
    expect(ledger.size).toBe(0);
    expect(new PendingLedger().size).toBe(0);
  });

  it('a corrupt store starts the ledger empty rather than throwing', () => {
    localStorage.setItem(PENDING_KEY, '{ not an array');
    expect(new PendingLedger().size).toBe(0);
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
      kind: 'withdrawn', id: 'p1', author: 'aa'.repeat(32), withdrawnAtHeight: 5050, confirmedAuthor: null,
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
