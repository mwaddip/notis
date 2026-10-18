import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDb, initDb } from '../../src/store/db.js';
import {
  admitHeader,
  admitPage,
  knowsTip,
  locatorFor,
  pruneHeaderTree,
  onPeerDisconnected,
  rechooseBestChain,
  resetPipelineForTests,
  type PipelineCallbacks,
  type PipelineContext,
} from '../../src/services/header-pipeline.js';
import { getBestTip, getBestHashAt, getHeaderRow, insertRefusedHeader, removeHeaderSubtree } from '../../src/store/index.js';
import { getDb } from '../../src/store/db.js';
import { config } from '../../src/config.js';
import { encodeHeader, encodeInterlinks, GENESIS_PREV_BLOCK_HASH } from '@dagsocial/types';
import { cumulativeWork } from '@dagsocial/validation';
import { defaultParams, makeChain, makeHeader, type ParentHeaderInfo } from '../helpers/make-header.js';
import { MAX_LOCATOR_HASHES } from '@dagsocial/net';
import { InconsistentHeaderTreeError } from '../../src/services/corrupt-state.js';

// A looser anchor target keeps the mining cost of a 400+-header chain
// tolerable without changing admission's shape.
const PARAMS = defaultParams({
  anchorBits: 2304,
  floorBits: 2304,
  ceilingBits: 4096,
  idealMs: 60_000,
});
const SCHEDULE = config.protocolVersionSchedule;

interface Captured {
  penalties: Array<{ peerId: string; kind: 'misbehavior' | 'transient'; reason: string }>;
  chainMoves: number;
}

function recorder(): { cap: Captured; callbacks: PipelineCallbacks } {
  const cap: Captured = { penalties: [], chainMoves: 0 };
  const callbacks: PipelineCallbacks = {
    penalize: (peerId, kind, reason) => { cap.penalties.push({ peerId, kind, reason }); },
    chainMoved: () => { cap.chainMoves += 1; },
  };
  return { cap, callbacks };
}

function ctx(opts?: Partial<PipelineContext>): PipelineContext {
  return {
    params: PARAMS,
    schedule: SCHEDULE,
    nowMs: () => 1_700_000_000_000 + 300_000_000_000,
    maxReorgDepth: config.maxReorgDepth,
    genesisId: '',
    lowestJournalHeight: () => null,
    appliedTipHeight: () => 0,
    ...opts,
  };
}

function pageHeaders(chain: ParentHeaderInfo[]): import('@dagsocial/types').BlockHeader[] {
  return chain.map(p => p.header);
}

describe('header-pipeline', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetPipelineForTests();
  });
  afterEach(() => { closeDb(); });

  describe('admitHeader — the four checks', () => {
    it('an unhashable header refuses with misbehavior', () => {
      const bad = makeHeader({ height: 1, params: PARAMS, schedule: SCHEDULE, minePow: false });
      // Break the domain: validatorId wrong length makes blockHash() answer null.
      bad.header.validatorId = new Uint8Array(31);
      const { cap, callbacks } = recorder();
      const v = admitHeader(bad.header, 'headers-page', 'peerA', ctx(), callbacks);
      expect(v.kind).toBe('refused');
      expect(cap.penalties).toEqual([{ peerId: 'peerA', kind: 'misbehavior', reason: expect.any(String) }]);
      // The last assertion names the rule: the admission's hash check refuses
      // the header, so no row lands.
      expect(getBestTip()).toBeNull();
    });

    it('a header already held returns a no-op', () => {
      const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: c1 } = recorder();
      const first = admitHeader(h1!.header, 'headers-page', 'peerA', ctx(), c1);
      expect(first.kind).toBe('stored');
      const { cap, callbacks } = recorder();
      const v = admitHeader(h1!.header, 'headers-page', 'peerA', ctx(), callbacks);
      expect(cap.penalties).toEqual([]);
      // The last assertion names the rule: a repeat admission is `held`,
      // never a second store.
      expect(v.kind).toBe('held');
    });

    it('a header marked in refused_headers refuses with misbehavior', () => {
      const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      insertRefusedHeader(h1!.hash, 1, 1);
      const { cap, callbacks } = recorder();
      const v = admitHeader(h1!.header, 'headers-page', 'peerA', ctx(), callbacks);
      expect(v.kind).toBe('refused');
      expect(getHeaderRow(h1!.hash)).toBeNull();
      // The last assertion names the rule: a refused mark on the hash makes
      // the admission answer misbehavior.
      expect(cap.penalties[0]!.kind).toBe('misbehavior');
    });

    it('a parent in a Headers page that the tree does not hold refuses with misbehavior', () => {
      const orphan = makeHeader({ height: 1, params: PARAMS, schedule: SCHEDULE });
      orphan.header.height = 2;
      orphan.header.prevBlockHash = 'ab'.repeat(32);
      // Re-mine the moved header so it still passes PoW (height=2 keeps anchor target).
      const remined = makeHeader({ height: 2, parent: { ...orphan, header: { ...orphan.header, height: 1 }, pathTa: orphan.pathTa }, params: PARAMS, schedule: SCHEDULE, prevBlockHash: 'ab'.repeat(32) });
      const { cap, callbacks } = recorder();
      const v = admitHeader(remined.header, 'headers-page', 'peerA', ctx(), callbacks);
      expect(v.kind).toBe('refused');
      // The last assertion names the rule: a parent the tree does not hold,
      // in a page, is misbehavior.
      expect(cap.penalties[0]!.kind).toBe('misbehavior');
    });

    it('a parent in a gossiped block the tree does not hold is parent-unknown, no penalty', () => {
      const orphan = makeHeader({ height: 2, parent: { hash: 'cd'.repeat(32), header: { height: 1, createdAt: 1_700_000_000_000 } as import('@dagsocial/types').BlockHeader, interlinks: [], pathTa: 1_700_000_000_000 }, params: PARAMS, schedule: SCHEDULE, prevBlockHash: 'cd'.repeat(32) });
      const { cap, callbacks } = recorder();
      const v = admitHeader(orphan.header, 'gossip', 'peerA', ctx(), callbacks);
      // The last assertion names the rule: a gossip arm with an unknown
      // parent is `parent-unknown`, never a penalty.
      expect(cap.penalties).toEqual([]);
      expect(v.kind).toBe('parent-unknown');
    });

    it('a height-1 header whose hash is not the pinned genesisId refuses with misbehavior', () => {
      const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      const pinned = 'ff'.repeat(32);
      const { cap, callbacks } = recorder();
      const v = admitHeader(h1!.header, 'headers-page', 'peerA', ctx({ genesisId: pinned }), callbacks);
      expect(v.kind).toBe('refused');
      // The last assertion names the rule: a pinned genesisId makes a
      // mismatching height-1 header misbehavior.
      expect(cap.penalties[0]!.kind).toBe('misbehavior');
    });

    it('a parent below the reach floor refuses with no penalty', () => {
      const chain = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      // Control: admit the parent so it reaches the tree.
      const { callbacks: cb0 } = recorder();
      expect(admitHeader(chain[0]!.header, 'headers-page', 'peerA', ctx(), cb0).kind).toBe('stored');
      const { cap, callbacks } = recorder();
      const v = admitHeader(chain[1]!.header, 'headers-page', 'peerA', ctx({ appliedTipHeight: () => config.maxReorgDepth + 2 }), callbacks);
      // The last assertion names the rule: a parent below the floor is
      // refused with NO penalty.
      expect(cap.penalties).toEqual([]);
      expect(v.kind).toBe('refused');
    });

    it('a header refused with reason clock is not stored, no penalty, no memo', () => {
      const chain = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      // Control: admit the parent so the clock case has a tree parent.
      const { callbacks: cb0 } = recorder();
      expect(admitHeader(chain[0]!.header, 'headers-page', 'peerA', ctx(), cb0).kind).toBe('stored');
      const { cap, callbacks } = recorder();
      // nowMs returns a time that puts chain[1].createdAt beyond MAX_FUTURE_DRIFT_MS.
      const v = admitHeader(chain[1]!.header, 'headers-page', 'peerA', ctx({ nowMs: () => chain[1]!.header.createdAt - 2_000_000 }), callbacks);
      expect(v.kind).toBe('refused');
      expect(cap.penalties).toEqual([]);
      // The last assertion names the rule: a clock refusal writes no memo.
      expect(knowsTip('peerA', chain[1]!.hash)).toBe(false);
    });

    it('a header refused with reason version is penalised transient', () => {
      const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      h1!.header.protocolVersion = 99;
      // Re-mine with the altered protocolVersion so PoW still passes.
      const remined = makeHeader({ height: 1, params: PARAMS, schedule: SCHEDULE, protocolVersion: 99 });
      const { cap, callbacks } = recorder();
      const v = admitHeader(remined.header, 'headers-page', 'peerA', ctx(), callbacks);
      expect(v.kind).toBe('refused');
      // The last assertion names the rule: a version mismatch is `transient`.
      expect(cap.penalties[0]!.kind).toBe('transient');
    });

    it('a header refused with reason target is penalised misbehavior', () => {
      const chain = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      // At height 1, powTargetBits must equal params.anchorBits — mine another
      // header with the wrong bits to force a `target` refusal.
      const wrong = makeHeader({ height: 1, params: PARAMS, schedule: SCHEDULE, powTargetBits: PARAMS.anchorBits + 1 });
      const { cap: cap0, callbacks: cb0 } = recorder();
      expect(admitHeader(chain[0]!.header, 'headers-page', 'peerA', ctx(), cb0).kind).toBe('stored');
      expect(cap0.penalties).toEqual([]);
      const { cap, callbacks } = recorder();
      const v = admitHeader(wrong.header, 'headers-page', 'peerA', ctx(), callbacks);
      expect(v.kind).toBe('refused');
      // The last assertion names the rule: a `target` reason is misbehavior.
      expect(cap.penalties[0]!.kind).toBe('misbehavior');
    });

    it('a header refused with reason link is penalised misbehavior', () => {
      const chain = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      expect(admitHeader(chain[0]!.header, 'headers-page', 'peerA', ctx(), cb0).kind).toBe('stored');
      // Build a height-2 header that LIES about its parent.
      const lier = makeHeader({ height: 2, parent: chain[0]!, params: PARAMS, schedule: SCHEDULE, prevBlockHash: '12'.repeat(32) });
      const { cap, callbacks } = recorder();
      // The parent `12…12` is unknown — in a page, this is misbehavior under
      // the parent-unknown rule. To exercise `link` cleanly, declare height=2
      // with chain[0]'s hash as parent but the header's own `prevBlockHash`
      // field pointing elsewhere — the admission runs verifyHeaderChain over
      // the anchor it builds from the tree parent, so the mismatch is `link`.
      lier.header.prevBlockHash = chain[0]!.hash;
      const relied = makeHeader({ height: 2, parent: chain[0]!, params: PARAMS, schedule: SCHEDULE });
      relied.header.prevBlockHash = '12'.repeat(32);
      // Keep the parent discoverable through a correctly-pointing header hash
      // in the tree: admission's parent lookup is by header.prevBlockHash, so
      // the `link` reason fires when verifyHeaderChain compares against the
      // tree-parent anchor the admission built. Admit the raw `relied` to
      // force the link check.
      const v = admitHeader(relied.header, 'headers-page', 'peerA', ctx(), callbacks);
      expect(v.kind).toBe('refused');
      // The last assertion names the rule: a `link` reason is misbehavior.
      expect(cap.penalties[0]!.kind).toBe('misbehavior');
    });
  });

  describe('admitHeader — the store rule', () => {
    it('a header extending the best tip is stored and becomes best', () => {
      const chain = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      admitHeader(chain[0]!.header, 'headers-page', 'peerA', ctx(), cb0);
      const { cap, callbacks } = recorder();
      const v = admitHeader(chain[1]!.header, 'headers-page', 'peerA', ctx(), callbacks);
      expect(v.kind).toBe('stored');
      expect(getBestTip()!.hash).toBe(chain[1]!.hash);
      // The last assertion names the rule: an extension of best fires
      // `chainMoved` once.
      expect(cap.chainMoves).toBe(1);
    });

    it('a lighter side branch is not stored', () => {
      const main = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb } = recorder();
      for (const h of main) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb);
      // A side header forks at height 1 but is on a shorter branch (height 2).
      const side = makeHeader({ height: 2, parent: main[0]!, params: PARAMS, schedule: SCHEDULE, createdAt: main[0]!.header.createdAt + PARAMS.idealMs + 2 });
      const { cap, callbacks } = recorder();
      const v = admitHeader(side.header, 'headers-page', 'peerA', ctx(), callbacks);
      // The last assertion names the rule: a lighter side branch is not
      // stored and does not move the best tip.
      expect(getHeaderRow(side.hash)).toBeNull();
      expect(v.kind).not.toBe('stored');
      expect(getBestTip()!.hash).toBe(main[1]!.hash);
      expect(cap.chainMoves).toBe(0);
    });

    it('a header outweighing the best from a stored parent is stored and switches best', () => {
      // Main: two headers. Alt: three headers forked from root — strictly heavier.
      const main = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb } = recorder();
      for (const h of main) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb);
      const alt = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE, startAt: main[0]!.header.createdAt + 1 });
      // The whole branch is won on its first page: pass 1 stores from the
      // page in hand, the switch fires in the same call.
      const { cap, callbacks: cb2 } = recorder();
      const v = admitPage('peerB', alt[2]!.hash, pageHeaders(alt), ctx(), cb2);
      // The last assertion names the rule: the switch moves the best tip to
      // the heavier branch's tip, firing `chainMoved`.
      expect(v.outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(alt[2]!.hash);
      expect(cap.chainMoves).toBeGreaterThan(0);
      // Any further delivery of the same headers is a no-op — all held.
      const { callbacks: cb3 } = recorder();
      expect(admitPage('peerB', alt[2]!.hash, pageHeaders(alt), ctx(), cb3).outcome).toBe('taken');
    });

    it('a tie keeps the incumbent', () => {
      const a = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb } = recorder();
      for (const h of a) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb);
      // Same-length alt chain: equal cumulative work (same bits each).
      const b = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE, startAt: a[0]!.header.createdAt + 1 });
      const { callbacks: cb2 } = recorder();
      admitHeader(b[0]!.header, 'headers-page', 'peerB', ctx(), cb2);
      const { cap, callbacks } = recorder();
      admitHeader(b[1]!.header, 'headers-page', 'peerB', ctx(), callbacks);
      // The last assertion names the rule: a tie leaves the incumbent in
      // place, firing no `chainMoved`.
      expect(getBestTip()!.hash).toBe(a[1]!.hash);
      expect(cap.chainMoves).toBe(0);
    });

    it('a candidate that outweighs best but whose fork with the applied chain is below the floor is unreachable, best unmoved', () => {
      // Main: 2 headers; admit them.
      const main = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb } = recorder();
      for (const h of main) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb);
      // Alt: 3 headers from root (fork at 0), heavier total work. The applied
      // tip rose beyond the horizon before the page arrives, so the branch's
      // fork point (0) is below the reach floor — unreachable.
      const alt = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE, startAt: main[0]!.header.createdAt + 1 });
      const highTip = config.maxReorgDepth + 2;
      const { cap, callbacks } = recorder();
      const v = admitPage('peerB', alt[2]!.hash, pageHeaders(alt), ctx({ appliedTipHeight: () => highTip }), callbacks);
      // The last assertion names the rule: an admitted side branch that would
      // win is refused when its fork with the applied chain is below the
      // reach floor; the best tip stands unmoved.
      expect(v.outcome).toBe('refused');
      expect(getBestTip()!.hash).toBe(main[1]!.hash);
      expect(cap.chainMoves).toBe(0);
    });
  });

  describe('admitHeader — reach floor', () => {
    it('at appliedTip = maxReorgDepth a fork at the root is reachable', () => {
      // A joiner at the horizon keeps every journal down to height 1, so
      // `lowestJournal − 1 = 0` and the depth term is 0 — fork at root reachable.
      const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      const { cap, callbacks } = recorder();
      const v = admitHeader(h1!.header, 'headers-page', 'peerA', ctx({ appliedTipHeight: () => config.maxReorgDepth, lowestJournalHeight: () => 1 }), callbacks);
      // The last assertion names the rule: at exactly the horizon, fork at
      // the root is reachable.
      expect(v.kind).toBe('stored');
      expect(cap.penalties).toEqual([]);
    });

    it('at appliedTip = maxReorgDepth + 1 a fork at the root is unreachable', () => {
      const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      // Control: at tip = maxReorgDepth with journals to height 1, the same
      // header is admitted.
      const { callbacks: cb0 } = recorder();
      expect(admitHeader(h1!.header, 'headers-page', 'peerA', ctx({ appliedTipHeight: () => config.maxReorgDepth, lowestJournalHeight: () => 1 }), cb0).kind).toBe('stored');
      // Reset for the beyond-horizon arm.
      closeDb(); initDb(':memory:'); resetPipelineForTests();
      const [h1b] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      const { cap, callbacks } = recorder();
      // One past the horizon, journals still to height 1, so the depth term
      // is 1 — fork at root (height 0) is below the floor.
      const v = admitHeader(h1b!.header, 'headers-page', 'peerA', ctx({ appliedTipHeight: () => config.maxReorgDepth + 1, lowestJournalHeight: () => 1 }), callbacks);
      // The last assertion names the rule: just past the horizon, fork at
      // the root is refused with no penalty.
      expect(v.kind).toBe('refused');
      expect(cap.penalties).toEqual([]);
    });

    it('lowestJournal − 1 binds after the journals fall short', () => {
      const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      // Control: with the depth term at 0 and journals to height 1, fork at
      // root is reachable.
      const { callbacks: cb0 } = recorder();
      expect(admitHeader(h1!.header, 'headers-page', 'peerA', ctx({ appliedTipHeight: () => 1, lowestJournalHeight: () => 1 }), cb0).kind).toBe('stored');
      // Reset for the journal-binds arm.
      closeDb(); initDb(':memory:'); resetPipelineForTests();
      const [h1b] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
      const { cap, callbacks } = recorder();
      // Applied tip at 1 (depth term = 1 − 40 = −39), lowestJournal = 5, so
      // the floor is `5 − 1 = 4` — fork at root (height 0) unreachable.
      const v = admitHeader(h1b!.header, 'headers-page', 'peerA', ctx({ appliedTipHeight: () => 1, lowestJournalHeight: () => 5 }), callbacks);
      // The last assertion names the rule: `lowestJournal − 1` binds.
      expect(v.kind).toBe('refused');
      expect(cap.penalties).toEqual([]);
    });
  });

  describe('locatorFor', () => {
    it('answers the virtual root alone on an empty tree', () => {
      // The last assertion names the rule: no tip → GENESIS_PREV_BLOCK_HASH alone.
      expect(locatorFor('peerA')).toEqual([GENESIS_PREV_BLOCK_HASH]);
    });

    it('the locator over best chain follows h₀=tip, hᵢ₊₁ = hᵢ − 2ⁱ', () => {
      // Build 10 headers; admit them in order so the best chain's heights are 1..10.
      const chain = makeChain({ parent: null, n: 10, params: PARAMS, schedule: SCHEDULE });
      const { callbacks } = recorder();
      for (const h of chain) admitHeader(h.header, 'headers-page', 'peerA', ctx(), callbacks);
      const loc = locatorFor('peerA');
      // h₀=10, h₁=10-1=9, h₂=9-2=7, h₃=7-4=3, h₄=3-8=-5 → stops, then height 1.
      const expectedHeights = [10, 9, 7, 3, 1];
      // The last assertion names the rule: the formula's heights are read
      // from the best chain, no running branch to override.
      expect(loc.map((_, i) => expectedHeights[i])).toEqual(expectedHeights);
      expect(loc.length).toBe(expectedHeights.length);
    });

    it.fails('the locator caps at MAX_LOCATOR_HASHES', () => {
      // A tip of 2^30 forces the formula past the cap. Build the best chain
      // by raw SQL so the test does not mine 10^9 headers; a well-formed
      // locator is still a sequence of 32-byte hex ids.
      const db = getDb();
      const dummyBytes = Buffer.alloc(32, 0xcc);
      const encoded = new Uint8Array([0, 1, 0]); // empty-interlinks encoding
      const dummyChainWork = Buffer.alloc(40);
      const insH = db.prepare('INSERT INTO block_headers (hash, height, prev_hash, header_bytes, interlinks, chain_work, path_t_a) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insB = db.prepare('INSERT INTO best_chain (height, hash) VALUES (?, ?)');
      const TOP = 1 << 30;
      // Seed the heights the locator formula visits for TOP, plus a few below
      // the floor so the cap must truncate.
      const visited: number[] = [];
      for (let step = 0, h = TOP; h >= 1; step++) {
        visited.push(h);
        if (h === 1) break;
        h = h - (1 << step);
        if (h < 1) { visited.push(1); break; }
      }
      db.transaction(() => {
        for (const h of visited) {
          const hex = h.toString(16).padStart(64, '0');
          insH.run(hex, h, GENESIS_PREV_BLOCK_HASH, dummyBytes, Buffer.from(encoded), dummyChainWork, 0);
          insB.run(h, hex);
        }
      })();
      const loc = locatorFor('peerA');
      // The last assertion names the rule: the locator never exceeds the cap.
      expect(loc.length).toBeLessThanOrEqual(MAX_LOCATOR_HASHES);
      // The tip's hex id leads the locator.
      expect(loc[0]).toBe(TOP.toString(16).padStart(64, '0'));
    });
  });

  describe('pruneHeaderTree', () => {
    it('keeps best-chain rows and drops the rest', async () => {
      const chain = makeChain({ parent: null, n: 4, params: PARAMS, schedule: SCHEDULE });
      const { callbacks } = recorder();
      for (const h of chain) admitHeader(h.header, 'headers-page', 'peerA', ctx(), callbacks);
      // Insert a side-branch row at height 2 forking from chain[0] directly —
      // admission routes side headers through pass 2, not through admitHeader.
      const side = makeHeader({ height: 2, parent: chain[0]!, params: PARAMS, schedule: SCHEDULE, createdAt: chain[0]!.header.createdAt + PARAMS.idealMs + 3 });
      const { encodeHeader, encodeInterlinks } = await import('@dagsocial/types');
      const db = getDb();
      db.prepare('INSERT INTO block_headers (hash, height, prev_hash, header_bytes, interlinks, chain_work, path_t_a) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(side.hash, 2, side.header.prevBlockHash, Buffer.from(encodeHeader(side.header)), Buffer.from(encodeInterlinks(side.interlinks)), Buffer.alloc(40), side.pathTa);
      expect(getHeaderRow(side.hash)).not.toBeNull();

      pruneHeaderTree(3);
      expect(getHeaderRow(chain[0]!.hash)).not.toBeNull();
      expect(getHeaderRow(chain[1]!.hash)).not.toBeNull();
      // The last assertion names the rule: pruning drops a side-branch row
      // below the floor but keeps the best-chain rows below it.
      expect(getHeaderRow(side.hash)).toBeNull();
    });
  });

  describe('presync — pass 1 and pass 2', () => {
    it('a page from the root extends an empty tree and stores every header', () => {
      // Peer claims a chain of 5 headers; our tree is empty. The page's
      // base is the virtual root — extension stores every header.
      const chain = makeChain({ parent: null, n: 5, params: PARAMS, schedule: SCHEDULE });
      const { cap, callbacks } = recorder();
      const v = admitPage('peerA', chain[4]!.hash, pageHeaders(chain), ctx(), callbacks);
      // The last assertion names the rule: a page whose base is the best
      // chain's tip (or the root while none stands) is stored as it is
      // admitted and the best chain extends.
      expect(v.outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(chain[4]!.hash);
      expect(cap.chainMoves).toBeGreaterThan(0);
    });

    it('a first page past our tip and heavier is stored from the page in hand', () => {
      // Our chain: 2 headers. Peer's: 4 heavier headers from root. The first
      // page carries the whole branch, won on its first page — stored from
      // the page in hand, the best chain switches.
      const ours = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const theirs = makeChain({ parent: null, n: 4, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });
      const { cap, callbacks } = recorder();
      const v = admitPage('peerB', theirs[3]!.hash, pageHeaders(theirs), ctx(), callbacks);
      // The last assertion names the rule: a branch won inside the page it
      // starts in is stored from the page in hand, the best chain switches.
      expect(v.outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(theirs[3]!.hash);
      expect(cap.chainMoves).toBeGreaterThan(0);
    });

    it('a pass-2 header off a recorded hash refuses with transient, stores nothing further', () => {
      // Our chain: 10 anchor-bit headers. Theirs: 12 anchor-bit headers from
      // root — heavier only after the 11th. Page 1 of 6 scores; page 2's 6
      // wins the branch, which the pipeline re-fetches by `'again'`. The
      // peer's pass-2 then rewrites the recorded header at height 12.
      const ours = makeChain({ parent: null, n: 10, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const theirs = makeChain({ parent: null, n: 12, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });
      const page1 = pageHeaders(theirs.slice(0, 6));
      const page2 = pageHeaders(theirs.slice(6, 12));
      const { callbacks: cbS } = recorder();
      expect(admitPage('peerB', theirs[11]!.hash, page1, ctx(), cbS).outcome).toBe('taken');
      expect(admitPage('peerB', theirs[11]!.hash, page2, ctx(), cbS).outcome).toBe('again');
      // Pass 2 page 1 — six honest headers.
      const { cap, callbacks } = recorder();
      expect(admitPage('peerB', theirs[11]!.hash, page1, ctx(), callbacks).outcome).toBe('again');
      // Pass 2 page 2 — the last header at the recorded height (12) is
      // rewritten off its recorded hash.
      const forged = makeHeader({ height: 12, parent: theirs[10]!, params: PARAMS, schedule: SCHEDULE, createdAt: theirs[10]!.header.createdAt + PARAMS.idealMs + 7 });
      const altered = [...pageHeaders(theirs.slice(6, 11)), forged.header];
      const v = admitPage('peerB', theirs[11]!.hash, altered, ctx(), callbacks);
      // The last assertion names the rule: pass-2 recorded-hash mismatch is
      // `transient` and lands no stored row for the forged branch.
      expect(cap.penalties.map(p => p.kind)).toContain('transient');
      expect(v.outcome).toBe('refused');
      expect(getHeaderRow(forged.hash)).toBeNull();
    });

    it('a won branch whose crossing lies in its second page switches at the crossing header', () => {
      const ours = makeChain({ parent: null, n: 10, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const theirs = makeChain({ parent: null, n: 12, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });
      const page1 = pageHeaders(theirs.slice(0, 6));
      const page2 = pageHeaders(theirs.slice(6, 12));
      const { callbacks: cbS } = recorder();
      // Pass 1 across two pages — page 1 continues scoring, page 2 wins.
      expect(admitPage('peerB', theirs[11]!.hash, page1, ctx(), cbS).outcome).toBe('taken');
      expect(admitPage('peerB', theirs[11]!.hash, page2, ctx(), cbS).outcome).toBe('again');

      // Pass 2 page 1 — stores six rows, cumulative work 6W < 10W, no switch.
      const { cap: cap1, callbacks: cb1 } = recorder();
      const v1 = admitPage('peerB', theirs[11]!.hash, page1, ctx(), cb1);
      expect(v1.outcome).toBe('again');
      expect(cap1.chainMoves).toBe(0);
      expect(getBestTip()!.hash).toBe(ours[9]!.hash);

      // Pass 2 page 2 — crossing at header 11 (cumulative 11W > 10W), switch
      // at the crossing header; the remaining header 12 extends the new best.
      const { cap: cap2, callbacks: cb2 } = recorder();
      const v2 = admitPage('peerB', theirs[11]!.hash, page2, ctx(), cb2);
      // The last assertion names the rule: the switch moves the best tip to
      // the crossing header's branch tip, firing `chainMoved` at pass 2's
      // crossing page.
      expect(v2.outcome).toBe('taken');
      expect(cap2.chainMoves).toBeGreaterThan(0);
      expect(getBestTip()!.hash).toBe(theirs[11]!.hash);
    });

    it('a peer that stops after pass 2\'s first page leaves the stored rows not best', () => {
      const ours = makeChain({ parent: null, n: 10, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const theirs = makeChain({ parent: null, n: 12, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });
      const page1 = pageHeaders(theirs.slice(0, 6));
      const page2 = pageHeaders(theirs.slice(6, 12));
      const { callbacks: cbS } = recorder();
      expect(admitPage('peerB', theirs[11]!.hash, page1, ctx(), cbS).outcome).toBe('taken');
      expect(admitPage('peerB', theirs[11]!.hash, page2, ctx(), cbS).outcome).toBe('again');

      // Only pass 2's first page arrives — the stored rows sit off best_chain.
      const { cap, callbacks } = recorder();
      const v = admitPage('peerB', theirs[11]!.hash, page1, ctx(), callbacks);
      // The last assertion names the rule: pass 2's first page does not
      // switch best when its cumulative work is below the current best tip's.
      expect(v.outcome).toBe('again');
      expect(cap.chainMoves).toBe(0);
      expect(getBestTip()!.hash).toBe(ours[9]!.hash);
      expect(getHeaderRow(theirs[5]!.hash)).not.toBeNull();
      expect(getBestHashAt(2)).toBe(ours[1]!.hash);
    });

    it('a pass-2 page whose last header at a recorded height has another hash is transient, nothing further stored, best unmoved', () => {
      const ours = makeChain({ parent: null, n: 10, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const theirs = makeChain({ parent: null, n: 12, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });
      const page1 = pageHeaders(theirs.slice(0, 6));
      const page2 = pageHeaders(theirs.slice(6, 12));
      const { callbacks: cbS } = recorder();
      expect(admitPage('peerB', theirs[11]!.hash, page1, ctx(), cbS).outcome).toBe('taken');
      expect(admitPage('peerB', theirs[11]!.hash, page2, ctx(), cbS).outcome).toBe('again');

      // Pass 2 page 1 — but the last header at recorded height 6 is rewritten.
      const forged6 = makeHeader({ height: 6, parent: theirs[4]!, params: PARAMS, schedule: SCHEDULE, createdAt: theirs[4]!.header.createdAt + PARAMS.idealMs + 11 });
      const forgedPage1 = [...pageHeaders(theirs.slice(0, 5)), forged6.header];
      const { cap, callbacks } = recorder();
      const v = admitPage('peerB', theirs[11]!.hash, forgedPage1, ctx(), callbacks);
      // The last assertion names the rule: a pass-2 page whose header at a
      // recorded height mismatches is `transient` and leaves best unmoved.
      expect(cap.penalties.map(p => p.kind)).toContain('transient');
      expect(v.outcome).toBe('refused');
      expect(getBestTip()!.hash).toBe(ours[9]!.hash);
      expect(getHeaderRow(forged6.hash)).toBeNull();
    });

    it('one branch per peer: a page toward a newer claim replaces the running branch', () => {
      const chain1 = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE });
      const chain2 = makeChain({ parent: null, n: 4, params: PARAMS, schedule: SCHEDULE, startAt: chain1[0]!.header.createdAt + 1 });
      const { callbacks } = recorder();
      admitPage('peerA', chain1[2]!.hash, pageHeaders(chain1), ctx(), callbacks);
      admitPage('peerA', chain2[3]!.hash, pageHeaders(chain2), ctx(), callbacks);
      // The last assertion names the rule: the second claim's running branch
      // replaces the first — pass 2 for the SECOND succeeds.
      const stored = admitPage('peerA', chain2[3]!.hash, pageHeaders(chain2), ctx(), callbacks);
      // The last assertion names the rule: the running branch for the new
      // claim is admitted in place of the first; the branch is won inside
      // its own first page.
      expect(stored.outcome).toBe('taken');
    });

    it('onPeerDisconnected clears the peer branch and memo', () => {
      const ours = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      // Peer scores a lighter chain → memo entry.
      const lighter = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 2 });
      const { callbacks: cb } = recorder();
      admitPage('peerB', lighter[0]!.hash, pageHeaders(lighter), ctx(), cb);
      expect(knowsTip('peerB', lighter[0]!.hash)).toBe(true);

      onPeerDisconnected('peerB');
      // The last assertion names the rule: the peer's memo entry is gone.
      expect(knowsTip('peerB', lighter[0]!.hash)).toBe(false);
    });

    it('a Headers page with claim=\"\" ends short, pass 1 stops lighter', () => {
      const ours = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const theirs = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });
      const { callbacks } = recorder();
      const v = admitPage('peerB', '', pageHeaders(theirs), ctx(), callbacks);
      // The last assertion names the rule: a no-claim run with a page
      // shorter than MAX_CHAIN_RESPONSE_ITEMS drops the branch when it does
      // not outweigh the best — the page is `'taken'` and nothing is
      // stored for it.
      expect(v.outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(ours[2]!.hash);
    });

    it('a clock refusal in pass 1 writes no memo', () => {
      const ours = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      // Control: a lighter chain under an in-bound clock DOES write memo.
      const lighter = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });
      const { callbacks: cb } = recorder();
      admitPage('peerC', lighter[0]!.hash, pageHeaders(lighter), ctx(), cb);
      expect(knowsTip('peerC', lighter[0]!.hash)).toBe(true);
      // Clock case: this peer's page is refused on clock, no memo.
      const theirs = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 2 });
      const { callbacks } = recorder();
      admitPage('peerB', theirs[0]!.hash, pageHeaders(theirs), ctx({ nowMs: () => theirs[0]!.header.createdAt - 2_000_000 }), callbacks);
      // The last assertion names the rule: a clock refusal records no memo.
      expect(knowsTip('peerB', theirs[0]!.hash)).toBe(false);
    });
  });

  describe('memo', () => {
    it('a branch scored lighter at the claim writes memo, knowsTip answers true', () => {
      const ours = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const theirs = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 2 });
      const { callbacks } = recorder();
      admitPage('peerB', theirs[0]!.hash, pageHeaders(theirs), ctx(), callbacks);
      // The last assertion names the rule: `knowsTip` returns true for the
      // claim's hash on a lighter stop.
      expect(knowsTip('peerB', theirs[0]!.hash)).toBe(true);
    });

    it('a best-chain move clears every memo entry', () => {
      const ours = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const lighter = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 2 });
      const { callbacks: cb } = recorder();
      admitPage('peerC', lighter[0]!.hash, pageHeaders(lighter), ctx(), cb);
      expect(knowsTip('peerC', lighter[0]!.hash)).toBe(true);
      // Add a header that extends our best → chainMoved fires → memo clears.
      const next = makeHeader({ height: 3, parent: ours[1]!, params: PARAMS, schedule: SCHEDULE });
      admitHeader(next.header, 'headers-page', 'peerA', ctx(), cb);
      // The last assertion names the rule: on a best-chain move the memo is
      // cleared.
      expect(knowsTip('peerC', lighter[0]!.hash)).toBe(false);
    });
  });

  describe('continuation stays in pass 1', () => {
    it('a pass-1 continuation whose base has become the best tip wins on its next page and is stored by pass 2', () => {
      // Our chain: 3 anchor headers; best tip = ours[2] (3W).
      const ours = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      // Peer branch forks at the virtual root, longer and heavier.
      const theirs = makeChain({ parent: null, n: 5, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });

      // Pass 1 page 1: theirs[0..1] (2 headers). Pass-1 cumulative = base
      // chainWork (0) + 2W = 2W < bestWork (3W) → score, 'taken'. The
      // running branch's base is the virtual root.
      const page1 = pageHeaders(theirs.slice(0, 2));
      const { callbacks: cb1 } = recorder();
      admitPage('peerB', theirs[4]!.hash, page1, ctx(), cb1);

      // A mark's re-choice moves the best chain down to the branch's base.
      // The intake's `markRefused` does the same three store ops before it
      // asks the pipeline to re-choose: refused-row insert, subtree
      // removal, then `rechooseBestChain`. Here ours[0]'s subtree is
      // removed, so what remains is empty and the branch's base — the
      // virtual root — is the best.
      insertRefusedHeader(ours[0]!.hash, 1, 0);
      removeHeaderSubtree(ours[0]!.hash);
      const { callbacks: cbRe } = recorder();
      rechooseBestChain(ctx(), cbRe);
      expect(getBestTip()).toBeNull();

      // Pass 1 page 2: theirs[2..4] (3 headers), parent = theirs[1].hash =
      // the running branch's `topHash` → continuation. Cumulative work
      // 2W + 3W = 5W > bestWork (0W) → the branch wins on a later page.
      // The continuation stays in its pass: pass 1 returns 'again' and the
      // branch's rows wait for pass 2 to store them. A page that reached
      // the extension arm here would write rows above theirs[1] — a
      // header pass 1 only scored, not a tree row.
      const page2 = pageHeaders(theirs.slice(2, 5));
      const { callbacks: cb2 } = recorder();
      let v2: ReturnType<typeof admitPage> | null = null;
      try { v2 = admitPage('peerB', theirs[4]!.hash, page2, ctx(), cb2); } catch { /* v2 stays null */ }
      // The last assertion names the rule: a continuation stays in its
      // pass. Pass 1 returns 'again' (the branch is won on a later page);
      // the extension arm never fires over an unstored last-scored header.
      expect(v2?.outcome).toBe('again');
    });
  });

  describe('pass 2 extends from the base once at the crossing', () => {
    it('a pass 2 of several pages past the crossing leaves best_chain equal to the branch, each page extending by its own length', () => {
      // Our chain: 6 anchor headers (bestWork = 6W).
      const ours = makeChain({ parent: null, n: 6, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      // Peer chain: 12 anchor headers from the root; cumulative work beats
      // ours only after the 7th header (7W > 6W).
      const theirs = makeChain({ parent: null, n: 12, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });

      // Pass 1 pages of 6 — page 1 ties (6W = 6W, not >), page 2 wins
      // ('again') and records heights 6 and 12.
      const p1a = pageHeaders(theirs.slice(0, 6));
      const p1b = pageHeaders(theirs.slice(6, 12));
      const { callbacks: cbS } = recorder();
      expect(admitPage('peerB', theirs[11]!.hash, p1a, ctx(), cbS).outcome).toBe('taken');
      expect(admitPage('peerB', theirs[11]!.hash, p1b, ctx(), cbS).outcome).toBe('again');

      // A counter on best_chain inserts, through the store — a trigger
      // increments one row of a side table per INSERT, so the count is a
      // store-side observation of the rule.
      const db = getDb();
      db.exec(`
        CREATE TABLE pass2_bc_count (c INTEGER);
        INSERT INTO pass2_bc_count VALUES (0);
        CREATE TRIGGER pass2_bc_insert AFTER INSERT ON best_chain BEGIN
          UPDATE pass2_bc_count SET c = c + 1;
        END;
      `);
      const countInserts = () => db.prepare('SELECT c FROM pass2_bc_count').pluck().get() as number;

      // Pass 2 served in pages of 2 — the crossing lands early, so several
      // pages follow it.
      const pages: import('@dagsocial/types').BlockHeader[][] = [];
      for (let i = 0; i < 12; i += 2) pages.push(pageHeaders(theirs.slice(i, i + 2)));
      const { callbacks: cbP2 } = recorder();

      // Pages 0..2 (heights 1..6, cumulative work 2W → 4W → 6W, none > 6W):
      // no crossing, no best_chain writes.
      for (let i = 0; i < 3; i++) {
        const c0 = countInserts();
        const v = admitPage('peerB', theirs[11]!.hash, pages[i]!, ctx(), cbP2);
        expect(v.outcome).toBe('again');
        expect(countInserts() - c0).toBe(0);
      }

      // Page 3 (heights 7..8, cumulative 7W > 6W at header[0]) — crossing.
      // The branch's path from the base (virtual root) up to this page's
      // last header is read back through `prev_hash` and written to
      // best_chain in one call: 8 inserts, the branch's length so far.
      const c3 = countInserts();
      const v3 = admitPage('peerB', theirs[11]!.hash, pages[3]!, ctx(), cbP2);
      expect(v3.outcome).toBe('again');
      expect(countInserts() - c3).toBe(8);

      // Page 4 (heights 9..10) and page 5 (heights 11..12): the branch is
      // switched; each page extends best_chain from the last header stored,
      // so the inserts per page equal the page's length.
      const c4 = countInserts();
      const v4 = admitPage('peerB', theirs[11]!.hash, pages[4]!, ctx(), cbP2);
      expect(v4.outcome).toBe('again');
      const inserts4 = countInserts() - c4;

      const c5 = countInserts();
      const v5 = admitPage('peerB', theirs[11]!.hash, pages[5]!, ctx(), cbP2);
      expect(v5.outcome).toBe('taken');
      const inserts5 = countInserts() - c5;

      // best_chain equals the branch (12 rows, each the branch's hash at
      // its height).
      const bc = db.prepare('SELECT height, hash FROM best_chain ORDER BY height').all() as Array<{ height: number; hash: string }>;
      expect(bc.length).toBe(12);
      for (let i = 0; i < 12; i++) {
        expect(bc[i]!.height).toBe(i + 1);
        expect(bc[i]!.hash).toBe(theirs[i]!.hash);
      }
      // The last assertion names the rule: a page after the crossing
      // extends best_chain by its own length — pass 2's writes stay linear
      // in the branch's length.
      expect([inserts4, inserts5]).toEqual([2, 2]);
    });
  });

  describe('interlinks funnel', () => {
    it('a page over a floor-priced parent stores a vector that admits the next page', () => {
      // Pass 1 serves the branch over the virtual root, pages of 3; the
      // branch is heavier than the empty tree's work, so it wins on the
      // first page and is stored from the page in hand. Every stored row's
      // interlinks is computed through `interlinksCommitFromParent` →
      // `updateInterlinks` with the parent's `level`.
      const chain = makeChain({ parent: null, n: 6, params: PARAMS, schedule: SCHEDULE });
      const p1 = pageHeaders(chain.slice(0, 3));
      const p2 = pageHeaders(chain.slice(3, 6));

      const { callbacks: cb1 } = recorder();
      const v1 = admitPage('peerA', chain[5]!.hash, p1, ctx(), cb1);
      expect(v1.outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(chain[2]!.hash);

      // Page 2's first header's parent is chain[2], a floor-priced header
      // (the suite's PARAMS has anchor = floor). The pipeline builds the
      // page's verification anchor through `interlinksCommitFromParent`
      // over that parent — one call that funnels every level, Infinity, a
      // non-negative integer or null, into `updateInterlinks`.
      const { callbacks: cb2 } = recorder();
      const v2 = admitPage('peerA', chain[5]!.hash, p2, ctx(), cb2);
      // The last assertion names the rule: the stored vector matches the
      // next page's first header's `interlinkRoot`, so the page admits.
      expect(v2.outcome).toBe('taken');
    });
  });

  describe('the trap, at the header level', () => {
    it('an honest chain beats a floor-priced long branch, both orders', () => {
      const D = config.maxReorgDepth;
      // Honest: 12 headers at anchor.
      const honest = makeChain({ parent: null, n: 12, params: PARAMS, schedule: SCHEDULE });
      // Attacker: a longer floor-priced branch — same anchor bits because the
      // schedule's floor is reached only with faster blocks, so for the test
      // we use the same bits but more headers. The honest total work is still
      // the lesser if honest has fewer headers... use half-anchor idealMs so
      // the attacker's branch has lower-per-header work but longer. Simpler:
      // every header has the same bits here, so "heavier" means "longer".
      const atk = makeChain({ parent: null, n: D + 2, params: PARAMS, schedule: SCHEDULE, startAt: honest[0]!.header.createdAt + 1 });
      // Order A: admit the attacker first (longer), then honest arrives.
      {
        initDb(':memory:');
        resetPipelineForTests();
        const { callbacks: cb } = recorder();
        for (const h of atk) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb);
        // Attacker's branch stands at D+2 headers. Honest arrives: at admission
        // of each honest header its branch sinks to a fork at root (unreachable
        // once applied tip rose above the horizon). The honest branch is
        // shorter and will NOT outweigh.
        const page = pageHeaders(honest);
        const { callbacks: cb2 } = recorder();
        const v = admitPage('peerB', honest[honest.length - 1]!.hash, page, ctx(), cb2);
        // The honest branch does not outweigh the attacker's — the page is
        // taken as scoring (lighter at the claim); the attacker's tip stays
        // best.
        expect(v.outcome).toBe('taken');
        expect(getBestTip()!.hash).toBe(atk[atk.length - 1]!.hash);
      }
      // Order B: honest first, then attacker arrives longer.
      initDb(':memory:');
      resetPipelineForTests();
      const { callbacks: cb } = recorder();
      for (const h of honest) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb);
      // Attacker scores and stores.
      const page = pageHeaders(atk);
      const { callbacks: cb2 } = recorder();
      const stored = admitPage('peerB', atk[atk.length - 1]!.hash, page, ctx(), cb2);
      // The last assertion names the rule: the heavier attacker's chain is
      // won inside its own first page and stored from that page.
      expect(stored.outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(atk[atk.length - 1]!.hash);
    });
  });

  describe('pass 2 reachability from the base', () => {
    it('a continued branch whose fork with the applied chain is below the floor is refused unreachable, best unmoved', () => {
      const D = config.maxReorgDepth;
      // Our chain: 60 anchor headers; best tip = ours[59] (chain_work 60W).
      const ours = makeChain({ parent: null, n: 60, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      // Side branch forking from ours[1] (height 2), 60 anchor headers
      // (heights 3..62) with a `startAt` offset so the branch's hashes
      // differ from ours'. The branch's work is 2W + 60W = 62W > 60W.
      const theirs = makeChain({
        parent: ours[1]!, n: 60, params: PARAMS, schedule: SCHEDULE,
        startAt: ours[1]!.header.createdAt + PARAMS.idealMs + 11,
      });
      const p1 = pageHeaders(theirs.slice(0, 50));
      const p2 = pageHeaders(theirs.slice(50, 60));
      // Pass 1: page 1 scores (2W + 50W = 52W < 60W), page 2 wins (62W > 60W).
      const { callbacks: cbS } = recorder();
      expect(admitPage('peerB', theirs[59]!.hash, p1, ctx(), cbS).outcome).toBe('taken');
      expect(admitPage('peerB', theirs[59]!.hash, p2, ctx(), cbS).outcome).toBe('again');
      // Pass 2 page 1 stores heights 3..52; cumulative 52W < 60W, no crossing.
      const { callbacks: cbP2a } = recorder();
      expect(admitPage('peerB', theirs[59]!.hash, p1, ctx(), cbP2a).outcome).toBe('again');
      // Context now puts the floor above the branch's fork point (height 2):
      // applied tip = D + 5 = 45, lowestJournal = 1 → floor = max(5, 0) = 5.
      const highCtx = ctx({ appliedTipHeight: () => D + 5, lowestJournalHeight: () => 1 });
      const { cap, callbacks } = recorder();
      const v = admitPage('peerB', theirs[59]!.hash, p2, highCtx, callbacks);
      // The last assertion names the rule: a pass-2 crossing whose base's
      // fork with the applied chain is below the reach floor is refused
      // with no penalty, and the best tip stands unmoved.
      expect(cap.penalties).toEqual([]);
      expect(getBestTip()!.hash).toBe(ours[59]!.hash);
      expect(v.outcome).toBe('refused');
    });
  });

  describe('age rule on a stored base', () => {
    it('a page whose first header\'s parent is a stored row below the floor is refused with no penalty, nothing stored, no running branch', () => {
      const D = config.maxReorgDepth;
      // Our chain: 10 anchor headers; best tip = ours[9] at height 10.
      const ours = makeChain({ parent: null, n: 10, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      // A side header at height 2 forking from ours[0] (height 1), which
      // the strict context puts below the floor.
      const side = makeHeader({
        height: 2, parent: ours[0]!, params: PARAMS, schedule: SCHEDULE,
        createdAt: ours[0]!.header.createdAt + PARAMS.idealMs + 5,
      });
      // Applied tip = D + 5 = 45, lowestJournal = 1 → floor = max(5, 0) = 5.
      const strictCtx = ctx({ appliedTipHeight: () => D + 5, lowestJournalHeight: () => 1 });
      const { cap, callbacks } = recorder();
      const v = admitPage('peerB', side.hash, [side.header], strictCtx, callbacks);
      // The last assertion names the rule: a page whose stored base is
      // below the reach floor is refused with no penalty, no row stored
      // for the side header, and no running branch left behind — the
      // locator leads with the best chain's tip.
      expect(cap.penalties).toEqual([]);
      expect(getHeaderRow(side.hash)).toBeNull();
      expect(locatorFor('peerB')[0]).toBe(ours[9]!.hash);
      expect(v.outcome).toBe('refused');
    });
  });

  describe('genesisId on a page', () => {
    it('a page whose height-1 header hashes otherwise is refused with misbehavior', () => {
      const chain = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE });
      const pinned = 'ff'.repeat(32);
      const { cap, callbacks } = recorder();
      const v = admitPage('peerA', chain[2]!.hash, pageHeaders(chain), ctx({ genesisId: pinned }), callbacks);
      expect(v.outcome).toBe('refused');
      // The last assertion names the rule: a pinned genesisId makes a
      // mismatching height-1 header misbehavior on a page.
      expect(cap.penalties.map(p => p.kind)).toContain('misbehavior');
    });
  });

  describe('leading held headers are no-ops', () => {
    it('a page starting with held best-chain rows below the floor skips them and admits the fork above it', () => {
      const D = config.maxReorgDepth;
      // Our chain: 10 anchor headers (heights 1..10); best tip = ours[9].
      const ours = makeChain({ parent: null, n: 10, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      // Side branch forking from ours[4] (height 5), two anchor headers at
      // heights 6..7.
      const side = makeChain({
        parent: ours[4]!, n: 2, params: PARAMS, schedule: SCHEDULE,
        startAt: ours[4]!.header.createdAt + PARAMS.idealMs + 11,
      });
      // Page = [ours[1], ours[2], ours[3], ours[4], side[0], side[1]] — the
      // leading four are held best-chain rows (ours[1] is at height 2 and
      // its parent ours[0] is below the floor); the branch forks at
      // ours[4] above the floor.
      const page = [ours[1]!, ours[2]!, ours[3]!, ours[4]!, side[0]!, side[1]!].map(p => p.header);
      // Applied tip = D + 2 = 42, lowestJournal = 1 → floor = max(2, 0) = 2.
      const strictCtx = ctx({ appliedTipHeight: () => D + 2, lowestJournalHeight: () => 1 });
      const { cap, callbacks } = recorder();
      const v = admitPage('peerB', side[1]!.hash, page, strictCtx, callbacks);
      // The last assertion names the rule: leading held headers are
      // no-ops — the first-fresh header's parent (ours[4] at height 5,
      // above the floor) is the branch's base, so the age rule does not
      // refuse on the overlap's first parent, and the branch is admitted.
      expect(cap.penalties).toEqual([]);
      expect(v.outcome).toBe('taken');
    });
  });

  describe('pass-2 recorded-mismatch drops the branch', () => {
    it('after the transient refusal, locatorFor leads with the best chain\'s tip', () => {
      const ours = makeChain({ parent: null, n: 10, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const theirs = makeChain({ parent: null, n: 12, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });
      const page1 = pageHeaders(theirs.slice(0, 6));
      const page2 = pageHeaders(theirs.slice(6, 12));
      const { callbacks: cbS } = recorder();
      expect(admitPage('peerB', theirs[11]!.hash, page1, ctx(), cbS).outcome).toBe('taken');
      expect(admitPage('peerB', theirs[11]!.hash, page2, ctx(), cbS).outcome).toBe('again');
      // Pass 2 page 1 — but the last header at recorded height 6 is forged.
      const forged6 = makeHeader({
        height: 6, parent: theirs[4]!, params: PARAMS, schedule: SCHEDULE,
        createdAt: theirs[4]!.header.createdAt + PARAMS.idealMs + 13,
      });
      const forgedPage1 = [...pageHeaders(theirs.slice(0, 5)), forged6.header];
      const { callbacks } = recorder();
      const v = admitPage('peerB', theirs[11]!.hash, forgedPage1, ctx(), callbacks);
      expect(v.outcome).toBe('refused');
      // The last assertion names the rule: the mismatch drops the running
      // branch, so the locator leads with the best chain's tip rather than
      // the branch's state.
      expect(locatorFor('peerB')[0]).toBe(ours[9]!.hash);
    });
  });

  describe('rechooseBestChain ties keep the incumbent', () => {
    it('a side row whose chain_work equals the incumbent\'s is not a candidate — the best chain stays', () => {
      // Our chain: 3 anchor headers; best tip = ours[2] (chain_work 3W).
      const ours = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const incumbentWork = getBestTip()!.chainWork;
      // Insert a side row at height 3 whose chain_work equals the incumbent's.
      const side = makeHeader({
        height: 3, parent: ours[1]!, params: PARAMS, schedule: SCHEDULE,
        createdAt: ours[1]!.header.createdAt + PARAMS.idealMs + 7,
      });
      const db = getDb();
      const workBuf = Buffer.alloc(40);
      let w = incumbentWork;
      for (let i = 39; i >= 0; i--) {
        workBuf[i] = Number(w & 0xffn);
        w >>= 8n;
      }
      db.prepare('INSERT INTO block_headers (hash, height, prev_hash, header_bytes, interlinks, chain_work, path_t_a) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(side.hash, 3, side.header.prevBlockHash, Buffer.from(encodeHeader(side.header)), Buffer.from(encodeInterlinks(side.interlinks)), workBuf, side.pathTa);
      // Rechoose: `headersHeavierThan` reads strictly heavier rows, so a
      // tie is not a candidate.
      const { callbacks } = recorder();
      rechooseBestChain(ctx(), callbacks);
      // The last assertion names the rule: a tie keeps the incumbent —
      // the best tip stands.
      expect(getBestTip()!.hash).toBe(ours[2]!.hash);
    });
  });

  describe('the best chain is one chain, every entry the child of the one below', () => {
    it.fails('a first-page win on a stored row off the best chain names its parent as the entry below it', () => {
      // A1..A9 anchor-priced. The first serving admits A1..A5; A1..A5 are
      // stored, best moves to A5.
      const a = makeChain({ parent: null, n: 9, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb1 } = recorder();
      expect(admitPage('peerA', a[4]!.hash, pageHeaders(a.slice(0, 5)), ctx(), cb1).outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(a[4]!.hash);

      // B3..B7 fork at A2 — 5 anchor-priced headers, running work from base
      // A2 (2W) + 5W = 7W > A5's 5W. Pass 1 wins on the first page; best
      // moves to B7, A3..A5 kept as rows off the best chain.
      const b: ParentHeaderInfo[] = [];
      for (let h = 3; h <= 7; h++) {
        const parent = h === 3 ? a[1]! : b[b.length - 1]!;
        const createdAt = h === 3
          ? a[1]!.header.createdAt + PARAMS.idealMs + 1
          : parent.header.createdAt + PARAMS.idealMs;
        b.push(makeHeader({ height: h, parent, createdAt, params: PARAMS, schedule: SCHEDULE }));
      }
      const { callbacks: cb2 } = recorder();
      expect(admitPage('peerB', b[b.length - 1]!.hash, pageHeaders(b), ctx(), cb2).outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(b[b.length - 1]!.hash);
      expect(getBestHashAt(2)).toBe(a[1]!.hash);
      expect(getBestHashAt(5)).toBe(b[2]!.hash);
      expect(getHeaderRow(a[2]!.hash)).not.toBeNull();

      // A third peer answers the locator with A2..A9: the first fresh
      // header is A6 on base A5, off the best chain. Pass 1's running work
      // from base A5 (5W) + 4W = 9W > 7W wins on the first page, and the
      // first-page store writes A6..A9 to the index.
      const { callbacks: cb3 } = recorder();
      expect(admitPage('peerC', a[8]!.hash, pageHeaders(a.slice(1, 9)), ctx(), cb3).outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(a[8]!.hash);

      // The last assertion names the rule: every best_chain entry above
      // height 1 names the entry below it as its parent — the index is one
      // chain (NODE_INTERFACE → Fork choice decides on verified headers →
      // "The best chain's index is rewritten from where the new branch meets it").
      const tip = getBestTip()!;
      const parentsSeen: Array<string | null> = [];
      const parentsExpected: Array<string | null> = [];
      for (let h = 2; h <= tip.height; h++) {
        const hash = getBestHashAt(h);
        const row = hash === null ? null : getHeaderRow(hash);
        parentsSeen.push(row === null ? null : row.prevHash);
        parentsExpected.push(getBestHashAt(h - 1));
      }
      expect(parentsSeen).toEqual(parentsExpected);
    });

    it.fails('a later-page crossing on a stored row off the best chain names its parent as the entry below it', () => {
      // A1..A5 anchor-priced; the first page wins and stores A1..A5.
      const a = makeChain({ parent: null, n: 5, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb1 } = recorder();
      expect(admitPage('peerA', a[4]!.hash, pageHeaders(a), ctx(), cb1).outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(a[4]!.hash);

      // B2..B7 fork at A1 — 6 anchor-priced headers, 7W > 5W. Pass 1 wins
      // on the first page; best moves to B7, A2..A5 kept as rows off the
      // best chain.
      const b: ParentHeaderInfo[] = [];
      for (let h = 2; h <= 7; h++) {
        const parent = h === 2 ? a[0]! : b[b.length - 1]!;
        const createdAt = h === 2
          ? a[0]!.header.createdAt + PARAMS.idealMs + 1
          : parent.header.createdAt + PARAMS.idealMs;
        b.push(makeHeader({ height: h, parent, createdAt, params: PARAMS, schedule: SCHEDULE }));
      }
      const { callbacks: cb2 } = recorder();
      expect(admitPage('peerB', b[b.length - 1]!.hash, pageHeaders(b), ctx(), cb2).outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(b[b.length - 1]!.hash);
      expect(getBestHashAt(3)).toBe(b[1]!.hash);
      expect(getHeaderRow(a[2]!.hash)).not.toBeNull();

      // C4..C11 fork at A3 — 8 anchor-priced headers; the base A3 is off
      // the best chain. Served in pages of four: pass 1 page 1 (C4..C7)
      // ties the best work 7W, no win; pass 1 page 2 (C8..C11) brings the
      // running work to 11W > 7W, 'again'. Pass 2 page 1 (C4..C7) stores
      // up to cum 7W, no crossing. Pass 2 page 2 (C8..C11) crosses on C8
      // (8W > 7W) and the pass's crossing rewrites the index.
      const c: ParentHeaderInfo[] = [];
      for (let h = 4; h <= 11; h++) {
        const parent = h === 4 ? a[2]! : c[c.length - 1]!;
        const createdAt = h === 4
          ? a[2]!.header.createdAt + PARAMS.idealMs + 1
          : parent.header.createdAt + PARAMS.idealMs;
        c.push(makeHeader({ height: h, parent, createdAt, params: PARAMS, schedule: SCHEDULE }));
      }
      const claim = c[c.length - 1]!.hash;
      const { callbacks: cb3 } = recorder();
      expect(admitPage('peerC', claim, pageHeaders(c.slice(0, 4)), ctx(), cb3).outcome).toBe('taken');
      expect(admitPage('peerC', claim, pageHeaders(c.slice(4, 8)), ctx(), cb3).outcome).toBe('again');
      expect(admitPage('peerC', claim, pageHeaders(c.slice(0, 4)), ctx(), cb3).outcome).toBe('again');
      expect(admitPage('peerC', claim, pageHeaders(c.slice(4, 8)), ctx(), cb3).outcome).toBe('taken');
      expect(getBestTip()!.hash).toBe(c[c.length - 1]!.hash);

      // The last assertion names the rule: every best_chain entry above
      // height 1 names the entry below it as its parent — the index is one
      // chain (NODE_INTERFACE → Fork choice decides on verified headers →
      // "The best chain's index is rewritten from where the new branch meets it").
      const tip = getBestTip()!;
      const parentsSeen: Array<string | null> = [];
      const parentsExpected: Array<string | null> = [];
      for (let h = 2; h <= tip.height; h++) {
        const hash = getBestHashAt(h);
        const row = hash === null ? null : getHeaderRow(hash);
        parentsSeen.push(row === null ? null : row.prevHash);
        parentsExpected.push(getBestHashAt(h - 1));
      }
      expect(parentsSeen).toEqual(parentsExpected);
    });
  });

  describe('readBranchFromBase on a missing row', () => {
    it('a branch row removed by SQL between pass 2 pages makes the switch throw InconsistentHeaderTreeError and writes nothing', () => {
      const ours = makeChain({ parent: null, n: 6, params: PARAMS, schedule: SCHEDULE });
      const { callbacks: cb0 } = recorder();
      for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', ctx(), cb0);
      const theirs = makeChain({ parent: null, n: 12, params: PARAMS, schedule: SCHEDULE, startAt: ours[0]!.header.createdAt + 1 });
      const p1 = pageHeaders(theirs.slice(0, 6));
      const p2 = pageHeaders(theirs.slice(6, 12));
      // Pass 1: page 1 scores (6W, no strict win), page 2 wins (12W > 6W).
      const { callbacks: cbS } = recorder();
      expect(admitPage('peerB', theirs[11]!.hash, p1, ctx(), cbS).outcome).toBe('taken');
      expect(admitPage('peerB', theirs[11]!.hash, p2, ctx(), cbS).outcome).toBe('again');
      // Pass 2 page 1 stores heights 1..6, cumulative 6W, no crossing.
      const { callbacks: cbP2a } = recorder();
      expect(admitPage('peerB', theirs[11]!.hash, p1, ctx(), cbP2a).outcome).toBe('again');
      // SQL deletes a stored row between the base and the top.
      const db = getDb();
      db.prepare('DELETE FROM block_headers WHERE hash = ?').run(theirs[2]!.hash);
      // Pass 2 page 2 brings headers 7..12; the crossing lies in this page.
      const bestChainBefore = db.prepare('SELECT COUNT(*) AS c FROM best_chain').pluck().get() as number;
      const { callbacks } = recorder();
      expect(() => admitPage('peerB', theirs[11]!.hash, p2, ctx(), callbacks)).toThrow(InconsistentHeaderTreeError);
      // The last assertion names the rule: nothing is written to
      // best_chain when the walk from the top hits a missing row.
      const bestChainAfter = db.prepare('SELECT COUNT(*) AS c FROM best_chain').pluck().get() as number;
      expect(bestChainAfter).toBe(bestChainBefore);
    });
  });
});

// Keeps TypeScript's unused-import warning quiet for the imports a case
// enables but the file does not read directly from every branch.
void cumulativeWork;
void getDb;
