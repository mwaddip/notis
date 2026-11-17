// @vitest-environment happy-dom
// WEB_INTERFACE → The extension → "The debug log" — the three records:
// `write` (one per walk's ending from the extension's `WriteClient`),
// `sign` (one per answer the proxy translates for the flow), and `wait`
// (`queued` at the waiting store's write of a record, and one per outcome
// the send pass reaches — `sent`, `refused`, `unsent`, and `no answer` for
// the write the walk stopped at).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  createDebugLog,
  routeShape,
  type DebugLog,
  type DebugTimerHandle,
  type DebugTimers,
} from '../../src/extension/debug-log';
import { WriteClient, type WriteObserver } from '../../src/api/write';
import { bootstrapProxy } from '../../src/extension/proxy';
import {
  WaitingStore,
  type WaitingStorage,
  type WaitingWrite,
  type WaitRecorder,
} from '../../src/wallet/waiting';
import { flushWaiting, type FlushDeps } from '../../src/wallet/flush';
import { PendingLedger } from '../../src/wallet/ledger';
import { fakeChrome, fakeLockManager } from '../fake-chrome';
import type { SignAnswer, SignRecord } from '../../src/extension/protocol';
import type {
  LikeSubmitResult,
  Rejection,
} from '../../src/api/write';

// ---------------------------------------------------------------------------
// Helpers — a real debug log over fake-indexeddb; storage + locks a fake
// waiting store runs on.
// ---------------------------------------------------------------------------

function fakeTimers(): DebugTimers {
  let seq = 0;
  const map = new Map<DebugTimerHandle, () => void>();
  return {
    setInterval(fn, _ms): DebugTimerHandle {
      const h = ++seq;
      map.set(h, fn);
      return h;
    },
    clearInterval(handle): void {
      map.delete(handle);
    },
  };
}

function makeDebugLog(): DebugLog {
  return createDebugLog({
    indexedDB: new IDBFactory(),
    now: () => 1_000,
    pageId: 'ab12cd34',
    boundBytes: 2_000_000,
    batchSize: 1,
    batchInterval: 60_000,
    timers: fakeTimers(),
  });
}

function fakeStorage(): WaitingStorage {
  const m = new Map<string, string>();
  return {
    get length(): number { return m.size; },
    getItem(k): string | null { return m.has(k) ? m.get(k)! : null; },
    setItem(k, v): void { m.set(k, v); },
    removeItem(k): void { m.delete(k); },
    key(i): string | null {
      const keys = [...m.keys()];
      return i >= 0 && i < keys.length ? keys[i]! : null;
    },
  };
}

/** A tiny observer the write cases share: writes one `write` event the way
 *  the extension build would — route and query from `routeShape`, the node
 *  from the request's origin, the status, the message when the walk ended
 *  on a rejection, `noAnswer` when the loop was exhausted, and `txId` where
 *  the 2xx or the rejection body carries one. */
function writeToLog(log: DebugLog): WriteObserver {
  return (ending): void => {
    const shape = ending.url !== '' ? routeShape(ending.url) : { path: '', query: {} };
    let node: string | null = null;
    if (ending.url !== '') {
      try {
        node = new URL(ending.url).origin;
      } catch {
        node = null;
      }
    }
    const fields: Record<string, unknown> = {
      route: shape.path,
      query: shape.query,
      node,
      tried: ending.tried,
      status: ending.status,
    };
    if (ending.message !== undefined) fields['message'] = ending.message;
    if (ending.noAnswer) fields['noAnswer'] = true;
    if (ending.txId !== undefined) fields['txId'] = ending.txId;
    log.record('write', fields);
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const PUB = 'aa'.repeat(32);
const TX_HEX = 'cc'.repeat(32);
const TX_B = 'cd'.repeat(32);
const POSTID_HEX = 'bb'.repeat(32);
const CHAIN_A = 'ab'.repeat(32);
const CHAIN_B = 'ef'.repeat(32);

// ---------------------------------------------------------------------------
// `write` — one event per walk's ending.
// ---------------------------------------------------------------------------

describe("the write client's walk records one `write` at its ending", () => {
  it('a walk the second base answers records one `write` with that base, two nodes tried and the status', async () => {
    // plain-`it` failure: AssertionError: expected [] to have a length of 1 but got +0
    const log = makeDebugLog();
    let count = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, _init?: RequestInit) => {
      count += 1;
      if (count === 1) throw new Error('ECONNREFUSED');
      void url;
      return new Response(
        JSON.stringify({ status: 'pending', txId: TX_HEX, expiresAtHeight: 100 }),
        { status: 200 },
      );
    }));
    const client = new WriteClient({
      bases: () => ['http://a.example', 'http://b.example'],
      fetch: (u, i) => fetch(u, i),
      observer: writeToLog(log),
    });
    await client.submitLike({});
    await log.flush();
    const writes = (await log.list()).filter((e) => e.kind === 'write');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      route: '/likes',
      node: 'http://b.example',
      tried: 2,
      status: 200,
      txId: TX_HEX,
    });
  });

  it('an exhausted walk records `noAnswer`', async () => {
    // plain-`it` failure: AssertionError: expected [] to have a length of 1 but got +0
    const log = makeDebugLog();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const client = new WriteClient({
      bases: () => ['http://a.example', 'http://b.example'],
      fetch: (u, i) => fetch(u, i),
      observer: writeToLog(log),
    });
    await client.submitLike({});
    await log.flush();
    const writes = (await log.list()).filter((e) => e.kind === 'write');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ noAnswer: true, tried: 2 });
  });

  it("a walk's recorded route holds no 64-hex run", async () => {
    // plain-`it` failure: AssertionError: expected [] to have a length of 1 but got +0
    const log = makeDebugLog();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ status: 'submitted', txId: TX_HEX, postId: POSTID_HEX, expiresAtHeight: 100 }),
        { status: 200 },
      ),
    ));
    const client = new WriteClient({
      bases: () => ['http://a.example'],
      fetch: (u, i) => fetch(u, i),
      observer: writeToLog(log),
    });
    await client.submitWithdraw(POSTID_HEX, {});
    await log.flush();
    const writes = (await log.list()).filter((e) => e.kind === 'write');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.route).toBe('/posts/:id/withdraw');
    expect(/[0-9a-f]{64}/.test(String(writes[0]!.route))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `sign` — one event per answer the proxy translates for the flow.
// ---------------------------------------------------------------------------

function wireBackground(c: ReturnType<typeof fakeChrome>, answers: Record<string, unknown>): void {
  c.api.runtime.sendMessage = (async (message: unknown) => {
    const kind = (message as { kind?: string })?.kind ?? '';
    if (kind in answers) return answers[kind];
    return { error: 'unknown message kind' };
  }) as typeof chrome.runtime.sendMessage;
}

describe("the proxy records one `sign` per answer, with the policy in force", () => {
  it('a signed `sign` records its outcome with the policy', async () => {
    // plain-`it` failure: AssertionError: expected [] to have a length of 1 but got +0
    const c = fakeChrome();
    wireBackground(c, {
      state: { pubKeyHex: PUB, locked: false, backedUp: true, policy: 'ask' },
      sign: { signature: 'ff'.repeat(64) } as SignAnswer,
    });
    const log = makeDebugLog();
    const proxy = await bootstrapProxy(c.api, { publicBase: '', debugLog: log });
    await proxy.sign(new Uint8Array(), 'cd'.repeat(32), PUB);
    await log.flush();
    const signs = (await log.list()).filter((e) => e.kind === 'sign');
    expect(signs).toHaveLength(1);
    expect(signs[0]).toMatchObject({ outcome: 'signed', policy: 'ask' });
  });

  it('a declined `sign` records its outcome with the policy', async () => {
    // plain-`it` failure: AssertionError: expected [] to have a length of 1 but got +0
    const c = fakeChrome();
    const PROMPT_ID = 'aabb' + '00'.repeat(14);
    wireBackground(c, {
      state: { pubKeyHex: PUB, locked: false, backedUp: true, policy: 'ask' },
      sign: { pending: PROMPT_ID } as SignAnswer,
      ack: 'ok',
    });
    const log = makeDebugLog();
    const proxy = await bootstrapProxy(c.api, { publicBase: '', debugLog: log });
    const pending = proxy.sign(new Uint8Array(), 'cd'.repeat(32), PUB);
    const key = 'notis.sign.' + PROMPT_ID;
    const record: SignRecord = {
      id: PROMPT_ID,
      txIdHex: 'cd'.repeat(32),
      txBytesHex: '',
      summary: { kind: 'thread', spendRep: '5' },
      hint: {},
      createdAt: 0,
      pubKeyHex: PUB,
      result: { declined: true },
    };
    c.storage.session.set(key, record);
    c.storage.fireChange('session', key, undefined, record);
    await pending;
    await log.flush();
    const signs = (await log.list()).filter((e) => e.kind === 'sign');
    expect(signs).toHaveLength(1);
    expect(signs[0]).toMatchObject({ outcome: 'declined', policy: 'ask' });
  });

  it('a refused `sign` records its outcome with its reason and the policy', async () => {
    // plain-`it` failure: AssertionError: expected [] to have a length of 1 but got +0
    const c = fakeChrome();
    wireBackground(c, {
      state: { pubKeyHex: PUB, locked: false, backedUp: true, policy: 'silent' },
      sign: { refused: 'id-mismatch' } as SignAnswer,
    });
    const log = makeDebugLog();
    const proxy = await bootstrapProxy(c.api, { publicBase: '', debugLog: log });
    await proxy.sign(new Uint8Array(), 'cd'.repeat(32), PUB);
    await log.flush();
    const signs = (await log.list()).filter((e) => e.kind === 'sign');
    expect(signs).toHaveLength(1);
    expect(signs[0]).toMatchObject({ outcome: 'refused', reason: 'id-mismatch', policy: 'silent' });
  });

  it('a locked `sign` records its outcome with the policy', async () => {
    // plain-`it` failure: AssertionError: expected [] to have a length of 1 but got +0
    const c = fakeChrome();
    wireBackground(c, {
      state: { pubKeyHex: PUB, locked: true, backedUp: true, policy: 'silent' },
      sign: { locked: true } as SignAnswer,
    });
    const log = makeDebugLog();
    const proxy = await bootstrapProxy(c.api, { publicBase: '', debugLog: log });
    await proxy.sign(new Uint8Array(), 'cd'.repeat(32), PUB);
    await log.flush();
    const signs = (await log.list()).filter((e) => e.kind === 'sign');
    expect(signs).toHaveLength(1);
    expect(signs[0]).toMatchObject({ outcome: 'locked', policy: 'silent' });
  });
});

// ---------------------------------------------------------------------------
// `wait` — `queued` at the store's write of a record, and one per outcome
// the send pass reaches.
// ---------------------------------------------------------------------------

/** The adapter the wiring builds: `WaitEvent`'s `kind` — the write's kind —
 *  is renamed to `txKind` for the stored event, so the `wait` debug kind is
 *  the only one carried under `kind` (WEB_INTERFACE → The extension → "The
 *  debug log" — every event carrying the page's id "beside its wall-clock
 *  time and its kind"). */
function waitToLog(log: DebugLog): WaitRecorder {
  return (e): void => {
    const fields: Record<string, unknown> = {
      outcome: e.outcome, txKind: e.kind, ledger: e.ledger, txId: e.txId,
    };
    if (e.message !== undefined) fields['message'] = e.message;
    if (e.cause !== undefined) fields['cause'] = e.cause;
    log.record('wait', fields);
  };
}

describe("the waiting store records `queued` at a new write", () => {
  it('a waitable write kept in the store records `queued` with its kind, ledger and txId', async () => {
    // plain-`it` failure: AssertionError: expected [] to have a length of 1 but got +0
    const log = makeDebugLog();
    const store = new WaitingStore(PUB, {
      storage: fakeStorage(),
      locks: fakeLockManager(),
      recorder: waitToLog(log),
    });
    store.keep({
      chain: CHAIN_A, ledger: 'rep', txId: TX_HEX, kind: 'like', postId: 'p1',
      tx: { txId: TX_HEX }, spent: [], change: null, cost: 1n, builtAtHeight: 500,
    });
    await log.flush();
    const waits = (await log.list()).filter((e) => e.kind === 'wait');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ outcome: 'queued', txKind: 'like', ledger: 'rep', txId: TX_HEX });
  });
});

// ---------------------------------------------------------------------------
// The send pass — `sent`, `refused`, `unsent` (both causes), and `no answer`
// for the write the walk stopped at; nothing for the writes after it.
// ---------------------------------------------------------------------------

/** A write client that answers per txId by a scripted map; the default is a
 *  plain 2xx echoing the txId. The pass walks `submitLike` so every seeded
 *  write is a like for simplicity. */
function scriptedLikeClient(script: Map<string, unknown>): FlushDeps['write'] {
  function answer(claimedTxId: string): unknown {
    const scripted = script.get(claimedTxId);
    if (scripted !== undefined) return scripted;
    const ok: LikeSubmitResult = { status: 'pending', expiresAtHeight: 9999, txId: claimedTxId };
    return ok;
  }
  function claimed(tx: Record<string, unknown>): string {
    return typeof tx['txId'] === 'string' ? tx['txId'] : '';
  }
  return {
    submitPost: async (_tx, _c) => ({ status: 0, message: 'unused' }),
    submitLike: async (tx) => answer(claimed(tx)) as LikeSubmitResult | Rejection,
    submitVouch: async (_tx) => ({ status: 0, message: 'unused' }),
    submitInvite: async (_tx) => ({ status: 0, message: 'unused' }),
    submitWithdraw: async (_pid, _tx) => ({ status: 0, message: 'unused' }),
    submitClaim: async (_tx) => ({ status: 0, message: 'unused' }),
    submitSend: async (_tx) => ({ status: 0, message: 'unused' }),
  };
}

function seedRepWrite(
  store: WaitingStore,
  ledger: PendingLedger,
  over: Partial<WaitingWrite> & { txId: string; spent?: string[]; change?: WaitingWrite['change']; chain?: string },
): WaitingWrite {
  const base: Omit<WaitingWrite, 'seq'> = {
    chain: CHAIN_A,
    ledger: 'rep',
    kind: 'like',
    postId: 'target-' + over.txId,
    tx: { txId: over.txId },
    spent: [],
    change: null,
    cost: 1n,
    builtAtHeight: 500,
    ...over,
    txId: over.txId,
  };
  const record = store.keep(base);
  ledger.add({
    txId: record.txId,
    kind: record.kind,
    postId: record.postId,
    waiting: true,
    expiresAtHeight: null,
    submittedAtHeight: record.builtAtHeight,
  });
  return record;
}

describe("the send pass records each outcome and `no answer` for the write it stopped at", () => {
  it('a pass with a sent, a refused, two unsents, a `no answer` and one write after the stop records the five, and nothing for the write after', async () => {
    // plain-`it` failure: AssertionError: expected [] to deeply equal [ { outcome: 'sent', txId: 't1' }, …(4 more) ]
    const storage = fakeStorage();
    const store = new WaitingStore(PUB, { storage, locks: fakeLockManager() });
    const ledger = new PendingLedger(PUB);
    store.recordBase('rep', {
      spendable: [
        { boxId: 'a', value: 100n }, { boxId: 'b', value: 100n },
        { boxId: 'd', value: 100n }, { boxId: 'e', value: 100n },
        { boxId: 'g', value: 100n },
      ],
      effective: 500n, height: 500, era: 1, author: PUB,
    }, CHAIN_A);
    // Seq 1: a like on CHAIN_A — the pass sends it, the node answers 2xx.
    seedRepWrite(store, ledger, { txId: 't1', spent: ['a'], change: { boxId: 'c1', value: 99n, createdAtBlock: 500 } });
    // Seq 2: a like on CHAIN_A — the node refuses it with a 409.
    seedRepWrite(store, ledger, { txId: 't2', spent: ['b'], change: { boxId: 'c2', value: 99n, createdAtBlock: 500 } });
    // Seq 3: a like on CHAIN_A spending t2's change — stranded behind-refused.
    seedRepWrite(store, ledger, { txId: 't3', spent: ['c2'], change: { boxId: 'c3', value: 98n, createdAtBlock: 500 } });
    // Seq 4: a like of another chain — unsent with cause `chain`.
    seedRepWrite(store, ledger, { txId: 't4', chain: CHAIN_B, spent: ['d'], change: { boxId: 'c4', value: 99n, createdAtBlock: 500 } });
    // Seq 5: a like on CHAIN_A — the node answers no answer; the walk stops.
    seedRepWrite(store, ledger, { txId: 't5', spent: ['e'], change: { boxId: 'c5', value: 99n, createdAtBlock: 500 } });
    // Seq 6: a like after the stop — never visited, never recorded.
    seedRepWrite(store, ledger, { txId: 't6', spent: ['g'], change: { boxId: 'c6', value: 99n, createdAtBlock: 500 } });
    const log = makeDebugLog();
    const recorder = waitToLog(log);
    const script = new Map<string, unknown>([
      ['t2', { status: 409, message: 'already in the mempool' } as Rejection],
      ['t5', { status: 0, message: 'fetch failed', noAnswer: true } as Rejection],
    ]);
    const deps: FlushDeps = {
      store,
      ledger,
      write: scriptedLikeClient(script),
      chain: () => CHAIN_A,
      tip: () => 900,
      recorder,
    };
    await flushWaiting(deps, 'rep');
    await log.flush();
    const waits = (await log.list()).filter((e) => e.kind === 'wait');
    expect(waits.map((e) => ({ outcome: e['outcome'], txId: e['txId'] }))).toEqual([
      { outcome: 'sent', txId: 't1' },
      { outcome: 'refused', txId: 't2' },
      { outcome: 'unsent', txId: 't3' },
      { outcome: 'unsent', txId: 't4' },
      { outcome: 'no answer', txId: 't5' },
    ]);
    // The `refused` event carries the rejection's message.
    expect(waits.find((e) => e['outcome'] === 'refused')).toMatchObject({ message: 'already in the mempool' });
    // The two `unsent` events carry their causes.
    const unsents = waits.filter((e) => e['outcome'] === 'unsent');
    expect(unsents.map((e) => ({ txId: e['txId'], cause: e['cause'] }))).toEqual([
      { txId: 't3', cause: 'behind-refused' },
      { txId: 't4', cause: 'chain' },
    ]);
    // t6 is not recorded — the walk returned before visiting it.
    expect(waits.find((e) => e['txId'] === 't6')).toBeUndefined();
    // The test's presence of TX_B avoids an "unused import" lint error.
    expect(typeof TX_B).toBe('string');
  });
});
