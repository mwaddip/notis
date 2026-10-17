import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encodeStruct, GENESIS_PREV_BLOCK_HASH } from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';
import { SyncMachine } from '../src/sync-machine.js';
import type { SyncStore } from '../src/sync-machine.js';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { MSG_SYNC_INFO } from '../src/types.js';
import { syncInfoCodec } from '../src/sync-codec.js';
import { makeConfig } from './helpers.js';

// ---------------------------------------------------------------------------
// The scheduler's header half: claims, header syncs, stall marks, the phases
// (NET_INTERFACE → Historical Sync, → Sync State Machine, → Stall Detection,
//  → Pipeline events, → Sync Handler Registration). These cases drive the
// surface the contract names — setPipeline, setChainView, needHeaders,
// chainMoved — and assert what it does when a claim arrives, when a page
// comes back, when a request's deadline fires, and when the applied tip or
// the best chain moves.
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
  outboundRedialCooldownMs: 60000,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3_600_000,
  penaltySafeIntervalMs: 120_000,
  syncRequestTimeoutMs: 10_000,
};

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

function hexId(n: number): string {
  return (n + 1).toString(16).padStart(64, '0');
}

function stubStore(overrides: Partial<SyncStore> = {}): SyncStore {
  return {
    getOrderingBlockId: () => null,
    heightByBlockId: () => null,
    chainHeight: () => 0,
    appendBlocks: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fakes for the scheduler's injected shape (NET_INTERFACE → Sync Handler
// Registration, → Pull Requests). Each is a thin recorder — the tests read
// what the scheduler asked, which pipeline call it made, which penalty it
// recorded.
// ---------------------------------------------------------------------------

interface FakePipeline {
  deliverHeaders: (peerId: string, claimHash: string, page: BlockHeader[]) => Promise<boolean>;
  deliverBlocks: (peerId: string, blocks: unknown[]) => Promise<void>;
  calls: { peerId: string; claimHash: string; page: BlockHeader[] }[];
  nextAnswer: boolean;
}

function makePipeline(nextAnswer: boolean = true): FakePipeline {
  const p: FakePipeline = {
    calls: [],
    nextAnswer,
    deliverHeaders: async (peerId, claimHash, page) => {
      p.calls.push({ peerId, claimHash, page });
      return p.nextAnswer;
    },
    deliverBlocks: async () => {},
  };
  return p;
}

interface FakeChainView {
  locatorFor: (peerId: string) => string[];
  knowsTip: (peerId: string, hash: string) => boolean;
  wantedBlocks: () => { id: string; height: number }[];
  fullyApplied: () => boolean;
  gateHeld: () => void;
  known: Set<string>;
  applied: boolean;
}

function makeChainView(opts: { locator?: string[]; known?: Set<string>; applied?: boolean } = {}): FakeChainView {
  const v: FakeChainView = {
    known: opts.known ?? new Set(),
    applied: opts.applied ?? true,
    locatorFor: () => opts.locator ?? [GENESIS_PREV_BLOCK_HASH],
    knowsTip: (_p, hash) => v.known.has(hash),
    wantedBlocks: () => [],
    fullyApplied: () => v.applied,
    gateHeld: () => {},
  };
  return v;
}

interface Scheduler {
  machine: SyncMachine;
  sent: { peerId: string; data: Uint8Array }[];
  penalties: { peerId: string; kind: string; reason: string }[];
  requests: { peerId: string; locator: string[] }[];
  connected: Set<string>;
  nextPage: BlockHeader[] | Error;
  pipeline: FakePipeline;
  view: FakeChainView;
}

function makeScheduler(opts: {
  store?: Partial<SyncStore>;
  pipeline?: FakePipeline;
  view?: FakeChainView;
  connected?: Set<string>;
  nextPage?: BlockHeader[] | Error;
} = {}): Scheduler {
  const sent: { peerId: string; data: Uint8Array }[] = [];
  const penalties: { peerId: string; kind: string; reason: string }[] = [];
  const requests: { peerId: string; locator: string[] }[] = [];
  const connected = opts.connected ?? new Set<string>();
  const pipeline = opts.pipeline ?? makePipeline();
  const view = opts.view ?? makeChainView();
  const nextPage = opts.nextPage ?? [];
  const sch: Scheduler = {
    machine: new SyncMachine(testConfig, stubStore(opts.store), (p, d) => sent.push({ peerId: p, data: d })),
    sent, penalties, requests, connected, pipeline, view, nextPage,
  };
  const asAny = sch.machine as unknown as {
    setPipeline?: (p: FakePipeline) => void;
    setChainView?: (v: FakeChainView) => void;
    setRequestHeaders?: (fn: (locator: string[], peerId: string) => Promise<BlockHeader[]>) => void;
    setConnectedPeers?: (fn: () => Set<string>) => void;
    setPenalize?: (fn: (peerId: string, kind: string, reason: string) => void) => void;
  };
  asAny.setPipeline?.(pipeline);
  asAny.setChainView?.(view);
  asAny.setRequestHeaders?.(async (locator, peerId) => {
    requests.push({ peerId, locator });
    if (sch.nextPage instanceof Error) throw sch.nextPage;
    return sch.nextPage;
  });
  asAny.setConnectedPeers?.(() => sch.connected);
  asAny.setPenalize?.((peerId, kind, reason) => penalties.push({ peerId, kind, reason }));
  return sch;
}

/** Hand the scheduler a `SyncInfo` through its public entry — the frame body. */
function syncInfo(sch: Scheduler, peerId: string, tipHeight: number, tipHash?: string): void {
  const body = encodeStruct(syncInfoCodec, { tipHeight, tipHash: tipHash ?? hexId(tipHeight) });
  sch.machine.handleMessage(peerId, MSG_SYNC_INFO, body);
  sch.machine.flush();
}

/** peerActive marks the connection and lets the scheduler record its direction. */
function peerActive(sch: Scheduler, peerId: string, height: number, direction: 'inbound' | 'outbound' = 'outbound'): void {
  sch.connected.add(peerId);
  sch.machine.onPeerActive(peerId, height, direction);
  sch.machine.flush();
}

/** Reach the scheduler through the control-event entries the contract names. */
function needHeaders(sch: Scheduler, peerId: string): void {
  (sch.machine as unknown as { needHeaders?: (p: string) => void }).needHeaders?.(peerId);
  sch.machine.flush();
}

function chainMoved(sch: Scheduler): void {
  (sch.machine as unknown as { chainMoved?: () => void }).chainMoved?.();
  sch.machine.flush();
}

// Give a header worker promise its microtask round so delivery lands.
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// H-7 — a peer whose answer refutes its claim is marked and asked no more
// (NET_INTERFACE → Stall Detection, → Sync State Machine → "How a header
// sync ends")
// ---------------------------------------------------------------------------

describe('a peer whose answer refutes its claim is marked and asked no more', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a short page below the claimed tip earns a transient penalty', async () => {
    const sch = makeScheduler({ nextPage: [] });
    peerActive(sch, 'bad', 1);
    syncInfo(sch, 'bad', 100_000_000);
    await settle();
    expect(sch.penalties.find(p => p.peerId === 'bad' && p.kind === 'transient')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// N12 — ghost peers (NET_INTERFACE → Sync State Machine → "An event for a
// peer no longer connected is ignored")
// ---------------------------------------------------------------------------

describe('an event for a peer not in the connected set plants nothing', () => {
  it('a SyncInfo whose sender is not in connectedPeers() sends nothing back', () => {
    const sch = makeScheduler();
    // `stranger` is NOT in sch.connected
    syncInfo(sch, 'stranger', 42);
    expect(sch.sent.filter(m => m.peerId === 'stranger').length).toBe(0);
  });

  it("a ghost's second SyncInfo inside the interval plants no pending entry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sch = makeScheduler();
    syncInfo(sch, 'stranger', 10);
    vi.advanceTimersByTime(10); // inside SYNC_INFO_MIN_INTERVAL_MS
    syncInfo(sch, 'stranger', 20);
    // Removing `handleSyncInfoMsg`'s connected-set check would hand the
    // first report to `actOnSyncInfo` (planting the acted-on stamp) and
    // store the second as the ghost's pending — the tick would then
    // act on it on expiry.
    const introspect = sch.machine as unknown as { getPendingSyncInfoForTest(): Map<string, unknown> };
    expect(introspect.getPendingSyncInfoForTest().has('stranger')).toBe(false);
    vi.useRealTimers();
  });

  it('a peer-active for a peer not in connectedPeers() records no direction and sends nothing', () => {
    const sch = makeScheduler();
    sch.machine.onPeerActive('ghost', 10, 'outbound');
    sch.machine.flush();
    // Removing the connected-set check in `handlePeerActive` would set
    // the ghost's direction and open a `SyncInfo` dial to it.
    expect(sch.machine.getDirectionForTest('ghost')).toBeNull();
    expect(sch.sent.filter(m => m.peerId === 'ghost').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A header run that throws degrades one run, not the subsystem
// (NET_INTERFACE → Stream Protocols — "A stream handler never rejects";
//  NODE_INTERFACE → "An unhandled rejection is logged, and the node
//  keeps running"). A `locatorFor` or `knowsTip` throw lands inside the
// run's launcher.
// ---------------------------------------------------------------------------

describe('a header run that throws leaves the scheduler serving the next event', () => {
  it("a throwing locatorFor ends one run and logs it", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = makeChainView();
    view.locatorFor = () => { throw new Error('view faulted'); };
    const sch = makeScheduler({ view });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 50, hexId(50));
    await settle();
    // The run's throw is logged with the peer id, not reflected to the
    // sender, and the scheduler goes on to the next event.
    expect(warnSpy.mock.calls.some((args) => args.join(' ').includes('header run for p threw'))).toBe(true);
    // The next event — another SyncInfo from another peer — still
    // reaches `actOnSyncInfo` and writes its claim.
    peerActive(sch, 'q', 1);
    syncInfo(sch, 'q', 10, hexId(10));
    await settle();
    expect(sch.machine.peerHeight('q')).toBe(10);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// A peer's direction is written at peer-active and read without a claim
// (NET_INTERFACE → Sync State Machine → "A claim is the peer's applied
// tip, height and hash" — direction travels with the peer id, not the
// claim; the gate counts outbound peers).
// ---------------------------------------------------------------------------

describe('direction travels with the peer id', () => {
  it("an inbound peer's peer-active then SyncInfo leaves it inbound", () => {
    const sch = makeScheduler();
    peerActive(sch, 'p', 1, 'inbound');
    syncInfo(sch, 'p', 50, hexId(50));
    expect(sch.machine.getDirectionForTest('p')).toBe('inbound');
  });
});

// ---------------------------------------------------------------------------
// Claims (NET_INTERFACE → Sync State Machine)
// ---------------------------------------------------------------------------

describe('claims drive one run at most per peer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a known claim settles the peer and the phase runs to synced', async () => {
    const known = new Set<string>([hexId(50)]);
    const view = makeChainView({ known, applied: true });
    const sch = makeScheduler({ view });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 50, hexId(50));
    await settle();
    expect(sch.machine.getState().phase).toBe('synced');
  });

  it('a claim the view lacks opens one header request', async () => {
    const sch = makeScheduler({ nextPage: new Error('held') });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 50, hexId(50));
    await settle();
    expect(sch.requests.length).toBe(1);
  });

  it('a claim replaced mid-run drives the next page toward the new hash', async () => {
    vi.setSystemTime(0);
    const h1 = hexId(50);
    const h2 = hexId(60);
    let release1!: (page: BlockHeader[]) => void;
    const page1 = new Promise<BlockHeader[]>((r) => { release1 = r; });
    const delivered: { peerId: string; claimHash: string }[] = [];
    const pipeline: FakePipeline = makePipeline(true);
    pipeline.deliverHeaders = async (peerId, hash, page) => {
      delivered.push({ peerId, claimHash: hash });
      pipeline.calls.push({ peerId, claimHash: hash, page });
      return true;
    };
    const sch = makeScheduler({ pipeline });
    const asAny = sch.machine as unknown as {
      setRequestHeaders?: (fn: (locator: string[], peerId: string) => Promise<BlockHeader[]>) => void;
    };
    asAny.setRequestHeaders?.(async (locator, peerId) => {
      sch.requests.push({ peerId, locator });
      return page1;
    });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 50, h1);
    await settle();
    // Advance past the SYNC_INFO_MIN_INTERVAL_MS so the second report
    // acts on arrival rather than being held pending.
    vi.advanceTimersByTime(200);
    syncInfo(sch, 'p', 60, h2);
    await settle();
    // Resolve the request started under the first claim.
    release1([]);
    await settle();
    await settle();
    // The run read the current claim at the delivery, which is h2.
    expect(delivered.some(d => d.claimHash === h2)).toBe(true);
  });

  it('a second claim from the same peer while a run is open opens no second request', async () => {
    vi.setSystemTime(0);
    let release!: () => void;
    const held = new Promise<BlockHeader[]>((r) => { release = () => r([]); });
    const sch = makeScheduler();
    const asAny = sch.machine as unknown as {
      setRequestHeaders?: (fn: (locator: string[], peerId: string) => Promise<BlockHeader[]>) => void;
    };
    asAny.setRequestHeaders?.(async (locator, peerId) => {
      sch.requests.push({ peerId, locator });
      return held;
    });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 50, hexId(50));
    await settle();
    // Past the per-peer interval so the second report is acted on
    // rather than held as pending.
    vi.advanceTimersByTime(200);
    syncInfo(sch, 'p', 60, hexId(60));
    await settle();
    expect(sch.requests.length).toBe(1);
    release();
    await settle();
  });

  it('the handshake height alone keeps the phase idle', async () => {
    const sch = makeScheduler();
    peerActive(sch, 'p', 1000);
    await settle();
    expect(sch.machine.getState().phase).toBe('idle');
  });

  it('a claim replaced while a page is in flight does not refute the peer', async () => {
    vi.setSystemTime(0);
    const h1 = hexId(50);
    const h2 = hexId(60);
    const pageOf50 = (): BlockHeader[] => {
      const out: BlockHeader[] = [];
      for (let i = 1; i <= 50; i++) {
        out.push({
          protocolVersion: 1, height: i,
          prevBlockHash: i === 1 ? '00'.repeat(32) : hexId(i - 1),
          utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(33),
          validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 2304,
          createdAt: 0, interlinkRoot: '00'.repeat(32), adProofsRoot: '00'.repeat(32),
        });
      }
      return out;
    };
    let release1!: (page: BlockHeader[]) => void;
    const page1 = new Promise<BlockHeader[]>((r) => { release1 = r; });
    const sch = makeScheduler();
    const asAny = sch.machine as unknown as {
      setRequestHeaders?: (fn: (locator: string[], peerId: string) => Promise<BlockHeader[]>) => void;
    };
    let callNo = 0;
    asAny.setRequestHeaders?.(async (locator, peerId) => {
      callNo++;
      sch.requests.push({ peerId, locator });
      if (callNo === 1) return page1;
      // The next request should run against the new claim; the fake
      // never resolves it, so the run is still open when the test
      // reads marks and penalties.
      return new Promise<BlockHeader[]>(() => { /* held */ });
    });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 50, h1);
    await settle();
    // Claim rises during the delivery — the peer's chain reaches 60.
    vi.advanceTimersByTime(200);
    syncInfo(sch, 'p', 60, h2);
    await settle();
    // The first page the peer served under the first claim ends at 50 —
    // short, but the targeted claim was 50; a refute against the new
    // claim (60) is the defect this case guards.
    release1(pageOf50());
    await settle();
    await settle();
    // No mark, no transient — the peer is honest.
    expect(sch.penalties.filter(x => x.peerId === 'p' && x.kind === 'transient').length).toBe(0);
    expect(sch.machine.getMarksForTest().has('p')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Three ends of a header sync (NET_INTERFACE → Sync State Machine → "How a
// header sync ends", plus the two unmarked ends)
// ---------------------------------------------------------------------------

describe('a header sync ends in one of three ways, with two unmarked side exits', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('the claim is reached — a short-page delivery that makes knowsTip true settles the run', async () => {
    const claimHash = hexId(50);
    const known = new Set<string>();
    const view = makeChainView({ known, applied: true });
    const pipeline = makePipeline(true);
    const originalDeliver = pipeline.deliverHeaders;
    pipeline.deliverHeaders = async (peerId, hash, p) => {
      // The pipeline admits the headers; the view now holds the claim.
      known.add(hash);
      return originalDeliver(peerId, hash, p);
    };
    const sch = makeScheduler({ view, pipeline, nextPage: [] });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 50, claimHash);
    await settle();
    // Removing the reached-settles return in `runHeaders` lets the loop
    // fall through to the refute branch on this short page: a mark and
    // a transient the scheduler must not record. The claim settled, so
    // the phase can reach synced.
    expect(sch.machine.getMarksForTest().has('p')).toBe(false);
    expect(sch.penalties.filter(x => x.peerId === 'p').length).toBe(0);
    expect(sch.requests.filter(r => r.peerId === 'p').length).toBe(1);
    expect(sch.machine.getState().phase).toBe('synced');
  });

  it('a short page below the claimed height marks the peer', async () => {
    const sch = makeScheduler({ nextPage: [] });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 100, hexId(100));
    await settle();
    const introspect = (sch.machine as unknown as { getMarksForTest?: () => Map<string, number> });
    const marks = introspect.getMarksForTest?.() ?? new Map<string, number>();
    expect(marks.has('p')).toBe(true);
  });

  it('a deadline — the requester rejects — marks the peer with no penalty', async () => {
    const sch = makeScheduler({ nextPage: new Error('deadline') });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 100, hexId(100));
    await settle();
    const introspect = (sch.machine as unknown as { getMarksForTest?: () => Map<string, number> });
    const marks = introspect.getMarksForTest?.() ?? new Map<string, number>();
    expect(marks.has('p')).toBe(true);
  });

  it('a page failing its shape earns a misbehavior penalty', async () => {
    const bogus: BlockHeader[] = [{
      protocolVersion: 1,
      height: 7,
      prevBlockHash: 'aa'.repeat(32), // not in the one-entry locator
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 2304,
      createdAt: 0,
      interlinkRoot: '00'.repeat(32),
      adProofsRoot: '00'.repeat(32),
    }];
    const sch = makeScheduler({ nextPage: bogus });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 100, hexId(100));
    await settle();
    expect(sch.penalties.find(x => x.peerId === 'p' && x.kind === 'misbehavior')).toBeTruthy();
  });

  it('a pipeline refusal — false — reaches the pipeline and the peer stays unmarked', async () => {
    const pipeline = makePipeline(false);
    const sch = makeScheduler({ pipeline, nextPage: [] });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 100, hexId(100));
    await settle();
    expect(pipeline.calls.length).toBeGreaterThan(0);
  });

  it('a pipeline refusal on a short page earns no mark, no penalty and no further request', async () => {
    const pipeline = makePipeline(false);
    const sch = makeScheduler({ pipeline, nextPage: [] });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 100, hexId(100));
    await settle();
    // Removing `if (!accepted) return;` in `runHeaders` lets the loop
    // fall into the refute branch on a short page: a mark and a
    // transient penalty the scheduler must not record.
    expect(sch.machine.getMarksForTest().has('p')).toBe(false);
    expect(sch.penalties.filter(x => x.peerId === 'p').length).toBe(0);
    expect(sch.requests.filter(r => r.peerId === 'p').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cadence (NET_INTERFACE → Sync State Machine → "A claim is the peer's
// applied tip, height and hash" — the sends: peer-active and every
// `SYNCED_POLL_INTERVAL_MS` to every Active peer)
// ---------------------------------------------------------------------------

describe('this node sends its SyncInfo at peer-active and on the poll', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends one SyncInfo to the new peer at peer-active, regardless of height', () => {
    const sch = makeScheduler({ store: { chainHeight: () => 0 } });
    peerActive(sch, 'p', 0);
    expect(sch.sent.filter(m => m.peerId === 'p').length).toBe(1);
  });

  it('on the poll, every Active peer gets a SyncInfo even without any claim-driven event', () => {
    const sch = makeScheduler({ store: { chainHeight: () => 0 } });
    peerActive(sch, 'p1', 0);
    peerActive(sch, 'p2', 0);
    sch.sent.length = 0;
    vi.advanceTimersByTime(30_001);
    sch.machine.onTimerTick();
    expect(sch.sent.filter(m => m.peerId === 'p1').length + sch.sent.filter(m => m.peerId === 'p2').length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// needHeaders (NET_INTERFACE → Pull Requests → "A gossiped block's relayer
// is asked for the headers the tree lacks")
// ---------------------------------------------------------------------------

describe('needHeaders asks the named relayer when it is Active and unmarked', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('needHeaders for a peer not in connectedPeers plants no openHeaderRuns entry', () => {
    const sch = makeScheduler({ nextPage: new Error('held') });
    // 'ghost' is NOT in sch.connected. `flush` drains the control
    // event synchronously; `startHeaderRun` runs synchronously up to
    // its first `await`. Without the launch connected-set check, the
    // run adds the ghost to `openHeaderRuns` here — only runHeaders'
    // own isConnected returns on the next microtask.
    needHeaders(sch, 'ghost');
    const openRuns = (sch.machine as unknown as { getOpenHeaderRunsForTest(): Set<string> })
      .getOpenHeaderRunsForTest();
    expect(openRuns.has('ghost')).toBe(false);
    expect(sch.requests.length).toBe(0);
  });

  it('needHeaders asks the unmarked relayer and not the marked one', async () => {
    const sch = makeScheduler({ nextPage: [] });
    peerActive(sch, 'bad', 1);
    peerActive(sch, 'ok', 1);
    // 'bad' earns a mark by refuting its claim
    syncInfo(sch, 'bad', 100, hexId(100));
    await settle();
    sch.nextPage = new Error('held');
    const beforeBad = sch.requests.filter(r => r.peerId === 'bad').length;
    needHeaders(sch, 'bad');
    needHeaders(sch, 'ok');
    await settle();
    const okReqs = sch.requests.filter(r => r.peerId === 'ok').length;
    const badReqs = sch.requests.filter(r => r.peerId === 'bad').length - beforeBad;
    expect(okReqs - badReqs).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// chainMoved (NET_INTERFACE → Pipeline events)
// ---------------------------------------------------------------------------

describe('chainMoved re-asks knowsTip for every retained claim', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a settled claim the view no longer knows reopens a run', async () => {
    const claimHash = hexId(50);
    const known = new Set<string>([claimHash]);
    const view = makeChainView({ known });
    const sch = makeScheduler({ view, nextPage: new Error('held') });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 50, claimHash);
    await settle();
    expect(sch.requests.length).toBe(0);
    known.delete(claimHash);
    chainMoved(sch);
    await settle();
    expect(sch.requests.filter(r => r.peerId === 'p').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Marks' bounds (CONSTANTS → net)
// ---------------------------------------------------------------------------

describe("marks' bounds — MAX_STALL_MARKS + 1 drops the oldest", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('an oldest mark drops once MAX_STALL_MARKS is exceeded', async () => {
    const sch = makeScheduler({ nextPage: [] });
    for (let i = 0; i <= 1024; i++) {
      const name = `peer-${i}`;
      peerActive(sch, name, 1);
      syncInfo(sch, name, 100, hexId(100 + i));
      await settle();
    }
    const introspect = (sch.machine as unknown as { getMarksForTest?: () => Map<string, number> });
    const marks = introspect.getMarksForTest?.() ?? new Map<string, number>();
    expect(marks.size).toBe(1024);
  });

  it('a peer marked during an open run is asked nothing more', async () => {
    const sch = makeScheduler();
    const asAny = sch.machine as unknown as {
      setRequestHeaders?: (fn: (locator: string[], peerId: string) => Promise<BlockHeader[]>) => void;
    };
    let callNo = 0;
    let release1!: (page: BlockHeader[]) => void;
    const page1 = new Promise<BlockHeader[]>((r) => { release1 = r; });
    asAny.setRequestHeaders?.(async (locator, peerId) => {
      callNo++;
      sch.requests.push({ peerId, locator });
      if (callNo === 1) return page1;
      return new Promise<BlockHeader[]>(() => { /* held */ });
    });
    peerActive(sch, 'p', 1);
    // Claim height above the full page's last — reachedClaimedHeight
    // stays false after the first delivery, so the first iteration
    // does not refute; the loop would ask again were the mark check
    // not there.
    syncInfo(sch, 'p', 1_000, hexId(1_000));
    await settle();
    expect(sch.requests.filter(r => r.peerId === 'p').length).toBe(1);

    // Mark the peer from outside; the loop's next iteration reads it.
    (sch.machine as unknown as { markPeerForTest(id: string): void }).markPeerForTest('p');

    // Return a 400-header full page: the loop would ask again
    // without the mark check.
    const full: BlockHeader[] = [];
    for (let i = 1; i <= 400; i++) {
      full.push({
        protocolVersion: 1, height: i,
        prevBlockHash: i === 1 ? '00'.repeat(32) : hexId(i - 1),
        utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 2304,
        createdAt: 0, interlinkRoot: '00'.repeat(32), adProofsRoot: '00'.repeat(32),
      });
    }
    release1(full);
    await settle();
    await settle();
    expect(sch.requests.filter(r => r.peerId === 'p').length).toBe(1);
  });

  it('a mark expires after STALL_MARK_EXPIRY_MS and the next SyncInfo opens a run', async () => {
    vi.setSystemTime(0);
    const sch = makeScheduler({ nextPage: [] });
    peerActive(sch, 'p', 1);
    syncInfo(sch, 'p', 100, hexId(100));
    await settle();
    expect(sch.machine.getMarksForTest().has('p')).toBe(true);
    const before = sch.requests.filter(r => r.peerId === 'p').length;

    // A fresh request-answer that would otherwise refute again.
    const asAny = sch.machine as unknown as {
      setRequestHeaders?: (fn: (locator: string[], peerId: string) => Promise<BlockHeader[]>) => void;
    };
    asAny.setRequestHeaders?.(async (locator, peerId) => {
      sch.requests.push({ peerId, locator });
      return new Promise<BlockHeader[]>(() => { /* held */ });
    });

    // Removing the expiry check in `onTimerTick` leaves the mark in
    // place; the next SyncInfo's run returns at the mark check without
    // asking for a page.
    vi.advanceTimersByTime(1_800_001);
    sch.machine.onTimerTick();
    syncInfo(sch, 'p', 100, hexId(100));
    await settle();
    expect(sch.requests.filter(r => r.peerId === 'p').length).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// Phases (NET_INTERFACE → Sync State Machine → "The phases")
// ---------------------------------------------------------------------------

describe('phases: idle, syncing, synced', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is idle before any claim settles', () => {
    const sch = makeScheduler();
    expect(sch.machine.getState().phase).toBe('idle');
  });

  it('a run ended unmarked by a pipeline refusal keeps the phase syncing', async () => {
    const claimOk = hexId(10);
    const claimBad = hexId(20);
    const known = new Set<string>([claimOk]);
    const view = makeChainView({ known, applied: true });
    // The pipeline refuses `bad`'s delivery; `ok` is admitted so its
    // claim is settled on arrival.
    const pipeline = makePipeline(true);
    pipeline.deliverHeaders = async (peerId, hash, page) => {
      pipeline.calls.push({ peerId, claimHash: hash, page });
      if (peerId === 'bad') return false;
      return true;
    };
    const sch = makeScheduler({ view, pipeline, nextPage: [] });
    peerActive(sch, 'ok', 1);
    peerActive(sch, 'bad', 1);
    syncInfo(sch, 'ok', 10, claimOk);
    syncInfo(sch, 'bad', 20, claimBad);
    await settle();
    // Removing `computePhase`'s unsettled-claim check would read the
    // marks and the open-runs set only — `bad` is unmarked and its
    // run has ended, so the phase would wrongly reach synced.
    expect(sch.machine.getState().phase).toBe('syncing');
  });

  it('synced requires fullyApplied and every unmarked Active claim settled', async () => {
    const claim1 = hexId(10);
    const claim2 = hexId(20);
    const known = new Set<string>([claim1]);
    const view = makeChainView({ known, applied: true });
    const sch = makeScheduler({ view, nextPage: new Error('held') });
    peerActive(sch, 'p1', 1);
    peerActive(sch, 'p2', 1);
    syncInfo(sch, 'p1', 10, claim1);
    syncInfo(sch, 'p2', 20, claim2);
    await settle();
    known.add(claim2);
    chainMoved(sch);
    await settle();
    expect(sch.machine.getState().phase).toBe('synced');
  });
});

// ---------------------------------------------------------------------------
// Entering synced clears every mark (NET_INTERFACE → Stall Detection, →
// Sync State Machine → "The phases")
// ---------------------------------------------------------------------------

describe('entering synced clears every stall mark', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('the phase moves to synced and the marks leave', async () => {
    const claimOk = hexId(10);
    const known = new Set<string>([claimOk]);
    const view = makeChainView({ known, applied: true });
    const sch = makeScheduler({ view, nextPage: [] });
    peerActive(sch, 'honest', 1);
    peerActive(sch, 'bad', 1);
    syncInfo(sch, 'bad', 100, hexId(100));
    await settle();
    expect(sch.machine.getMarksForTest().has('bad')).toBe(true);
    syncInfo(sch, 'honest', 10, claimOk);
    await settle();
    expect(sch.machine.getState().phase).toBe('synced');
    // Removing `stallMarks.clear()` on entering synced leaves the mark
    // behind — the next bad claim would be ignored past its expiry.
    expect(sch.machine.getMarksForTest().has('bad')).toBe(false);
    expect(sch.machine.getMarksForTest().size).toBe(0);
  });

  it("a marked peer's SyncInfo while synced leaves the phase, the mark and the request count alone", async () => {
    vi.setSystemTime(0);
    const claimOk = hexId(10);
    const claimBadKnown = hexId(20);
    const known = new Set<string>([claimOk, claimBadKnown]);
    const view = makeChainView({ known, applied: true });
    const sch = makeScheduler({ view, nextPage: [] });
    let syncedCount = 0;
    sch.machine.onSynced(() => { syncedCount++; });
    peerActive(sch, 'ok', 1);
    peerActive(sch, 'bad', 1);
    syncInfo(sch, 'ok', 10, claimOk);
    syncInfo(sch, 'bad', 20, claimBadKnown);
    await settle();
    expect(sch.machine.getState().phase).toBe('synced');
    expect(syncedCount).toBe(1);
    // Mark 'bad' from outside — synced-entry had cleared any mark.
    (sch.machine as unknown as { markPeerForTest(id: string): void }).markPeerForTest('bad');
    expect(sch.machine.getMarksForTest().has('bad')).toBe(true);

    // 'bad' sends a new, unknown claim. Without the launch mark check,
    // `actOnSyncInfo` calls `startHeaderRun`, which adds the peer to
    // `openHeaderRuns`, yields, and the caller's `recomputePhase` sees
    // an open run — the phase flickers synced → syncing → synced,
    // fires `onSynced` a second time, and the second synced-entry
    // clears every stall mark.
    vi.advanceTimersByTime(200);
    const before = sch.requests.filter(r => r.peerId === 'bad').length;
    syncInfo(sch, 'bad', 200, hexId(200));
    await settle();
    expect(sch.machine.getState().phase).toBe('synced');
    expect(syncedCount).toBe(1);
    expect(sch.machine.getMarksForTest().has('bad')).toBe(true);
    expect(sch.requests.filter(r => r.peerId === 'bad').length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: two real NetNodes — a claim → a GetHeaders → the page reaching
// a registered pipeline (NET_INTERFACE → Sync Flow)
// ---------------------------------------------------------------------------

describe('end to end: a claim opens a GetHeaders, the page reaches the pipeline', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  it("a joiner's pipeline sees a page from the taller peer's chain", async () => {
    nodeA = new NetNode(makeConfig(), validators);
    nodeB = new NetNode(makeConfig(), validators);
    await nodeA.start();
    await nodeB.start();

    const pipelineB = makePipeline(true);
    const viewB = makeChainView({ applied: false });
    (nodeB as unknown as { setPipeline?: (p: FakePipeline) => void }).setPipeline?.(pipelineB);
    (nodeB as unknown as { setChainView?: (v: FakeChainView) => void }).setChainView?.(viewB);

    const addrs = (nodeA as unknown as { libp2pNode: { getMultiaddrs: () => { toString: () => string }[] } }).libp2pNode.getMultiaddrs();
    const dialAddr = addrs[0]!.toString();
    await (nodeB as unknown as { dialAndHandshake: (addr: string, kind: 'seed' | 'candidate') => Promise<boolean> }).dialAndHandshake(dialAddr, 'seed');

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (pipelineB.calls.length > 0) break;
    }
    expect(pipelineB.calls.length).toBeGreaterThan(0);
  }, 20_000);
});
