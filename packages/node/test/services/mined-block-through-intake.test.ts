import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OrderingBlock } from '@dagsocial/types';
import {
  importBlockCreator,
  importDb,
  initChainStore,
  startCreator,
  testConfig,
} from './fork-resolution-fixtures.js';
import { mineNextBlock } from '../helpers.js';

// NODE_INTERFACE → Block finalization → "A mined block is applied through the
// pipeline's intake": `submitMinedBlock` hands the block to the intake's
// mined-block entry and answers its verdict. An applied block broadcasts; a
// refused one rebuilds the template so the next solve is not spent on refused
// bytes.

interface NetSpy {
  broadcast: Array<OrderingBlock>;
}

function makeSpyNet(spy: NetSpy): unknown {
  return {
    broadcastOrderingBlock: async (b: OrderingBlock) => { spy.broadcast.push(b); },
    broadcastTx: async () => {},
    getConnectedPeers: () => [],
    tipApplied: () => {},
    setKarmaMembers: () => {},
    addKarmaMember: () => {},
    removeKarmaMember: () => {},
    chainMoved: () => {},
    needHeaders: () => {},
    penalizePeer: () => {},
  };
}

/**
 * Minimal wire surface for `wireNet` — the registration methods it reads, each
 * swallowing its callback since the mined-block path never fires one.
 */
function makeFakeWireableNet(base: unknown): unknown {
  return {
    ...(base as object),
    setPipeline: () => {},
    setChainView: () => {},
    onOrderingBlock: () => {},
    onPeerDisconnected: () => {},
  };
}

describe('a mined block applies through the pipeline\'s intake', () => {
  beforeEach(async () => {
    await initChainStore();
  });

  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch { /* not imported */ }
    const { clearIntakeSeamsForTests } = await import('../../src/services/intake.js');
    clearIntakeSeamsForTests();
    const db = await importDb();
    db.closeDb();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a mined block is admitted to the header tree before it applies', async () => {
    const spy: NetSpy = { broadcast: [] };
    const { setNet } = await import('../../src/services/net-instance.js');
    const net = makeSpyNet(spy);
    setNet(net as never);
    const { wireNet } = await import('../../src/services/net-wiring.js');
    wireNet(makeFakeWireableNet(net) as never);

    await startCreator(testConfig);
    const bc = await importBlockCreator();
    const mined = await mineNextBlock(bc);

    expect(mined).not.toBeNull();
    const minedHash = (await import('@dagsocial/validation')).blockHash(mined!.header);
    expect(minedHash).not.toBeNull();
    // Broadcast ran — submitMinedBlock handed the block to net.
    expect(spy.broadcast.length).toBe(1);
    // The last assertion names the rule: the mined block's header has a tree
    // row (every applied header is a tree row — the pipeline is the tables'
    // one writer).
    const { getHeaderRow } = await import('../../src/store/header-tree.js');
    expect(getHeaderRow(minedHash!)).not.toBeNull();
  });

  it('submitMinedBlock answers null when the intake refuses the mined block', async () => {
    // A refusal here means the intake does not apply the block — the one
    // path that produces that without a corrupt-state throw is a template
    // whose header the mined nonce does not satisfy. The route's PoW check
    // in `submitMinedBlock` guards that, so we drive the mocked seam by
    // replacing the apply seam.
    const spy: NetSpy = { broadcast: [] };
    const { setNet } = await import('../../src/services/net-instance.js');
    const net = makeSpyNet(spy);
    setNet(net as never);
    const { wireNet } = await import('../../src/services/net-wiring.js');
    wireNet(makeFakeWireableNet(net) as never);

    // Build a template through the creator, then arrange for apply to refuse.
    await startCreator(testConfig);
    const bc = await importBlockCreator();

    // Set the apply seam to refuse — the intake's extension will see a
    // local-class refusal, drop the staged row, and submitMinedBlock answers
    // null (its default verdict path).
    const intake = await import('../../src/services/intake.js');
    intake.setIntakeSeamsForTests({
      apply: () => ({ applied: false, class: 'local', detail: 'test' }),
    });

    const mined = await mineNextBlock(bc);
    expect(mined).toBeNull();
    // On refusal the next template is built — the creator has an unapplied
    // tip and `rebuildTemplate` writes a new one.
    // The last assertion names the rule: the broadcast did not fire for a
    // refused block (nothing re-propagated).
    expect(spy.broadcast).toEqual([]);
    intake.clearIntakeSeamsForTests();
  });
});
