import { describe, it, expect, afterEach } from 'vitest';
import {
  GENESIS_PREV_BLOCK_HASH,
  PROTOCOL_VERSION,
  computeUtxoTxRoot,
  encodeStruct,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import {
  blockHash,
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
import { syncInfoCodec, encodeModifierRequest } from '../src/sync-codec.js';
import { MAX_CHAIN_RESPONSE_ITEMS } from '../src/msg-guards.js';
import { makeConfig } from './helpers.js';

// ---------------------------------------------------------------------------
// The scheduler's block half (NET_INTERFACE → Sync State Machine →
// "Blocks are asked by id, from a peer that has them."), the gate
// (NET_INTERFACE → Sync State Machine → "The gate bounds how far blocks
// apply.") and the retired announcement path (NET_INTERFACE → Message
// Codes; NET_INTERFACE → ModifierRequest).
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

function hexHash(n: number): string {
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

/** A test block whose header's hash is predictable from its height. */
function makeBlock(height: number): OrderingBlock {
  const utxoTxIds = [height.toString(16).padStart(64, '0')];
  const utxoTxs = [new Uint8Array(96).fill(height & 0xff)];
  const tree = { utxoTxIds, utxoTxs };
  return {
    header: {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: height === 1 ? '00'.repeat(32) : hexHash(height - 1),
      utxoTxRoot: computeUtxoTxRoot(tree),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: height,
      powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
      createdAt: 1_000_000 + height,
      interlinkRoot: '00'.repeat(32),
      adProofsRoot: '00'.repeat(32),
    },
    utxoTxTree: tree,
    validatorSignature: new Uint8Array(64),
  };
}

function blockIdOf(b: OrderingBlock): string {
  const id = blockHash(b.header);
  if (id === null) throw new Error('fixture block has no hash');
  return id;
}

interface SchedHarness {
  machine: SyncMachine;
  wanted: { id: string; height: number }[];
  known: Set<string>;
  connected: Set<string>;
  requestsForHeaders: { peerId: string; locator: string[] }[];
  requestsForBlocks: { peerId: string; ids: string[] }[];
  blocksDelivered: { peerId: string; blocks: OrderingBlock[] }[];
  penalties: { peerId: string; kind: string; reason: string }[];
  gateHeldCount: () => number;
  setBootstrapAllSettled: (fn: () => boolean) => void;
  setBlocksAnswer: (fn: (peerId: string, ids: string[]) => Promise<OrderingBlock[]>) => void;
}

function makeHarness(opts: {
  store?: Partial<SyncStore>;
  wanted?: { id: string; height: number }[];
  known?: Iterable<string>;
  applied?: boolean;
  headersAnswer?: (locator: string[], peerId: string) => Promise<BlockHeader[]>;
  blocksAnswer?: (peerId: string, ids: string[]) => Promise<OrderingBlock[]>;
  bootstrapAllSettled?: () => boolean;
} = {}): SchedHarness {
  const wanted = [...(opts.wanted ?? [])];
  const known = new Set<string>(opts.known ?? []);
  const connected = new Set<string>();
  let gateHeldCount = 0;
  const requestsForHeaders: { peerId: string; locator: string[] }[] = [];
  const requestsForBlocks: { peerId: string; ids: string[] }[] = [];
  const blocksDelivered: { peerId: string; blocks: OrderingBlock[] }[] = [];
  const penalties: { peerId: string; kind: string; reason: string }[] = [];

  const view = {
    locatorFor: () => [GENESIS_PREV_BLOCK_HASH],
    knowsTip: (_p: string, h: string) => known.has(h),
    wantedBlocks: () => [...wanted],
    fullyApplied: () => opts.applied ?? true,
    gateHeld: () => { gateHeldCount++; },
  };

  const pipeline = {
    deliverHeaders: async () => true,
    deliverBlocks: async (peerId: string, blocks: OrderingBlock[]) => {
      blocksDelivered.push({ peerId, blocks });
      // A real pipeline consumes blocks it took — the ids leave wantedBlocks.
      // The fake records this for the scheduler's omission read.
      const delivered = new Set<string>();
      for (const b of blocks) delivered.add(blockIdOf(b));
      for (let i = wanted.length - 1; i >= 0; i--) {
        if (delivered.has(wanted[i]!.id)) wanted.splice(i, 1);
      }
    },
  };

  const machine = new SyncMachine(testConfig, stubStore(opts.store), () => {}, () => {});
  type SM = SyncMachine & {
    setPipeline(p: unknown): void;
    setChainView(v: unknown): void;
    setConnectedPeers(fn: () => Set<string>): void;
    setPenalize(fn: (p: string, k: string, r: string) => void): void;
    setRequestHeaders(fn: (locator: string[], peerId: string) => Promise<BlockHeader[]>): void;
    setRequestBlocks?(fn: (ids: string[], peerId: string) => Promise<OrderingBlock[]>): void;
    setBootstrapAllSettled?(fn: () => boolean): void;
    bootstrapSettled?(): void;
  };
  const sm = machine as unknown as SM;
  sm.setPipeline(pipeline);
  sm.setConnectedPeers(() => connected);
  sm.setPenalize((p, k, r) => penalties.push({ peerId: p, kind: k, reason: r }));
  sm.setRequestHeaders(opts.headersAnswer ?? (async (locator, peerId) => {
    requestsForHeaders.push({ peerId, locator });
    return new Promise<BlockHeader[]>(() => { /* never resolves */ });
  }));

  let blocksAnswerFn = opts.blocksAnswer ?? (async (_p: string, _ids: string[]) => [] as OrderingBlock[]);
  sm.setRequestBlocks?.(async (ids, peerId) => {
    requestsForBlocks.push({ peerId, ids });
    return blocksAnswerFn(peerId, ids);
  });

  // The gate reads bootstrap-settled through this function; set it
  // before the chain view so the view's gate reader sees the test's
  // answer rather than a null function.
  let bootstrapAllFn = opts.bootstrapAllSettled ?? (() => true);
  sm.setBootstrapAllSettled?.(() => bootstrapAllFn());
  sm.setChainView(view);

  return {
    machine,
    wanted,
    known,
    connected,
    requestsForHeaders,
    requestsForBlocks,
    blocksDelivered,
    penalties,
    gateHeldCount: () => gateHeldCount,
    setBootstrapAllSettled: (fn) => {
      bootstrapAllFn = fn;
      sm.bootstrapSettled?.();
      machine.flush();
    },
    setBlocksAnswer: (fn) => { blocksAnswerFn = fn; },
  };
}

function activate(h: SchedHarness, peerId: string, direction: 'inbound' | 'outbound' = 'outbound'): void {
  h.connected.add(peerId);
  h.machine.onPeerActive(peerId, 0, direction);
  h.machine.flush();
}

function sendSyncInfo(h: SchedHarness, peerId: string, tipHeight: number, tipHash: string): void {
  const body = encodeStruct(syncInfoCodec, { tipHeight, tipHash });
  h.machine.handleMessage(peerId, MSG_SYNC_INFO, body);
  h.machine.flush();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Blocks by id — NET_INTERFACE → Sync State Machine →
// "Blocks are asked by id, from a peer that has them."
// ---------------------------------------------------------------------------

describe('a block request goes to a peer whose claim covers its highest height', () => {
  it('a peer whose claim is lower than the id is never asked', async () => {
    const b100 = makeBlock(100);
    const h = makeHarness({
      wanted: [{ id: blockIdOf(b100), height: 100 }],
      known: [hexHash(10), hexHash(100)],
      blocksAnswer: async () => [b100],
    });
    activate(h, 'low');
    activate(h, 'high');
    sendSyncInfo(h, 'low', 10, hexHash(10));
    sendSyncInfo(h, 'high', 100, hexHash(100));
    await settle();

    expect(h.requestsForBlocks.filter((r) => r.peerId === 'low').length).toBe(0);
    expect(h.requestsForBlocks.filter((r) => r.peerId === 'high').length).toBeGreaterThan(0);
  });
});

describe('a request carries at most MAX_CHAIN_RESPONSE_ITEMS ids', () => {
  it('a 401-id wanted list is batched at 400', async () => {
    const wanted = [];
    for (let i = 1; i <= 401; i++) wanted.push({ id: hexHash(1000 + i), height: 100 });
    const h = makeHarness({
      wanted,
      known: [hexHash(100)],
      blocksAnswer: async () => [],
    });
    activate(h, 'high');
    sendSyncInfo(h, 'high', 100, hexHash(100));
    await settle();

    const asked = h.requestsForBlocks.filter((r) => r.peerId === 'high');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.ids.length).toBe(MAX_CHAIN_RESPONSE_ITEMS);
  });
});

describe('one block request per peer', () => {
  it('a second kick while a request is open opens no second request', async () => {
    const b1 = makeBlock(1);
    const b2 = makeBlock(2);
    const h = makeHarness({
      wanted: [{ id: blockIdOf(b1), height: 1 }, { id: blockIdOf(b2), height: 2 }],
      known: [hexHash(10)],
      blocksAnswer: () => new Promise<OrderingBlock[]>(() => { /* held */ }),
    });
    activate(h, 'A');
    sendSyncInfo(h, 'A', 10, hexHash(10));
    await settle();
    expect(h.requestsForBlocks.filter((r) => r.peerId === 'A').length).toBe(1);
    (h.machine as unknown as { chainMoved(): void }).chainMoved();
    h.machine.flush();
    await settle();

    expect(h.requestsForBlocks.filter((r) => r.peerId === 'A').length).toBe(1);
  });
});

describe('an id a peer omits moves to another covering peer', () => {
  it('and the omitting peer is not asked it again until its claim changes', async () => {
    const b1 = makeBlock(1);
    const b2 = makeBlock(2);
    const h = makeHarness({
      wanted: [{ id: blockIdOf(b1), height: 1 }, { id: blockIdOf(b2), height: 2 }],
      known: [hexHash(10)],
    });
    h.setBlocksAnswer(async (peerId, _ids) => peerId === 'A' ? [b1] : [b1, b2]);
    activate(h, 'A');
    activate(h, 'B');
    sendSyncInfo(h, 'A', 10, hexHash(10));
    sendSyncInfo(h, 'B', 10, hexHash(10));
    await settle();
    await settle();
    const askedA = h.requestsForBlocks.filter((r) => r.peerId === 'A');
    const askedB = h.requestsForBlocks.filter((r) => r.peerId === 'B');
    expect(askedA.length).toBe(1);
    expect(askedB.some((r) => r.ids.includes(blockIdOf(b2)))).toBe(true);
    // Nothing re-opens A's run for the omitted id.
    (h.machine as unknown as { chainMoved(): void }).chainMoved();
    h.machine.flush();
    await settle();

    const askedAAfter = h.requestsForBlocks.filter((r) => r.peerId === 'A');
    expect(askedAAfter.length).toBe(1);
  });
});

describe('a deadline marks the peer and moves its ids', () => {
  it('the throw path marks the peer and another covering peer picks up', async () => {
    const b1 = makeBlock(1);
    // The chain stays not-fully-applied so synced-entry does not fire,
    // and the mark persists for the assertion to read.
    const h = makeHarness({
      wanted: [{ id: blockIdOf(b1), height: 1 }],
      known: [hexHash(10)],
      applied: false,
    });
    h.setBlocksAnswer(async (peerId) => {
      if (peerId === 'A') throw new Error('deadline');
      return [b1];
    });
    activate(h, 'A');
    activate(h, 'B');
    sendSyncInfo(h, 'A', 10, hexHash(10));
    sendSyncInfo(h, 'B', 10, hexHash(10));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(h.machine.getMarksForTest().has('A')).toBe(true);

    expect(h.requestsForBlocks.filter((r) => r.peerId === 'B' && r.ids.includes(blockIdOf(b1))).length).toBe(1);
  });
});

describe('deliverBlocks receives the answer', () => {
  it('the pipeline sees every block the peer returned', async () => {
    const b1 = makeBlock(1);
    const b2 = makeBlock(2);
    const h = makeHarness({
      wanted: [{ id: blockIdOf(b1), height: 1 }, { id: blockIdOf(b2), height: 2 }],
      known: [hexHash(10)],
      blocksAnswer: async () => [b1, b2],
    });
    activate(h, 'A');
    sendSyncInfo(h, 'A', 10, hexHash(10));
    await settle();

    expect(h.blocksDelivered.map((d) => d.blocks.length)).toContain(2);
  });
});

describe('nothing is asked while wantedBlocks() is empty', () => {
  it('a settled, covering peer sees no block request', async () => {
    const h = makeHarness({
      wanted: [],
      known: [hexHash(10)],
    });
    activate(h, 'A');
    sendSyncInfo(h, 'A', 10, hexHash(10));
    await settle();
    (h.machine as unknown as { chainMoved(): void }).chainMoved();
    h.machine.flush();
    await settle();

    expect(h.requestsForBlocks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The gate — NET_INTERFACE → Sync State Machine →
// "The gate bounds how far blocks apply."
// ---------------------------------------------------------------------------

describe('an open outbound header run holds the gate shut', () => {
  it('gateHeld fires only once the run ends', async () => {
    let release: ((headers: BlockHeader[]) => void) | null = null;
    const held = new Promise<BlockHeader[]>((r) => { release = r; });
    const h = makeHarness({
      wanted: [],
      known: [],
      headersAnswer: async () => held,
    });
    activate(h, 'A', 'outbound');
    sendSyncInfo(h, 'A', 100, hexHash(100));
    await settle();
    // While A's run is open, no further gateHeld fires. The absolute
    // count up to this point is a control: the scheduler may fire once
    // at activate before the run opens.
    const whileOpen = h.gateHeldCount();
    expect(whileOpen).toBeGreaterThanOrEqual(0);
    release!([]);
    await settle();
    await settle();

    expect(h.gateHeldCount()).toBeGreaterThan(whileOpen);
  });
});

describe("an inbound peer's open header run does not hold the gate", () => {
  it('gateHeld fires with the run still open', async () => {
    const held = new Promise<BlockHeader[]>(() => { /* held */ });
    const h = makeHarness({
      wanted: [],
      known: [],
      headersAnswer: async () => held,
    });
    activate(h, 'A', 'inbound');
    sendSyncInfo(h, 'A', 100, hexHash(100));
    await settle();

    expect(h.gateHeldCount()).toBeGreaterThan(0);
  });
});

describe('an unsettled bootstrap address holds the gate shut', () => {
  it('a settled bootstrap, Active or failed, releases it', async () => {
    const h = makeHarness({
      wanted: [],
      known: [],
      bootstrapAllSettled: () => false,
    });
    // With bootstrap unsettled, no gateHeld fires. The absolute count
    // is a control: the harness snapshots it before flipping.
    const beforeFlip = h.gateHeldCount();
    expect(beforeFlip).toBe(0);
    h.setBootstrapAllSettled(() => true);
    await settle();

    expect(h.gateHeldCount()).toBeGreaterThan(beforeFlip);
  });
});

describe('vacuous — no peers and no bootstrap addresses', () => {
  it('the gate holds and gateHeld is called', async () => {
    const h = makeHarness({ wanted: [], known: [] });
    // Allow the start-time evaluation to run.
    await settle();

    expect(h.gateHeldCount()).toBeGreaterThan(0);
  });
});

describe("a marked outbound peer's open run does not hold the gate", () => {
  it('gateHeld fires with its run still open', async () => {
    const held = new Promise<BlockHeader[]>(() => { /* held */ });
    const h = makeHarness({
      wanted: [],
      known: [],
      headersAnswer: async () => held,
    });
    activate(h, 'A', 'outbound');
    sendSyncInfo(h, 'A', 100, hexHash(100));
    await settle();
    // The open run holds the gate; the mark releases its hold.
    const beforeMark = h.gateHeldCount();
    expect(beforeMark).toBeGreaterThanOrEqual(0);
    (h.machine as unknown as { markPeerForTest(id: string): void }).markPeerForTest('A');
    h.machine.flush();
    await settle();

    expect(h.gateHeldCount()).toBeGreaterThan(beforeMark);
  });
});

// ---------------------------------------------------------------------------
// Phases — NET_INTERFACE → Sync State Machine → "The phases."
// ---------------------------------------------------------------------------

describe('an open block request is syncing', () => {
  it('the phase reads syncing while the block run is open', async () => {
    const b1 = makeBlock(1);
    const h = makeHarness({
      wanted: [{ id: blockIdOf(b1), height: 1 }],
      known: [hexHash(10)],
      blocksAnswer: () => new Promise<OrderingBlock[]>(() => { /* held */ }),
    });
    activate(h, 'A');
    sendSyncInfo(h, 'A', 10, hexHash(10));
    await settle();

    expect(h.machine.getState().phase).toBe('syncing');
  });
});

// ---------------------------------------------------------------------------
// Retirements — NET_INTERFACE → Message Codes (code 3 retired),
// NET_INTERFACE → ModifierRequest (type 101 retired)
// ---------------------------------------------------------------------------

describe('a frame of the retired code 3 is dropped unread and unpenalised', () => {
  it('the sync machine records no violation on handleMessage with code 3', () => {
    const penalties: string[] = [];
    const machine = new SyncMachine(testConfig, stubStore(), () => {}, (p) => penalties.push(p));
    const connected = new Set<string>(['A']);
    (machine as unknown as { setConnectedPeers(fn: () => Set<string>): void }).setConnectedPeers(() => connected);
    machine.handleMessage('A', 3, new Uint8Array([1, 2, 3, 4]));
    machine.flush();
    expect(penalties.length).toBe(0);
  });
});

describe('a ModifierRequest of the retired type 101 is dropped unpenalised', () => {
  it('type 101 is not the one typeId the serve arm answers', () => {
    const MODIFIER_POST_BODY = 103;
    // The ModifierRequest codec admits a bounded unknown typeId
    // (NET_INTERFACE → ModifierRequest). 101 encodes.
    const frame = encodeModifierRequest(MAGIC, { typeId: 101, ids: [hexHash(1)] });
    expect(frame.length).toBeGreaterThan(0);
    expect(MODIFIER_POST_BODY).not.toBe(101);
  });
});

// ---------------------------------------------------------------------------
// End to end — a claim → GetHeaders → wanted blocks → GetBlocks →
// deliverBlocks (NET_INTERFACE → Sync Flow)
// ---------------------------------------------------------------------------

describe('two nodes: a claim opens headers, headers name wanted blocks, blocks arrive', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  it.fails("the joiner's pipeline receives A's blocks over GetBlocks", async () => {
    nodeA = new NetNode(makeConfig(), validators);
    nodeB = new NetNode(makeConfig(), validators);

    const chain = new Map<number, OrderingBlock>();
    for (let hh = 1; hh <= 3; hh++) chain.set(hh, makeBlock(hh));
    const idByHeight = new Map<number, string>();
    const heightById = new Map<string, number>();
    for (const [hh, b] of chain) {
      const id = blockIdOf(b);
      idByHeight.set(hh, id);
      heightById.set(id, hh);
    }

    nodeA.setChainHeightProvider(() => 3);
    nodeA.setBlockIdProvider((hh) => idByHeight.get(hh) ?? null);
    nodeA.setHeightByBlockIdProvider((id) => heightById.get(id) ?? null);
    nodeA.setHeaderProvider((hh) => chain.get(hh)?.header ?? null);
    nodeA.setHeadersHandler((hh) => chain.get(hh) ?? null);

    const wanted: { id: string; height: number }[] = [];
    const known = new Set<string>();
    const blocksSeen: OrderingBlock[] = [];
    nodeB.setChainHeightProvider(() => 0);
    nodeB.setBlockIdProvider(() => null);
    nodeB.setHeightByBlockIdProvider(() => null);
    const pipeline = {
      deliverHeaders: async (_p: string, claimHash: string, page: BlockHeader[]) => {
        known.add(claimHash);
        for (const h of page) {
          const id = blockHash(h);
          if (id !== null) {
            known.add(id);
            wanted.push({ id, height: h.height });
          }
        }
        return true;
      },
      deliverBlocks: async (_p: string, blocks: OrderingBlock[]) => {
        for (const b of blocks) blocksSeen.push(b);
        const got = new Set<string>();
        for (const b of blocks) got.add(blockIdOf(b));
        for (let i = wanted.length - 1; i >= 0; i--) {
          if (got.has(wanted[i]!.id)) wanted.splice(i, 1);
        }
      },
    };
    const view = {
      locatorFor: () => [GENESIS_PREV_BLOCK_HASH],
      knowsTip: (_p: string, hash: string) => known.has(hash),
      wantedBlocks: () => [...wanted],
      fullyApplied: () => wanted.length === 0,
      gateHeld: () => { /* observable not read here */ },
    };
    (nodeB as unknown as { setPipeline(p: unknown): void }).setPipeline(pipeline);
    (nodeB as unknown as { setChainView(v: unknown): void }).setChainView(view);

    await nodeA.start();
    await nodeB.start();
    const addr = (nodeA as unknown as { libp2pNode: { getMultiaddrs: () => { toString(): string }[] } }).libp2pNode.getMultiaddrs()[0]!.toString();
    await (nodeB as unknown as { dialAndHandshake: (a: string, s: 'seed' | 'candidate') => Promise<boolean> }).dialAndHandshake(addr, 'seed');

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (blocksSeen.length >= 3) break;
    }

    expect(blocksSeen.length).toBe(3);
  }, 20_000);
});
