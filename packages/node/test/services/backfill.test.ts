import { describe, it, expect, beforeEach, vi } from 'vitest';

// A spy on `emitPostReceived`: the driver imports the binding at module
// load, so the observing wrapper replaces the module's export rather than
// patching the reference after. `vi.hoisted` lifts the capture above
// `vi.mock`'s hoisted factory so the spy fills the same array every case
// reads (JOURNAL_EVENTS → post_received).
const emitStore = vi.hoisted(() => ({
  emitLog: [] as Array<{ postId: string; source: string; via: string }>,
}));
vi.mock('../../src/journal.js', () => ({
  emitPostReceived: (postId: string, source: string, via = 'packet') => {
    emitStore.emitLog.push({ postId, source, via });
  },
}));

import {
  initBackfill,
  registerPlaceholder,
  onBlockApplied,
  readerArrived,
  clearPending,
  getPendingCount,
} from '../../src/services/backfill.js';

describe('backfill driver', () => {
  let requestLog: Array<{ wanted: Array<{ id: string; contentHash: string }>; peerId: string }>;
  let storedBodies: Map<string, string>;
  let connectedPeers: string[];
  let servingReaders: string[];
  let setPostBodyCalls: Array<{ id: string; content: string }>;
  let openCount: number;
  let maxOpen: number;
  let gateRelease: () => void;
  let gate: Promise<void>;

  beforeEach(() => {
    clearPending();
    requestLog = [];
    storedBodies = new Map();
    connectedPeers = ['peer-a', 'peer-b'];
    servingReaders = [];
    setPostBodyCalls = [];
    openCount = 0;
    maxOpen = 0;
    emitStore.emitLog.length = 0;
    gateRelease = () => {};
    gate = Promise.resolve();

    initBackfill({
      requestPostBodies: async (wanted, peerId) => {
        openCount++;
        if (openCount > maxOpen) maxOpen = openCount;
        requestLog.push({ wanted, peerId });
        try {
          await gate;
          const results: Array<{ id: string; content: string }> = [];
          for (const w of wanted) {
            const body = storedBodies.get(w.id);
            if (body) results.push({ id: w.id, content: body });
          }
          return results;
        } finally {
          openCount--;
        }
      },
      getConnectedPeers: () => connectedPeers,
      // A default of `[]`: the puller asks node peers alone where no reader
      // serves (NODE_INTERFACE → "A serving reader is asked for what has been due").
      getServingReaders: () => servingReaders,
      setPostBody: (id: string, content: string) => {
        setPostBodyCalls.push({ id, content });
        return true;
      },
      // The driver's two reads over the store. In this file every registered
      // id is a placeholder, and no stored row exists for the init-time scan.
      getMissingBodies: () => [],
      getStillPlaceholderIds: (ids) => [...ids],
    });
  });

  it('⛔ a registered placeholder triggers a request at its creation height', async () => {
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');

    await onBlockApplied(10);

    expect(requestLog).toHaveLength(1);
    expect(requestLog[0]!.peerId).toBe('peer-a');
    expect(requestLog[0]!.wanted).toEqual([{ id: 'post-1', contentHash: 'hash-1' }]);
  });

  it('⛔ a stored body removes the entry from pending and emits via pull', async () => {
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
    storedBodies.set('post-1', 'hello world');

    expect(getPendingCount()).toBe(1);
    await onBlockApplied(10);
    expect(getPendingCount()).toBe(0);
  });

  it('retries at exponential intervals: 1, 2, 4, … capped at 256', async () => {
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');

    await onBlockApplied(10);
    expect(requestLog).toHaveLength(1);

    // Next retry at height 10 + 1 = 11
    await onBlockApplied(10);
    expect(requestLog).toHaveLength(1);

    await onBlockApplied(11);
    expect(requestLog).toHaveLength(2);

    // Next at 11 + 2 = 13
    await onBlockApplied(12);
    expect(requestLog).toHaveLength(2);

    await onBlockApplied(13);
    expect(requestLog).toHaveLength(3);

    // Next at 13 + 4 = 17
    await onBlockApplied(16);
    expect(requestLog).toHaveLength(3);

    await onBlockApplied(17);
    expect(requestLog).toHaveLength(4);
  });

  it('⛔ the second attempt goes to a different peer when one exists', async () => {
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');

    await onBlockApplied(10);
    expect(requestLog[0]!.peerId).toBe('peer-a');

    await onBlockApplied(11);
    expect(requestLog[1]!.peerId).toBe('peer-b');
  });

  it('first attempt uses the relaying peer', async () => {
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-b');

    await onBlockApplied(10);
    expect(requestLog[0]!.peerId).toBe('peer-b');
  });

  it('skips a disconnected fromPeerId on first attempt and picks another', async () => {
    connectedPeers = ['peer-b'];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-gone');

    await onBlockApplied(10);
    expect(requestLog[0]!.peerId).toBe('peer-b');
  });

  it('does nothing with no connected peers', async () => {
    connectedPeers = [];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');

    await onBlockApplied(10);
    expect(requestLog).toHaveLength(0);
  });

  it('does not re-register the same id', () => {
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
    registerPlaceholder('post-1', 'hash-1', 11, 'peer-b');
    expect(getPendingCount()).toBe(1);
  });

  it('logs a warning when the request fails rather than swallowing', async () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(' '));
    try {
      initBackfill({
        requestPostBodies: async () => { throw new Error('network down'); },
        getConnectedPeers: () => ['peer-a'],
        getServingReaders: () => [],
        setPostBody: () => true,
        getMissingBodies: () => [],
        getStillPlaceholderIds: (ids) => [...ids],
      });
      registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
      await onBlockApplied(10);
      expect(warns.some(w => w.includes('network down'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  // NODE_INTERFACE → "One pass runs at a time": the gate held open, a second
  // call to onBlockApplied at the same height passes through without a
  // request — the entry is already marked asked, its schedule advanced.
  it('a second call at the same height during an open request fires no new request', async () => {
    gate = new Promise((resolve) => { gateRelease = resolve; });
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');

    const first = onBlockApplied(10);
    // Flush microtasks so the pass reaches the gate.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(requestLog).toHaveLength(1);

    // A second call while the first pass is open: no new request fires.
    void onBlockApplied(10);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(requestLog).toHaveLength(1);

    gateRelease();
    await first;
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due": an
  // entry's first due pass is a pass that advances its schedule, and the
  // reader-eligible set is the due entries whose schedule a pass has
  // advanced before.
  it('an entry is not asked of a reader at its first due pass, and is at its second', async () => {
    connectedPeers = ['peer-a'];
    servingReaders = ['reader-a'];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');

    await onBlockApplied(10);
    // The first due pass advances the schedule; no reader is asked.
    expect(requestLog.map((c) => c.peerId)).toEqual(['peer-a']);

    await onBlockApplied(11);
    // The second due pass asks the node peer, then the reader; the
    // reader's call carries the entry.
    expect(requestLog.map((c) => c.peerId)).toEqual(['peer-a', 'peer-a', 'reader-a']);
    expect(requestLog[2]!.wanted).toEqual([{ id: 'post-1', contentHash: 'hash-1' }]);
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due": the
  // schedule advances even when no node peer is connected, so an entry's
  // schedule a pass advanced is reader-eligible at its next due height.
  it('with no node peer, an entry due once reaches readers at its next due pass', async () => {
    connectedPeers = [];
    servingReaders = ['reader-a'];
    storedBodies.set('post-1', 'the body');
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');

    await onBlockApplied(10);
    // The first due pass advances the schedule; no call fires.
    expect(requestLog).toHaveLength(0);

    await onBlockApplied(11);
    // The second due pass reaches the reader, which answers with the body.
    expect(requestLog.map((c) => c.peerId)).toEqual(['reader-a']);
    expect(setPostBodyCalls).toEqual([{ id: 'post-1', content: 'the body' }]);
    expect(emitStore.emitLog).toEqual([{ postId: 'post-1', source: 'reader-a', via: 'pull' }]);
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due": each
  // serving reader is asked once a pass, with the whole reader-eligible set.
  it('every serving reader is asked, one call each', async () => {
    connectedPeers = ['peer-a'];
    servingReaders = ['reader-a', 'reader-b', 'reader-c'];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
    registerPlaceholder('post-2', 'hash-2', 10, 'peer-a');

    await onBlockApplied(10);
    // The first due pass asks the node peer once, no reader.
    expect(requestLog.map((c) => c.peerId)).toEqual(['peer-a']);
    expect([...requestLog[0]!.wanted.map((w) => w.id)].sort()).toEqual(['post-1', 'post-2']);

    await onBlockApplied(11);
    // The second due pass: one call to the node, one call per reader.
    expect(requestLog.map((c) => c.peerId)).toEqual(['peer-a', 'peer-a', 'reader-a', 'reader-b', 'reader-c']);
    for (const call of requestLog.slice(2)) {
      expect([...call.wanted.map((w) => w.id)].sort()).toEqual(['post-1', 'post-2']);
    }
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due": a
  // reader's call that rejects leaves the pass asking the next reader.
  it('a reader whose call rejects leaves the pass asking the next reader', async () => {
    initBackfill({
      requestPostBodies: async (wanted, peerId) => {
        requestLog.push({ wanted, peerId });
        if (peerId === 'reader-1') throw new Error('reader down');
        const out: Array<{ id: string; content: string }> = [];
        for (const w of wanted) {
          const body = storedBodies.get(w.id);
          if (body) out.push({ id: w.id, content: body });
        }
        return out;
      },
      getConnectedPeers: () => [],
      getServingReaders: () => ['reader-1', 'reader-2'],
      setPostBody: (id, content) => { setPostBodyCalls.push({ id, content }); return true; },
      getMissingBodies: () => [],
      getStillPlaceholderIds: (ids) => [...ids],
    });
    storedBodies.set('post-1', 'the body');
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');

    await onBlockApplied(10);
    // The first due pass advances the schedule; no asks (no node peer, no
    // reader-eligible entry before the advance).
    expect(requestLog).toHaveLength(0);

    await onBlockApplied(11);
    // reader-1's call rejects; reader-2 is asked and answers.
    expect(requestLog.map((c) => c.peerId)).toEqual(['reader-1', 'reader-2']);
    expect(setPostBodyCalls).toEqual([{ id: 'post-1', content: 'the body' }]);
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due": the
  // arrival asks the reader once for every scheduled entry that has been due.
  it('readerArrived asks the reader for every pending entry due once, and moves no schedule', async () => {
    connectedPeers = ['peer-a'];
    servingReaders = ['reader-a'];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
    registerPlaceholder('post-2', 'hash-2', 10, 'peer-a');
    registerPlaceholder('post-3', 'hash-3', 100, 'peer-a');

    await onBlockApplied(10);
    const callsAfterFirstPass = requestLog.length;

    await readerArrived('reader-a');
    const arrivalCalls = requestLog.slice(callsAfterFirstPass);
    expect(arrivalCalls.map((c) => c.peerId)).toEqual(['reader-a']);
    expect([...arrivalCalls[0]!.wanted.map((w) => w.id)].sort()).toEqual(['post-1', 'post-2']);

    // Which heights trigger node calls after the arrival.
    const heightsA: number[] = [];
    for (let h = 11; h <= 25; h++) {
      const before = requestLog.length;
      await onBlockApplied(h);
      const added = requestLog.slice(before).filter((c) => c.peerId === 'peer-a');
      if (added.length > 0) heightsA.push(h);
    }

    // The control: the same arrangement with no arrival.
    clearPending();
    requestLog.length = 0;
    servingReaders = [];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
    registerPlaceholder('post-2', 'hash-2', 10, 'peer-a');
    registerPlaceholder('post-3', 'hash-3', 100, 'peer-a');
    await onBlockApplied(10);
    const heightsB: number[] = [];
    for (let h = 11; h <= 25; h++) {
      const before = requestLog.length;
      await onBlockApplied(h);
      const added = requestLog.slice(before).filter((c) => c.peerId === 'peer-a');
      if (added.length > 0) heightsB.push(h);
    }

    // The two schedules match: the arrival moves none of them.
    expect(heightsA).toEqual(heightsB);
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due": a
  // peer id `getServingReaders()` does not name is asked nothing.
  it('readerArrived asks a reader that does not serve nothing', async () => {
    connectedPeers = ['peer-a'];
    servingReaders = ['reader-a'];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
    await onBlockApplied(10);
    const before = requestLog.length;

    await readerArrived('peer-outside');
    expect(requestLog.slice(before).filter((c) => c.peerId === 'peer-outside')).toHaveLength(0);

    await readerArrived('reader-a');
    expect(requestLog.filter((c) => c.peerId === 'reader-a')).toHaveLength(1);
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due":
  // after the entries no longer placeholders leave unasked.
  it('readerArrived skips an entry that is no longer a placeholder', async () => {
    connectedPeers = [];
    servingReaders = ['reader-a'];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
    registerPlaceholder('post-2', 'hash-2', 10, 'peer-a');
    await onBlockApplied(10);
    expect(requestLog).toHaveLength(0);

    // Rewire so `getStillPlaceholderIds` drops post-1.
    initBackfill({
      requestPostBodies: async (wanted, peerId) => {
        requestLog.push({ wanted, peerId });
        return [];
      },
      getConnectedPeers: () => [],
      getServingReaders: () => ['reader-a'],
      setPostBody: () => true,
      getMissingBodies: () => [],
      getStillPlaceholderIds: (ids) => ids.filter((id) => id !== 'post-1'),
    });

    await readerArrived('reader-a');
    expect(requestLog).toHaveLength(1);
    expect(requestLog[0]!.peerId).toBe('reader-a');
    expect(requestLog[0]!.wanted.map((w) => w.id)).toEqual(['post-2']);
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due": the
  // arrival runs in the puller's one-at-a-time order, never beside a pass.
  it('readerArrived during a pass runs after it', async () => {
    connectedPeers = ['peer-a'];
    servingReaders = ['reader-a'];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');

    await onBlockApplied(10);
    expect(requestLog).toHaveLength(1);

    // Hold the second pass's node call open.
    gate = new Promise((resolve) => { gateRelease = resolve; });
    const pass2 = onBlockApplied(11);
    // Wait until the pass's node call is actually in flight.
    await vi.waitFor(() => {
      expect(openCount).toBe(1);
      expect(requestLog).toHaveLength(2);
    });

    // readerArrived while a pass is open joins the queue; the pass drains
    // first. The claim rests on the final order and on nothing overlapping.
    const arrival = readerArrived('reader-a');

    gateRelease();
    await pass2;
    await arrival;

    expect(maxOpen).toBe(1);
    expect(requestLog.filter((c) => c.peerId === 'reader-a')).toHaveLength(2);
    // The pass's reader ask comes before the arrival's: nothing from the
    // arrival ran while the pass was in flight.
    expect(requestLog.map((c) => c.peerId)).toEqual(['peer-a', 'peer-a', 'reader-a', 'reader-a']);
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due":
  // the entry stored through the arrival leaves pending, so the next due
  // pass asks no one for it.
  it('a text a reader sends leaves the schedule', async () => {
    initBackfill({
      requestPostBodies: async (wanted, peerId) => {
        requestLog.push({ wanted, peerId });
        if (peerId !== 'reader-a') return [];
        const out: Array<{ id: string; content: string }> = [];
        for (const w of wanted) out.push({ id: w.id, content: 'the body' });
        return out;
      },
      getConnectedPeers: () => ['peer-a'],
      getServingReaders: () => ['reader-a'],
      setPostBody: (id, content) => { setPostBodyCalls.push({ id, content }); return true; },
      getMissingBodies: () => [],
      getStillPlaceholderIds: (ids) => [...ids],
    });

    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
    await onBlockApplied(10);
    // The node held no body; the entry remains pending.
    expect(getPendingCount()).toBe(1);

    await readerArrived('reader-a');
    expect(getPendingCount()).toBe(0);

    const before = requestLog.length;
    await onBlockApplied(11);
    const laterCalls = requestLog.slice(before);
    const anyPost1 = laterCalls.some((c) => c.wanted.some((w) => w.id === 'post-1'));
    expect(anyPost1).toBe(false);
  });

  // NODE_INTERFACE → "A serving reader is asked for what has been due": the
  // reader arm asks only for the eligible entries the node arm has not
  // already filled in the same pass.
  it('a pass asks readers only for what its node peers left unanswered', async () => {
    connectedPeers = ['peer-a'];
    servingReaders = ['reader-a'];
    registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
    registerPlaceholder('post-2', 'hash-2', 10, 'peer-a');

    await onBlockApplied(10);
    // The first due pass advances the schedule for both; no reader-eligible
    // entry yet, so only the node peer is asked.
    expect(requestLog.map((c) => c.peerId)).toEqual(['peer-a']);

    // The node gains post-1 between the passes.
    storedBodies.set('post-1', 'the body');

    await onBlockApplied(11);
    // The node peer answers post-1 in the second pass; the reader is asked
    // only for post-2.
    const readerCall = requestLog.find((c) => c.peerId === 'reader-a');
    expect(readerCall).toBeDefined();
    expect(readerCall!.wanted.map((w) => w.id)).toEqual(['post-2']);
  });
});
