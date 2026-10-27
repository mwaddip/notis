// NODE_INTERFACE → Karma transition rules → "A karma spend is covered by
// effective karma, over the block's body as a whole" and "Engine inputs the
// rule needs": admission reads `held = store.getKarmaValue(owner) -
// pendingKarmaSpend(hex(owner))` and `owed = karmaOwed(sum, record, height,
// decayCfg)`, through the one implementation in `services/karma-admission.ts`
// wired by both engine-deps literals (`server.ts`,
// `services/handle-tx.ts`). Every case here goes through the service
// functions the routes call, over the real store and the real `validateTx`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computeContentHash,
  computeTxId,
  decodeTx,
  effectiveKarma,
  KARMA_MINIMUM,
  LIKE_KARMA_COST,
  MAX_BLOCK_BODY_BYTES,
  POST_PRICE_THREAD,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
} from '@dagsocial/types';
import { validateTx } from '@dagsocial/consensus';
import type {
  AnyBox,
  IdentityRecord,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import {
  initDb,
  closeDb,
  getDb,
  getKarmaBoxes,
  insertBox,
  insertPost,
  getBox as storeGetBox,
  consumeBox as storeConsumeBox,
  getIdentityRecord as storeGetIdentityRecord,
  putIdentityRecord as storePutIdentityRecord,
  getNetworkRecord as storeGetNetworkRecord,
  getVouchBox as storeGetVouchBox,
  hasActiveVouchEscrow as storeHasActiveVouchEscrow,
  getBoxWithPending,
  removeUtxoTxEntry,
  getPendingEntries,
  pendingKarmaSpend,
  getKarmaValue as storeKarmaValue,
  getPost as storeGetPost,
  getHeldEntry,
} from '../../src/store/index.js';
import { castLike } from '../../src/services/likes.js';
import { createInvite } from '../../src/services/invites.js';
import { castVouch } from '../../src/services/vouch.js';
import { createPost } from '../../src/services/post-service.js';
import { verifyPost } from '../../src/services/verifier.js';
import { admitTx } from '../../src/services/admit-tx.js';
import {
  startBlockCreator,
  stopBlockCreator,
  createOrderingBlock,
  getCurrentTemplate,
  submitMinedBlock,
} from '../../src/services/block-creator.js';
import { admissionHeld, admissionOwed, admissionGetOwnKarmaBoxIds } from '../../src/services/karma-admission.js';
import { ClientError } from '../../src/services/client-error.js';
import {
  makeTestConfig,
  mineNextBlock,
  rawPublicKey,
  seedCommittedState,
  seedProvenance,
  signTransaction,
  fixturePostId,
  fixtureTxId,
  type Stored,
} from '../helpers.js';
import type { PostServiceDeps } from '../../src/services/post-service.js';
import { config } from '../../src/config.js';

const AUTHOR = new Uint8Array(32).fill(0x7a);

interface Identity {
  pub: Uint8Array;
  priv: KeyObject;
  pubHex: string;
}

function newIdentity(): Identity {
  const kp = generateKeyPairSync('ed25519');
  const pub = rawPublicKey(kp.publicKey);
  return { pub, priv: kp.privateKey, pubHex: Buffer.from(pub).toString('hex') };
}

/** Deps built as `server.ts`' and `handle-tx.ts`' admission literals build them. */
function admissionDeps(): UtxoEngineDeps {
  const decayCfg = {
    staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
    decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
    decayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
  };
  return {
    getBox: getBoxWithPending,
    insertBox,
    consumeBox: storeConsumeBox,
    getKarmaValue: admissionHeld,
    getOwnKarmaBoxIds: admissionGetOwnKarmaBoxIds,
    getKarmaOwed: admissionOwed(decayCfg),
    getIdentityRecord: storeGetIdentityRecord,
    hasActiveVouchEscrow: storeHasActiveVouchEscrow,
    vouchCooldownBlocks: 2,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg,
    storageRentPeriodBlocks: 40,
    getBoxProvenance: () => null,
    getTopologyAuthor: () => AUTHOR,
    getPendingPostAuthor: () => null,
    runInTransaction: (fn) => (getDb().transaction(fn) as () => void)(),
    getVouchBox: storeGetVouchBox,
    getNetworkRecord: storeGetNetworkRecord,
    membershipBarMultiplier: 1,
    putIdentityRecord: storePutIdentityRecord,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    getUsername: () => null,
    getUsernameByOwner: () => null,
  };
}

/** A karma box owned by `owner` seeded in the committed set at height 0, nonce `seed`. */
function seedKarma(owner: Uint8Array, value: bigint, seed: number, income?: true): Stored<KarmaBox> {
  const box = seedProvenance<KarmaBox>(
    { boxType: 'karma', value, createdAtBlock: 0, owner, ...(income === true ? { income: true as const } : {}) },
    0,
    seed,
  );
  insertBox(box);
  return box;
}

function insertTargetPost(): string {
  const commit = {
    contentHash: computeContentHash('karma-spend admission subject'),
    author: AUTHOR,
    parentRefs: [] as string[],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular' as const,
  };
  const postId = fixturePostId(commit);
  insertPost(postId, fixtureTxId(commit), commit, 'karma-spend admission subject');
  return postId;
}

/** A signed like transaction over `karmaInput`, targeting `postId`. */
function buildLike(liker: Identity, karmaInput: KarmaBox, postId: string): UtxoTransaction {
  const change = karmaInput.value - LIKE_KARMA_COST;
  const outputs: AnyBox[] = [];
  if (change > 0n) {
    outputs.push({
      boxType: 'karma',
      value: change,
      createdAtBlock: 0,
      owner: liker.pub,
    } as unknown as AnyBox);
  }
  outputs.push({
    boxType: 'like_accrual',
    value: LIKE_KARMA_COST,
    createdAtBlock: 0,
    author: AUTHOR,
  } as unknown as AnyBox);
  const tx: UtxoTransaction = {
    inputs: [karmaInput.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: postId,
  };
  signTransaction(tx, liker.priv, liker.pubHex);
  return tx;
}

/** A signed thread post over `karmaInput`. */
function buildThread(author: Identity, karmaInput: KarmaBox, content: string): UtxoTransaction {
  const change = karmaInput.value - POST_PRICE_THREAD;
  const outputs: AnyBox[] = [];
  if (change > 0n) {
    outputs.push({
      boxType: 'karma',
      value: change,
      createdAtBlock: 0,
      owner: author.pub,
    } as unknown as AnyBox);
  }
  outputs.push({
    boxType: 'karma_price',
    value: POST_PRICE_THREAD,
    createdAtBlock: 0,
  } as unknown as AnyBox);
  const tx: UtxoTransaction = {
    inputs: [karmaInput.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: {
      contentHash: computeContentHash(content),
      author: author.pub,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    },
  };
  signTransaction(tx, author.priv, author.pubHex);
  return tx;
}

/** A signed invite transaction consuming `karmaInput`, bonding `bondValue` to `invitee`. */
function buildInvite(
  inviter: Identity,
  karmaInput: KarmaBox,
  bondValue: bigint,
  invitee: Uint8Array,
): UtxoTransaction {
  const change = karmaInput.value - bondValue;
  const outputs: AnyBox[] = [];
  if (change > 0n) {
    outputs.push({
      boxType: 'karma',
      value: change,
      createdAtBlock: 0,
      owner: inviter.pub,
    } as unknown as AnyBox);
  }
  outputs.push({
    boxType: 'bond',
    value: bondValue,
    createdAtBlock: 0,
    inviterId: inviter.pub,
    inviteePublicKey: invitee,
  } as unknown as AnyBox);
  const tx: UtxoTransaction = {
    inputs: [karmaInput.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, inviter.priv, inviter.pubHex);
  return tx;
}

/** A signed vouch cast consuming `karmaInput`, staking VOUCH_KARMA_AMOUNT for `target`. */
function buildVouchCast(
  voucher: Identity,
  karmaInput: KarmaBox,
  target: Uint8Array,
  height: number,
): UtxoTransaction {
  const change = karmaInput.value - VOUCH_KARMA_AMOUNT;
  const outputs: AnyBox[] = [];
  if (change > 0n) {
    outputs.push({
      boxType: 'karma',
      value: change,
      createdAtBlock: 0,
      owner: voucher.pub,
    } as unknown as AnyBox);
  }
  outputs.push({
    boxType: 'vouch',
    value: VOUCH_KARMA_AMOUNT,
    createdAtBlock: height,
    voucherId: voucher.pub,
    targetId: target,
  } as unknown as AnyBox);
  const tx: UtxoTransaction = {
    inputs: [karmaInput.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, voucher.priv, voucher.pubHex);
  return tx;
}

/** The pooled change box of a karma transaction whose output 0 is the change. */
function pendingChangeBox(tx: UtxoTransaction): KarmaBox {
  const txId = computeTxId(tx);
  const materialized = {
    boxType: 'karma' as const,
    value: (tx.outputs[0] as KarmaBox).value,
    createdAtBlock: 0,
    owner: (tx.outputs[0] as KarmaBox).owner,
    txId,
    index: 0,
  };
  return { ...materialized, id: computeBoxId(materialized) };
}

/** The topology record the vouch service expects. */
function putMember(pub: Uint8Array, memberSinceBlock = 1): void {
  const rec: IdentityRecord = {
    lastActivityBlock: memberSinceBlock,
    lastDecayBlock: 0,
    invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
    memberSinceBlock,
    memberBar: 0,
    memberVouches: 0,
    memberLikes: 0n,
    invitesUsed: 0,
  };
  storePutIdentityRecord(pub, rec);
}

/** The topology record a root holds — invited at genesis, never set past. */
function putRoot(pub: Uint8Array): void {
  const rec: IdentityRecord = {
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
  storePutIdentityRecord(pub, rec);
}

/** The deps `routes/posts.ts` passes `createPost`, built over `engine` and `storeGetPost`. */
function postServiceDeps(engine: UtxoEngineDeps, getCurrentHeight: () => number): PostServiceDeps {
  return {
    verifyPost,
    getKarmaBoxes,
    getIdentityRecord: engine.getIdentityRecord,
    decayCfg: engine.decayCfg,
    getPost: storeGetPost,
    insertPost,
    getCurrentHeight,
    protocolVersionSchedule: engine.protocolVersionSchedule,
    admitTx,
    getHeldEntry,
    validateTx: (tx, i, h) => validateTx(engine, tx, i, h),
    getBox: engine.getBox,
    runInTransaction: engine.runInTransaction,
  };
}

/** The config a block creator starts under in these cases — testnet, miner, the consensus budget. */
const miningConfig = makeTestConfig({
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

/** Insert a post with the given content; returns its id. */
function insertNamedPost(content: string): string {
  const commit = {
    contentHash: computeContentHash(content),
    author: AUTHOR,
    parentRefs: [] as string[],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular' as const,
  };
  const postId = fixturePostId(commit);
  insertPost(postId, fixtureTxId(commit), commit, content);
  return postId;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('admission\'s held and owed are the engine\'s two inputs', () => {
  let liker: Identity;
  let postId: string;

  beforeEach(() => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    liker = newIdentity();
    postId = insertTargetPost();
  });

  afterEach(() => {
    try {
      stopBlockCreator();
    } catch {
      // The creator may not have started in this case.
    }
    closeDb();
  });

  // -------- One 12-karma box --------

  describe('a fresh identity with one 12-karma box', () => {
    it('admits a like; admits a second over the pooled change; refuses a third with the floor\'s text', () => {
      // Three posts so `(liker, post)` dedup does not refuse the second like
      // ahead of the karma rule (NODE_INTERFACE → Likes).
      const target1 = postId;
      const target2 = insertNamedPost('one-box-second');
      const target3 = insertNamedPost('one-box-third');
      const karma = seedKarma(liker.pub, 12n, 1);
      const deps = admissionDeps();

      // Like 1 — held 12, remaining 12, spend 1, remaining - spend = 11 ≥ 10.
      const like1 = buildLike(liker, karma, target1);
      expect(() => castLike(deps, like1, 10)).not.toThrow();

      // Like 2 — the pool's `getBoxWithPending` finds the change box
      // output of `like1`, and `pendingKarmaSpend` is 1 (the first marker).
      // held = 12 - 1 = 11; remaining - spend = 10 ≥ 10.
      const change1 = pendingChangeBox(like1);
      const like2 = buildLike(liker, change1, target2);
      expect(() => castLike(deps, like2, 10)).not.toThrow();

      // Like 3 — pending = 2, held = 10; remaining - spend = 9 < floor 10.
      const change2 = pendingChangeBox(like2);
      const like3 = buildLike(liker, change2, target3);
      let caught: ClientError | null = null;
      try {
        castLike(deps, like3, 10);
      } catch (err) {
        caught = err as ClientError;
      }
      expect(caught).not.toBeNull();
      expect(caught!).toBeInstanceOf(ClientError);
      expect(caught!.statusCode).toBe(400);
      expect(caught!.message).toMatch(/below the floor of 10/);
      expect(caught!.message).toMatch(/Karma spend of 1 would leave 9/);

      // The pool still holds two entries, no more.
      expect(getPendingEntries(10)).toHaveLength(2);
      expect(pendingKarmaSpend(liker.pubHex)).toBe(2n);
    });

    it('a confirming block holds the two likes, drains the pool, and a thread is admitted by createPost', async () => {
      // Seed the karma box FIRST so the prover's bootstrap finds it in the
      // store — the apply path's engine reads boxes through the tree view,
      // and a box inserted after the bootstrap sits in the store without
      // sitting under the state root.
      const karma = seedKarma(liker.pub, 12n, 1);
      // The like targets must sit under the state root before a block can
      // apply a like referencing them (NODE_INTERFACE → Karma transition
      // rules). `seedCommittedState` writes the post record to the tree and
      // the row to `block_topology` under the author the apply path reads.
      const makeCommit = (content: string) => ({
        contentHash: computeContentHash(content),
        author: AUTHOR,
        parentRefs: [] as string[],
        protocolVersion: PROTOCOL_VERSION,
        type: 'regular' as const,
      });
      const targets = [
        'karma-spend admission subject',
        'one-box-confirmed-second',
        'one-box-confirmed-after',
      ].map((content) => {
        const commit = makeCommit(content);
        return { postId: fixturePostId(commit), txId: fixtureTxId(commit), post: commit };
      });
      await seedCommittedState({ posts: targets }, 0);
      const target1 = targets[0]!.postId;
      const target2 = targets[1]!.postId;
      const target3 = targets[2]!.postId;
      const deps = admissionDeps();

      const like1 = buildLike(liker, karma, target1);
      castLike(deps, like1, 10);
      const change1 = pendingChangeBox(like1);
      const like2 = buildLike(liker, change1, target2);
      castLike(deps, like2, 10);

      // The confirming block is built from the pool by `createOrderingBlock`
      // — the function the mining template route calls — and applied by the
      // path a submitted block takes (`submitMinedBlock`), one call of
      // `mineNextBlock`.
      startBlockCreator(miningConfig);
      const block = await mineNextBlock({ createOrderingBlock, getCurrentTemplate, submitMinedBlock });
      expect(block).not.toBeNull();
      // The body holds the two user txs (and the settlement last), in order.
      const ids = block!.utxoTxTree.utxoTxIds;
      expect(ids.length).toBe(3);
      expect(ids[0]).toBe(computeTxId(like1));
      expect(ids[1]).toBe(computeTxId(like2));

      // The pool is empty — the node's own cleanup drained the rows.
      expect(getPendingEntries(100)).toHaveLength(0);
      expect(pendingKarmaSpend(liker.pubHex)).toBe(0n);
      // The confirmed sum is 10 — the change-of-change box.
      expect(storeKarmaValue(liker.pub)).toBe(10n);

      // A like at remaining 10, spend 1: 10 - 1 = 9 < floor 10 → refused.
      const change2 = pendingChangeBox(like2);
      const liveChange = storeGetBox(change2.id!) as KarmaBox;
      const likeAfter = buildLike(liker, liveChange, target3);
      expect(() => castLike(deps, likeAfter, 11)).toThrow(/below the floor of 10/);

      // A thread: remaining 10 ≥ spend 5, floor not read on the post arm.
      // Through `createPost`, the function `POST /posts` calls.
      const threadContent = 'a thread the owner can still write';
      const threadTx = buildThread(liker, liveChange, threadContent);
      const result = createPost(postServiceDeps(deps, () => 10), threadTx, threadContent);
      expect(result.status).toBe('pending');
    });
  });

  // -------- 12 karma spread over two 6-value boxes --------

  it('12 karma over own + income: two likes admitted, a third is refused', () => {
    // Two posts are needed because `(liker, post)` dedup refuses the same
    // liker a second like on one post (NODE_INTERFACE → Likes). The own
    // box carries the inputs through the chain of likes; the income box
    // rides beside it, counted into `held` but outside the inputs rule 3
    // asks for (NODE_INTERFACE → Karma transition rules → "An identity
    // holds at most two karma boxes").
    const postIdA = postId;
    const postIdB = insertNamedPost('own-income-second');
    const postIdC = insertNamedPost('own-income-third');
    const first = seedKarma(liker.pub, 6n, 1);
    seedKarma(liker.pub, 6n, 2, true);
    const deps = admissionDeps();

    // held = 12, pending 0, remaining - spend = 11.
    const like1 = buildLike(liker, first, postIdA);
    expect(() => castLike(deps, like1, 10)).not.toThrow();

    // The pending change box of like1 is the owner's one unmarked karma box.
    // held = 11, pending = 1, remaining - spend = 10 ≥ floor.
    const change1 = pendingChangeBox(like1);
    const like2 = buildLike(liker, change1, postIdB);
    expect(() => castLike(deps, like2, 10)).not.toThrow();

    // held = 10, pending = 2. A like from the pending change box of like2
    // would leave 10 - 1 = 9 < floor; the engine refuses on
    // `remaining − spend < floor`.
    const change2 = pendingChangeBox(like2);
    const like3 = buildLike(liker, change2, postIdC);
    expect(() => castLike(deps, like3, 10)).toThrow(/below the floor of 10/);
  });

  // -------- A stale identity with effective karma of 10 --------

  it('a stale identity whose effective karma is 10: a like refused, two threads admitted over the pool, a third refused by the post rule', () => {
    // Stale is `lastActivityBlock + staleThresholdBlocks ≤ height` and
    // `karmaOwed` grants decay to the floor. Face 20 under a stale clock
    // gives `owed = 10`, leaving `effectiveKarma = 10`.
    const karma = seedKarma(liker.pub, 20n, 1);
    const rec: IdentityRecord = {
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
    storePutIdentityRecord(liker.pub, rec);
    const height = KARMA_STALE_THRESHOLD_BLOCKS + 1000;
    const deps = admissionDeps();

    // Pre-body: held 20, owed 10, remaining 10.
    const face = storeKarmaValue(liker.pub);
    const remaining = effectiveKarma(face, rec, height, deps.decayCfg);
    expect(remaining).toBe(10n);

    // A like — held 20, pending 0, owed 10; remaining − spend = 9 < floor 10,
    // refused with the floor's text.
    const likeTx = buildLike(liker, karma, postId);
    expect(() => castLike(deps, likeTx, height)).toThrow(/below the floor of 10/);

    // Thread 1 through `createPost`, the function `POST /posts` calls — held
    // 20, pending 0, owed 10; remaining 10 ≥ spend 5. Admitted; the pool's
    // karma spend by the owner is POST_PRICE_THREAD.
    const t1Content = 'thread 1';
    const t1 = buildThread(liker, karma, t1Content);
    const r1 = createPost(postServiceDeps(deps, () => height - 1), t1, t1Content);
    expect(r1.status).toBe('pending');
    expect(pendingKarmaSpend(liker.pubHex)).toBe(POST_PRICE_THREAD);

    // Thread 2 spends thread 1's pooled change box — held 20 − 5 = 15, owed 10;
    // remaining 5 ≥ spend 5. Admitted; the pool's karma spend by the owner is
    // 2 × POST_PRICE_THREAD.
    const change1 = pendingChangeBox(t1);
    const t2Content = 'thread 2';
    const t2 = buildThread(liker, change1, t2Content);
    const r2 = createPost(postServiceDeps(deps, () => height - 1), t2, t2Content);
    expect(r2.status).toBe('pending');
    expect(pendingKarmaSpend(liker.pubHex)).toBe(POST_PRICE_THREAD * 2n);

    // Thread 3 spends thread 2's pooled change — held 20 − 10 = 10, owed 10;
    // remaining 0 < spend 5. Refused by the engine's post rule, naming a
    // `remaining` of 0.
    const change2 = pendingChangeBox(t2);
    const t3Content = 'thread 3';
    const t3 = buildThread(liker, change2, t3Content);
    let caught: ClientError | null = null;
    try {
      createPost(postServiceDeps(deps, () => height - 1), t3, t3Content);
    } catch (err) {
      caught = err as ClientError;
    }
    expect(caught).not.toBeNull();
    expect(caught!).toBeInstanceOf(ClientError);
    expect(caught!.message).toMatch(
      /Karma spend of 5 exceeds what remains of the owner's effective karma \(0\)/,
    );

    // The pool stands as it stood after thread 2 — two entries, karma spend
    // 2 × POST_PRICE_THREAD.
    expect(getPendingEntries(100)).toHaveLength(2);
    expect(pendingKarmaSpend(liker.pubHex)).toBe(POST_PRICE_THREAD * 2n);
  });

  // -------- Invite --------

  it('invite by a root holding the bond plus the floor: admitted at bond+KARMA_MINIMUM, refused at bond+KARMA_MINIMUM-1', () => {
    const inviter = newIdentity();
    putRoot(inviter.pub);
    const invitee = new Uint8Array(32).fill(0x55);
    const bond = config.inviteBondMin;

    // At bond + KARMA_MINIMUM: admitted.
    seedKarma(inviter.pub, bond + KARMA_MINIMUM, 1);
    const deps = admissionDeps();
    const admittedTx = buildInvite(inviter, getKarmaBoxes(inviter.pub)[0] as KarmaBox, bond, invitee);
    expect(() => createInvite(deps, admittedTx, 10)).not.toThrow();
    // Drain the pool so the next inviter's `held` starts clean.
    for (const row of getPendingEntries(100)) {
      removeUtxoTxEntry(computeTxId(decodeTx(row.utxoTxBytes!)));
    }

    // At bond + KARMA_MINIMUM - 1: refused with the courtesy's text.
    const inviter2 = newIdentity();
    putRoot(inviter2.pub);
    seedKarma(inviter2.pub, bond + KARMA_MINIMUM - 1n, 2);
    const deps2 = admissionDeps();
    const refusedTx = buildInvite(inviter2, getKarmaBoxes(inviter2.pub)[0] as KarmaBox, bond, invitee);
    let caught: ClientError | null = null;
    try {
      createInvite(deps2, refusedTx, 10);
    } catch (err) {
      caught = err as ClientError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Insufficient karma to invite/);
    expect(caught!.message).toContain(`${bond}`);
  });

  it('a stale root with a thread in the pool is refused an invite, and the message names 5', () => {
    // Face 1000, a stale clock (lastActivityBlock 0) at a height that drains
    // its decay to the floor so `karmaOwed = 990` and `effectiveKarma = 10`.
    // One POST_PRICE_THREAD (= 5) of karma spent by a pooled thread, so
    // `held = 1000 - 5 = 995`, `owed = 990` over the confirmed sum, and
    // `remaining = 995 - 990 = 5`.
    const inviter = newIdentity();
    putRoot(inviter.pub);
    const inviteeKey = new Uint8Array(32).fill(0x77);
    const karma = seedKarma(inviter.pub, 1000n, 1);
    // decayAmount = 5, so 198 periods drain 1000 face to the floor of 10.
    const height = (198 + 1) * KARMA_DECAY_INTERVAL_BLOCKS;
    const deps = admissionDeps();

    // A thread of POST_PRICE_THREAD (= 5) in the pool, through `createPost`.
    const threadContent = 'a stale root posts a thread';
    const threadTx = buildThread(inviter, karma, threadContent);
    createPost(postServiceDeps(deps, () => height - 1), threadTx, threadContent);
    expect(pendingKarmaSpend(Buffer.from(inviter.pub).toString('hex'))).toBe(POST_PRICE_THREAD);

    // The invite reads `remaining = held − owed = 5`, below the bond's floor.
    const change = pendingChangeBox(threadTx);
    const inviteTx = buildInvite(inviter, change, config.inviteBondMin, inviteeKey);
    let caught: ClientError | null = null;
    try {
      createInvite(deps, inviteTx, height);
    } catch (err) {
      caught = err as ClientError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Insufficient karma to invite/);
    expect(caught!.message).toMatch(/inviter holds 5/);
  });

  // -------- Vouch --------

  it('vouch cast at VOUCH_MIN_BALANCE: admitted; at VOUCH_MIN_BALANCE - 1: refused', () => {
    const voucher = newIdentity();
    const target = newIdentity();
    putMember(voucher.pub);
    putMember(target.pub);
    seedKarma(voucher.pub, VOUCH_MIN_BALANCE, 1);
    const deps = admissionDeps();

    const admittedTx = buildVouchCast(
      voucher,
      getKarmaBoxes(voucher.pub)[0] as KarmaBox,
      target.pub,
      10,
    );
    expect(() => castVouch(deps, admittedTx, 10)).not.toThrow();
    // Drain the pool.
    for (const row of getPendingEntries(100)) {
      removeUtxoTxEntry(computeTxId(decodeTx(row.utxoTxBytes!)));
    }

    const voucher2 = newIdentity();
    putMember(voucher2.pub);
    seedKarma(voucher2.pub, VOUCH_MIN_BALANCE - 1n, 2);
    const deps2 = admissionDeps();
    const refusedTx = buildVouchCast(
      voucher2,
      getKarmaBoxes(voucher2.pub)[0] as KarmaBox,
      target.pub,
      10,
    );
    let caught: ClientError | null = null;
    try {
      castVouch(deps2, refusedTx, 10);
    } catch (err) {
      caught = err as ClientError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(new RegExp(`need at least ${VOUCH_MIN_BALANCE}`));
  });

  // -------- The relay --------

  it('handleRelayedTx refuses a third chained like over two pooled ones, and the pool holds what it held', async () => {
    const target1 = postId;
    const target2 = insertNamedPost('relay-second');
    const target3 = insertNamedPost('relay-third');
    const karma = seedKarma(liker.pub, 12n, 1);
    const deps = admissionDeps();

    const like1 = buildLike(liker, karma, target1);
    castLike(deps, like1, 10);
    const change1 = pendingChangeBox(like1);
    const like2 = buildLike(liker, change1, target2);
    castLike(deps, like2, 10);

    const beforePool = getPendingEntries(100).length;

    const change2 = pendingChangeBox(like2);
    const like3 = buildLike(liker, change2, target3);

    const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
    // The handler logs the refusal and returns — the suite silences stdout.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      handleRelayedTx(like3, undefined, 'peer-relay-under-test');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }

    // The pool is unchanged — the refusal left no row.
    expect(getPendingEntries(100).length).toBe(beforePool);
  });
});
