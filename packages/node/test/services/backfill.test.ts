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

  beforeEach(() => {
    clearPending();
    requestLog = [];
    storedBodies = new Map();
    connectedPeers = ['peer-a', 'peer-b'];

    initBackfill({
      requestPostBodies: async (wanted, peerId) => {
        requestLog.push({ wanted, peerId });
        const results: Array<{ id: string; content: string }> = [];
        for (const w of wanted) {
          const body = storedBodies.get(w.id);
          if (body) results.push({ id: w.id, content: body });
        }
        return results;
      },
      getConnectedPeers: () => connectedPeers,
      setPostBody: (_id: string, _content: string) => true,
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
      });
      registerPlaceholder('post-1', 'hash-1', 10, 'peer-a');
      await onBlockApplied(10);
      expect(warns.some(w => w.includes('network down'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});
