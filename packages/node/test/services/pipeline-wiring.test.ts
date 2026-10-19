import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// `db.ts`, `header-pipeline.ts` and `intake.ts` are imported dynamically in
// each case so a `vi.resetModules()` keeps the whole graph aligned.
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';

// NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
// at a time" is wired to net through the registrations in `src/index.ts`:
// `net.onOrderingBlock` routes to the intake's gossip entry, `net.setPipeline`
// takes the intake's two deliver methods, `net.setChainView` takes the chain
// view (locatorFor / knowsTip / wantedBlocks / fullyApplied / gateHeld), and
// `net.onPeerDisconnected` routes to the intake. The chain view's reads that
// decode a stored row are handed over wrapped in `failStopIfCorruptChain`
// (NODE_INTERFACE → Sync handlers (pull-path), the `setChainView` row).

interface Captured {
  pipeline: {
    deliverHeaders?: (peerId: string, claimHash: string, headers: BlockHeader[]) => Promise<boolean>;
    deliverBlocks?: (peerId: string, blocks: OrderingBlock[]) => Promise<void>;
  };
  chainView: {
    locatorFor?: (peerId: string) => string[];
    knowsTip?: (peerId: string, hash: string) => boolean;
    wantedBlocks?: () => { id: string; height: number }[];
    fullyApplied?: () => boolean;
    gateHeld?: () => void;
  };
  onOrderingBlock?: (block: OrderingBlock, fromPeerId: string) => void;
  onPeerActive?: (peerId: string, direction: 'inbound' | 'outbound') => void;
  onPeerDisconnected?: (peerId: string, reason: string) => void;
  onPeerPenalised?: (peerId: string, kind: string, detail: string | null) => void;
  onSyncComplete?: () => void;
  penalizePeerCalls: Array<{ peerId: string; kind: 'misbehavior' | 'transient'; reason: string }>;
  chainMovedCalls: number;
  needHeadersCalls: string[];
}

function makeFakeNet(cap: Captured): unknown {
  return {
    setPipeline: (intake: Captured['pipeline']) => { cap.pipeline = intake; },
    setChainView: (view: Captured['chainView']) => { cap.chainView = view; },
    onOrderingBlock: (fn: Captured['onOrderingBlock']) => { cap.onOrderingBlock = fn; },
    onTx: () => {},
    onPeerActive: (fn: Captured['onPeerActive']) => { cap.onPeerActive = fn; },
    onPeerDisconnected: (fn: Captured['onPeerDisconnected']) => { cap.onPeerDisconnected = fn; },
    onPeerPenalised: (fn: Captured['onPeerPenalised']) => { cap.onPeerPenalised = fn; },
    onSyncComplete: (fn: Captured['onSyncComplete']) => { cap.onSyncComplete = fn; },
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
      cap.penalizePeerCalls.push({ peerId, kind, reason });
    },
    chainMoved: () => { cap.chainMovedCalls += 1; },
    needHeaders: (peerId: string) => { cap.needHeadersCalls.push(peerId); },
    requestPostBodies: async () => [],
    getConnectedPeers: () => [],
  };
}

function freshCap(): Captured {
  return {
    pipeline: {},
    chainView: {},
    penalizePeerCalls: [],
    chainMovedCalls: 0,
    needHeadersCalls: [],
  };
}

describe('pipeline wired to net — registrations', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await import('../../src/store/db.js');
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const pipeline = await import('../../src/services/header-pipeline.js');
    const intake = await import('../../src/services/intake.js');
    intake.resetIntakeForTests();
    pipeline.resetPipelineForTests();
  });

  afterEach(async () => {
    const db = await import('../../src/store/db.js');
    db.closeDb();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('wireNet calls setPipeline with the intake deliverHeaders / deliverBlocks', async () => {
    const cap = freshCap();
    const { wireNet } = await import('../../src/services/net-wiring.js');
    wireNet(makeFakeNet(cap) as never);
    expect(typeof cap.pipeline.deliverHeaders).toBe('function');
    expect(typeof cap.pipeline.deliverBlocks).toBe('function');
  });

  it('wireNet calls setChainView with locatorFor / knowsTip / wantedBlocks / fullyApplied / gateHeld', async () => {
    const cap = freshCap();
    const { wireNet } = await import('../../src/services/net-wiring.js');
    wireNet(makeFakeNet(cap) as never);
    expect(typeof cap.chainView.locatorFor).toBe('function');
    expect(typeof cap.chainView.knowsTip).toBe('function');
    expect(typeof cap.chainView.wantedBlocks).toBe('function');
    expect(typeof cap.chainView.fullyApplied).toBe('function');
    expect(typeof cap.chainView.gateHeld).toBe('function');
  });

  it('wireNet registers an onOrderingBlock handler that routes a gossiped block to the intake', async () => {
    const cap = freshCap();
    const { wireNet } = await import('../../src/services/net-wiring.js');
    wireNet(makeFakeNet(cap) as never);
    expect(typeof cap.onOrderingBlock).toBe('function');
    const block: OrderingBlock = {
      header: {
        protocolVersion: 1,
        height: 1,
        prevBlockHash: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 3072,
        createdAt: 1,
        interlinkRoot: '00'.repeat(32),
        adProofsRoot: '00'.repeat(32),
      },
      utxoTxTree: { utxoTxIds: ['ff'.repeat(32)], utxoTxs: [new Uint8Array(0)] },
      validatorSignature: new Uint8Array(64),
    };
    cap.onOrderingBlock!(block, 'peerR');
    // Give the microtask the intake schedules a tick to settle.
    await Promise.resolve();
    await Promise.resolve();
    // A height-1 header with GENESIS_PREV_BLOCK_HASH as parent reaches
    // admission, which may need headers for its relayer, or score it against
    // the pinned genesisId. Either way a wire-callback fires — a signal the
    // dispatch happened. A pristine chain would otherwise see neither.
    expect(cap.penalizePeerCalls.length + cap.needHeadersCalls.length).toBeGreaterThan(0);
  });

  it('wireNet registers an onPeerDisconnected handler that routes to the intake', async () => {
    const cap = freshCap();
    const { wireNet } = await import('../../src/services/net-wiring.js');
    wireNet(makeFakeNet(cap) as never);
    expect(typeof cap.onPeerDisconnected).toBe('function');
    // No crash on an unknown peer — the hook is idempotent and does the
    // intake and pipeline bookkeeping.
    expect(() => cap.onPeerDisconnected!('peerX', '')).not.toThrow();
  });

  it('a gossiped block pending for a relayer is dropped when onPeerDisconnected fires for that relayer', async () => {
    // The gossip entry (`net.onOrderingBlock`) routes to the intake, which
    // stores the block as pending when its header's parent is not in the
    // tree. The wire-level `onPeerDisconnected` handler the wiring installs
    // then clears every pending entry for the departed peer (NODE_INTERFACE →
    // Fork choice decides on verified headers → "One intake, one at a time").
    const cap = freshCap();
    const { wireNet } = await import('../../src/services/net-wiring.js');
    wireNet(makeFakeNet(cap) as never);

    const block: OrderingBlock = {
      header: {
        protocolVersion: 1,
        height: 2,
        prevBlockHash: 'ee'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 3072,
        createdAt: 2,
        interlinkRoot: '00'.repeat(32),
        adProofsRoot: '00'.repeat(32),
      },
      utxoTxTree: { utxoTxIds: ['ff'.repeat(32)], utxoTxs: [new Uint8Array(0)] },
      validatorSignature: new Uint8Array(64),
    };
    cap.onOrderingBlock!(block, 'peerR');
    // Microtasks the intake schedules settle.
    await Promise.resolve();
    await Promise.resolve();

    const intake = await import('../../src/services/intake.js');
    expect(intake.getPendingBlockForTests('peerR')?.header.height).toBe(2);

    cap.onPeerDisconnected!('peerR', '');
    // The last assertion names the rule: the pending block is dropped by the
    // wire-level disconnect handler.
    expect(intake.getPendingBlockForTests('peerR')).toBeUndefined();
  });

  it('a chain view read over a poisoned block_headers row reaches the fail-stop seam', async () => {
    // The row's `header_bytes` is bytes a decoder refuses — a stored row that
    // will not decode is local corruption, and the chain view's wrapper hands
    // it to the fail-stop seam (NODE_INTERFACE → Sync handlers (pull-path)).
    const cap = freshCap();
    const { wireNet } = await import('../../src/services/net-wiring.js');
    wireNet(makeFakeNet(cap) as never);

    // Write a block_headers row whose header_bytes are nonsense, and point
    // best_chain at it. `wantedBlocks` traverses `best_chain` and reads a
    // header row through `getHeaderRow` to compare chain_work.
    const { getDb } = await import('../../src/store/db.js');
    const db = getDb();
    const hashHex = 'aa'.repeat(32);
    const prevHex = '00'.repeat(32);
    db.prepare(
      `INSERT INTO block_headers (hash, height, prev_hash, header_bytes, interlinks, chain_work, path_t_a)
       VALUES (?, 1, ?, ?, ?, ?, 0)`,
    ).run(hashHex, prevHex, Buffer.from([0xff, 0xff, 0xff]), Buffer.alloc(0), Buffer.alloc(40));
    db.prepare(`INSERT INTO best_chain (height, hash) VALUES (1, ?)`).run(hashHex);

    // Spy on process.exit — the chain view's wrap calls failStopIfCorruptChain,
    // which exits for the corrupt-state family.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => {
      throw new Error('process.exit called');
    }) as unknown as typeof process.exit);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      cap.chainView.wantedBlocks!();
    } catch {
      /* exit threw — expected */
    }
    expect(exitSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  // NODE_INTERFACE → Fork choice decides on verified headers →
  // "The intake owns what it runs".
  it.fails('a chain view hold over a poisoned block_headers row reaches the fail-stop seam', async () => {
    const cap = freshCap();
    const { wireNet } = await import('../../src/services/net-wiring.js');
    wireNet(makeFakeNet(cap) as never);

    const { getDb } = await import('../../src/store/db.js');
    const db = getDb();
    const hashHex = 'aa'.repeat(32);
    const prevHex = '00'.repeat(32);
    db.prepare(
      `INSERT INTO block_headers (hash, height, prev_hash, header_bytes, interlinks, chain_work, path_t_a)
       VALUES (?, 1, ?, ?, ?, ?, 0)`,
    ).run(hashHex, prevHex, Buffer.from([0xff, 0xff, 0xff]), Buffer.alloc(0), Buffer.alloc(40));
    db.prepare(`INSERT INTO best_chain (height, hash) VALUES (1, ?)`).run(hashHex);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => {
      throw new Error('process.exit called');
    }) as unknown as typeof process.exit);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      cap.chainView.gateHeld!();
    } catch {
      /* exit threw — expected */
    }
    // The last assertion names the rule: a corrupt-state error inside the
    // hold's item reaches the fail-stop seam through the chain view's wrapper.
    expect(exitSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
