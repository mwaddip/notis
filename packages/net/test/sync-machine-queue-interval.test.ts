import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encodeStruct } from '@dagsocial/types';
import { SyncMachine } from '../src/sync-machine.js';
import type { SyncStore } from '../src/sync-machine.js';
import {
  syncInfoCodec,
  invCodec,
  modifierRequestCodec,
  modifierResponseCodec,
} from '../src/sync-codec.js';
import { decodeFrame } from '../src/frame.js';
import {
  MSG_SYNC_INFO,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MSG_INV,
  MODIFIER_ORDERING_BLOCK,
} from '../src/types.js';
import type { NetConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// The three machine-level rules that NET_INTERFACE states and the tree does
// not: a peer's `SyncInfo` acted on at most once per 100 ms (the register's
// `SYNC_INFO_MIN_INTERVAL_MS`), a peer served one block answer at a time
// (`MAX_PENDING_BLOCK_REQUESTS`), and a data queue bounded per peer
// (`MAX_DATA_EVENTS_PER_PEER`) so one peer's flood never pushes out another.
// Written as `.fails` on `SyncMachine` driven through its message entries, so
// the assertion a rule flips reaches the real code without a stub reaching
// around it.
// ---------------------------------------------------------------------------

const MAGIC = 0x54444147;

const testConfig: NetConfig = {
  magic: MAGIC,
  protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
  orderingBlockPowTargetFloorBits: 2304,
  bootstrapPeers: [],
  listenAddrs: '',
  maxPeers: 10,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3_600_000,
  penaltySafeIntervalMs: 120_000,
  syncRequestTimeoutMs: 10_000,
};

function stubStore(overrides: Partial<SyncStore> = {}): SyncStore {
  return {
    getOrderingBlock: () => null,
    serializeOrderingBlock: () => null,
    getOrderingBlockId: () => null,
    heightByBlockId: () => null,
    chainHeight: () => 0,
    appendBlocks: () => {},
    ...overrides,
  };
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

function hexId(n: number): string {
  return (n + 1).toString(16).padStart(64, '0');
}

/** Count framed ModifierResponse frames addressed to `peerId`. */
function countResponsesTo(sent: Sent[], peerId: string): number {
  let n = 0;
  for (const m of sent) {
    if (m.peerId !== peerId) continue;
    try {
      const frame = decodeFrame(MAGIC, m.data);
      if (frame.code === MSG_MODIFIER_RESPONSE) n++;
    } catch { /* not a frame — nothing to count */ }
  }
  return n;
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

  it.fails('two SyncInfos 10 ms apart: the second is held, the tick acts on it', () => {
    const { machine } = makeMachine({ chainHeight: () => 0 });

    // The first SyncInfo stands at once — nothing is held before an interval.
    machine.handleMessage('B', MSG_SYNC_INFO, encodeStruct(syncInfoCodec, { tipHeight: 100 }));
    machine.flush();
    expect(machine.peerHeight('B')).toBe(100);

    // Advance 10 ms — well inside the 100 ms interval — and send the second.
    vi.advanceTimersByTime(10);
    machine.handleMessage('B', MSG_SYNC_INFO, encodeStruct(syncInfoCodec, { tipHeight: 200 }));
    machine.flush();
    const rightAfterSecond = machine.peerHeight('B');

    // Advance past the interval and tick — the held report is acted on now.
    vi.advanceTimersByTime(120);
    machine.onTimerTick();
    machine.flush();
    const afterTick = machine.peerHeight('B');

    // The tick is what reads the held report; both verdicts hold today, but a
    // held second brings `rightAfterSecond` back to 100 and the last line is
    // what today's "acted on at once" fails.
    expect(afterTick).toBe(200);
    expect(rightAfterSecond).toBe(100);
  });

  it('a single SyncInfo stands at once — the interval holds nothing of the first', () => {
    const { machine } = makeMachine({ chainHeight: () => 0 });
    machine.handleMessage('B', MSG_SYNC_INFO, encodeStruct(syncInfoCodec, { tipHeight: 42 }));
    machine.flush();
    expect(machine.peerHeight('B')).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// NET_INTERFACE → Serve Side → "A peer is served one block answer at a time"
// ---------------------------------------------------------------------------

describe('a peer is served one block answer at a time', () => {
  it.fails('three block requests arrive and only one answer goes out', () => {
    // A holds three contiguous blocks at heights 1..3; the ids are our hex
    // encodings of the heights. B is a peer behind us at height 0.
    const ids = [hexId(0), hexId(1), hexId(2)];
    const heights = new Map<string, number>(ids.map((id, i) => [id, i + 1]));
    const { machine, sent } = makeMachine({
      chainHeight: () => 3,
      heightByBlockId: (id) => heights.get(id) ?? null,
      serializeOrderingBlock: (h) => new Uint8Array([h]),
    });

    // Transition B to Active without consuming the initial reply.
    machine.onPeerActive('B', 0, 'outbound');
    machine.flush();
    sent.length = 0;

    // Three ModifierRequests arrive back to back, each asking for one id.
    for (const id of ids) {
      const body = encodeStruct(modifierRequestCodec, { typeId: MODIFIER_ORDERING_BLOCK, ids: [id] });
      machine.handleMessage('B', MSG_MODIFIER_REQUEST, body);
    }
    machine.flush();

    const toB = countResponsesTo(sent, 'B');
    // No answer at all would be a different failure — pin that it is a serve,
    // not a drop. The second line is the rule the tree does not hold.
    expect(toB).toBeGreaterThanOrEqual(1);
    expect(toB).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// NET_INTERFACE → Biased Event Loop clause 2 — "bounded per peer, lossy: a
// peer holds at most MAX_DATA_EVENTS_PER_PEER queued, and one more drops that
// peer's oldest, never another peer's"
// ---------------------------------------------------------------------------

describe("a peer's flood never pushes out the sync peer's answer", () => {
  it.fails("the sync peer's ModifierResponse is applied despite a flooder's 65 Invs", () => {
    // The ids we have asked S for — one each. Tracking height via a mutable
    // variable lets `appendBlocks` move the chain, which is how progress is
    // measured.
    const askId = hexId(0);
    let height = 0;
    const { machine } = makeMachine({
      chainHeight: () => height,
      heightByBlockId: () => null,
      getOrderingBlockId: () => null,
      appendBlocks: (blocks) => { height += blocks.length; },
    });

    // S becomes the sync peer and we ask it for `askId`.
    machine.onPeerActive('S', 100, 'outbound');
    machine.flush();
    machine.handleMessage('S', MSG_INV, encodeStruct(invCodec, {
      typeId: MODIFIER_ORDERING_BLOCK,
      ids: [askId],
    }));
    machine.flush();

    // No flush between these — the queue must grow in one turn so the flood
    // reaches 64 before anything is drained.
    const respBody = encodeStruct(modifierResponseCodec, {
      typeId: MODIFIER_ORDERING_BLOCK,
      modifiers: [{ id: askId, data: new Uint8Array([1]) }],
    });
    machine.handleMessage('S', MSG_MODIFIER_RESPONSE, respBody);
    for (let i = 0; i < 65; i++) {
      const invBody = encodeStruct(invCodec, {
        typeId: MODIFIER_ORDERING_BLOCK,
        ids: [hexId(i + 100)],
      });
      machine.handleMessage('F', MSG_INV, invBody);
    }

    // Drain. The global queue drops its oldest once full — today S's response
    // was the first in and goes with it; a per-peer queue leaves it alone.
    machine.flush();

    // The response reaches the store if and only if it was not pushed out.
    expect(height).toBe(1);
  });
});
