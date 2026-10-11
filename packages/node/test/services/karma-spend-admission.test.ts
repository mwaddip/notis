// NODE_INTERFACE → Karma transition rules → "A karma spend is covered by
// effective karma, over the block's body as a whole" and "Engine inputs the
// rule needs": admission reads `held = store.getKarmaValue(owner) -
// pendingKarmaSpend(hex(owner))` and `owed = karmaOwed(sum, record, height,
// decayCfg)`, through the one implementation in `services/karma-admission.ts`
// wired into both engine-deps literals (`server.ts`,
// `services/handle-tx.ts`). Every case here goes through the service
// functions the routes call, over the real store and the real `validateTx`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computeContentHash,
  computeTxId,
  decodeTx,
  effectiveKarma,
  KARMA_MINIMUM,
  LIKE_KARMA_COST,
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
  BondBox,
  IdentityRecord,
  KarmaBox,
  UtxoTransaction,
  VouchBox,
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
} from '../../src/store/index.js';
import { castLike } from '../../src/services/likes.js';
import { createInvite } from '../../src/services/invites.js';
import { castVouch } from '../../src/services/vouch.js';
import { admissionHeld, admissionOwed } from '../../src/services/karma-admission.js';
import { ClientError } from '../../src/services/client-error.js';
import {
  rawPublicKey,
  seedProvenance,
  signTransaction,
  fixturePostId,
  fixtureTxId,
  type Stored,
} from '../helpers.js';
import { config } from '../../src/config.js';

const AUTHOR = new Uint8Array(32).fill(0x7a);
const AUTHOR_HEX = Buffer.from(AUTHOR).toString('hex');

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
function seedKarma(owner: Uint8Array, value: bigint, seed: number): Stored<KarmaBox> {
  const box = seedProvenance<KarmaBox>(
    { boxType: 'karma', value, createdAtBlock: 0, owner },
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

/**
 * The admitted karma transactions clear from the pool and the owner's karma
 * resolves to the post-body state — the simulation of a block confirming the
 * body without replaying `applyBlock`. The input is spent, each change box
 * lands, and the markers do not: the settlement consumes them in the same
 * block. The pool is cleared of every `tx_id`.
 */
function confirmPendingKarmaTxs(txs: UtxoTransaction[], atBlock: number): void {
  for (const tx of txs) {
    const txId = computeTxId(tx);
    for (const id of tx.inputs) {
      storeConsumeBox(id, atBlock);
    }
    // Output 0 is the change box when there is one; the markers settle out.
    const change = tx.outputs[0];
    if (change && change.boxType === 'karma') {
      const changeBox = {
        ...(change as KarmaBox),
        txId,
        index: 0,
      } as KarmaBox;
      insertBox({ ...changeBox, id: computeBoxId(changeBox) } as AnyBox);
    }
    removeUtxoTxEntry(txId);
  }
}

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
    closeDb();
  });

  // -------- Scenario 1: one 12-karma box --------

  describe('a fresh identity with one 12-karma box', () => {
    it('admits a like; admits a second over the pooled change; refuses a third with the floor\'s text', () => {
      // Three posts so `(liker, post)` dedup does not refuse the second like
      // ahead of the karma rule (NODE_INTERFACE → Likes).
      const target1 = postId;
      const target2 = insertNamedPost('scenario-1-second');
      const target3 = insertNamedPost('scenario-1-third');
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

    it('after a body confirms the first two likes, a like is still refused and a thread is admitted', () => {
      const target1 = postId;
      const target2 = insertNamedPost('scenario-1b-second');
      const target3 = insertNamedPost('scenario-1b-after');
      const karma = seedKarma(liker.pub, 12n, 1);
      const deps = admissionDeps();

      const like1 = buildLike(liker, karma, target1);
      castLike(deps, like1, 10);
      const change1 = pendingChangeBox(like1);
      const like2 = buildLike(liker, change1, target2);
      castLike(deps, like2, 10);

      confirmPendingKarmaTxs([like1, like2], 10);

      // The confirmed sum is now 10 (the change-of-change). The pool is empty.
      expect(storeKarmaValue(liker.pub)).toBe(10n);
      expect(pendingKarmaSpend(liker.pubHex)).toBe(0n);

      // A like at remaining 10, spend 1: 10 - 1 = 9 < floor 10 → refused.
      const change2 = pendingChangeBox(like2);
      const liveChange = storeGetBox(change2.id!) as KarmaBox;
      const likeAfter = buildLike(liker, liveChange, target3);
      expect(() => castLike(deps, likeAfter, 11)).toThrow(/below the floor of 10/);

      // A thread: remaining 10 ≥ spend 5, floor not read on the post arm.
      const threadTx = buildThread(liker, liveChange, 'a thread the owner can still write');
      const threadResult = validateTx(deps, threadTx, 11);
      expect(threadResult.valid).toBe(true);
    });
  });

  // -------- Scenario 2: 12 karma spread over two 6-value boxes --------

  it('two 6-karma boxes: a like from each is admitted, a third is refused', () => {
    // Two posts are needed because `(liker, post)` dedup refuses the same
    // liker a second like on one post (NODE_INTERFACE → Likes).
    const postIdA = postId;
    const postIdB = insertNamedPost('second-target-for-scenario-2');
    const postIdC = insertNamedPost('third-target-for-scenario-2');
    const first = seedKarma(liker.pub, 6n, 1);
    seedKarma(liker.pub, 6n, 2);
    const deps = admissionDeps();

    // held = 12, pending 0, remaining - spend = 11.
    const like1 = buildLike(liker, first, postIdA);
    expect(() => castLike(deps, like1, 10)).not.toThrow();

    // The second box's own id, not the pool's change. The sum is the owner's,
    // not the box's: pending = 1, held = 11, remaining - spend = 10 ≥ floor.
    const second = getKarmaBoxes(liker.pub).find((b) => b.id !== first.id)!;
    const like2 = buildLike(liker, second as KarmaBox, postIdB);
    expect(() => castLike(deps, like2, 10)).not.toThrow();

    // held = 12 - 2 = 10. A like from the pending change box of like1 would
    // leave 10 - 1 = 9 < floor; the engine refuses on `remaining − spend < floor`.
    const change1 = pendingChangeBox(like1);
    const like3 = buildLike(liker, change1, postIdC);
    expect(() => castLike(deps, like3, 10)).toThrow(/below the floor of 10/);
  });

  // -------- Scenario 3: a stale identity with effective karma of 10 --------

  it('a stale identity whose effective karma is 10: a like refused, two threads admitted, a third refused', () => {
    // Stale is `lastActivityBlock + staleThresholdBlocks ≤ height` and
    // `karmaOwed` grants decay to the floor. We seed 20 face and record a
    // stale clock so `owed = 10` leaves `remaining = 10`.
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

    // The pre-body effective karma is 10 under these settings.
    const face = storeKarmaValue(liker.pub);
    const remaining = effectiveKarma(face, rec, height, deps.decayCfg);
    expect(remaining).toBe(10n);

    // A like: 10 - 1 = 9 < floor 10 → refused.
    const likeTx = buildLike(liker, karma, postId);
    expect(() => castLike(deps, likeTx, height)).toThrow(/below the floor of 10/);

    // A thread: remaining 10 ≥ spend 5, admitted (the post arm does not read
    // the floor).
    const t1 = buildThread(liker, karma, 'thread 1');
    const t1Result = validateTx(deps, t1, height);
    expect(t1Result.valid).toBe(true);
  });

  // -------- Scenario 4: invite --------

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

  // -------- Scenario 5: vouch --------

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

  // -------- Scenario 6: the relay --------

  it('handleRelayedTx refuses the third like of scenario 1, and the pool holds what it held', async () => {
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
    const { vi } = await import('vitest');
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
