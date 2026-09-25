import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EMPTY_STATE_ROOT,
  PROTOCOL_VERSION,
  USERNAME_BURN_PRICE,
  canonicalUsernameBytes,
  computeTxId,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, KarmaBox, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { materializeOutput } from '@dagsocial/consensus';
import {
  activateProverOverStore,
  makeApplicableBlock,
  makeKarmaBox,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  signTransaction,
  type TestIdentity,
} from '../helpers.js';

/**
 * A name claimed and burned in one block, and a holder key a block both creates
 * and removes (NODE_INTERFACE → "A removable record the block creates and removes
 * nets out, as a box does"). Valid under every rule, so the producer speculates
 * the body to a digest, a node holding a prover applies it, a second node applies
 * the same block to the same digest, the tree holds no key the block created and
 * removed, and a revert returns the tree to the pre-block digest.
 */

const holder = makeTestIdentity();
const other = makeTestIdentity();
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function outputsOf(tx: UtxoTransaction): AnyBox[] {
  const txId = computeTxId(tx);
  return tx.outputs.map((out, index) => materializeOutput(out, txId, index));
}

/** A claim of `name`: the karma input back as change, and the name box. */
function claimTx(who: TestIdentity, karma: KarmaBox, name: string): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karma.id!],
    outputs: [
      { boxType: 'karma', value: karma.value, createdAtBlock: 1, owner: who.userId },
      { boxType: 'username', value: 0n, createdAtBlock: 1, owner: who.userId, name: new TextEncoder().encode(name) },
    ] as AnyBoxCandidate[],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, who.privateKey, hexOf(who.userId));
  return tx;
}

/** A burn of `nameBox`, its price paid from `karma`. */
function burnTx(who: TestIdentity, karma: AnyBox, nameBox: AnyBox): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karma.id!, nameBox.id!],
    outputs: [
      { boxType: 'karma', value: karma.value - USERNAME_BURN_PRICE, createdAtBlock: 1, owner: who.userId },
      { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: 1 },
    ] as AnyBoxCandidate[],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, who.privateKey, hexOf(who.userId));
  return tx;
}

/** A node over a fresh store: two identities holding karma, the tree over it. */
async function openNode() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();
  const utxo = await import('../../src/store/utxo.js');
  utxo.insertBox(makeKarmaBox(100n, holder.userId, 0, 1));
  utxo.insertBox(makeKarmaBox(100n, other.userId, 0, 2));
  const handle = await activateProverOverStore();
  const avl = await import('../../src/state/avl-prover.js');
  const nameKey = (name: string): Uint8Array =>
    Buffer.from(avl.usernameRecordKey(canonicalUsernameBytes(new TextEncoder().encode(name))), 'hex');
  const holderKey = (who: TestIdentity): Uint8Array => Buffer.from(avl.holderRecordKey(who.userId), 'hex');
  return {
    db,
    utxo,
    handle,
    digest: (): string => hexOf(handle.prover.digest()!),
    lookup: (key: Uint8Array): string | null => {
      const value = handle.prover.unauthenticatedLookup(key);
      return value ? hexOf(value) : null;
    },
    nameKey,
    holderKey,
    serialize: await import('../../src/state/serialize-box.js'),
    usernames: await import('../../src/store/usernames.js'),
    journal: await import('../../src/store/journal.js'),
    blockApply: await import('../../src/services/block-apply.js'),
    forks: await import('../../src/services/fork-resolution.js'),
  };
}

type Node = Awaited<ReturnType<typeof openNode>>;

/** The block's producer speculates it to a digest, the prover left where it was. */
function expectSpeculatesTo(node: Node, block: OrderingBlock): void {
  const before = node.digest();
  expect(block.header.stateRoot).not.toBe(EMPTY_STATE_ROOT);
  expect(node.blockApply.computePostBlockStateRoot(block)).toEqual({ kind: 'computed', stateRoot: block.header.stateRoot });
  expect(node.digest()).toBe(before);
}

/** A second node, over the same pre-block state, applies the block to the same digest. */
async function expectSecondNodeApplies(block: OrderingBlock, preDigest: string): Promise<Node> {
  vi.resetModules();
  const second = await openNode();
  expect(second.digest()).toBe(preDigest);
  expect(second.blockApply.applyOrderingBlockVerdict(block)).toEqual({ applied: true });
  expect(second.digest()).toBe(block.header.stateRoot);
  return second;
}

describe('a removable record the block creates and removes', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    try {
      (await import('../../src/services/block-creator.js')).stopBlockCreator();
    } catch { /* never started */ }
    vi.resetModules();
  });

  it('a name claimed and burned in one block: speculated, applied, applied again elsewhere, reverted', async () => {
    const node = await openNode();
    const preDigest = node.digest();
    const claim = claimTx(holder, node.utxo.getKarmaBoxes(holder.userId)[0]!, 'Alpha');
    const [change, nameBox] = outputsOf(claim) as [AnyBox, AnyBox];
    const burn = burnTx(holder, change, nameBox);

    const block = await makeApplicableBlock({ utxoTxs: [claim, burn] });
    expectSpeculatesTo(node, block);
    expect(node.blockApply.applyOrderingBlockVerdict(block)).toEqual({ applied: true });
    expect(node.digest()).toBe(block.header.stateRoot);

    // The tree holds neither record, nor the name box the block made and spent.
    expect(node.lookup(node.nameKey('alpha'))).toBeNull();
    expect(node.lookup(node.holderKey(holder))).toBeNull();
    expect(node.lookup(Buffer.from(nameBox.id!, 'hex'))).toBeNull();
    expect(node.usernames.getUsername('alpha')).toBeNull();
    expect(node.usernames.getUsernameByOwner(holder.userId)).toBeNull();
    // The journal holds all four writes, each removal with the row the claim wrote.
    const mutations = node.journal.getBlockJournal(1)!.mutations
      .filter((m) => m.kind === 'username' || m.kind === 'holder')
      .map((m) => ({ kind: m.kind, write: (m.kind === 'username' ? m.row : m.record) !== null, replaced: 'replaced' in m }));
    expect(mutations).toEqual([
      { kind: 'username', write: true, replaced: false },
      { kind: 'holder', write: true, replaced: false },
      { kind: 'username', write: false, replaced: true },
      { kind: 'holder', write: false, replaced: true },
    ]);

    const second = await expectSecondNodeApplies(block, preDigest);
    expect(second.lookup(second.nameKey('alpha'))).toBeNull();
    expect(second.lookup(second.holderKey(holder))).toBeNull();

    second.forks.reorg(0, []);
    expect(second.digest()).toBe(preDigest);
    expect(second.usernames.getUsername('alpha')).toBeNull();
    expect(second.utxo.getBox(nameBox.id!)).toBeNull();
    expect(second.utxo.getKarmaBoxes(holder.userId).map((b) => b.value)).toEqual([100n]);
  });

  it('a holder key the block creates and removes while the name passes to another: speculated, applied, applied again elsewhere, reverted', async () => {
    const node = await openNode();
    const preDigest = node.digest();
    const claim = claimTx(holder, node.utxo.getKarmaBoxes(holder.userId)[0]!, 'Beta');
    const [change, nameBox] = outputsOf(claim) as [AnyBox, AnyBox];
    const burn = burnTx(holder, change, nameBox);
    const reclaim = claimTx(other, node.utxo.getKarmaBoxes(other.userId)[0]!, 'beta');
    const reclaimedBox = outputsOf(reclaim)[1]!;

    const block = await makeApplicableBlock({ utxoTxs: [claim, burn, reclaim] });
    expectSpeculatesTo(node, block);
    expect(node.blockApply.applyOrderingBlockVerdict(block)).toEqual({ applied: true });
    expect(node.digest()).toBe(block.header.stateRoot);

    expect(node.lookup(node.holderKey(holder))).toBeNull();
    expect(node.lookup(node.nameKey('beta'))).toBe(hexOf(node.serialize.serializeUsernameRecord({ boxId: reclaimedBox.id! })));
    expect(node.lookup(node.holderKey(other))).toBe(
      hexOf(node.serialize.serializeHolderRecord({ claimAvailable: false, boxId: reclaimedBox.id! })),
    );
    expect(node.usernames.getUsername('beta')?.owner).toBe(hexOf(other.userId));

    const second = await expectSecondNodeApplies(block, preDigest);
    expect(second.lookup(second.holderKey(holder))).toBeNull();

    second.forks.reorg(0, []);
    expect(second.digest()).toBe(preDigest);
    expect(second.lookup(second.nameKey('beta'))).toBeNull();
    expect(second.lookup(second.holderKey(other))).toBeNull();
    expect(second.usernames.getUsername('beta')).toBeNull();
  });

  it('a claim and its burn pooled in one interval: the creator templates both over a computed stateRoot and the block applies', async () => {
    const node = await openNode();
    const mempool = await import('../../src/store/mempool.js');
    const claim = claimTx(holder, node.utxo.getKarmaBoxes(holder.userId)[0]!, 'Gamma');
    const [change, nameBox] = outputsOf(claim) as [AnyBox, AnyBox];
    const burn = burnTx(holder, change, nameBox);
    mempool.insertUtxoTx(claim, 100);
    mempool.insertUtxoTx(burn, 100);

    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(makeTestConfig());
    const template = bc.getCurrentTemplate();
    expect(template).not.toBeNull();
    expect(template!.utxoTxTree.utxoTxIds.slice(0, 2)).toEqual([computeTxId(claim), computeTxId(burn)]);
    expect(template!.header.stateRoot).not.toBe(EMPTY_STATE_ROOT);

    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();
    expect(block!.header.height).toBe(1);
    expect(node.digest()).toBe(block!.header.stateRoot);
    expect(node.lookup(node.nameKey('gamma'))).toBeNull();
    expect(node.lookup(node.holderKey(holder))).toBeNull();
    expect(mempool.getPendingEntries(10)).toEqual([]);
  });
});
