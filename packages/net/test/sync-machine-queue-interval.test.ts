import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encodeStruct } from '@dagsocial/types';
import { SyncMachine } from '../src/sync-machine.js';
import type { SyncStore } from '../src/sync-machine.js';
import { syncInfoCodec } from '../src/sync-codec.js';
import { MSG_SYNC_INFO } from '../src/types.js';
import type { NetConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// NET_INTERFACE → Serve Side → "A peer's `SyncInfo` is acted on at most once
// per `SYNC_INFO_MIN_INTERVAL_MS`". Driven through `SyncMachine`'s message
// entries, so the assertion the rule flips reaches the real code without a
// stub reaching around it.
// ---------------------------------------------------------------------------

const MAGIC = 0x54444147;

const testConfig: NetConfig = {
  magic: MAGIC,
  protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
  orderingBlockPowTargetFloorBits: 2304,
  bootstrapPeers: [],
  listenAddrs: '',
  maxPeers: 10,
  minPeers: 3,
  peerDbCap: 100,
  outboundRedialCooldownMs: 60_000,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3_600_000,
  penaltyDecayIntervalMs: 120_000,
  syncRequestTimeoutMs: 10_000,
};

function stubStore(overrides: Partial<SyncStore> = {}): SyncStore {
  return {
    getOrderingBlockId: () => null,
    heightByBlockId: () => null,
    chainHeight: () => 0,
    ...overrides,
  };
}

function heightOf(machine: SyncMachine, peerId: string): number | null {
  return machine.getClaimsForTest().get(peerId)?.tipHeight ?? null;
}

interface Sent { peerId: string; data: Uint8Array }

function makeMachine(store?: Partial<SyncStore>): { machine: SyncMachine; sent: Sent[] } {
  const sent: Sent[] = [];
  const machine = new SyncMachine(
    testConfig,
    stubStore(store),
    (peerId, data) => sent.push({ peerId, data }),
  );
  return { machine, sent };
}

// ---------------------------------------------------------------------------
// NET_INTERFACE → Serve Side →
// "A peer's `SyncInfo` is acted on at most once per `SYNC_INFO_MIN_INTERVAL_MS`"
// ---------------------------------------------------------------------------

describe("a peer's SyncInfo is acted on at most once per 100 ms", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('two SyncInfos 10 ms apart: the second is held, the tick acts on it', () => {
    const { machine } = makeMachine({ chainHeight: () => 0 });

    // The first SyncInfo stands at once — nothing is held before an interval.
    machine.handleMessage('B', MSG_SYNC_INFO, encodeStruct(syncInfoCodec, { tipHeight: 100, tipHash: '00'.repeat(32) }));
    machine.flush();
    expect(heightOf(machine, 'B')).toBe(100);

    // Advance 10 ms — well inside the 100 ms interval — and send the second.
    vi.advanceTimersByTime(10);
    machine.handleMessage('B', MSG_SYNC_INFO, encodeStruct(syncInfoCodec, { tipHeight: 200, tipHash: '00'.repeat(32) }));
    machine.flush();
    const rightAfterSecond = heightOf(machine, 'B');

    // Advance past the interval and tick — the held report is acted on now.
    vi.advanceTimersByTime(120);
    machine.onTimerTick();
    machine.flush();
    const afterTick = heightOf(machine, 'B');

    // The tick is what reads the held report; both verdicts hold once the
    // interval does, and the last line is the one the interval flips —
    // right after the second, the retained height is still the first's.
    expect(afterTick).toBe(200);
    expect(rightAfterSecond).toBe(100);
  });

  it('a single SyncInfo stands at once — the interval holds nothing of the first', () => {
    const { machine } = makeMachine({ chainHeight: () => 0 });
    machine.handleMessage('B', MSG_SYNC_INFO, encodeStruct(syncInfoCodec, { tipHeight: 42, tipHash: '00'.repeat(32) }));
    machine.flush();
    expect(heightOf(machine, 'B')).toBe(42);
  });
});

// The scheduler keeps at most one header request and one block request open
// per peer and awaits each answer by its round trip (NET_INTERFACE → Sync
// State Machine → "One header request per peer, every peer at once.";
// → "Blocks are asked by id, from a peer that has them.").
