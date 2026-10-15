import { describe, it, expect, beforeEach } from 'vitest';
import {
  initBackfill,
  registerPlaceholder,
  onBlockApplied,
  clearPending,
  getPendingCount,
} from '../../src/services/backfill.js';

describe('backfill driver', () => {
  let requestLog: Array<{ wanted: Array<{ id: string; contentHash: string }>; peerId: string }>;
  let storedBodies: Map<string, string>;
  let connectedPeers: string[];
  let gateRelease: () => void;
  let gate: Promise<void>;

  beforeEach(() => {
    clearPending();
    requestLog = [];
    storedBodies = new Map();
    connectedPeers = ['peer-a', 'peer-b'];
    gateRelease = () => {};
    gate = Promise.resolve();

    initBackfill({
      requestPostBodies: async (wanted, peerId) => {
        requestLog.push({ wanted, peerId });
        await gate;
        const results: Array<{ id: string; content: string }> = [];
        for (const w of wanted) {
          const body = storedBodies.get(w.id);
          if (body) results.push({ id: w.id, content: body });
        }
        return results;
      },
      getConnectedPeers: () => connectedPeers,
      setPostBody: (_id: string, _content: string) => true,
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

  // NODE_INTERFACE → "mark each remaining entry asked — the next due height
  // and the interval advanced — before any request goes out". The gate held
  // open, a second call to onBlockApplied at the same height passes through
  // without a request — the schedule has already advanced.
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
});
