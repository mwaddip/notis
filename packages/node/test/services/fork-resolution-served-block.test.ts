import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  blockHash,
  cumulativeWork,
  verifyOrderingBlockStructure,
  verifyValidatorSignature,
} from '@dagsocial/validation';
import { decodeTx, encodeTx, computeTxId } from '@dagsocial/types';
import type { OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import {
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestIdentity,
  revertChainTo,
  seedBoxes,
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
