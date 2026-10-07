import { describe, it, expect } from 'vitest';
import { BatchAVLProver, BatchAVLVerifier, StrictBatchAVLVerifier } from '@dagsocial/avltree';
import type { AvlNode } from '@dagsocial/avltree';
import {
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  PROTOCOL_VERSION,
  STORAGE_RENT_PER_BYTE,
  TREE_KEY_LENGTH,
  TREE_TAG,
  boxKey,
  boxRecordBytes,
  bytesToHex,
  castCountKey,
  decodeTx,
  encodeTx,
  hexToBytes,
  karmaOfKey,
  profileFor,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  CreditBox,
  IdentityRecord,
  KarmaBox,
  NetworkRecord,
  OrderingBlock,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';
import { applyBlock, isSentinel, seedTreeWrites, treeStateView, treeWritesOf, verifierSession } from '@dagsocial/consensus';
import type { ApplyContext } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  burnTx,
  candidateBlock,
  changeOf,
  claimTx,
  consolidateTx,
  creditSendTx,
  finish,
  hex,
  identityRecord,
  inviteTx,
  karmaBox,
  likeTx,
  protocolBox,
  replyTx,
  seedProvenance,
  seededIdentity,
  threadTx,
  uid,
  unvouchTx,
  vouchTx,
  withdrawTx,
  writeEffects,
  type Built,
  type TestIdentity,
} from './helpers.js';
import { TREE_CONFIG, loggingSession, proveBlock, proverFrom, recordingSession, replayBlock } from './block-proof.js';

/**
 * The session over the step-by-step verifier (CONSENSUS_INTERFACE → The tree
 * session): a chain proven on a prover through a recording session
 * (CONSENSUS_INTERFACE → The block proof), then each block replayed on a
 * verifier from its parent's digest and its proof alone — the same verdict, the
 * same writes, the same digest, every lookup answered as the prover's session
 * answered it; the sentinels at both ends of the tree; and a proof with a byte
 * flipped, or one missing the block's last read, making the run throw rather
 * than answer a verdict.
 */

/** Devnet's numbers, the timescales shortened so the cooldown, the probation, decay and rent come due within a few blocks. */
const ctx: ApplyContext = {
  ...applyContextFor(profileFor('devnet')),
  inviteProbationBlocks: 3,
  storageRentPeriodBlocks: 4,
  vouchCooldownBlocks: 3,
  decayCfg: { staleThresholdBlocks: 6, decayIntervalBlocks: 3, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM },
};
const CREDIT = 10n ** 8n;
const named = (label: string): TestIdentity => seededIdentity(`verifier-session/${label}`);
const miner = named('miner');
const [r1, r2, r3] = [named('root-1'), named('root-2'), named('root-3')];
const [t, x, u, v, w, l1, l2] = ['target', 'second-target', 'name-holder', 'passing-name', 'withdrawer', 'liker-1', 'liker-2'].map(named) as [
  TestIdentity, TestIdentity, TestIdentity, TestIdentity, TestIdentity, TestIdentity, TestIdentity,
];
const [c1, c2, i1] = [named('credit-sender'), named('credit-recipient'), named('invitee')];

/** One block of the chain: the prover's state before it — a proof-cycle boundary — and what proving it answered. */
interface Proven {
  label: string;
  block: OrderingBlock;
  parent: { root: AvlNode; height: number; digest: Uint8Array };
  proven: ReturnType<typeof proveBlock>;
}

/** The block with body entry `i` changed and re-encoded; its declared id, which no signature enters, stays. */
function withEntry(block: OrderingBlock, i: number, change: (tx: UtxoTransaction) => void): OrderingBlock {
  const utxoTxs = [...block.utxoTxTree.utxoTxs];
  const tx = decodeTx(utxoTxs[i]!);
  change(tx);
  utxoTxs[i] = encodeTx(tx);
  return { ...block, utxoTxTree: { ...block.utxoTxTree, utxoTxs } };
}

/**
 * The tree view's round-trip chain, built over `MemoryStateView` and proven on
 * a prover seeded with the same genesis: blocks 1 to 6 and 8 — and ahead of
 * block 2, block 2 with its name claim's signature corrupted, which the rules
 * refuse after the reads they made before the batch.
 */
function provenChain(): Proven[] {
  const boxes: AnyBox[] = [];
  const records: Array<{ identityId: Uint8Array; record: IdentityRecord }> = [];
  let seedNonce = 1;
  for (const [who, values] of [[r1, [1000n]], [r2, [1000n]], [r3, [6n, 6n]]] as const) {
    for (const value of values) boxes.push(karmaBox(who.userId, value, seedNonce++, 0));
    records.push({ identityId: who.userId, record: identityRecord({ memberSinceBlock: 1 }) });
  }
  for (const who of [t, x, u, v, w, l1, l2]) {
    boxes.push(karmaBox(who.userId, 100n, seedNonce++, 0));
    records.push({ identityId: who.userId, record: identityRecord() });
  }
  const c1Credit = seedProvenance<CreditBox>(
    { boxType: 'credit', value: 100n * CREDIT, createdAtBlock: 0, owner: c1.userId },
    0,
    seedNonce++,
  );
  boxes.push(
    c1Credit,
    protocolBox('emission', profileFor('devnet').creditEmissionTotal, seedNonce++),
    protocolBox('karma_pool', 1_000_000n, seedNonce++),
  );
  const network: NetworkRecord = { memberCount: 3 };

  const memory = new MemoryStateView(network);
  for (const box of boxes) memory.insertBox(box);
  for (const { identityId, record } of records) memory.putIdentityRecord(identityId, record);
  const prover = proverFrom(seedTreeWrites(boxes, records, network));

  const chain: Proven[] = [];
  const prove = (label: string, block: OrderingBlock): Proven['proven'] => {
    const parent = { root: prover.root, height: prover.height, digest: prover.digest() };
    const proven = proveBlock(prover, block, ctx);
    chain.push({ label, block, parent, proven });
    return proven;
  };
  const step = (height: number, txs: Built[]): OrderingBlock => {
    const block = candidateBlock(memory, height, txs, miner.userId, ctx);
    const { result } = prove(`block ${height}`, block);
    if (!result.ok) throw new Error(`block ${height} was refused over the prover: ${result.reason}`);
    const fromMemory = applyBlock(memory, block, ctx);
    if (!fromMemory.ok) throw new Error(`block ${height} was refused over the reference: ${fromMemory.reason}`);
    writeEffects(memory, fromMemory.effects, height);
    return block;
  };
  const largest = (who: TestIdentity): KarmaBox => {
    const box = memory.getKarmaBoxes(who.userId)[0];
    if (!box) throw new Error(`${hex(who.userId).slice(0, 8)} holds no karma`);
    return box;
  };

  // 1: a thread, and a reply and a like in the block confirming it; a thread withdrawn at 5.
  const tThread = threadTx(t, largest(t), 'the target opens a thread', 1);
  const wThread = threadTx(w, largest(w), 'a thread its author withdraws', 1);
  step(1, [
    tThread,
    replyTx(r2, largest(r2), 'a reply in the block that confirms its parent', tThread.postId, t.userId, 1),
    likeTx(r1, largest(r1), tThread.postId, t.userId, 1),
    wThread,
  ]);

  // 2: two vouches — the target becomes a member — a like, an invite, a name, credits, a like and a reply;
  // first with the name claim's signature corrupted.
  const r3Consolidate = consolidateTx(r3, memory.getKarmaBoxes(r3.userId), 2);
  const r1Vouch = vouchTx(r1, largest(r1), t.userId, 2);
  const r2Like = likeTx(r2, largest(r2), tThread.postId, t.userId, 2);
  const uClaim = claimTx(u, largest(u), 'Pinned', 2);
  const c1Send = creditSendTx(c1, c1Credit, 40n * CREDIT, c2.userId, CREDIT, 2);
  const l1Like = likeTx(l1, largest(l1), tThread.postId, t.userId, 2);
  const body2 = [
    r3Consolidate,
    vouchTx(r3, changeOf(r3Consolidate), x.userId, 2),
    r1Vouch,
    r2Like,
    inviteTx(r2, changeOf(r2Like), i1.userId, 25n, 2),
    uClaim,
    c1Send,
    l1Like,
    replyTx(l1, changeOf(l1Like), 'a reply paid from its own change', wThread.postId, w.userId, 2),
  ];
  const block2 = candidateBlock(memory, 2, body2, miner.userId, ctx);
  const claimant = hex(u.userId);
  const refused = prove('block 2, refused', withEntry(block2, body2.indexOf(uClaim), (tx) => {
    const signature = Uint8Array.from(tx.signatures[claimant]!);
    signature[0] = signature[0]! ^ 1;
    tx.signatures[claimant] = signature;
  }));
  if (refused.result.ok) throw new Error('block 2 with a corrupted signature was accepted');
  step(2, body2);

  // 3: a name claimed and burned in one block, and the new member's vouch.
  const vClaim = claimTx(v, largest(v), 'Fleeting', 3);
  step(3, [vClaim, burnTx(v, changeOf(vClaim), vClaim.out[1]!, 3), vouchTx(t, largest(t), w.userId, 3)]);

  // 4: a burn, its owner's next claim, and another's claim of the burned name.
  const uBurn = burnTx(u, largest(u), uClaim.out[1]!, 4);
  step(4, [uBurn, claimTx(u, changeOf(uBurn), 'Second', 4), claimTx(w, largest(w), 'pinned', 4)]);

  // 5: a like and a withdrawal of one post, an unvouch that lapses the target, the invite's bond settling.
  step(5, [
    likeTx(l2, largest(l2), wThread.postId, w.userId, 5),
    withdrawTx(w, largest(w), wThread.postId, 5),
    unvouchTx(r1, r1Vouch.out[1]! as VouchBox, ctx.vouchCooldownBlocks, 5),
  ]);

  // 6: an empty body: the unvouch's escrow releases, and the lapse leg withdraws the lapsed target's vouch.
  step(6, []);

  // 8: decay on the stale owners the body touches, one of them posting; rent from a box dormant since 2.
  const dormant = c1Send.out[0]! as CreditBox;
  const charge = STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(dormant, dormant.txId, dormant.index).length);
  const rent = finish({
    inputs: [dormant.id!],
    outputs: [
      { boxType: 'credit', value: dormant.value - charge, createdAtBlock: 8, owner: dormant.owner } as AnyBoxCandidate,
      { boxType: 'fee', value: charge, createdAtBlock: 8 } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, null);
  step(8, [consolidateTx(l2, memory.getKarmaBoxes(l2.userId), 8), threadTx(x, largest(x), 'a stale owner posts', 8), rent]);

  return chain;
}

const chain = provenChain();
const at = (label: string): Proven => {
  const found = chain.find((p) => p.label === label);
  if (found === undefined) throw new Error(`the chain holds no ${label}`);
  return found;
};

describe('verifierSession — a chain replayed from its proofs', () => {
  /** Each block replayed from its parent's digest and its proof, inside the test that reads it. */
  const replays = () => chain.map(({ label, block, parent, proven }) => ({
    label,
    proven,
    replay: replayBlock(parent.digest, proven.proof, block, ctx),
  }));

  it('proves the refused block and every accepted one', () => {
    expect(chain.map(({ label, proven }) => [label, proven.result.ok])).toEqual([
      ['block 1', true],
      ['block 2, refused', false],
      ['block 2', true],
      ['block 3', true],
      ['block 4', true],
      ['block 5', true],
      ['block 6', true],
      ['block 8', true],
    ]);
  });

  it("answers each block from its proof alone, anchored at its parent's digest: the same verdict, the same writes, the same digest", () => {
    for (const { label, proven, replay } of replays()) {
      expect(replay.result, label).toEqual(proven.result);
      expect(replay.writes, label).toEqual(proven.writes);
      expect(replay.digest, label).toEqual(proven.digest);
    }
    expect(at('block 2, refused').proven.digest).toEqual(at('block 2, refused').parent.digest);
  });

  it("answers every lookup as the prover's session answered it, key for key, a sentinel neighbour among them", () => {
    const replayed = replays();
    for (const { label, proven, replay } of replayed) {
      expect(replay.keys, label).toEqual(proven.keys);
      expect(replay.answers, label).toEqual(proven.answers);
    }
    const atAnEnd = replayed
      .flatMap(({ replay }) => replay.answers)
      .filter((answer) => isSentinel(answer.nextKey) || (!answer.found && isSentinel(answer.prevKey)));
    expect(atAnEnd.length).toBeGreaterThan(0);
  });

  it("proves the view's distinct keys in first-read order: the rules' reads, then the writes' own, each a cast count", () => {
    for (const { label, proven } of chain) {
      expect(new Set(proven.keys).size, label).toBe(proven.keys.length);
      expect(proven.keys.length, label).toBe(proven.lookups);
      const writesOwn = proven.keys.slice(proven.rulesLookups);
      expect(writesOwn.every((key) => hexToBytes(key)[0] === TREE_TAG.castCount), label).toBe(true);
    }
    // A block that spends and creates and moves no vouch adds no read; one that casts vouches reads their counts.
    expect(at('block 1').proven.lookups - at('block 1').proven.rulesLookups).toBe(0);
    expect(at('block 2').proven.lookups - at('block 2').proven.rulesLookups).toBe(2);
  });
});

describe('verifierSession — the ends of the tree', () => {
  it("answers the sentinels as the prover's session does — all 0x00 below the first key, all 0xff past the last — a fresh array each", () => {
    const owner = uid('verifier-session/ends-owner');
    const held = [karmaBox(owner, 5n, 1, 0), karmaBox(owner, 6n, 2, 0)];
    const prover = proverFrom(seedTreeWrites(held, [], { memberCount: 0 }));
    const parentDigest = prover.digest();
    const byKey = (a: Uint8Array, b: Uint8Array): number => (hex(a) < hex(b) ? -1 : hex(a) > hex(b) ? 1 : 0);
    // The tree: two box keys (tag 0x01), the network record (0x03), two karma entries (0x10).
    const first = held.map((box) => boxKey(hexToBytes(box.id!))).sort(byKey)[0]!;
    const last = held.map((box) => karmaOfKey(owner, hexToBytes(box.id!))).sort(byKey)[1]!;
    const belowFirst = boxKey(new Uint8Array(32));
    const pastLast = castCountKey(new Uint8Array(32).fill(0xff));
    const keys = [belowFirst, first, last, pastLast];

    const proverLog = loggingSession(recordingSession(prover));
    for (const key of keys) proverLog.lookup(key);
    const verifierLog = loggingSession(verifierSession(new BatchAVLVerifier(parentDigest, prover.generateProof(), TREE_CONFIG)));
    for (const key of keys) verifierLog.lookup(key);

    expect(verifierLog.answers).toEqual(proverLog.answers);
    const [below, atFirst, atLast, past] = verifierLog.answers;
    const zeros = new Uint8Array(TREE_KEY_LENGTH);
    const ones = new Uint8Array(TREE_KEY_LENGTH).fill(0xff);
    expect(below).toEqual({ found: false, prevKey: zeros, nextKey: first });
    expect(atFirst!.found).toBe(true);
    expect(atLast).toEqual({ found: true, value: expect.any(Uint8Array), nextKey: ones });
    expect(past).toEqual({ found: false, prevKey: last, nextKey: ones });
    expect(atLast!.nextKey).not.toBe(past!.nextKey);
  });
});

describe('verifierSession — a proof that does not verify', () => {
  it('a proof with one byte flipped makes the run throw rather than answer a verdict — a byte of its tree, or its last', () => {
    const { block, parent, proven } = at('block 2');
    const flipped = (position: number, mask: number): Uint8Array => {
      const bytes = Uint8Array.from(proven.proof);
      bytes[position] = bytes[position]! ^ mask;
      return bytes;
    };
    for (const position of [0, Math.floor(proven.proof.length / 3), Math.floor(proven.proof.length / 2)]) {
      const proof = flipped(position, 0x01);
      // The byte is the tree's, so the proof no longer anchors at the parent's digest.
      expect(new BatchAVLVerifier(parent.digest, proof, TREE_CONFIG).digest(), `byte ${position}`).toBeNull();
      expect(() => replayBlock(parent.digest, proof, block, ctx), `byte ${position}`).toThrow('proof refuses');
    }
    // The last byte is the directions': the proof anchors, and an operation it steers fails.
    const proof = flipped(proven.proof.length - 1, 0xff);
    expect(new BatchAVLVerifier(parent.digest, proof, TREE_CONFIG).digest()).not.toBeNull();
    expect(() => replayBlock(parent.digest, proof, block, ctx)).toThrow('proof refuses');
  });

  it("a proof missing the block's last read makes the run throw — a read of the writes' own, or of the rules'", () => {
    for (const [label, castCount] of [['block 2', true], ['block 1', false]] as const) {
      const { block, parent, proven } = at(label);
      const lastRead = proven.keys[proven.keys.length - 1]!;
      expect(hexToBytes(lastRead)[0] === TREE_TAG.castCount, label).toBe(castCount);
      const prover = new BatchAVLProver(TREE_KEY_LENGTH, null);
      prover.restoreRoot(parent.root, parent.height);
      const skipped = proveBlock(prover, block, ctx, new Set([lastRead]));
      expect(skipped.keys, label).toEqual(proven.keys);
      expect(skipped.digest, label).toEqual(proven.digest);
      expect(skipped.proof, label).not.toEqual(proven.proof);
      expect(() => replayBlock(parent.digest, skipped.proof, block, ctx), label).toThrow('the proof refuses the lookup');
    }
  });

  it('a lookup the verifier refuses is an Error naming its reason — over a proof anchored elsewhere, or of a sentinel', () => {
    const { block, proven } = at('block 1');
    const elsewhere = new BatchAVLVerifier(at('block 2').parent.digest, proven.proof, TREE_CONFIG);
    expect(() => applyBlock(treeStateView(verifierSession(elsewhere)), block, ctx)).toThrow(': digest-mismatch');
    expect(elsewhere.getLastFailReason()).toBe('digest-mismatch');

    const healthy = new BatchAVLVerifier(at('block 1').parent.digest, proven.proof, TREE_CONFIG);
    expect(() => verifierSession(healthy).lookup(new Uint8Array(TREE_KEY_LENGTH))).toThrow(': key-out-of-bounds');
  });
});

describe('replayBlock — the proof is consumed exactly', () => {
  it('an honest proof replays; the same proof with one zero byte appended is refused — a plain BatchAVLVerifier replays it to the right digest', () => {
    const { block, parent, proven } = at('block 2');
    expect(() => replayBlock(parent.digest, proven.proof, block, ctx)).not.toThrow();

    const padded = new Uint8Array(proven.proof.length + 1);
    padded.set(proven.proof);
    // The plain verifier accepts it: a step-by-step verifier reads only the
    // bits an operation names, so a trailing byte is unseen there. The rules'
    // reads and `treeWritesOf`'s own cast-count read are each a lookup through
    // the view; the writes are then performed on the verifier.
    const plain = new BatchAVLVerifier(parent.digest, padded, TREE_CONFIG);
    const view = treeStateView(verifierSession(plain));
    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const writes = treeWritesOf(result.effects, block.header.height, view);
    for (const write of writes) {
      expect(plain.performOneOperation(write).success, bytesToHex(write.key)).toBe(true);
    }
    expect(plain.digest()).toEqual(proven.digest);

    // The strict helper refuses — isFullyConsumed() is what adds this check.
    expect(() => replayBlock(parent.digest, padded, block, ctx))
      .toThrow('is not byte for byte the proof its operations write');
  });
});

describe('verifierSession — either step-by-step verifier', () => {
  it("takes BatchAVLVerifier and StrictBatchAVLVerifier: each answers the first block's reads as the prover's session did", () => {
    const { block, parent, proven } = at('block 1');
    for (const verifier of [
      new BatchAVLVerifier(parent.digest, proven.proof, TREE_CONFIG),
      new StrictBatchAVLVerifier(parent.digest, proven.proof, TREE_CONFIG),
    ]) {
      const log = loggingSession(verifierSession(verifier));
      // The rules alone — the writes would move the verifier out from under a later run.
      const view = treeStateView(log);
      const result = applyBlock(view, block, ctx);
      expect(result.ok, verifier.constructor.name).toBe(true);
      expect(log.keys, verifier.constructor.name).toEqual(proven.keys.slice(0, log.keys.length));
      expect(log.answers, verifier.constructor.name).toEqual(proven.answers.slice(0, log.answers.length));
    }
  });
});
