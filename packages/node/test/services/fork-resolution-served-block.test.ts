import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  blockHash,
  cumulativeWork,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyValidatorSignature,
} from '@dagsocial/validation';
import { computeTxId, computeUtxoTxRoot, decodeTx, encodeTx } from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import {
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestIdentity,
  revertChainTo,
  seedBoxes,
  signHeader,
  solveHeaderPow,
} from '../helpers.js';
import {
  testConfig,
  importOrdering,
  installTrackers,
  teardownTrackers,
  settleResolveForks,
  T1,
  HL,
  initChainStore,
  startCreator,
  buildAndApply,
  singleBranchNet,
} from './fork-resolution-fixtures.js';
import type { Trackers } from './fork-resolution-fixtures.js';

// ---------------------------------------------------------------------------
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A served block is bound to its header before it is kept"
//
// The hash alone says a served block carries the verified header; it does not
// say the body is the one that header's root commits, nor that the signature
// outside the root is one its `validatorId` holds. Each case here delivers a
// branch heavier than this node's whose first serve carries one block the peer
// altered. The honest second serve then stands or does not stand, depending on
// what the first serve left behind.
// ---------------------------------------------------------------------------

/** The branch and this node's own chain, built from a shared block. */
interface Scenario {
  readonly shared1: OrderingBlock;
  /** The branch's first block above the fork; carries one signed credit tx. */
  readonly branchFirst: OrderingBlock;
  /** The branch's last block, its tip. */
  readonly branchLast: OrderingBlock;
  /** This node's own tip above the fork. */
  readonly ourTip: OrderingBlock;
  readonly ourWork: bigint;
  readonly branchWork: bigint;
}

/**
 * The setting one case uses: a shared block, a credit box seeded against the
 * state both chains share, the heavier branch built from that state (its first
 * block above the fork spends the credit box in a signed transaction), and this
 * node's lighter chain. The branch has two blocks above the fork.
 */
async function buildScenario(): Promise<Scenario> {
  await initChainStore();
  await startCreator(testConfig);
  const [shared1] = await buildAndApply([[1, T1]]);
  // The box both chains share. Seeded after the shared block applied so the
  // tree version at the fork point holds it, which is where either branch
  // reads from.
  const spender = makeTestIdentity();
  const box = makeCreditBox(10n ** 8n, spender.userId, 0, 7);
  await seedBoxes([box]);
  const creditTx = makeCreditTx(spender, [box], 10n ** 6n);
  const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
    applyOrderingBlock: (b: OrderingBlock) => boolean;
  };
  const branchFirst = await makeApplicableBlock({
    height: 2,
    createdAt: T1 + 1,
    utxoTxs: [creditTx],
  });
  expect(applyOrderingBlock(branchFirst!)).toBe(true);
  const branchLast = await makeApplicableBlock({ height: 3, createdAt: T1 + 2 });
  expect(applyOrderingBlock(branchLast!)).toBe(true);
  await revertChainTo(1);
  const [ourTip] = await buildAndApply([[2, T1 + 60_000 + HL]]);
  const ourWork = cumulativeWork([ourTip!.header]);
  const branchWork = cumulativeWork([branchFirst!.header, branchLast!.header]);
  return { shared1: shared1!, branchFirst: branchFirst!, branchLast: branchLast!, ourTip: ourTip!, ourWork, branchWork };
}

/**
 * The serve sequence of the cases below. One peer serves `firstServe`, the
 * branch with one block altered: the tip stays this node's own and that peer
 * carries exactly one penalty, of kind `misbehavior`. A second peer then
 * serves the branch whole. Returns what the cases compare.
 */
async function serveAlteredThenHonest(
  sc: Scenario,
  ctx: Trackers,
  firstServe: readonly OrderingBlock[],
  alteredHash: string,
): Promise<{
  alteredMarked: boolean;
  tipHeight: number;
  tipHash: string | null;
  peerBPenalties: number;
  peerBAskedForBlocks: boolean;
}> {
  const ordering = await importOrdering();

  const peerA = singleBranchNet('peer-a', firstServe);
  const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
  expect(handleOrderingBlock(sc.branchLast, 'peer-a', peerA)).toBe(false);
  await settleResolveForks(ctx);

  expect(ordering.getCurrentHeight()).toBe(sc.ourTip.header.height);
  expect(ordering.getOrderingBlockHash(sc.ourTip.header.height)).toBe(blockHash(sc.ourTip.header));
  expect(peerA.penalties.length).toBe(1);
  expect(peerA.penalties[0]!.kind).toBe('misbehavior');

  const peerB = singleBranchNet('peer-b', [sc.shared1, sc.branchFirst, sc.branchLast]);
  expect(handleOrderingBlock(sc.branchLast, 'peer-b', peerB)).toBe(false);
  await settleResolveForks(ctx);

  const { anyRefusedHeader } = await import('../../src/store/refused-headers.js');
  return {
    alteredMarked: anyRefusedHeader([alteredHash]),
    tipHeight: ordering.getCurrentHeight(),
    tipHash: ordering.getOrderingBlockHash(ordering.getCurrentHeight()),
    peerBPenalties: peerB.penalties.length,
    peerBAskedForBlocks: peerB.blockCalls.count > 0,
  };
}

/**
 * The honest branch served whole: one peer, three blocks. The resolver
 * fetches the branch and switches the chain under its tip, no penalty.
 */
describe('a heavier branch served whole by one peer switches the chain', () => {
  const ctx: Trackers = { caughtCorrupt: [] };
  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the tip reaches the branch tip and the peer carries no penalty', async () => {
    const sc = await buildScenario();
    expect(sc.branchWork > sc.ourWork).toBe(true);

    const net = singleBranchNet('peer-honest', [sc.shared1, sc.branchFirst, sc.branchLast]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(sc.branchLast, 'peer-honest', net)).toBe(false);
    await settleResolveForks(ctx);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(sc.branchLast.header.height);
    expect(ordering.getOrderingBlockHash(sc.branchLast.header.height)).toBe(blockHash(sc.branchLast.header));
    expect(net.penalties).toEqual([]);
  });
});

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A served block is bound to its header before it is kept".
 *
 * One peer serves the branch's real headers and its blocks with one block
 * altered inside `utxoTxs[i]` — one byte of a signed transaction's signature
 * flipped. The honest header hashes the same bytes it did; the body does not.
 */
describe('a served block whose embedded transaction signature was altered', () => {
  const ctx: Trackers = { caughtCorrupt: [] };
  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  function alter(block: OrderingBlock): OrderingBlock {
    const decoded = decodeTx(block.utxoTxTree.utxoTxs[0]!);
    const key = Object.keys(decoded.signatures)[0]!;
    const sig = Uint8Array.from(decoded.signatures[key]!);
    sig[0] = sig[0]! ^ 1;
    decoded.signatures[key] = sig;
    const utxoTxs = [...block.utxoTxTree.utxoTxs];
    utxoTxs[0] = encodeTx(decoded);
    return { ...block, utxoTxTree: { ...block.utxoTxTree, utxoTxs } };
  }

  it('the altered element decodes, computes to the id beside it, differs in bytes, and the block passes structure and the validator signature', async () => {
    const sc = await buildScenario();
    const altered = alter(sc.branchFirst);
    expect(blockHash(altered.header)).toBe(blockHash(sc.branchFirst.header));
    const decoded: UtxoTransaction = decodeTx(altered.utxoTxTree.utxoTxs[0]!);
    expect(computeTxId(decoded)).toBe(altered.utxoTxTree.utxoTxIds[0]);
    const honestBytes = sc.branchFirst.utxoTxTree.utxoTxs[0]!;
    const alteredBytes = altered.utxoTxTree.utxoTxs[0]!;
    expect(Buffer.from(alteredBytes).equals(Buffer.from(honestBytes))).toBe(false);
    expect(verifyOrderingBlockStructure(altered).valid).toBe(true);
    expect(verifyValidatorSignature(altered.header, altered.validatorSignature)).toBe(true);
  });

  it.fails('the altered block is refused with no mark, and the honest branch then switches the chain', async () => {
    const sc = await buildScenario();
    expect(sc.branchWork > sc.ourWork).toBe(true);
    const altered = alter(sc.branchFirst);
    const alteredHash = blockHash(altered.header)!;

    const observed = await serveAlteredThenHonest(sc, ctx, [sc.shared1, altered, sc.branchLast], alteredHash);

    expect(observed).toEqual({
      alteredMarked: false,
      tipHeight: sc.branchLast.header.height,
      tipHash: blockHash(sc.branchLast.header),
      peerBPenalties: 0,
      peerBAskedForBlocks: true,
    });
  });
});

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A served block is bound to its header before it is kept".
 *
 * One peer serves the branch's real headers and the branch's last block with
 * one `utxoTxs` element replaced by other bytes of the same length; the ids
 * array is the honest block's, unchanged.
 */
describe('a served block whose body element bytes were replaced at the same length', () => {
  const ctx: Trackers = { caughtCorrupt: [] };
  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  function alter(block: OrderingBlock): OrderingBlock {
    const utxoTxs = [...block.utxoTxTree.utxoTxs];
    const last = utxoTxs[utxoTxs.length - 1]!;
    const replaced = new Uint8Array(last.length);
    for (let i = 0; i < replaced.length; i++) replaced[i] = last[i]! ^ 0xff;
    utxoTxs[utxoTxs.length - 1] = replaced;
    return { ...block, utxoTxTree: { ...block.utxoTxTree, utxoTxs } };
  }

  it('the ids are the honest block\'s, and the block passes structure and the validator signature', async () => {
    const sc = await buildScenario();
    const altered = alter(sc.branchLast);
    expect(blockHash(altered.header)).toBe(blockHash(sc.branchLast.header));
    expect(altered.utxoTxTree.utxoTxIds).toEqual(sc.branchLast.utxoTxTree.utxoTxIds);
    expect(verifyOrderingBlockStructure(altered).valid).toBe(true);
    expect(verifyValidatorSignature(altered.header, altered.validatorSignature)).toBe(true);
  });

  it.fails('the altered block is refused with no mark, and the honest branch then switches the chain', async () => {
    const sc = await buildScenario();
    expect(sc.branchWork > sc.ourWork).toBe(true);
    const altered = alter(sc.branchLast);
    const alteredHash = blockHash(altered.header)!;

    const observed = await serveAlteredThenHonest(sc, ctx, [sc.shared1, sc.branchFirst, altered], alteredHash);

    expect(observed).toEqual({
      alteredMarked: false,
      tipHeight: sc.branchLast.header.height,
      tipHash: blockHash(sc.branchLast.header),
      peerBPenalties: 0,
      peerBAskedForBlocks: true,
    });
  });
});

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A served block is bound to its header before it is kept".
 *
 * One peer serves the branch's real headers and the branch's first block with
 * `validatorSignature` replaced by 64 bytes that do not verify. Header and
 * body are byte-identical to the honest block's; the signature outside the
 * header's root is not.
 */
describe('a served block whose validator signature does not verify', () => {
  const ctx: Trackers = { caughtCorrupt: [] };
  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  function alter(block: OrderingBlock): OrderingBlock {
    return { ...block, validatorSignature: new Uint8Array(64).fill(0xff) };
  }

  it('the header and the body are the honest block\'s, structure accepts the block, and the signature is refused', async () => {
    const sc = await buildScenario();
    const altered = alter(sc.branchFirst);
    expect(blockHash(altered.header)).toBe(blockHash(sc.branchFirst.header));
    expect(altered.utxoTxTree.utxoTxIds).toEqual(sc.branchFirst.utxoTxTree.utxoTxIds);
    expect(altered.utxoTxTree.utxoTxs.length).toBe(sc.branchFirst.utxoTxTree.utxoTxs.length);
    for (let i = 0; i < altered.utxoTxTree.utxoTxs.length; i++) {
      expect(
        Buffer.from(altered.utxoTxTree.utxoTxs[i]!).equals(Buffer.from(sc.branchFirst.utxoTxTree.utxoTxs[i]!)),
      ).toBe(true);
    }
    expect(verifyOrderingBlockStructure(altered).valid).toBe(true);
    expect(verifyValidatorSignature(altered.header, altered.validatorSignature)).toBe(false);
  });

  it.fails('the altered block is refused with no mark, and the honest branch then switches the chain', async () => {
    const sc = await buildScenario();
    expect(sc.branchWork > sc.ourWork).toBe(true);
    const altered = alter(sc.branchFirst);
    const alteredHash = blockHash(altered.header)!;

    const observed = await serveAlteredThenHonest(sc, ctx, [sc.shared1, altered, sc.branchLast], alteredHash);

    expect(observed).toEqual({
      alteredMarked: false,
      tipHeight: sc.branchLast.header.height,
      tipHash: blockHash(sc.branchLast.header),
      peerBPenalties: 0,
      peerBAskedForBlocks: true,
    });
  });
});

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A served block is bound to its header before it is kept".
 *
 * One peer serves the branch's real headers and the branch's first block with
 * its last `utxoTxs` element dropped; the two arrays then differ in length.
 */
describe('a served block whose utxoTxs array drops its last element', () => {
  const ctx: Trackers = { caughtCorrupt: [] };
  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  function alter(block: OrderingBlock): OrderingBlock {
    const utxoTxs = block.utxoTxTree.utxoTxs.slice(0, -1);
    return { ...block, utxoTxTree: { ...block.utxoTxTree, utxoTxs } };
  }

  it('structure refuses the block', async () => {
    const sc = await buildScenario();
    const altered = alter(sc.branchFirst);
    expect(blockHash(altered.header)).toBe(blockHash(sc.branchFirst.header));
    expect(verifyOrderingBlockStructure(altered).valid).toBe(false);
  });

  it.fails('the altered block is refused with no mark, and the honest branch then switches the chain', async () => {
    const sc = await buildScenario();
    expect(sc.branchWork > sc.ourWork).toBe(true);
    const altered = alter(sc.branchFirst);
    const alteredHash = blockHash(altered.header)!;

    const observed = await serveAlteredThenHonest(sc, ctx, [sc.shared1, altered, sc.branchLast], alteredHash);

    expect(observed).toEqual({
      alteredMarked: false,
      tipHeight: sc.branchLast.header.height,
      tipHash: blockHash(sc.branchLast.header),
      peerBPenalties: 0,
      peerBAskedForBlocks: true,
    });
  });
});

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A served block is bound to its header before it is kept".
 *
 * One peer serves a branch whose last block is its header's — the body's root
 * matches the header's `utxoTxRoot`, the signature verifies — and whose body
 * holds one element that will not decode. The intake path keeps the block,
 * `reorg` applies the honest first block and refuses the second at decode, and
 * the mark lands on that block's hash: the header's own.
 */
describe('a served block that is its header\'s and whose body will not decode', () => {
  const ctx: Trackers = { caughtCorrupt: [] };
  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the three checks accept the block, its hash lands in refused_headers, the peer carries one misbehavior penalty, the chain stands', async () => {
    await initChainStore();
    await startCreator(testConfig);
    const [shared1] = await buildAndApply([[1, T1]]) as [OrderingBlock];

    // A credit box both chains share: the branch's first block above the
    // fork spends it in a signed transaction (as `buildScenario` does).
    const spender = makeTestIdentity();
    const box = makeCreditBox(10n ** 8n, spender.userId, 0, 7);
    await seedBoxes([box]);
    const creditTx = makeCreditTx(spender, [box], 10n ** 6n);

    const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (b: OrderingBlock) => boolean;
    };

    // The branch's two blocks, built honestly over the shared state. The
    // second's miner is held so the body-rewritten variant below re-signs
    // with the same key — the signature verifies against the block's own
    // `validatorId`.
    const branchFirst = await makeApplicableBlock({
      height: 2,
      createdAt: T1 + 1,
      utxoTxs: [creditTx],
    });
    expect(applyOrderingBlock(branchFirst)).toBe(true);
    const branchMiner = makeTestIdentity();
    const branchLastHonest = await makeApplicableBlock({
      height: 3,
      createdAt: T1 + 2,
      miner: branchMiner,
    });
    expect(applyOrderingBlock(branchLastHonest)).toBe(true);

    // Revert and build this node's lighter chain — one block above the fork.
    await revertChainTo(1);
    const [ourTip] = await buildAndApply([[2, T1 + 60_000 + HL]]) as [OrderingBlock];

    // The branch's last block, body replaced by one element that will not
    // decode, header's `utxoTxRoot` recomputed over that body, re-mined, and
    // re-signed by `branchMiner`.
    const alteredTree = {
      utxoTxIds: ['00'.repeat(32)],
      utxoTxs: [new Uint8Array([0xff, 0xff, 0xff])],
    };
    const alteredHeader: BlockHeader = {
      ...branchLastHonest.header,
      utxoTxRoot: computeUtxoTxRoot(alteredTree),
    };
    alteredHeader.powNonce = solveHeaderPow(alteredHeader);
    const alteredSignature = signHeader(alteredHeader, branchMiner.privateKey);
    const altered: OrderingBlock = {
      header: alteredHeader,
      utxoTxTree: alteredTree,
      validatorSignature: alteredSignature,
    };

    // Controls: the block is its header's (structure accepts, root matches)
    // and the signature outside the root is its validator's.
    expect(verifyOrderingBlockStructure(altered).valid).toBe(true);
    expect(verifyUtxoTxRoot(altered)).toBe(true);
    expect(verifyValidatorSignature(altered.header, altered.validatorSignature)).toBe(true);

    const branchWork = cumulativeWork([branchFirst.header, altered.header]);
    const ourWork = cumulativeWork([ourTip.header]);
    expect(branchWork > ourWork).toBe(true);

    const alteredHash = blockHash(altered.header)!;
    const net = singleBranchNet('peer-undecodable', [shared1, branchFirst, altered]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(altered, 'peer-undecodable', net)).toBe(false);
    await settleResolveForks(ctx);

    const ordering = await importOrdering();
    const { anyRefusedHeader } = await import('../../src/store/refused-headers.js');
    expect(anyRefusedHeader([alteredHash])).toBe(true);
    expect(ordering.getCurrentHeight()).toBe(ourTip.header.height);
    expect(ordering.getOrderingBlockHash(ourTip.header.height)).toBe(blockHash(ourTip.header));
    expect(net.penalties.length).toBe(1);
    expect(net.penalties[0]!.kind).toBe('misbehavior');
  });
});

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A served block is bound to its header before it is kept".
 *
 * The same peer id delivers the branch's first serve with a block whose
 * `validatorSignature` does not verify, then its second serve with the branch
 * whole. The last assertion is the same five values the file's other cases
 * compare.
 */
describe('one peer serves an altered block then the branch whole', () => {
  const ctx: Trackers = { caughtCorrupt: [] };
  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  function alter(block: OrderingBlock): OrderingBlock {
    return { ...block, validatorSignature: new Uint8Array(64).fill(0xff) };
  }

  it.fails('the first serve leaves no mark on the altered block\'s hash, and the second serve switches the chain', async () => {
    const sc = await buildScenario();
    expect(sc.branchWork > sc.ourWork).toBe(true);
    const altered = alter(sc.branchFirst);
    const alteredHash = blockHash(altered.header)!;

    const peerId = 'peer-shared';
    const peerFirst = singleBranchNet(peerId, [sc.shared1, altered, sc.branchLast]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(sc.branchLast, peerId, peerFirst)).toBe(false);
    await settleResolveForks(ctx);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(sc.ourTip.header.height);
    expect(ordering.getOrderingBlockHash(sc.ourTip.header.height)).toBe(blockHash(sc.ourTip.header));
    expect(peerFirst.penalties.length).toBe(1);
    expect(peerFirst.penalties[0]!.kind).toBe('misbehavior');

    // The same peer id serves the branch whole on its second round.
    const peerSecond = singleBranchNet(peerId, [sc.shared1, sc.branchFirst, sc.branchLast]);
    expect(handleOrderingBlock(sc.branchLast, peerId, peerSecond)).toBe(false);
    await settleResolveForks(ctx);

    const { anyRefusedHeader } = await import('../../src/store/refused-headers.js');
    const observed = {
      alteredMarked: anyRefusedHeader([alteredHash]),
      tipHeight: ordering.getCurrentHeight(),
      tipHash: ordering.getOrderingBlockHash(ordering.getCurrentHeight()),
      peerBPenalties: peerSecond.penalties.length,
      peerBAskedForBlocks: peerSecond.blockCalls.count > 0,
    };

    expect(observed).toEqual({
      alteredMarked: false,
      tipHeight: sc.branchLast.header.height,
      tipHash: blockHash(sc.branchLast.header),
      peerBPenalties: 0,
      peerBAskedForBlocks: true,
    });
  });
});
