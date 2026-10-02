import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  MAX_BLOCK_BODY_BYTES,
  MAX_BLOCK_COST,
  POST_PRICE_REPLY,
  POST_PRICE_THREAD,
  PROTOCOL_VERSION,
  REPLY_AUTHOR_SHARE,
  TREE_KEY_LENGTH,
  USERNAME_BURN_PRICE,
  VOUCH_KARMA_AMOUNT,
  W_OP,
  bytesToHex,
  computeContentHash,
  computePostId,
  computeTxId,
  hash32,
  hexToBytes,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  BlockHeader,
  CreditBox,
  IdentityRecord,
  KarmaBox,
  OrderingBlock,
  UsernameBox,
  UtxoTransaction,
  UtxoTxTree,
  VouchBox,
} from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { materializeOutput } from '@dagsocial/consensus';
import type { ApplyContext, TreeSession } from '@dagsocial/consensus';
import type { LeafVerdict } from '../harness/leaf-replay.js';
import {
  FIXTURE_BOND_KARMA,
  activateProverOverStore,
  blockBudgetSeam,
  changeBoxOf,
  hex,
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeKarmaBox,
  makeLikeTx,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  revertChainTo,
  signTransaction,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';

/**
 * The leaf's path on a chain the node built (CONSENSUS_INTERFACE → The tree
 * session; CONSENSUS_INTERFACE → The block proof). The node's own producer
 * makes a devnet chain whose traffic covers every transaction kind; each block
 * is fetched over HTTP as a leaf fetches it — the header from `GET
 * /blocks/:height`, the proof from `GET /blocks/:height/proof` (NODE_INTERFACE
 * → Blocks) — and replayed by `replayAsLeaf` holding its parent's root alone.
 * Every block reaches its header's `stateRoot`, and the proof each block's node
 * regenerated at apply is the one its header's `adProofsRoot` names.
 *
 * Four altered blocks over the chain's tip are each refused by the replay and
 * by the node's funnel: a proof missing a read, a proof with one next key
 * tampered, a block whose `adProofsRoot` is not its proof's, and a block one
 * operation over the budget — the budget lowered through `blockBudgetSeam`,
 * never through `types`' constant (CONSENSUS_INTERFACE → The block's cost).
 */

/** The node's modules and the replay, imported after the budget seam so every budget decision reads it. */
async function importNode() {
  return {
    db: await import('../../src/store/db.js'),
    utxo: await import('../../src/store/utxo.js'),
    records: await import('../../src/store/identity-records.js'),
    mempool: await import('../../src/store/mempool.js'),
    ordering: await import('../../src/store/ordering.js'),
    blockApply: await import('../../src/services/block-apply.js'),
    creator: await import('../../src/services/block-creator.js'),
    sessions: await import('../../src/state/prover-session.js'),
    avl: await import('../../src/state/avl-prover.js'),
    server: await import('../../src/server.js'),
    config: (await import('../../src/config.js')).config,
    consensus: await import('@dagsocial/consensus'),
    leaf: await import('../harness/leaf-replay.js'),
  };
}

type Node = Awaited<ReturnType<typeof importNode>>;

/** A root's record (`isRoot`): a member from genesis, with no bar, never invited. */
const ROOT: IdentityRecord = {
  lastActivityBlock: 0,
  lastDecayBlock: 0,
  invitedAtBlock: 0,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 1,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
};

/** The record of an account that is not a member. */
const ACCOUNT: IdentityRecord = { ...ROOT, memberSinceBlock: 0 };

/** What each credit send pays its block's miner. */
const FEE = 10n ** 6n;

// ---------------------------------------------------------------------------
// The traffic — each transaction as a client builds it at the tip, `height`
// ---------------------------------------------------------------------------

function signedBy(who: TestIdentity, tx: UtxoTransaction): UtxoTransaction {
  signTransaction(tx, who.privateKey, hex(who.userId));
  return tx;
}

/** Output `index` of `tx`, as block application materializes it. */
function outputOf<B extends AnyBox>(tx: UtxoTransaction, index: number): B {
  return materializeOutput(tx.outputs[index]!, computeTxId(tx), index) as B;
}

/** A thread, or with `parent` a reply, paid from `box` (NODE_INTERFACE → Legal box transitions). */
function postTx(
  author: TestIdentity,
  box: KarmaBox,
  content: string,
  height: number,
  parent?: { postId: string; author: Uint8Array },
): { tx: UtxoTransaction; postId: string } {
  const price = parent ? POST_PRICE_REPLY : POST_PRICE_THREAD;
  const outputs: AnyBoxCandidate[] = [
    { boxType: 'karma', value: box.value - price, createdAtBlock: height, owner: author.userId },
  ];
  if (parent) {
    outputs.push(
      { boxType: 'karma_price', value: POST_PRICE_REPLY - REPLY_AUTHOR_SHARE, createdAtBlock: height },
      { boxType: 'like_accrual', value: REPLY_AUTHOR_SHARE, createdAtBlock: height, author: parent.author },
    );
  } else {
    outputs.push({ boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: height });
  }
  const tx = signedBy(author, {
    inputs: [box.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: {
      contentHash: computeContentHash(content),
      author: author.userId,
      parentRefs: parent ? [parent.postId] : [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    },
  });
  return { tx, postId: computePostId(computeTxId(tx), 0) };
}

function vouchTx(voucher: TestIdentity, box: KarmaBox, target: TestIdentity, height: number): UtxoTransaction {
  return signedBy(voucher, {
    inputs: [box.id!],
    outputs: [
      { boxType: 'karma', value: box.value - VOUCH_KARMA_AMOUNT, createdAtBlock: height, owner: voucher.userId },
      {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: height,
        voucherId: voucher.userId,
        targetId: target.userId,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  });
}

/** The unvouch: the stake into an escrow that releases a cooldown after the vouch was cast. */
function unvouchTx(voucher: TestIdentity, vouch: VouchBox, height: number, cooldown: number): UtxoTransaction {
  return signedBy(voucher, {
    inputs: [vouch.id!],
    outputs: [{
      boxType: 'vouch_escrow',
      value: vouch.value,
      createdAtBlock: height,
      owner: voucher.userId,
      releaseAtBlock: vouch.createdAtBlock + cooldown,
    }],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  });
}

function inviteTx(inviter: TestIdentity, box: KarmaBox, invitee: TestIdentity, bond: bigint, height: number): UtxoTransaction {
  return signedBy(inviter, {
    inputs: [box.id!],
    outputs: [
      { boxType: 'karma', value: box.value - bond, createdAtBlock: height, owner: inviter.userId },
      {
        boxType: 'bond',
        value: bond,
        createdAtBlock: height,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  });
}

function claimTx(claimant: TestIdentity, box: KarmaBox, name: string, height: number): UtxoTransaction {
  return signedBy(claimant, {
    inputs: [box.id!],
    outputs: [
      { boxType: 'karma', value: box.value, createdAtBlock: height, owner: claimant.userId },
      {
        boxType: 'username',
        value: 0n,
        createdAtBlock: height,
        owner: claimant.userId,
        name: new TextEncoder().encode(name),
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  });
}

function burnTx(holder: TestIdentity, box: KarmaBox, name: UsernameBox, height: number): UtxoTransaction {
  return signedBy(holder, {
    inputs: [box.id!, name.id!],
    outputs: [
      { boxType: 'karma', value: box.value - USERNAME_BURN_PRICE, createdAtBlock: height, owner: holder.userId },
      { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: height },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  });
}

function withdrawTx(author: TestIdentity, box: KarmaBox, postId: string, height: number): UtxoTransaction {
  return signedBy(author, {
    inputs: [box.id!],
    outputs: [{ boxType: 'karma', value: box.value, createdAtBlock: height, owner: author.userId }],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    postWithdraw: { postId },
  });
}

// ---------------------------------------------------------------------------
// The proof's packed tree
// ---------------------------------------------------------------------------

/**
 * Each leaf a proof carries, read from its packed tree — `@ergots/avltree`'s
 * post-order token stream: `2` a leaf, `3` a label and its 32 bytes, `4` the
 * tree's end, any other byte an internal node's balance. A leaf is its key,
 * its next key, a 4-byte big-endian value length and the value; its key is
 * written only at the stream's start and after a label, and otherwise is the
 * leaf before it's next key. Answers each leaf's key, its next key and the
 * offset of the next key's bytes.
 */
function packedLeaves(proof: Uint8Array): Array<{ key: string; next: string; nextAt: number }> {
  const leaves: Array<{ key: string; next: string; nextAt: number }> = [];
  let previousNext: Uint8Array | null = null;
  let at = 0;
  for (;;) {
    const token = proof[at++];
    if (token === undefined) throw new Error('packedLeaves: the proof ends inside its tree');
    if (token === 4) return leaves;
    if (token === 3) {
      at += 32;
      previousNext = null;
      continue;
    }
    if (token !== 2) continue;
    let key = previousNext;
    if (key === null) {
      key = proof.subarray(at, at + TREE_KEY_LENGTH);
      at += TREE_KEY_LENGTH;
    }
    const next = proof.subarray(at, at + TREE_KEY_LENGTH);
    leaves.push({ key: bytesToHex(key), next: bytesToHex(next), nextAt: at });
    at += TREE_KEY_LENGTH;
    at += 4 + new DataView(proof.buffer, proof.byteOffset + at, 4).getUint32(0);
    previousNext = next;
  }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

/**
 * One lookup a block made: the key, the key of the leaf that answered it — the
 * key itself where the tree holds it, its predecessor where it does not — and
 * that leaf's next key.
 */
interface Lookup {
  key: string;
  leaf: string;
  next: string;
}

/** A block's proof over the tip, each lookup it made in order, and the keys its writes touch. */
interface ProofRun {
  proof: Uint8Array;
  lookups: Lookup[];
  written: Set<string>;
}

/** A block as `GET /blocks/:height` serves it. */
interface ServedBlock {
  header: Omit<BlockHeader, 'validatorId'> & { validatorId: string };
  utxoTxTree: { utxoTxIds: string[]; postIds: string[]; utxoTxs: unknown[] };
  validatorSignature: string;
}

describe('a leaf replays the node\'s chain from each block\'s proof', () => {
  let node: Node;
  let budget: { set(budget: number): void };
  let ctx: ApplyContext;
  let server: Server;
  let base: string;
  /** The state root before block 1 — the root the chain's first block builds on. */
  let genesisRoot: Uint8Array;
  /** The chain's tip, the parent of every altered block. */
  let tip: OrderingBlock;
  /** The next block over the tip, as a miner outside the node builds it, and its traffic. */
  let miner: TestIdentity;
  let nextTraffic: UtxoTransaction[];
  let honest: OrderingBlock;
  /** The honest block's proof, its lookups in order, and the keys its writes touch. */
  let proven: ProofRun;

  /**
   * `block`'s proof over the tip as the node's cycle makes it (NODE_INTERFACE →
   * The block proof) — its lookups through the recording session, then its
   * writes — with the lookup of `unrecorded` (hex), if any, made unrecorded
   * instead; the prover is put back as the speculation puts it back.
   */
  function proveOverTip(block: OrderingBlock, unrecorded: string | null): ProofRun {
    const handle = node.avl.getAvlProver();
    const inner = handle.prover.prover;
    const root = inner.root;
    const height = inner.height;
    const recording = node.sessions.recordingSession(handle.prover);
    const plain = node.sessions.proverSession(handle.prover);
    const lookups: Lookup[] = [];
    const session: TreeSession = {
      lookup(key) {
        const keyHex = bytesToHex(key);
        const answer = keyHex === unrecorded ? plain.lookup(key) : recording.lookup(key);
        const leaf = answer.found ? keyHex : bytesToHex(answer.prevKey);
        lookups.push({ key: keyHex, leaf, next: bytesToHex(answer.nextKey) });
        return answer;
      },
    };
    try {
      const view = node.consensus.treeStateView(session);
      const result = node.consensus.applyBlock(view, block, ctx);
      if (!result.ok) throw new Error(`proveOverTip: the rules refuse the block: ${result.reason}`);
      const writes = node.consensus.treeWritesOf(result.effects, block.header.height, view);
      node.avl.performTreeWrites(handle.prover, block.header.height, writes, 'proveOverTip');
      return { proof: inner.generateProof(), lookups, written: new Set(writes.map((write) => bytesToHex(write.key))) };
    } finally {
      inner.restoreRoot(root, height);
    }
  }

  /** The block's cost over the tip, read unrecorded (CONSENSUS_INTERFACE → The block's cost). */
  function costOverTip(block: OrderingBlock): number {
    const view = node.consensus.treeStateView(node.sessions.proverSession(node.avl.getAvlProver().prover));
    const result = node.consensus.applyBlock(view, block, ctx);
    if (!result.ok) throw new Error(`costOverTip: the rules refuse the block: ${result.reason}`);
    const writes = node.consensus.treeWritesOf(result.effects, block.header.height, view);
    return node.consensus.blockCost({ signatures: result.effects.signatures, lookups: view.lookupCount(), writes: writes.length });
  }

  /** The block over the tip replayed as a leaf with `proof`, holding the tip's root alone. */
  function replayOverTip(block: OrderingBlock, proof: Uint8Array): LeafVerdict {
    return node.leaf.replayAsLeaf({
      parentRoot: hexToBytes(tip.header.stateRoot),
      header: block.header,
      body: block.utxoTxTree,
      proof,
      ctx,
    });
  }

  /** The honest block with its header committing to `adProofsRoot`, mined and signed again; nothing else moves. */
  async function committingTo(adProofsRoot: string): Promise<OrderingBlock> {
    const block = await makeApplicableBlock({
      height: honest.header.height,
      miner,
      utxoTxs: nextTraffic,
      createdAt: honest.header.createdAt,
      adProofsRoot,
    });
    expect(block.utxoTxTree).toEqual(honest.utxoTxTree);
    expect({ ...block.header, adProofsRoot, powNonce: 0 }).toEqual({ ...honest.header, adProofsRoot, powNonce: 0 });
    return block;
  }

  /** The node's funnel refuses `block` as a consensus rejection, logging `line`, and leaves the tip where it was. */
  function expectNodeRefuses(block: OrderingBlock, line: string): void {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(node.blockApply.applyOrderingBlockVerdict(block)).toEqual({ applied: false, class: 'consensus' });
      expect(warn.mock.calls.map(([first]) => String(first))).toContain(line);
    } finally {
      warn.mockRestore();
    }
    expect(node.ordering.getCurrentHeight()).toBe(tip.header.height);
    expect(bytesToHex(node.avl.getAvlProver().prover.digest())).toBe(tip.header.stateRoot);
  }

  /**
   * Block `height` as a leaf fetches it: the header and the body's ids from
   * `GET /blocks/:height`, the proof from `GET /blocks/:height/proof`. The route
   * serves the body's ids and not its bytes, so the bytes are the ones this node
   * stores for the height, bound to the served header by the ids they prove and
   * the header's `utxoTxRoot` over those ids.
   */
  async function fetchAsLeaf(height: number): Promise<{ header: BlockHeader; body: UtxoTxTree; proof: Uint8Array }> {
    const blockRes = await fetch(`${base}/blocks/${height}`);
    expect(blockRes.status).toBe(200);
    const served = (await blockRes.json()) as ServedBlock;
    const header: BlockHeader = { ...served.header, validatorId: hexToBytes(served.header.validatorId) };

    const proofRes = await fetch(`${base}/blocks/${height}/proof`);
    expect(proofRes.status).toBe(200);
    expect(proofRes.headers.get('content-type')).toBe('application/octet-stream');
    const proof = new Uint8Array(await proofRes.arrayBuffer());

    expect(served.utxoTxTree.utxoTxs).toEqual([]);
    const stored = node.ordering.getOrderingBlock(height);
    if (stored === null) throw new Error(`fetchAsLeaf: this node stores no block at height ${height}`);
    const body: UtxoTxTree = { utxoTxIds: served.utxoTxTree.utxoTxIds, utxoTxs: stored.utxoTxTree.utxoTxs };
    expect(node.creator.computeUtxoTxRoot(body)).toBe(header.utxoTxRoot);
    return { header, body, proof };
  }

  /** The producer's next block from `traffic`, pooled first: it carries every transaction of it. */
  async function produce(height: number, traffic: Record<string, UtxoTransaction>): Promise<OrderingBlock> {
    for (const tx of Object.values(traffic)) node.mempool.insertUtxoTx(tx, 1_000);
    const block = await mineNextBlock(node.creator);
    if (block === null || block.header.height !== height) throw new Error(`the producer made no block at height ${height}`);
    const carried = block.utxoTxTree.utxoTxIds.slice(0, -1);
    const missing = Object.entries(traffic)
      .filter(([, tx]) => !carried.includes(computeTxId(tx)))
      .map(([kind]) => kind);
    if (missing.length > 0 || carried.length !== Object.keys(traffic).length) {
      throw new Error(`block ${height} carries ${carried.length} transactions; of its traffic it lacks: ${missing.join(', ')}`);
    }
    return block;
  }

  beforeAll(async () => {
    vi.resetModules();
    budget = blockBudgetSeam();
    node = await importNode();
    ctx = node.blockApply.applyContextFrom(node.config);
    node.db.initDb(':memory:');

    // Five roots, two accounts, a credit holder — committed before the tree is
    // built over them, as genesis is.
    const author = makeTestIdentity();
    const replier = makeTestIdentity();
    const liker = makeTestIdentity();
    const voucher = makeTestIdentity();
    const inviter = makeTestIdentity();
    const target = makeTestIdentity();
    const namer = makeTestIdentity();
    const invitee = makeTestIdentity();
    const payer = makeTestIdentity();
    const payee = makeTestIdentity();
    for (const root of [author, replier, liker, voucher, inviter]) node.records.putIdentityRecord(root.userId, ROOT);
    for (const account of [target, namer]) node.records.putIdentityRecord(account.userId, ACCOUNT);
    node.records.putNetworkRecord({ memberCount: 5 });
    let nonce = 0;
    const karma = (owner: TestIdentity): KarmaBox => {
      const box = makeKarmaBox(100n, owner.userId, 0, ++nonce);
      node.utxo.insertBox(box);
      return box;
    };
    const threadBox = karma(author);
    const withdrawBox = karma(author);
    const replyBox = karma(replier);
    const likeBox = karma(liker);
    const vouchBox = karma(voucher);
    const inviteBox = karma(inviter);
    const nameBox = karma(namer);
    karma(target);
    const credit = makeCreditBox(10n ** 9n, payer.userId, 0, ++nonce);
    node.utxo.insertBox(credit);
    genesisRoot = (await activateProverOverStore()).prover.digest();
    node.creator.startBlockCreator(makeTestConfig({ nodeRole: 'miner', blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES }));

    // 1: a thread, a vouch, an invite and its bond — the settlement grants the
    // invitee the bond's value — a name claimed, credits sent with a fee.
    const thread = postTx(author, threadBox, 'a thread its author withdraws', 0);
    const vouch = vouchTx(voucher, vouchBox, target, 0);
    const claim = claimTx(namer, nameBox, 'Namer_1', 0);
    const send = makeCreditTx(payer, [credit], FEE, payee.userId);
    await produce(1, {
      thread: thread.tx,
      vouch,
      invite: inviteTx(inviter, inviteBox, invitee, FIXTURE_BOND_KARMA, 0),
      'name claim': claim,
      'credit send': send,
    });

    // 2: a reply and a like of the thread, the unvouch, a thread paid from the
    // invitee's grant, credits sent back.
    const [grant] = node.utxo.getKarmaBoxes(invitee.userId);
    if (grant === undefined) throw new Error('block 1 granted the invitee nothing');
    const like = makeLikeTx(liker, likeBox, thread.postId, author.userId);
    const granted = postTx(invitee, grant, 'a thread paid from a grant', 1);
    const sendBack = makeCreditTx(payee, [outputOf<CreditBox>(send, 0)], FEE, payer.userId);
    await produce(2, {
      reply: postTx(replier, replyBox, 'a reply', 1, { postId: thread.postId, author: author.userId }).tx,
      like,
      unvouch: unvouchTx(voucher, outputOf<VouchBox>(vouch, 1), 1, ctx.vouchCooldownBlocks),
      'thread from a grant': granted.tx,
      'credit send': sendBack,
    });
    expect(node.utxo.hasActiveVouchEscrow(voucher.userId)).toBe(true);

    // 3: the thread withdrawn, the name burned; the settlement releases the
    // unvouch's escrow, due at the cast height plus the cooldown.
    tip = await produce(3, {
      withdrawal: withdrawTx(author, withdrawBox, thread.postId, 2),
      burn: burnTx(namer, outputOf<KarmaBox>(claim, 0), outputOf<UsernameBox>(claim, 1), 2),
    });
    expect(node.utxo.hasActiveVouchEscrow(voucher.userId)).toBe(false);

    // The next block — a like, a vouch cast again, a credit send — by a miner
    // whose key the suite holds, so the cases below can mine and sign it again.
    miner = makeTestIdentity();
    nextTraffic = [
      makeLikeTx(liker, changeBoxOf(like), granted.postId, invitee.userId),
      vouchTx(voucher, outputOf<KarmaBox>(vouch, 0), target, 3),
      makeCreditTx(payer, [outputOf<CreditBox>(sendBack, 0)], FEE, payee.userId),
    ];
    honest = await makeApplicableBlock({ height: 4, miner, utxoTxs: nextTraffic });
    const speculation = node.blockApply.computePostBlockStateRoot(honest, node.avl.getAvlProver());
    if (speculation.kind !== 'computed') throw new Error(`the next block's speculation answered ${speculation.kind}`);
    proven = proveOverTip(honest, null);
    // The cycle above is the node's, byte for byte.
    expect(proven.proof).toEqual(speculation.proof);

    const app = node.server.createApp(makeTestConfig({ nodeRole: 'server' }));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    node?.creator.stopBlockCreator();
    node?.db.closeDb();
    vi.doUnmock('@dagsocial/consensus');
    vi.doUnmock('../../src/services/cost-estimate.js');
    vi.resetModules();
  });

  it('every block the node produced, fetched as a leaf fetches it, replays from its parent\'s root to its stateRoot', async () => {
    const current = (await (await fetch(`${base}/blocks/current`)).json()) as { height: number; hash: string };
    expect(current.height).toBe(3);

    let parentRoot = genesisRoot;
    let parentHash = '0'.repeat(64);
    for (let height = 1; height <= current.height; height++) {
      const { header, body, proof } = await fetchAsLeaf(height);
      expect(header.prevBlockHash, `block ${height}`).toBe(parentHash);
      expect(node.leaf.replayAsLeaf({ parentRoot, header, body, proof, ctx }), `block ${height}`).toEqual({ ok: true });
      const hash = blockHash(header);
      if (hash === null) throw new Error(`block ${height}'s served header is outside the encodable domain`);
      parentRoot = hexToBytes(header.stateRoot);
      parentHash = hash;
    }
    expect(parentHash).toBe(current.hash);
  });

  it('the next block replays from the tip\'s root with the proof its speculation made', () => {
    expect(replayOverTip(honest, proven.proof)).toEqual({ ok: true });
  });

  it('a proof missing a read is refused by the replay and by the node', async () => {
    // A key the block reads and never writes, answered by another leaf than the
    // read after it: with its lookup left out of the proof, the verifier follows
    // the next read's path for it, reaches that read's leaf, and refuses a key
    // outside the leaf's range.
    const reads = proven.lookups;
    const at = reads.findIndex((read, i) =>
      !proven.written.has(read.key) && reads[i + 1] !== undefined && read.leaf !== reads[i + 1]!.leaf);
    expect(at).toBeGreaterThanOrEqual(0);
    const skipped = reads[at]!.key;
    const missing = proveOverTip(honest, skipped);
    expect(missing.lookups).toEqual(reads);
    expect(missing.proof).not.toEqual(proven.proof);
    const altered = await committingTo(bytesToHex(hash32(missing.proof)));

    expect(replayOverTip(altered, missing.proof)).toEqual({
      ok: false,
      reason: `the block's proof refuses the lookup of ${skipped}: leaf-key-out-of-order`,
    });
    expectNodeRefuses(
      altered,
      `adProofsRoot mismatch at height 4: computed=${honest.header.adProofsRoot.slice(0, 16)}... ` +
      `header=${altered.header.adProofsRoot.slice(0, 16)}...`,
    );
  });

  it('a proof with one next key tampered is refused by the replay and by the node', async () => {
    // A range walk's first step — the range's start, absent, answered by the
    // leaf before it, whose next key is the range's first entry, which the block
    // looks up next — and that leaf's next key moved on past the entry: a walk
    // through the tampered leaf skips it.
    const reads = proven.lookups;
    const at = reads.findIndex((read, i) => read.leaf !== read.key && reads[i + 1]?.key === read.next);
    expect(at).toBeGreaterThanOrEqual(0);
    const walked = reads[at]!;
    const leaf = packedLeaves(proven.proof).find((packed) => packed.key === walked.leaf);
    if (leaf === undefined) throw new Error('the proof carries no leaf the walk read');
    expect(leaf.next).toBe(walked.next);
    const tampered = Uint8Array.from(proven.proof);
    tampered.set(hexToBytes(reads[at + 1]!.next), leaf.nextAt);
    expect(tampered).not.toEqual(proven.proof);
    const altered = await committingTo(bytesToHex(hash32(tampered)));

    expect(replayOverTip(altered, tampered)).toEqual({
      ok: false,
      reason: 'the proof does not anchor at the parent root: digest-mismatch',
    });
    expectNodeRefuses(
      altered,
      `adProofsRoot mismatch at height 4: computed=${honest.header.adProofsRoot.slice(0, 16)}... ` +
      `header=${altered.header.adProofsRoot.slice(0, 16)}...`,
    );
  });

  it('a block whose adProofsRoot is not its proof\'s is refused by the replay and by the node', async () => {
    const wrong = bytesToHex(hash32(hexToBytes(honest.header.adProofsRoot)));
    const altered = await committingTo(wrong);

    expect(replayOverTip(altered, proven.proof)).toEqual({
      ok: false,
      reason: `the header's adProofsRoot ${wrong} is not the proof's hash32 ${honest.header.adProofsRoot}`,
    });
    expectNodeRefuses(
      altered,
      `adProofsRoot mismatch at height 4: computed=${honest.header.adProofsRoot.slice(0, 16)}... ` +
      `header=${wrong.slice(0, 16)}...`,
    );
  });

  it('a block one operation over the budget is refused by the replay and by the node; at the budget both accept it', async () => {
    const cost = costOverTip(honest);
    const refusal = `Rejected block height=4: cost ${cost} over the budget ${cost - W_OP}`;
    try {
      budget.set(cost - W_OP);
      expect(replayOverTip(honest, proven.proof)).toEqual({ ok: false, reason: refusal });
      expectNodeRefuses(honest, refusal);

      budget.set(cost);
      expect(replayOverTip(honest, proven.proof)).toEqual({ ok: true });
      expect(node.blockApply.applyOrderingBlockVerdict(honest)).toEqual({ applied: true });
    } finally {
      budget.set(MAX_BLOCK_COST);
    }
    await revertChainTo(tip.header.height);
    expect(node.ordering.getCurrentHeight()).toBe(tip.header.height);
    expect(bytesToHex(node.avl.getAvlProver().prover.digest())).toBe(tip.header.stateRoot);
  });

  // =========================================================================
  // The five altered proofs — proofs a `BatchAVLVerifier` replays to the right
  // digest but `StrictBatchAVLVerifier.isFullyConsumed()` refuses
  // (CONSENSUS_INTERFACE → The tree session, "A block replays from its proof
  // only on all of these"). Each is committed by a header re-mined around its
  // hash, accepted by a plain verifier, refused by `replayAsLeaf`, refused by
  // the funnel's `adProofsRoot` mismatch.
  // =========================================================================

  const NOT_EXACT_REASON = 'the proof is not byte for byte the proof its operations write';

  /** The block's cycle, then one more recorded lookup after the writes. */
  function proveOverTipWithExtraRead(block: OrderingBlock, extraKey: Uint8Array): Uint8Array {
    const handle = node.avl.getAvlProver();
    const inner = handle.prover.prover;
    const root = inner.root;
    const height = inner.height;
    const recording = node.sessions.recordingSession(handle.prover);
    try {
      const view = node.consensus.treeStateView(recording);
      const result = node.consensus.applyBlock(view, block, ctx);
      if (!result.ok) throw new Error(`the rules refuse the block: ${result.reason}`);
      const writes = node.consensus.treeWritesOf(result.effects, block.header.height, view);
      node.avl.performTreeWrites(handle.prover, block.header.height, writes, 'proveOverTipWithExtraRead');
      recording.lookup(extraKey);
      return inner.generateProof();
    } finally {
      inner.restoreRoot(root, height);
    }
  }

  /** The offset just past the packed tree's END_OF_TREE token — where directions begin. */
  function directionsStart(proof: Uint8Array): number {
    let previousLeaf = false;
    let at = 0;
    for (;;) {
      const token = proof[at++];
      if (token === undefined) throw new Error('directionsStart: the proof ends inside its tree');
      if (token === 4) return at;
      if (token === 3) {
        at += 32;
        previousLeaf = false;
        continue;
      }
      if (token !== 2) continue;
      if (!previousLeaf) at += TREE_KEY_LENGTH;
      at += TREE_KEY_LENGTH;
      at += 4 + new DataView(proof.buffer, proof.byteOffset + at, 4).getUint32(0);
      previousLeaf = true;
    }
  }

  /** Every leaf key of the tree at the tip, walked by `nextKey`. */
  function leafKeysAtTip(): string[] {
    const plain = node.sessions.proverSession(node.avl.getAvlProver().prover);
    const keys: string[] = [];
    const first = new Uint8Array(TREE_KEY_LENGTH);
    first[TREE_KEY_LENGTH - 1] = 1;
    let next = plain.lookup(first).nextKey;
    while (!next.every((byte) => byte === 0xff)) {
      keys.push(bytesToHex(next));
      next = plain.lookup(next).nextKey;
    }
    return keys;
  }

  /** A leaf the honest proof leaves under a label — a recorded lookup of it widens the proof's tree. */
  function wideningKey(): Uint8Array {
    const honestTree = bytesToHex(proven.proof.subarray(0, directionsStart(proven.proof)));
    const inFull = new Set(packedLeaves(proven.proof).map((leaf) => leaf.key));
    const all = leafKeysAtTip();
    const unvisited = all.filter((key) => !inFull.has(key));
    for (const key of unvisited) {
      const wider = proveOverTipWithExtraRead(honest, hexToBytes(key));
      if (bytesToHex(wider.subarray(0, directionsStart(wider))) !== honestTree) return hexToBytes(key);
    }
    throw new Error('no unvisited leaf widens the packed tree');
  }

  function replayPlainOverTip(block: OrderingBlock, proof: Uint8Array): LeafVerdict {
    return node.leaf.replayAsLeafPlain({
      parentRoot: hexToBytes(tip.header.stateRoot),
      header: block.header,
      body: block.utxoTxTree,
      proof,
      ctx,
    });
  }

  async function expectAltered(label: string, tampered: Uint8Array): Promise<void> {
    expect(tampered, `${label}: differs from the honest proof`).not.toEqual(proven.proof);
    const altered = await committingTo(bytesToHex(hash32(tampered)));
    // A plain BatchAVLVerifier reaches the header's `stateRoot` — the ambient
    // `replayAsLeaf` built with the strict verifier is what refuses, with
    // `isFullyConsumed`'s reason.
    expect(replayPlainOverTip(altered, tampered), `${label}: plain verifier replays`).toEqual({ ok: true });
    expect(replayOverTip(altered, tampered), `${label}: strict verifier`).toEqual({ ok: false, reason: NOT_EXACT_REASON });
    expectNodeRefuses(
      altered,
      `adProofsRoot mismatch at height 4: computed=${honest.header.adProofsRoot.slice(0, 16)}... ` +
      `header=${altered.header.adProofsRoot.slice(0, 16)}...`,
    );
  }

  it('one zero byte appended is refused with the strict reason', async () => {
    const padded = new Uint8Array(proven.proof.length + 1);
    padded.set(proven.proof);
    await expectAltered('zero byte appended', padded);
  });

  it('one recorded lookup after the writes, of a key the block already read, is refused', async () => {
    const reread = proven.lookups.find((read) => !proven.written.has(read.key));
    if (reread === undefined) throw new Error('the block reads no key it does not write');
    await expectAltered('extra re-read', proveOverTipWithExtraRead(honest, hexToBytes(reread.key)));
  });

  it('one recorded lookup after the writes, of a leaf the proof leaves under a label, is refused', async () => {
    await expectAltered('extra fresh read', proveOverTipWithExtraRead(honest, wideningKey()));
  });

  it('a set padding bit in the last direction byte is total over both outcomes', async () => {
    // The directions' unused bits are the last byte's high bits. Bit 7 is
    // padding when the directions do not fill the byte, and a direction when
    // they do. The test asserts the full triple in both outcomes.
    const last = proven.proof.length - 1;
    const altered = Uint8Array.from(proven.proof);
    // Flip bit 7: if it was 0 it becomes a set padding bit; if it was 1 it
    // becomes a cleared direction. Either way the proof differs.
    altered[last] = altered[last]! ^ 0x80;
    const alteredBlock = await committingTo(bytesToHex(hash32(altered)));
    const plainReplay = replayPlainOverTip(alteredBlock, altered);
    if ((proven.proof[last]! & 0x80) === 0) {
      // Bit 7 was padding; setting it leaves the digest unchanged — plain
      // replays to the right stateRoot, strict refuses as `NOT_EXACT_REASON`.
      await expectAltered('padding bit set', altered);
    } else {
      // Bit 7 was a direction; clearing it changes a read's path — plain
      // refuses, strict refuses, the node refuses on `adProofsRoot`.
      expect(plainReplay.ok, 'padding bit cleared: plain verifier').toBe(false);
      expect(replayOverTip(alteredBlock, altered).ok, 'padding bit cleared: strict verifier').toBe(false);
      expectNodeRefuses(
        alteredBlock,
        `adProofsRoot mismatch at height 4: computed=${honest.header.adProofsRoot.slice(0, 16)}... ` +
        `header=${alteredBlock.header.adProofsRoot.slice(0, 16)}...`,
      );
    }
  });

  it('an unvisited node written in full is refused', async () => {
    // The tree part of a wider proof grafted onto the honest proof's directions —
    // the same operations, a tree with a node a prover would never write.
    const wider = proveOverTipWithExtraRead(honest, wideningKey());
    const widerTree = wider.subarray(0, directionsStart(wider));
    const honestDirections = proven.proof.subarray(directionsStart(proven.proof));
    const tampered = new Uint8Array(widerTree.length + honestDirections.length);
    tampered.set(widerTree);
    tampered.set(honestDirections, widerTree.length);
    await expectAltered('unvisited node in full', tampered);
  });
});
