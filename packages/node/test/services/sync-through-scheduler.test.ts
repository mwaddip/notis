import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { GENESIS_PREV_BLOCK_HASH, updateInterlinks } from '@dagsocial/types';
import { blockHash, level, cumulativeWork } from '@dagsocial/validation';
import { MAX_CHAIN_RESPONSE_ITEMS } from '@dagsocial/net';

import { closeDb, getDb, initDb } from '../../src/store/db.js';
import {
  getBestTip,
  getBestHashAt,
  getCurrentHeight,
  getHeaderRow,
} from '../../src/store/index.js';
import { resetPipelineForTests } from '../../src/services/header-pipeline.js';
import { resetIntakeForTests } from '../../src/services/intake.js';
import { wireNet } from '../../src/services/net-wiring.js';
import { setClock } from '../../src/services/difficulty.js';
import { config } from '../../src/config.js';

import { defaultParams, makeHeader, type ParentHeaderInfo } from '../helpers/make-header.js';
import { makeApplicableBlock } from '../helpers.js';

// NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
// at a time" and NET_INTERFACE → Sync State Machine → "One header request per
// peer, every peer at once." A sync through the scheduler's loop end to end,
// through the node's real entries: `wireNet` hands the fake net the intake's
// `deliverHeaders` / `deliverBlocks` and the chain view's `locatorFor` /
// `knowsTip` / `wantedBlocks` / `fullyApplied` / `gateHeld`, and this file
// drives them.

const PARAMS = defaultParams({
  anchorBits: config.orderingBlockPowTargetBits,
  floorBits: config.orderingBlockPowTargetFloorBits,
  ceilingBits: config.orderingBlockPowTargetCeilingBits,
  idealMs: config.orderingBlockIdealMs,
});
const SCHEDULE = config.protocolVersionSchedule;
const T_ANCHOR = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Captured net surface — NODE_INTERFACE → Sync handlers (pull-path) →
// "setPipeline(intake)" / "setChainView(view)".
// ---------------------------------------------------------------------------

interface Captured {
  pipeline: {
    deliverHeaders?: (peerId: string, claimHash: string, headers: BlockHeader[]) => Promise<'taken' | 'again' | 'refused'>;
    deliverBlocks?: (peerId: string, blocks: OrderingBlock[]) => Promise<void>;
  };
  chainView: {
    locatorFor?: (peerId: string) => string[];
    knowsTip?: (peerId: string, hash: string) => boolean;
    wantedBlocks?: () => { id: string; height: number }[];
    fullyApplied?: () => boolean;
    gateHeld?: () => void;
  };
  penalties: Array<{ peerId: string; kind: 'misbehavior' | 'transient'; reason: string }>;
  chainMoved: number;
  needHeaders: string[];
}

function freshCap(): Captured {
  return { pipeline: {}, chainView: {}, penalties: [], chainMoved: 0, needHeaders: [] };
}

function makeFakeNet(cap: Captured): unknown {
  return {
    setPipeline: (intake: Captured['pipeline']) => { cap.pipeline = intake; },
    setChainView: (view: Captured['chainView']) => { cap.chainView = view; },
    onOrderingBlock: () => {},
    onPeerActive: () => {},
    onPeerDisconnected: () => {},
    onPeerPenalised: () => {},
    onSyncComplete: () => {},
    setHeadersHandler: () => {},
    setHeaderProvider: () => {},
    setScheduledTargetProvider: () => {},
    setChainHeightProvider: () => {},
    setBlockIdProvider: () => {},
    setHeightByBlockIdProvider: () => {},
    setHeaderStandingProvider: () => {},
    setPostBodyProvider: () => {},
    setKarmaMembers: () => {},
    penalizePeer: (peerId: string, kind: 'misbehavior' | 'transient', reason: string) => {
      cap.penalties.push({ peerId, kind, reason });
    },
    chainMoved: () => { cap.chainMoved += 1; },
    needHeaders: (peerId: string) => { cap.needHeaders.push(peerId); },
    requestPostBodies: async () => [],
    getConnectedPeers: () => [],
    broadcastOrderingBlock: async () => {},
    broadcastTx: async () => {},
    tipApplied: () => {},
    addKarmaMember: () => {},
    removeKarmaMember: () => {},
  };
}

// ---------------------------------------------------------------------------
// FakeServer — one per peer. Serves headers by locator exactly as the serve
// rule states (NET_INTERFACE → `GetHeaders` / `GetBlocks` responses →
// "A `Headers` page has one shape, and a requester holds a page to it"): the
// first locator entry its chain holds → the headers above it, up to 400 or
// its tip; no entry held → from height 1; its tip → an empty page.
// ---------------------------------------------------------------------------

interface FakeServer {
  headers: BlockHeader[];
  hashes: string[];
  blocks: Map<string, OrderingBlock>;
  claimHash: string;
  claimHeight: number;
  requests: number;
  /** Grow the chain between pages — mutated after each request. */
  tipGrow?: (() => void);
  /** Swap the chain the server holds — fires once between page N and N+1. */
  swapAt?: { page: number; newHeaders: BlockHeader[] };
}

function hashOf(h: BlockHeader): string {
  const x = blockHash(h);
  if (x === null) throw new Error('hashOf: unhashable header');
  return x;
}

function newServer(headers: BlockHeader[], blocks: OrderingBlock[], claim: { hash: string; height: number }): FakeServer {
  const hashes = headers.map(hashOf);
  const blockMap = new Map<string, OrderingBlock>();
  for (const b of blocks) blockMap.set(hashOf(b.header), b);
  return { headers, hashes, blocks: blockMap, claimHash: claim.hash, claimHeight: claim.height, requests: 0 };
}

function serveHeaders(server: FakeServer, locator: string[]): BlockHeader[] {
  server.requests += 1;
  for (const h of locator) {
    const i = server.hashes.indexOf(h);
    if (i >= 0) {
      const start = i + 1;
      return server.headers.slice(start, start + MAX_CHAIN_RESPONSE_ITEMS);
    }
  }
  return server.headers.slice(0, MAX_CHAIN_RESPONSE_ITEMS);
}

function serveBlocks(server: FakeServer, ids: string[]): OrderingBlock[] {
  const out: OrderingBlock[] = [];
  for (const id of ids) {
    const b = server.blocks.get(id);
    if (b !== undefined) out.push(b);
  }
  return out;
}

interface Refute { peerId: string; reason: string }

// ---------------------------------------------------------------------------
// The scheduler loop (NET_INTERFACE → Sync State Machine → "One header
// request per peer, every peer at once." + the block pump). Returns the
// refutes recorded.
// ---------------------------------------------------------------------------

async function runHeaderRun(peerId: string, server: FakeServer, cap: Captured, refutes: Refute[]): Promise<void> {
  // NET_INTERFACE → Sync State Machine — a settled claim opens no header run;
  // `knowsTip` is the chain view's answer and the gate reads it.
  if (server.claimHash !== '' && cap.chainView.knowsTip!(peerId, server.claimHash)) return;
  let pagesServed = 0;
  for (;;) {
    // The claim the request was asked under is what the refute test reads
    // (NET_INTERFACE → Sync State Machine → "How a header sync ends"). A
    // claim replaced between request and delivery leaves the next page to
    // continue against the new one — the server's `tipGrow` fires between
    // pages, moving its claim; the loop keeps the pre-request claim here
    // and compares.
    const claimAtRequest = server.claimHash;
    const locator = cap.chainView.locatorFor!(peerId);
    if (server.tipGrow !== undefined && server.requests > 0) server.tipGrow();
    if (server.swapAt !== undefined && pagesServed === server.swapAt.page) {
      server.headers = server.swapAt.newHeaders;
      server.hashes = server.headers.map(hashOf);
      server.swapAt = undefined;
    }
    const page = serveHeaders(server, locator);
    pagesServed += 1;
    const outcome = await cap.pipeline.deliverHeaders!(peerId, server.claimHash, page);
    if (outcome === 'refused') return;
    if (outcome === 'again') continue;
    // outcome === 'taken'
    if (server.claimHash === '') return;
    if (cap.chainView.knowsTip!(peerId, server.claimHash)) return;
    // A claim replaced between request and delivery leaves the loop to
    // continue against the new one — the refute test reads the request-time
    // claim.
    if (server.claimHash !== claimAtRequest) continue;
    // NET_INTERFACE → Sync State Machine → "How a header sync ends": a short
    // page, or a page reaching the claimed height, with the claim unknown —
    // the peer is refuted.
    const reachedClaim = page.length > 0 && page[page.length - 1]!.height >= server.claimHeight;
    if (page.length < MAX_CHAIN_RESPONSE_ITEMS || reachedClaim) {
      refutes.push({ peerId, reason: 'headers page refutes the claim' });
      return;
    }
    // A full page under the claimed height — the loop asks again.
  }
}

async function runBlockPump(peers: Map<string, FakeServer>, cap: Captured): Promise<boolean> {
  let moved = false;
  for (let round = 0; round < 10_000; round++) {
    const wanted = cap.chainView.wantedBlocks!();
    if (wanted.length === 0) break;
    const wantedIds = new Set(wanted.map((w) => w.id));
    let roundMoved = false;
    for (const [peerId, server] of peers) {
      if (server.claimHash === '' || !cap.chainView.knowsTip!(peerId, server.claimHash)) continue;
      const ids: string[] = [];
      for (const w of wanted) {
        if (w.height > server.claimHeight) continue;
        if (!wantedIds.has(w.id)) continue;
        ids.push(w.id);
        if (ids.length >= MAX_CHAIN_RESPONSE_ITEMS) break;
      }
      if (ids.length === 0) continue;
      const blocks = serveBlocks(server, ids);
      if (blocks.length === 0) continue;
      await cap.pipeline.deliverBlocks!(peerId, blocks);
      roundMoved = true;
    }
    if (!roundMoved) break;
    moved = true;
  }
  return moved;
}

async function runSyncLoop(
  peers: Map<string, FakeServer>,
  cap: Captured,
  opts: { driveBlocks: boolean } = { driveBlocks: true },
): Promise<Refute[]> {
  const refutes: Refute[] = [];
  for (let outer = 0; outer < 200; outer++) {
    let worked = false;
    for (const [peerId, server] of peers) {
      const before = server.requests;
      await runHeaderRun(peerId, server, cap, refutes);
      if (server.requests > before) worked = true;
    }
    cap.chainView.gateHeld!();
    if (opts.driveBlocks) {
      const did = await runBlockPump(peers, cap);
      if (did) worked = true;
    }
    if (!worked) break;
  }
  return refutes;
}

// ---------------------------------------------------------------------------
// Chain builders — only headers (no bodies). The pipeline reads
// `retargetParams()` from the node's config, so headers are built against the
// same parameters the pipeline will verify them under.
// ---------------------------------------------------------------------------

function buildHeaderChain(opts: {
  parent: ParentHeaderInfo | null;
  n: number;
  startAt?: number;
  bitsOverride?: (height: number) => number | undefined;
  createdAtFor?: (height: number, prevCreatedAt: number) => number;
}): ParentHeaderInfo[] {
  const out: ParentHeaderInfo[] = [];
  let prev = opts.parent;
  const startAt = opts.startAt ?? (opts.parent ? opts.parent.header.createdAt + PARAMS.idealMs : T_ANCHOR);
  for (let i = 0; i < opts.n; i++) {
    const height = (prev ? prev.header.height : 0) + 1;
    const createdAt = opts.createdAtFor
      ? opts.createdAtFor(height, prev ? prev.header.createdAt : startAt - PARAMS.idealMs)
      : (i === 0 ? startAt : prev!.header.createdAt + PARAMS.idealMs);
    const row = makeHeader({
      height,
      parent: prev,
      params: PARAMS,
      schedule: SCHEDULE,
      createdAt,
      powTargetBits: opts.bitsOverride?.(height),
    });
    out.push(row);
    prev = row;
  }
  return out;
}

/**
 * The lag the schedule needs to clamp a header to the floor from `anchorBits`:
 * `(anchorBits − floorBits) × halflifeMs / 256`, floored, with one idealMs
 * padding so the integer division cannot leave `q` one short of the clamp
 * (MINING_INTERFACE → Difficulty Schedule).
 */
const FLOOR_LAG_MS = Math.ceil(((PARAMS.anchorBits - PARAMS.floorBits) * PARAMS.halflifeMs) / 256) + PARAMS.idealMs;

/**
 * Build a chain of `n` headers whose first header is anchor-priced and every
 * header above the second is floor-priced — the lag row's `createdAt` lifts
 * the schedule's `delta` to `FLOOR_LAG_MS`, which is enough to drive
 * `asertTargetBits` below the floor so the clamp fires (MINING_INTERFACE →
 * Difficulty Schedule; `slow/pass-1-at-floor-difficulty-bound.test.ts`
 * applies the same cadence over a stored base). Interlinks are precomputed
 * through `updateInterlinks` so a parent whose `level` is `null` passes the
 * vector through, instead of `makeHeader`'s own `level`-reading path.
 */
function buildFloorPricedBranch(opts: {
  base: ParentHeaderInfo | null;
  n: number;
  startAt?: number;
}): ParentHeaderInfo[] {
  const out: ParentHeaderInfo[] = [];
  let prev = opts.base;
  const branchStart = opts.startAt
    ?? (opts.base ? opts.base.header.createdAt + FLOOR_LAG_MS : T_ANCHOR);
  let expected: string[] = opts.base === null
    ? []
    : updateInterlinks(opts.base.interlinks, opts.base.hash, level(opts.base.header, PARAMS.anchorBits));
  const basePresent = opts.base !== null;
  for (let i = 0; i < opts.n; i++) {
    const height = (prev ? prev.header.height : 0) + 1;
    // The lag the schedule reads lives on the row whose `delta` becomes the
    // floor-triggering size at its CHILD: over a stored base that row is the
    // branch's first header (`i === 0`), from the virtual root it is the
    // chain's second header (`i === 1`, the first header is at anchor by
    // schedule). Heights above the lag row inherit the same delta — the
    // schedule reads `parent.createdAt − anchor − idealMs × (parent.height −
    // 1)`, and parent timing moves one idealMs per height after the lag.
    let createdAt: number;
    if (basePresent && i === 0) {
      createdAt = prev!.header.createdAt + FLOOR_LAG_MS;
    } else if (!basePresent && i === 0) {
      createdAt = branchStart;
    } else if (!basePresent && i === 1) {
      createdAt = prev!.header.createdAt + FLOOR_LAG_MS;
    } else {
      createdAt = prev!.header.createdAt + PARAMS.idealMs;
    }
    const row = makeHeader({
      height,
      parent: prev,
      params: PARAMS,
      schedule: SCHEDULE,
      createdAt,
      interlinks: expected,
    });
    out.push(row);
    expected = updateInterlinks(expected, row.hash, level(row.header, PARAMS.anchorBits));
    prev = row;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The eight scenarios.
// ---------------------------------------------------------------------------

describe('a sync through the scheduler', () => {
  beforeEach(() => {
    initDb(':memory:');
    // Seed the network record so a block application that reads it has an
    // answer — `network_record` is the row every pre-body membership read
    // names.
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    resetPipelineForTests();
    resetIntakeForTests();
    // Pin the clock inside drift so verifyHeaderChain's clock bound reads
    // the test's own timeline (NODE_INTERFACE → Difficulty schedule).
    setClock(() => T_ANCHOR + 4_000 * PARAMS.idealMs);
  });
  afterEach(() => {
    setClock(null);
    closeDb();
  });

  it(
    'a joiner from empty syncs a chain of more than two pages to its claim — every header stored, the applied tip at the claim, no penalty, no refute',
    async () => {
      // The chain spans three pages at `MAX_CHAIN_RESPONSE_ITEMS = 400`:
      // 801 real applicable blocks mined into this store, pulled back out as
      // JS objects, the store wiped, and then handed back to the pipeline
      // through the fake net's `deliverHeaders` / `deliverBlocks`.
      const N = 2 * MAX_CHAIN_RESPONSE_ITEMS + 1;
      const headers: BlockHeader[] = [];
      const blocks: OrderingBlock[] = [];
      // Wire the intake once with a stub net so applies land through the
      // pipeline's intake; each `wireIntakeForTests` call resets the window
      // hold, so the loop wires once and holds the gate per block.
      const { wireIntakeForTests } = await import('../helpers.js');
      await wireIntakeForTests();
      const intake = await import('../../src/services/intake.js');
      for (let h = 1; h <= N; h++) {
        intake.gateHeld();
        const block = await makeApplicableBlock({ height: h });
        const verdict = intake.deliverMinedBlock(block);
        expect(verdict.applied).toBe(true);
        headers.push(block.header);
        blocks.push(block);
      }
      const claimHeight = N;
      const claimHash = hashOf(headers[N - 1]!);

      // Wipe the store and the pipeline, wire the fake net.
      closeDb();
      initDb(':memory:');
      getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
      resetPipelineForTests();
      resetIntakeForTests();
      const cap = freshCap();
      wireNet(makeFakeNet(cap) as never);

      const server = newServer(headers, blocks, { hash: claimHash, height: claimHeight });
      const peers = new Map<string, FakeServer>([['peerA', server]]);
      const refutes = await runSyncLoop(peers, cap);

      expect(cap.penalties).toEqual([]);
      expect(refutes).toEqual([]);
      for (let h = 1; h <= N; h++) {
        expect(getBestHashAt(h)).toBe(hashOf(headers[h - 1]!));
        expect(getHeaderRow(hashOf(headers[h - 1]!))).not.toBeNull();
      }
      expect(getBestTip()!.hash).toBe(claimHash);
      // The last assertion names the rule: a joiner from empty syncs a chain
      // of more than two pages to its claim, every header stored, the applied
      // tip at the claim.
      expect(getCurrentHeight()).toBe(claimHeight);
    },
    30 * 60 * 1000,
  );

  it('a peer at height 0 (claim: the root) — knowsTip answers true, no request goes to it', async () => {
    const cap = freshCap();
    wireNet(makeFakeNet(cap) as never);
    const server = newServer([], [], { hash: GENESIS_PREV_BLOCK_HASH, height: 0 });
    const peers = new Map<string, FakeServer>([['peerZero', server]]);

    // The gate reads `knowsTip` first (NET_INTERFACE → Sync Handler
    // Registration — the chain view knows the root): the root is known for
    // every peer, so no header request opens.
    expect(cap.chainView.knowsTip!('peerZero', GENESIS_PREV_BLOCK_HASH)).toBe(true);
    const refutes = await runSyncLoop(peers, cap);

    expect(cap.penalties).toEqual([]);
    expect(refutes).toEqual([]);
    expect(getBestTip()).toBeNull();
    expect(getCurrentHeight()).toBe(0);
    // The last assertion names the rule: no request went to the height-0
    // peer because the chain view already answered its claim.
    expect(server.requests).toBe(0);
  });

  it(
    'a synced node meets a heavier branch forking inside the horizon, won on a later page — pass 1, again, pass 2, the switch at the crossing, best chain on the branch',
    async () => {
      // Node holds a main chain of 51 anchor-priced headers populated through
      // the scheduler's own entries from peerA. Pass 1 of peerB's floor-
      // priced branch does not win on page 1 (400 floor × ≈ 51 × 1
      // anchor-work on the band is below the ratio); page 2 wins, the
      // scheduler re-asks from the base, pass 2 stores and the switch
      // rewrites `best_chain`.
      const cap = freshCap();
      wireNet(makeFakeNet(cap) as never);

      const MAIN = 52;
      const main = buildHeaderChain({ parent: null, n: MAIN });
      const mainClaim = { hash: main[main.length - 1]!.hash, height: MAIN };
      const peerA = newServer(main.map((p) => p.header), [], mainClaim);

      // Sync peerA through the scheduler's entries so main sits in the tree.
      let refutes = await runSyncLoop(new Map([['peerA', peerA]]), cap, { driveBlocks: false });
      expect(refutes).toEqual([]);
      expect(getBestTip()!.height).toBe(MAIN);
      const mainWork = getBestTip()!.chainWork;

      // A floor-priced side branch from the virtual root — 801 headers to
      // span three pages at the full-page size.
      const branchLen = 801;
      const branch = buildFloorPricedBranch({ base: null, n: branchLen, startAt: T_ANCHOR + 1 });
      // Sanity: every header above the first is at the floor.
      for (let i = 2; i < branch.length; i++) {
        expect(branch[i]!.header.powTargetBits).toBe(PARAMS.floorBits);
      }

      // Measure the two chains' work in the case.
      const branchWorkAfterPage1 = cumulativeWork(branch.slice(0, MAX_CHAIN_RESPONSE_ITEMS).map((p) => p.header));
      const branchWorkAfterPage2 = cumulativeWork(branch.slice(0, 2 * MAX_CHAIN_RESPONSE_ITEMS).map((p) => p.header));
      expect(branchWorkAfterPage1).toBeLessThan(mainWork);
      expect(branchWorkAfterPage2).toBeGreaterThan(mainWork);

      const branchClaim = { hash: branch[branch.length - 1]!.hash, height: branchLen };
      const peerB = newServer(branch.map((p) => p.header), [], branchClaim);
      refutes = await runSyncLoop(new Map([['peerB', peerB]]), cap, { driveBlocks: false });

      expect(cap.penalties).toEqual([]);
      expect(refutes).toEqual([]);
      // The last assertion names the rule: the switch wrote `best_chain` to
      // the branch's tip, with the branch's path above the virtual root in
      // place of main's.
      expect(getBestTip()!.hash).toBe(branch[branch.length - 1]!.hash);
      expect(getBestHashAt(1)).toBe(branch[0]!.hash);
      expect(getBestHashAt(branchLen)).toBe(branch[branch.length - 1]!.hash);
    },
    120_000,
  );

  it('a joiner holding a taller, lighter chain from the root meets a shorter, heavier one from the root — it ends on the heavier', async () => {
    // Taller chain: 1 anchor header + 19 floor-priced headers above it.
    // Shorter chain: 5 anchor-priced headers.
    // anchor_work = 2^12 = 4096; floor_work = 2^9 = 512 (ratio 8).
    // Taller work = 4096 + 19 × 512 = 13824; shorter work = 5 × 4096 = 20480.
    const cap = freshCap();
    wireNet(makeFakeNet(cap) as never);

    const tallerLen = 20;
    const taller = buildFloorPricedBranch({ base: null, n: tallerLen, startAt: T_ANCHOR + 7 });
    // Sanity: taller is floor-priced from height 3 upward.
    for (let i = 2; i < taller.length; i++) {
      expect(taller[i]!.header.powTargetBits).toBe(PARAMS.floorBits);
    }

    const shorterLen = 5;
    const shorter = buildHeaderChain({ parent: null, n: shorterLen, startAt: T_ANCHOR + 11 });

    const tallerWork = cumulativeWork(taller.map((p) => p.header));
    const shorterWork = cumulativeWork(shorter.map((p) => p.header));
    expect(tallerWork).toBeLessThan(shorterWork);

    // Sync the taller lighter chain first so the node holds it as its best.
    const peerT = newServer(
      taller.map((p) => p.header),
      [],
      { hash: taller[taller.length - 1]!.hash, height: tallerLen },
    );
    let refutes = await runSyncLoop(new Map([['peerT', peerT]]), cap, { driveBlocks: false });
    expect(refutes).toEqual([]);
    expect(getBestTip()!.hash).toBe(taller[taller.length - 1]!.hash);
    expect(getBestTip()!.chainWork).toBe(tallerWork);

    // Peer S offers the shorter heavier chain; the switch moves the best to it.
    const peerS = newServer(
      shorter.map((p) => p.header),
      [],
      { hash: shorter[shorter.length - 1]!.hash, height: shorterLen },
    );
    refutes = await runSyncLoop(new Map([['peerS', peerS]]), cap, { driveBlocks: false });

    expect(cap.penalties).toEqual([]);
    expect(refutes).toEqual([]);
    // The last assertion names the rule: the heavier of two chains from the
    // root wins, taller or not.
    expect(getBestTip()!.hash).toBe(shorter[shorter.length - 1]!.hash);
  });

  it('a peer on a lighter side branch whose served chain runs past its claim — the memo answers knowsTip, no penalty, no refute', async () => {
    // Node holds a 20-anchor main; the peer's lighter branch is 30 floor-
    // priced headers from the virtual root, claim at height 10 and tip at
    // height 30 — the peer's tip grew past its claim. Pass 1 scores and the
    // claim is in the page's hashes — the memo records it.
    const cap = freshCap();
    wireNet(makeFakeNet(cap) as never);

    const main = buildHeaderChain({ parent: null, n: 20 });
    const peerA = newServer(
      main.map((p) => p.header),
      [],
      { hash: main[main.length - 1]!.hash, height: 20 },
    );
    let refutes = await runSyncLoop(new Map([['peerA', peerA]]), cap, { driveBlocks: false });
    expect(refutes).toEqual([]);
    expect(getBestTip()!.height).toBe(20);
    const mainWork = getBestTip()!.chainWork;

    // Lighter branch: 30 floor-priced headers from the root.
    const branchLen = 30;
    const branch = buildFloorPricedBranch({ base: null, n: branchLen, startAt: T_ANCHOR + 3 });
    const branchWork = cumulativeWork(branch.map((p) => p.header));
    expect(branchWork).toBeLessThan(mainWork);

    const claimHeight = 10;
    const claimHash = branch[claimHeight - 1]!.hash;
    const peerB = newServer(
      branch.map((p) => p.header),
      [],
      { hash: claimHash, height: claimHeight },
    );
    refutes = await runSyncLoop(new Map([['peerB', peerB]]), cap, { driveBlocks: false });

    expect(cap.penalties).toEqual([]);
    expect(refutes).toEqual([]);
    expect(getBestTip()!.hash).toBe(main[main.length - 1]!.hash);
    // The last assertion names the rule: the memo answers `knowsTip` for the
    // claim of a lighter branch whose served chain ran past it, with no
    // penalty and no refute.
    expect(cap.chainView.knowsTip!('peerB', claimHash)).toBe(true);
  });

  it('a peer whose tip grows between two pages of one branch — the branch continues, no penalty', async () => {
    // Node holds a 60-anchor main. The peer's branch is 10 floor-priced
    // headers at page 1; between pages the branch grows to 15 — the second
    // page extends the same scoring run.
    const cap = freshCap();
    wireNet(makeFakeNet(cap) as never);

    const main = buildHeaderChain({ parent: null, n: 60 });
    const peerA = newServer(
      main.map((p) => p.header),
      [],
      { hash: main[main.length - 1]!.hash, height: 60 },
    );
    let refutes = await runSyncLoop(new Map([['peerA', peerA]]), cap, { driveBlocks: false });
    expect(refutes).toEqual([]);
    expect(getBestTip()!.height).toBe(60);

    const branchFirst = 10;
    const branchGrownTo = 15;
    const branch = buildFloorPricedBranch({ base: null, n: branchGrownTo, startAt: T_ANCHOR + 5 });

    // The server initially holds `branchFirst` headers with a claim at
    // that tip; after the first request its tip grows to `branchGrownTo`,
    // and its SyncInfo claim moves with it (NET_INTERFACE → Serve Side).
    const initialHeaders = branch.slice(0, branchFirst).map((p) => p.header);
    const grownHeaders = branch.slice(0, branchGrownTo).map((p) => p.header);
    const peerB = newServer(initialHeaders, [], {
      hash: branch[branchFirst - 1]!.hash,
      height: branchFirst,
    });
    let served = 0;
    peerB.tipGrow = () => {
      served += 1;
      if (served === 1) {
        peerB.headers = grownHeaders;
        peerB.hashes = peerB.headers.map(hashOf);
        peerB.claimHash = branch[branchGrownTo - 1]!.hash;
        peerB.claimHeight = branchGrownTo;
      }
    };
    refutes = await runSyncLoop(new Map([['peerB', peerB]]), cap, { driveBlocks: false });

    expect(cap.penalties).toEqual([]);
    expect(refutes).toEqual([]);
    expect(getBestTip()!.hash).toBe(main[main.length - 1]!.hash);
    // The last assertion names the rule: the branch continues across the
    // tip-growth boundary — no second running branch opens.
    expect(cap.chainView.knowsTip!('peerB', peerB.claimHash)).toBe(true);
  });

  it('pass 2 served a different branch than pass 1 scored — transient, nothing further stored, best unchanged', async () => {
    // Node holds a 52-anchor main. Pass 1 scores an 801 floor-priced branch
    // X across two pages (won on page 2 → `again`). Pass 2's first page is
    // a different branch Y with the same base at the virtual root — Y's
    // hash at height 400 differs from X's recorded one, so pass 2 refuses
    // transient and nothing further is stored.
    const cap = freshCap();
    wireNet(makeFakeNet(cap) as never);

    const mainN = 52;
    const main = buildHeaderChain({ parent: null, n: mainN });
    const peerA = newServer(
      main.map((p) => p.header),
      [],
      { hash: main[main.length - 1]!.hash, height: mainN },
    );
    let refutes = await runSyncLoop(new Map([['peerA', peerA]]), cap, { driveBlocks: false });
    expect(refutes).toEqual([]);
    const mainTipHash = main[main.length - 1]!.hash;
    const mainWork = getBestTip()!.chainWork;

    // Branch X: 801 floor-priced headers from the virtual root.
    const branchLen = 801;
    const branchX = buildFloorPricedBranch({ base: null, n: branchLen, startAt: T_ANCHOR + 1 });
    expect(cumulativeWork(branchX.slice(0, MAX_CHAIN_RESPONSE_ITEMS).map((p) => p.header))).toBeLessThan(mainWork);
    expect(cumulativeWork(branchX.slice(0, 2 * MAX_CHAIN_RESPONSE_ITEMS).map((p) => p.header))).toBeGreaterThan(mainWork);

    // Branch Y: 400 floor-priced headers from the virtual root, with a
    // different `createdAt` seed so every hash differs from X.
    const branchY = buildFloorPricedBranch({ base: null, n: MAX_CHAIN_RESPONSE_ITEMS, startAt: T_ANCHOR + 99 });
    expect(branchY[MAX_CHAIN_RESPONSE_ITEMS - 1]!.hash).not.toBe(branchX[MAX_CHAIN_RESPONSE_ITEMS - 1]!.hash);

    const claim = { hash: branchX[branchX.length - 1]!.hash, height: branchLen };
    const peerB = newServer(branchX.map((p) => p.header), [], claim);
    // On page 2 (after the pass-1 win), swap to branch Y for pass 2 iter 1.
    peerB.swapAt = { page: 2, newHeaders: branchY.map((p) => p.header) };
    refutes = await runSyncLoop(new Map([['peerB', peerB]]), cap, { driveBlocks: false });

    const transients = cap.penalties.filter((p) => p.peerId === 'peerB' && p.kind === 'transient');
    expect(transients.length).toBeGreaterThan(0);
    expect(getBestTip()!.hash).toBe(mainTipHash);
    // The last assertion names the rule: Y[400] was never written as a
    // stored row — pass 2's recorded-hash mismatch refused the whole page
    // ahead of the store loop.
    expect(getHeaderRow(branchY[MAX_CHAIN_RESPONSE_ITEMS - 1]!.hash)).toBeNull();
  });

  it('a page from height 1 on a node whose reach floor is above 0 — refused at admission, no penalty, nothing scored', async () => {
    // The reach floor rises above 0 once the applied tip clears
    // `maxReorgDepth` with the journal still naming heights above 1.
    // 41 real applied blocks give applied tip 41 and floor
    // max(41 − 40, lowest − 1) ≥ 1, so a page from height 1 is refused.
    const MIN_APPLIED = config.maxReorgDepth + 1;
    // Wire the intake once with a stub net so applies land through the
    // pipeline's intake (NODE_INTERFACE → Fork choice decides on verified
    // headers → "One intake, one at a time"). Each `wireIntakeForTests`
    // resets the window hold, so the loop wires once and holds the gate
    // per block.
    const { wireIntakeForTests } = await import('../helpers.js');
    await wireIntakeForTests();
    const intake = await import('../../src/services/intake.js');
    for (let h = 1; h <= MIN_APPLIED; h++) {
      intake.gateHeld();
      const block = await makeApplicableBlock({ height: h });
      const verdict = intake.deliverMinedBlock(block);
      expect(verdict.applied).toBe(true);
    }
    expect(getCurrentHeight()).toBe(MIN_APPLIED);

    // Reset the pipeline alone — the applied chain and its journal stay in
    // the store. Wire the fake net over them.
    resetPipelineForTests();
    resetIntakeForTests();
    const cap = freshCap();
    wireNet(makeFakeNet(cap) as never);

    // The peer serves a chain from height 1 that shares no hash with the
    // applied chain — no running branch, `locatorFor` leads with the best
    // chain alone, and the first fresh header's base is the virtual root.
    const foreign = buildHeaderChain({ parent: null, n: 10, startAt: T_ANCHOR + 3_000_000 });
    const claim = { hash: foreign[foreign.length - 1]!.hash, height: 10 };
    const peerF = newServer(foreign.map((p) => p.header), [], claim);
    const refutes = await runSyncLoop(new Map([['peerF', peerF]]), cap, { driveBlocks: false });

    expect(cap.penalties).toEqual([]);
    expect(refutes).toEqual([]);
    // The best chain stays on the applied chain's tip — nothing of the
    // foreign chain was stored or scored.
    expect(getBestTip()!.height).toBe(MIN_APPLIED);
    for (const row of foreign) {
      expect(getHeaderRow(row.hash)).toBeNull();
    }
    // The last assertion names the rule: an age-rule refusal of a page
    // leaves no penalty.
    const peerFPenalties = cap.penalties.filter((p) => p.peerId === 'peerF');
    expect(peerFPenalties).toEqual([]);
  }, 120_000);
});
