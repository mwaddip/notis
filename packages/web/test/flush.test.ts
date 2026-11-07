// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import { flushWaiting, type FlushDeps } from '../src/wallet/flush';
import { PendingLedger } from '../src/wallet/ledger';
import { WaitingStore, type WaitingStorage, type WaitingWrite } from '../src/wallet/waiting';
import { fakeLockManager } from './fake-chrome';
import type {
  PostSubmitResult, LikeSubmitResult, VouchSubmitResult, InviteSubmitResult,
  WithdrawSubmitResult, ClaimSubmitResult, SendSubmitResult, Rejection,
} from '../src/api/write';

// WEB_INTERFACE → The wallet → "Waiting writes go out at the first answer": a
// flush walks the ledger's waiting writes in seq order, sends each by its
// kind, and either releases, refuses or leaves it waiting on the first no
// answer. WEB_INTERFACE → The wallet → "A refusal ends what it strands"
// strands every later write of the ledger that spends the refused one's
// change (or a change of one already stranded), and so does a write of
// another chain.

const PUB = 'aa'.repeat(32);
const CHAIN = 'ab'.repeat(32);
const CHAIN_B = 'cd'.repeat(32);

function fakeStorage(): WaitingStorage {
  const m = new Map<string, string>();
  return {
    get length(): number { return m.size; },
    getItem(k: string): string | null { return m.has(k) ? m.get(k)! : null; },
    setItem(k: string, v: string): void { m.set(k, v); },
    removeItem(k: string): void { m.delete(k); },
    key(i: number): string | null {
      const keys = [...m.keys()];
      return i >= 0 && i < keys.length ? keys[i]! : null;
    },
  };
}

type Call =
  | { kind: 'post'; tx: Record<string, unknown>; content: string }
  | { kind: 'like'; tx: Record<string, unknown> }
  | { kind: 'vouch'; tx: Record<string, unknown> }
  | { kind: 'invite'; tx: Record<string, unknown> }
  | { kind: 'withdraw'; postId: string; tx: Record<string, unknown> }
  | { kind: 'claim'; tx: Record<string, unknown> }
  | { kind: 'send'; tx: Record<string, unknown> };

interface Scripted {
  calls: Call[];
  /** Script per txId (the key the test stored on the waiting write's tx) → the
   *  answer. Anything not scripted answers a plain 2xx echoing the txId.
   *  `okPost` kinds echo `postId` from `tx.postId` when the test wants a
   *  specific id; the default post answer re-echoes the write's claimed postId
   *  from the test-provided `postIdByTx` map.
   */
  script?: Map<string, unknown>;
  /** The post id the node answers for a given stored txId — defaults to the
   *  write's own `postId`, which the walk compares against. */
  postIdByTx?: Map<string, string>;
}

function writeClient(s: Scripted): FlushDeps['write'] {
  function answer(kind: Call['kind'], claimedTxId: string): unknown {
    const scripted = s.script?.get(claimedTxId);
    if (scripted !== undefined) return scripted;
    // Default 2xx: echo the txId and a fixed expiry.
    switch (kind) {
      case 'post': {
        const postId = s.postIdByTx?.get(claimedTxId) ?? 'postid-' + claimedTxId;
        const ok: PostSubmitResult = { postId, status: 'pending', expiresAtHeight: 9999, txId: claimedTxId };
        return ok;
      }
      case 'like': {
        const ok: LikeSubmitResult = { status: 'pending', expiresAtHeight: 9999, txId: claimedTxId };
        return ok;
      }
      case 'vouch': {
        const ok: VouchSubmitResult = { status: 'pending', expiresAtHeight: 9999, txId: claimedTxId };
        return ok;
      }
      case 'invite': {
        const ok: InviteSubmitResult = { status: 'pending', expiresAtHeight: 9999, txId: claimedTxId, bondBoxId: 'bond-' + claimedTxId };
        return ok;
      }
      case 'withdraw': {
        const ok: WithdrawSubmitResult = { status: 'submitted', expiresAtHeight: 9999, txId: claimedTxId, postId: 'postid-' + claimedTxId };
        return ok;
      }
      case 'claim': {
        const ok: ClaimSubmitResult = { status: 'pending', expiresAtHeight: 9999, txId: claimedTxId, name: 'name-' + claimedTxId };
        return ok;
      }
      case 'send': {
        const ok: SendSubmitResult = { status: 'pending', expiresAtHeight: 9999, txId: claimedTxId };
        return ok;
      }
    }
  }
  function claimed(tx: Record<string, unknown>): string {
    return typeof tx.txId === 'string' ? tx.txId : '';
  }
  return {
    submitPost: async (tx, content) => {
      s.calls.push({ kind: 'post', tx, content });
      return answer('post', claimed(tx)) as PostSubmitResult | Rejection;
    },
    submitLike: async (tx) => {
      s.calls.push({ kind: 'like', tx });
      return answer('like', claimed(tx)) as LikeSubmitResult | Rejection;
    },
    submitVouch: async (tx) => {
      s.calls.push({ kind: 'vouch', tx });
      return answer('vouch', claimed(tx)) as VouchSubmitResult | Rejection;
    },
    submitInvite: async (tx) => {
      s.calls.push({ kind: 'invite', tx });
      return answer('invite', claimed(tx)) as InviteSubmitResult | Rejection;
    },
    submitWithdraw: async (postId, tx) => {
      s.calls.push({ kind: 'withdraw', postId, tx });
      return answer('withdraw', claimed(tx)) as WithdrawSubmitResult | Rejection;
    },
    submitClaim: async (tx) => {
      s.calls.push({ kind: 'claim', tx });
      return answer('claim', claimed(tx)) as ClaimSubmitResult | Rejection;
    },
    submitSend: async (tx) => {
      s.calls.push({ kind: 'send', tx });
      return answer('send', claimed(tx)) as SendSubmitResult | Rejection;
    },
  };
}

interface Waiter {
  store: WaitingStore;
  storage: WaitingStorage;
  ledger: PendingLedger;
}

function waiter(): Waiter {
  const storage = fakeStorage();
  const store = new WaitingStore(PUB, { storage, locks: fakeLockManager() });
  const ledger = new PendingLedger(PUB);
  return { store, storage, ledger };
}

/** Seed a waiting rep like-shaped write and its pending entry together, the
 *  pair the submit flow writes (`WEB_INTERFACE → The wallet → "A write no
 *  node answers waits"`). Returns the seq-assigned record. */
function seedRep(w: Waiter, over: Partial<WaitingWrite> & { txId: string }): WaitingWrite {
  const { txId, ...rest } = over;
  const base: Omit<WaitingWrite, 'seq'> = {
    chain: CHAIN,
    ledger: 'rep',
    kind: 'like',
    postId: 'target-' + txId,
    tx: { txId },
    spent: [],
    change: null,
    cost: 0n,
    builtAtHeight: 500,
    ...rest,
    txId,
  };
  const record = w.store.keep(base);
  w.ledger.add({
    txId: record.txId,
    kind: record.kind,
    postId: record.postId,
    ...(record.send ? { send: record.send } : {}),
    waiting: true,
    expiresAtHeight: null,
    submittedAtHeight: record.builtAtHeight,
  });
  return record;
}

function recordRepBase(w: Waiter, effective: bigint, boxes: Array<{ boxId: string; value: bigint }>): void {
  w.store.recordBase('rep', { spendable: boxes, height: 500, era: 1, author: PUB, effective }, CHAIN);
}

function flushDeps(w: Waiter, calls: Scripted, chainValue: string | null, tipValue: number | null): FlushDeps {
  return {
    store: w.store,
    ledger: w.ledger,
    write: writeClient(calls),
    chain: () => chainValue,
    tip: () => tipValue,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('flushWaiting — the walk sends in order and releases', () => {
  it('sends in seq order and releases each', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    seedRep(w, { txId: 't1', spent: ['a'], change: { boxId: 'c1', value: 99n, createdAtBlock: 500 }, cost: 1n });
    seedRep(w, { txId: 't2', spent: ['c1'], change: { boxId: 'c2', value: 98n, createdAtBlock: 500 }, cost: 1n });

    const s: Scripted = { calls: [] };
    const outcomes = await flushWaiting(flushDeps(w, s, CHAIN, 900), 'rep');

    expect(s.calls.map((c) => ({ kind: c.kind, tx: (c as { tx?: { txId?: string } }).tx?.txId }))).toEqual([
      { kind: 'like', tx: 't1' },
      { kind: 'like', tx: 't2' },
    ]);
    expect(outcomes.map((o) => o.outcome)).toEqual(['sent', 'sent']);
    expect(w.store.list()).toEqual([]);
    // Each ledger entry stops waiting.
    const entries = w.ledger.all();
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect(e.waiting).toBeUndefined();
    }
  });
});

describe('flushWaiting — no answer stops the walk', () => {
  it('stops at the first no answer and keeps the rest', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    seedRep(w, { txId: 't1', spent: ['a'], change: { boxId: 'c1', value: 99n, createdAtBlock: 500 }, cost: 1n });
    seedRep(w, { txId: 't2', spent: ['c1'], change: { boxId: 'c2', value: 98n, createdAtBlock: 500 }, cost: 1n });
    seedRep(w, { txId: 't3', spent: ['c2'], change: { boxId: 'c3', value: 97n, createdAtBlock: 500 }, cost: 1n });
    // t2's send answers noAnswer; t3 must never be attempted.
    const script = new Map<string, unknown>([
      ['t2', { status: 0, message: 'fetch failed', noAnswer: true } as Rejection],
    ]);
    const s: Scripted = { calls: [], script };
    const outcomes = await flushWaiting(flushDeps(w, s, CHAIN, 900), 'rep');
    expect(s.calls.length).toBe(2); // t1 and t2, never t3
    expect(outcomes.map((o) => o.outcome)).toEqual(['sent']);
    const remaining = w.store.list().map((r) => r.txId);
    expect(remaining).toEqual(['t2', 't3']);
    // The ledger still holds t2 and t3 as waiting.
    expect(w.ledger.all().filter((e) => e.waiting === true).map((e) => e.txId).sort()).toEqual(['t2', 't3']);
  });
});

describe('flushWaiting — a refusal strands what spends its change', () => {
  it('a refusal ends the writes that spend its change, and only those', async () => {
    const w = waiter();
    // Two base boxes `a` and `d`. A spends `a` → change `c_a`. B spends `c_a`
    // → change `c_b`. C spends `d` → change `c_d` — C is unrelated.
    recordRepBase(w, 300n, [{ boxId: 'a', value: 100n }, { boxId: 'd', value: 200n }]);
    seedRep(w, { txId: 'A', spent: ['a'], change: { boxId: 'c_a', value: 99n, createdAtBlock: 500 }, cost: 1n });
    seedRep(w, { txId: 'B', spent: ['c_a'], change: { boxId: 'c_b', value: 98n, createdAtBlock: 500 }, cost: 1n });
    seedRep(w, { txId: 'C', spent: ['d'], change: { boxId: 'c_d', value: 199n, createdAtBlock: 500 }, cost: 1n });
    const script = new Map<string, unknown>([
      ['A', { status: 409, message: 'already in the mempool' } as Rejection],
    ]);
    const s: Scripted = { calls: [], script };
    const outcomes = await flushWaiting(flushDeps(w, s, CHAIN, 900), 'rep');
    // A was sent and refused; B stranded (spends `c_a`); C sent.
    expect(outcomes.map((o) => ({ tx: o.write.txId, outcome: o.outcome }))).toEqual([
      { tx: 'A', outcome: 'refused' },
      { tx: 'B', outcome: 'unsent' },
      { tx: 'C', outcome: 'sent' },
    ]);
    // Only A and C ever reached the write client — B must NOT have been sent.
    expect(s.calls.map((c) => (c as { tx?: { txId?: string } }).tx?.txId).sort()).toEqual(['A', 'C']);
    // Store and ledger are empty — every write was either sent or ended.
    expect(w.store.list()).toEqual([]);
    const idsLeft = w.ledger.all().map((e) => e.txId).sort();
    // C's release leaves it in the ledger as a plain (non-waiting) entry.
    expect(idsLeft).toEqual(['C']);
    expect(w.ledger.all()[0]!.waiting).toBeUndefined();
  });
});

describe('flushWaiting — a write of another chain ends unsent', () => {
  it('a write of another chain ends unsent, and so does one behind it', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    seedRep(w, { chain: CHAIN_B, txId: 'X', spent: ['a'], change: { boxId: 'c_x', value: 99n, createdAtBlock: 500 }, cost: 1n });
    seedRep(w, { txId: 'Y', spent: ['c_x'], change: { boxId: 'c_y', value: 98n, createdAtBlock: 500 }, cost: 1n });
    const s: Scripted = { calls: [] };
    const outcomes = await flushWaiting(flushDeps(w, s, CHAIN, 900), 'rep');
    expect(outcomes.map((o) => ({ tx: o.write.txId, outcome: o.outcome, cause: (o as { cause?: string }).cause }))).toEqual([
      { tx: 'X', outcome: 'unsent', cause: 'chain' },
      { tx: 'Y', outcome: 'unsent', cause: 'behind-refused' },
    ]);
    expect(s.calls).toEqual([]);
    expect(w.store.list()).toEqual([]);
    expect(w.ledger.all()).toEqual([]);
  });
});

describe('flushWaiting — no chain leaves everything alone', () => {
  it('with no chain nothing is sent and nothing ends', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    seedRep(w, { txId: 't1', spent: ['a'], change: null, cost: 1n });
    const s: Scripted = { calls: [] };
    const outcomes = await flushWaiting(flushDeps(w, s, null, 900), 'rep');
    expect(outcomes).toEqual([]);
    expect(s.calls).toEqual([]);
    expect(w.store.list().map((r) => r.txId)).toEqual(['t1']);
    expect(w.ledger.all().map((e) => e.txId)).toEqual(['t1']);
  });
});

describe('flushWaiting — id mismatches on a 2xx refuse', () => {
  it('a 2xx with another txId is refused', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    seedRep(w, { txId: 't1', spent: ['a'], change: { boxId: 'c1', value: 99n, createdAtBlock: 500 }, cost: 1n });
    // Script a 2xx whose txId is not t1.
    const script = new Map<string, unknown>([
      ['t1', { status: 'pending', expiresAtHeight: 9999, txId: 'somethingelse' } as LikeSubmitResult],
    ]);
    const s: Scripted = { calls: [], script };
    const outcomes = await flushWaiting(flushDeps(w, s, CHAIN, 900), 'rep');
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.outcome).toBe('refused');
    expect((outcomes[0] as { rejection: Rejection }).rejection).toEqual({
      status: 0, message: 'the node computed a different transaction id',
    });
    expect(w.store.list()).toEqual([]);
    expect(w.ledger.all()).toEqual([]);
  });

  it('a post whose answered id differs is refused', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    const record = w.store.keep({
      chain: CHAIN, ledger: 'rep', txId: 'tp', kind: 'post', postId: 'claimed-postid',
      tx: { txId: 'tp' }, content: 'hello', spent: ['a'],
      change: { boxId: 'c1', value: 99n, createdAtBlock: 500 }, cost: 1n, builtAtHeight: 500,
    });
    w.ledger.add({
      txId: record.txId, kind: 'post', postId: record.postId, waiting: true,
      expiresAtHeight: null, submittedAtHeight: record.builtAtHeight,
    });
    // Node answers with a different postId.
    const script = new Map<string, unknown>([
      ['tp', { status: 'pending', expiresAtHeight: 9999, txId: 'tp', postId: 'different-postid' } as PostSubmitResult],
    ]);
    const s: Scripted = { calls: [], script };
    const outcomes = await flushWaiting(flushDeps(w, s, CHAIN, 900), 'rep');
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.outcome).toBe('refused');
    expect((outcomes[0] as { rejection: Rejection }).rejection).toEqual({
      status: 0, message: 'the node computed a different post id',
    });
  });
});

describe('flushWaiting — the expiry runs from the tip read at the send', () => {
  it('tip() 900 → submittedAtHeight 900, expiresAtHeight 900 + MEMPOOL_EXPIRY_BLOCKS', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    seedRep(w, { txId: 't1', spent: ['a'], change: null, cost: 1n, builtAtHeight: 500 });
    // The write client answers a 2xx with a MUCH later expiry — the ledger's
    // bound caps it to 900 + MEMPOOL_EXPIRY_BLOCKS.
    const script = new Map<string, unknown>([
      ['t1', { status: 'pending', expiresAtHeight: 10_000_000, txId: 't1' } as LikeSubmitResult],
    ]);
    const s: Scripted = { calls: [], script };
    const outcomes = await flushWaiting(flushDeps(w, s, CHAIN, 900), 'rep');
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.outcome).toBe('sent');
    const entry = (outcomes[0] as { entry: { submittedAtHeight: number; expiresAtHeight: number } }).entry;
    expect(entry.submittedAtHeight).toBe(900);
    expect(entry.expiresAtHeight).toBe(900 + MEMPOOL_EXPIRY_BLOCKS);
  });

  it('with no tip read, the build height stands in', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    seedRep(w, { txId: 't1', spent: ['a'], change: null, cost: 1n, builtAtHeight: 500 });
    const script = new Map<string, unknown>([
      ['t1', { status: 'pending', expiresAtHeight: 10_000_000, txId: 't1' } as LikeSubmitResult],
    ]);
    const s: Scripted = { calls: [], script };
    // tip() answers null — fall back to the write's own built height.
    const outcomes = await flushWaiting(flushDeps(w, s, CHAIN, null), 'rep');
    const entry = (outcomes[0] as { entry: { submittedAtHeight: number; expiresAtHeight: number } }).entry;
    expect(entry.submittedAtHeight).toBe(500);
    expect(entry.expiresAtHeight).toBe(500 + MEMPOOL_EXPIRY_BLOCKS);
  });
});

describe('flushWaiting — a sent write is absorbed', () => {
  it('the view after the flush builds past it', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    seedRep(w, { txId: 't1', spent: ['a'], change: { boxId: 'c1', value: 99n, createdAtBlock: 500 }, cost: 1n });
    const s: Scripted = { calls: [] };
    await flushWaiting(flushDeps(w, s, CHAIN, 900), 'rep');
    // After the flush, the store is empty — the view is the base alone, and
    // its spendable now carries `c1`, effective 99: a next press builds past.
    expect(w.store.list()).toEqual([]);
    const v = w.store.repView(CHAIN)!;
    expect(v.spendable).toEqual([{ boxId: 'c1', value: 99n }]);
    expect(v.effective).toBe(99n);
  });
});

describe('flushWaiting — two flushes run in turn under the lock', () => {
  it('a second flush waits for the first', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }]);
    seedRep(w, { txId: 't1', spent: ['a'], change: { boxId: 'c1', value: 99n, createdAtBlock: 500 }, cost: 1n });
    seedRep(w, { txId: 't2', spent: ['c1'], change: null, cost: 1n });
    const s: Scripted = { calls: [] };
    const deps = flushDeps(w, s, CHAIN, 900);
    // Fire both together. The store's lock serialises them, so each write is
    // seen once — the second flush, waiting for the first, reads an empty
    // store.
    const [a, b] = await Promise.all([
      flushWaiting(deps, 'rep'),
      flushWaiting(deps, 'rep'),
    ]);
    // Exactly two calls across both flushes — never four.
    expect(s.calls.length).toBe(2);
    expect(s.calls.map((c) => (c as { tx?: { txId?: string } }).tx?.txId)).toEqual(['t1', 't2']);
    const combined = [...a, ...b].map((o) => o.outcome);
    expect(combined.filter((x) => x === 'sent').length).toBe(2);
  });
});

describe('flushWaiting — per-kind routing', () => {
  it('a send is posted with the stored body and, for a post, its text; a withdrawal with its post id', async () => {
    const w = waiter();
    recordRepBase(w, 100n, [{ boxId: 'a', value: 100n }, { boxId: 'b', value: 100n }, { boxId: 'd', value: 100n }]);
    // A post, a withdrawal, a claim, a vouch, an invite — one of each.
    w.store.keep({
      chain: CHAIN, ledger: 'rep', txId: 'tp', kind: 'post', postId: 'pp',
      tx: { txId: 'tp' }, content: 'hello world', spent: ['a'], change: null, cost: 1n, builtAtHeight: 500,
    });
    w.ledger.add({ txId: 'tp', kind: 'post', postId: 'pp', waiting: true, expiresAtHeight: null, submittedAtHeight: 500 });
    w.store.keep({
      chain: CHAIN, ledger: 'rep', txId: 'tw', kind: 'withdraw', postId: 'targetPost',
      tx: { txId: 'tw' }, spent: ['b'], change: null, cost: 0n, builtAtHeight: 500,
    });
    w.ledger.add({ txId: 'tw', kind: 'withdraw', postId: 'targetPost', waiting: true, expiresAtHeight: null, submittedAtHeight: 500 });
    w.store.keep({
      chain: CHAIN, ledger: 'rep', txId: 'tc', kind: 'claim', postId: 'name',
      tx: { txId: 'tc' }, spent: ['d'], change: null, cost: 0n, builtAtHeight: 500,
    });
    w.ledger.add({ txId: 'tc', kind: 'claim', postId: 'name', waiting: true, expiresAtHeight: null, submittedAtHeight: 500 });

    // The post's answer needs a matching postId so the walk reports it sent.
    const s: Scripted = {
      calls: [],
      script: new Map<string, unknown>([
        ['tp', { status: 'pending', expiresAtHeight: 9999, txId: 'tp', postId: 'pp' } as PostSubmitResult],
      ]),
    };
    const outcomes = await flushWaiting(flushDeps(w, s, CHAIN, 900), 'rep');
    expect(outcomes.map((o) => o.outcome)).toEqual(['sent', 'sent', 'sent']);
    // Posts get their text; withdrawals get their post id; others only the tx.
    const byKind = new Map(s.calls.map((c) => [c.kind, c]));
    const postCall = byKind.get('post') as { kind: 'post'; tx: { txId: string }; content: string };
    expect(postCall).toBeDefined();
    expect(postCall.content).toBe('hello world');
    expect(postCall.tx.txId).toBe('tp');
    const wdCall = byKind.get('withdraw') as { kind: 'withdraw'; postId: string; tx: { txId: string } };
    expect(wdCall.postId).toBe('targetPost');
    expect(wdCall.tx.txId).toBe('tw');
    const claimCall = byKind.get('claim') as { kind: 'claim'; tx: { txId: string } };
    expect(claimCall.tx.txId).toBe('tc');
  });
});
