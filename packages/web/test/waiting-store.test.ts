import { describe, it, expect } from 'vitest';
import { WaitingStore, type WaitingStorage, type WaitingWrite } from '../src/wallet/waiting';
import { fakeLockManager } from './fake-chrome';
import type { BuildContext, RepBuildContext } from '../src/wallet/builders';

// WEB_INTERFACE → The wallet → "The waiting store keeps every waiting write as
// a record of its own": per identity, under one lock (`notis.waiting.<key>`);
// every read goes to storage; a view is the ledger's base of the chain,
// advanced by every waiting write of that ledger and chain in seq order.

const KEY = 'aa'.repeat(32);
const KEY2 = 'bb'.repeat(32);
const CHAIN_A = 'a'.repeat(64);
const CHAIN_B = 'b'.repeat(64);
const AUTHOR = KEY;

/** A `Storage` fake over a `Map` — just enough of the shape `WaitingStorage`
 *  reads. `length`/`key` are the two the store walks over to list its rows. */
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

function repBase(effective: bigint, boxes: Array<{ boxId: string; value: bigint }>): RepBuildContext {
  return { spendable: boxes, height: 50, era: 1, author: AUTHOR, effective };
}

function creditBase(boxes: Array<{ boxId: string; value: bigint }>): BuildContext {
  return { spendable: boxes, height: 50, era: 1, author: AUTHOR };
}

/** The fields a waiting rep write needs beyond its spent, change and cost —
 *  the test only exercises the view-advancing fields. */
function repWrite(over: Partial<WaitingWrite>): Omit<WaitingWrite, 'seq'> {
  return {
    chain: CHAIN_A, ledger: 'rep', txId: 't-' + Math.random().toString(16).slice(2),
    kind: 'like', postId: 'p-x', tx: {}, spent: [],
    change: null, cost: 0n, builtAtHeight: 50,
    ...over,
  };
}

function creditWrite(over: Partial<WaitingWrite>): Omit<WaitingWrite, 'seq'> {
  return {
    chain: CHAIN_A, ledger: 'credits', txId: 't-' + Math.random().toString(16).slice(2),
    kind: 'send', postId: 'r-x', tx: {}, spent: [],
    change: null, cost: 0n, builtAtHeight: 50,
    ...over,
  };
}

describe('repView — the base, advanced by each waiting write in seq order', () => {
  it('spends and change ride forward in order; effective drops by each write\'s cost', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    // First like: spends `a`, change `c1` 99, cost 1.
    s.keep(repWrite({ txId: 't1', spent: ['a'], change: { boxId: 'c1', value: 99n, createdAtBlock: 50 }, cost: 1n }));
    // Second like: spends `c1`, change `c2` 98, cost 1.
    s.keep(repWrite({ txId: 't2', spent: ['c1'], change: { boxId: 'c2', value: 98n, createdAtBlock: 50 }, cost: 1n }));

    const v = s.repView(CHAIN_A);
    expect(v).not.toBeNull();
    expect(v!.spendable).toEqual([{ boxId: 'c2', value: 98n }]);
    expect(v!.effective).toBe(98n);
    expect(v!.height).toBe(50);
    expect(v!.era).toBe(1);
    expect(v!.author).toBe(AUTHOR);
  });
});

describe('creditView — the base, advanced by each waiting write in seq order', () => {
  it('leaves out the spent boxes and adds the change', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('credits', creditBase([
      { boxId: 'b1', value: 1000n },
      { boxId: 'b2', value: 500n },
    ]), CHAIN_A);
    // First send: spends `b1`, change `c1` 900 (100 paid out).
    s.keep(creditWrite({ txId: 'cs1', spent: ['b1'], change: { boxId: 'c1', value: 900n, createdAtBlock: 50 }, cost: 100n }));
    // Second send: spends `b2` AND `c1`, no change (exact spend).
    s.keep(creditWrite({ txId: 'cs2', spent: ['b2', 'c1'], change: null, cost: 1400n }));

    const v = s.creditView(CHAIN_A);
    expect(v).not.toBeNull();
    expect(v!.spendable).toEqual([]); // every input spent, no change
    expect((v as RepBuildContext).effective).toBeUndefined(); // credits view has no effective
  });

  it('a credit write\'s cost is not subtracted from a rep view, and vice versa', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    s.recordBase('credits', creditBase([{ boxId: 'b', value: 1000n }]), CHAIN_A);
    // A credits send and a rep like, each spending the other ledger's box would
    // never happen in the real flow; the test shows each view reads only its
    // ledger's writes.
    s.keep(creditWrite({ txId: 'cs1', spent: ['b'], change: null, cost: 1000n }));
    s.keep(repWrite({ txId: 'r1', spent: [], change: null, cost: 5n }));

    expect(s.repView(CHAIN_A)!.spendable).toEqual([{ boxId: 'a', value: 100n }]);
    expect(s.repView(CHAIN_A)!.effective).toBe(95n);
    expect(s.creditView(CHAIN_A)!.spendable).toEqual([]);
  });
});

describe('under the lock', () => {
  it('two stores over one storage keep in turn — seq rises and each build reads the other\'s change', async () => {
    const storage = fakeStorage();
    const locks = fakeLockManager(); // one FIFO queue per lock name
    const a = new WaitingStore(KEY, { storage, locks });
    const b = new WaitingStore(KEY, { storage, locks });
    a.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);

    // Both pages start their lock request together. Under one FIFO queue the
    // second body runs on the first's change: its `spent[0]` is the first's
    // change id, and its seq is the next.
    const p1 = a.withLock(async () => {
      const v = a.repView(CHAIN_A)!;
      const first = v.spendable[0]!;
      return a.keep(repWrite({ txId: 't1', spent: [first.boxId], change: { boxId: 'c1', value: 99n, createdAtBlock: 50 }, cost: 1n }));
    });
    const p2 = b.withLock(async () => {
      const v = b.repView(CHAIN_A)!;
      const first = v.spendable[0]!;
      return b.keep(repWrite({ txId: 't2', spent: [first.boxId], change: { boxId: 'c2', value: 98n, createdAtBlock: 50 }, cost: 1n }));
    });
    const [w1, w2] = await Promise.all([p1, p2]);
    expect(w1.seq).toBe(1);
    expect(w2.seq).toBe(2);
    expect(w1.spent).toEqual(['a']);
    expect(w2.spent).toEqual(['c1']); // the second built on the first's change

    expect(a.list().map((w) => w.txId)).toEqual(['t1', 't2']);
    expect(b.list().map((w) => w.txId)).toEqual(['t1', 't2']);
  });
});

describe('malformed records', () => {
  it('a record that does not parse is skipped and the rest stay', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    s.keep(repWrite({ txId: 't1', spent: [], change: null, cost: 0n }));
    s.keep(repWrite({ txId: 't2', spent: [], change: null, cost: 0n }));
    // Corrupt one row in place.
    storage.setItem('notis.waiting.' + KEY + '.w.t1', '{ not json');
    // The parser drops the bad one; t2 stays.
    expect(s.list().map((w) => w.txId)).toEqual(['t2']);
    // The view still answers — the dropped row's spent/change are not applied.
    const v = s.repView(CHAIN_A)!;
    expect(v.spendable).toEqual([{ boxId: 'a', value: 100n }]);
  });
});

describe('the view is of a chain', () => {
  it('a base of another chain answers null', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    expect(s.repView(CHAIN_B)).toBeNull();
    s.recordBase('credits', creditBase([{ boxId: 'c', value: 1000n }]), CHAIN_A);
    expect(s.creditView(CHAIN_B)).toBeNull();
  });

  it('no base answers null', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    expect(s.repView(CHAIN_A)).toBeNull();
    expect(s.creditView(CHAIN_A)).toBeNull();
  });
});

describe('remove', () => {
  it('drops one record and no other', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    s.keep(repWrite({ txId: 't1', spent: [], change: null, cost: 0n }));
    s.keep(repWrite({ txId: 't2', spent: [], change: null, cost: 0n }));
    s.keep(repWrite({ txId: 't3', spent: [], change: null, cost: 0n }));
    s.remove('t2');
    expect(s.list().map((w) => w.txId)).toEqual(['t1', 't3']);
  });
});

describe('absorb — a sent write folds into the base', () => {
  it('absorb folds a sent write into the base and the view is unchanged', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    // Base: effective 100, one box.
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    // Two waiting likes — the first spends `a` (change `c1` 99, cost 1), the
    // second spends `c1` (change `c2` 98, cost 1). The view is `c2`/98.
    s.keep(repWrite({ txId: 't1', spent: ['a'], change: { boxId: 'c1', value: 99n, createdAtBlock: 50 }, cost: 1n }));
    s.keep(repWrite({ txId: 't2', spent: ['c1'], change: { boxId: 'c2', value: 98n, createdAtBlock: 50 }, cost: 1n }));
    const before = s.repView(CHAIN_A)!;
    // Absorb the first — the view the remaining write advances is the same.
    s.absorb('t1');
    expect(s.list().map((w) => w.txId)).toEqual(['t2']);
    const after = s.repView(CHAIN_A)!;
    expect(after.spendable).toEqual(before.spendable);
    expect(after.effective).toBe(before.effective);
    // And absorbing the second leaves the base at the tip — the store is empty,
    // the view the base itself.
    s.absorb('t2');
    expect(s.list()).toEqual([]);
    const final = s.repView(CHAIN_A)!;
    expect(final.spendable).toEqual(before.spendable);
    expect(final.effective).toBe(before.effective);
  });

  it('credits-side absorb folds the same way, with no effective', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('credits', creditBase([
      { boxId: 'b1', value: 1000n },
      { boxId: 'b2', value: 500n },
    ]), CHAIN_A);
    s.keep(creditWrite({ txId: 'cs1', spent: ['b1'], change: { boxId: 'c1', value: 900n, createdAtBlock: 50 }, cost: 100n }));
    s.keep(creditWrite({ txId: 'cs2', spent: ['b2'], change: null, cost: 500n }));
    const before = s.creditView(CHAIN_A)!;
    s.absorb('cs1');
    const after = s.creditView(CHAIN_A)!;
    expect(after.spendable).toEqual(before.spendable);
  });

  it('absorb with no base only removes', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    // Keep a write without first recording a base — the record still lives in
    // storage. Absorb finds no base and only removes.
    s.keep(repWrite({ txId: 't1', spent: ['a'], change: { boxId: 'c1', value: 99n, createdAtBlock: 50 }, cost: 1n }));
    expect(s.list().map((w) => w.txId)).toEqual(['t1']);
    s.absorb('t1');
    expect(s.list()).toEqual([]);
    expect(s.repView(CHAIN_A)).toBeNull();
  });

  it('absorb of a write of another chain only removes', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    // Record a base on CHAIN_A, keep a waiting write naming CHAIN_B.
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    s.keep(repWrite({ chain: CHAIN_B, txId: 't1', spent: ['a'], change: null, cost: 1n }));
    s.absorb('t1');
    expect(s.list()).toEqual([]);
    // The base on CHAIN_A was not touched.
    const v = s.repView(CHAIN_A)!;
    expect(v.spendable).toEqual([{ boxId: 'a', value: 100n }]);
    expect(v.effective).toBe(100n);
  });

  it('absorb of an unknown id is a no-op', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    s.keep(repWrite({ txId: 't1', spent: [], change: null, cost: 0n }));
    s.absorb('unknown');
    expect(s.list().map((w) => w.txId)).toEqual(['t1']);
  });
});

describe('absorbSent — a sent spend folds into the base, no record kept', () => {
  it('absorbSent folds a sent spend into the base', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    // The write the node took spent `a` and returned change `c1` of 99; its
    // cost on rep was 1. Nothing is kept — the write was sent, not waiting.
    s.absorbSent('rep', CHAIN_A, ['a'], { boxId: 'c1', value: 99n, createdAtBlock: 50 }, 1n);
    const v = s.repView(CHAIN_A)!;
    expect(v.spendable).toEqual([{ boxId: 'c1', value: 99n }]);
    expect(v.effective).toBe(99n);
    expect(s.list()).toEqual([]);
  });

  it('a credits-side absorbSent folds the same way, with no effective', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('credits', creditBase([{ boxId: 'b1', value: 1000n }]), CHAIN_A);
    s.absorbSent('credits', CHAIN_A, ['b1'], { boxId: 'c1', value: 900n, createdAtBlock: 50 }, 100n);
    const v = s.creditView(CHAIN_A)!;
    expect(v.spendable).toEqual([{ boxId: 'c1', value: 900n }]);
  });

  it('absorbSent of another chain does nothing', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    // The sent write names CHAIN_B; the base is of CHAIN_A — nothing folds.
    s.absorbSent('rep', CHAIN_B, ['a'], null, 1n);
    const v = s.repView(CHAIN_A)!;
    expect(v.spendable).toEqual([{ boxId: 'a', value: 100n }]);
    expect(v.effective).toBe(100n);
  });

  it('absorbSent with no base does nothing', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const s = new WaitingStore(KEY, { storage, locks });
    s.absorbSent('rep', CHAIN_A, ['a'], null, 1n);
    expect(s.repView(CHAIN_A)).toBeNull();
  });
});

describe('per-identity isolation', () => {
  it('a store of another key sees none of this key\'s writes', () => {
    const storage = fakeStorage();
    const locks = fakeLockManager();
    const a = new WaitingStore(KEY, { storage, locks });
    const b = new WaitingStore(KEY2, { storage, locks });
    a.recordBase('rep', repBase(100n, [{ boxId: 'a', value: 100n }]), CHAIN_A);
    a.keep(repWrite({ txId: 't1', spent: [], change: null, cost: 0n }));
    expect(a.list().length).toBe(1);
    expect(b.list().length).toBe(0);
    expect(b.repView(CHAIN_A)).toBeNull();
    // b records a base of its own; a's view is unaffected.
    b.recordBase('rep', repBase(42n, [{ boxId: 'z', value: 42n }]), CHAIN_A);
    b.keep(repWrite({ txId: 'tb', spent: [], change: null, cost: 0n }));
    expect(a.list().map((w) => w.txId)).toEqual(['t1']);
    expect(b.list().map((w) => w.txId)).toEqual(['tb']);
    expect(a.repView(CHAIN_A)!.spendable).toEqual([{ boxId: 'a', value: 100n }]);
    expect(b.repView(CHAIN_A)!.spendable).toEqual([{ boxId: 'z', value: 42n }]);
  });
});
