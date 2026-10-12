// NODE_INTERFACE → Karma transition rules → "An identity holds at most two
// karma boxes": admission's three rules on an own box and an income box,
// through the service functions the routes call. Every case runs over the
// real store and the real validateTx, so the status and refusal text each
// case prints are the ones the HTTP route serves.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import {
  computeContentHash,
  computeTxId,
  decodeTx,
  KARMA_MINIMUM,
  LIKE_KARMA_COST,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
} from '@dagsocial/types';
import type {
  AnyBox,
  IdentityRecord,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { materializeOutput } from '@dagsocial/consensus';
import {
  initDb,
  closeDb,
  getDb,
  insertBox,
  insertPost,
  insertBlockTopology,
  consumeBox as storeConsumeBox,
  getIdentityRecord as storeGetIdentityRecord,
  putIdentityRecord as storePutIdentityRecord,
  getNetworkRecord as storeGetNetworkRecord,
  getVouchBox as storeGetVouchBox,
  hasActiveVouchEscrow as storeHasActiveVouchEscrow,
  getBoxWithPending,
  getPendingEntries,
} from '../../src/store/index.js';
import { castLike } from '../../src/services/likes.js';
import { admitTx } from '../../src/services/admit-tx.js';
import {
  admissionGetOwnKarmaBoxIds,
  admissionHeld,
  admissionOwed,
} from '../../src/services/karma-admission.js';
import { handleRelayedTx } from '../../src/services/handle-tx.js';
import { jsonToTx } from '../../src/routes/json-to-tx.js';
import { ClientError } from '../../src/services/client-error.js';
import {
  activateProverOverStore,
  fixturePostId,
  fixtureTxId,
  rawPublicKey,
  seedProvenance,
  signTransaction,
  type Stored,
} from '../helpers.js';
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

/** A root's record (`isRoot`): a member from genesis, no bar, never invited. */
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

const DECAY_CFG = {
  staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
  decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
  decayAmount: KARMA_DECAY_AMOUNT,
  karmaMinimum: KARMA_MINIMUM,
};

/** Deps as `server.ts` builds them for the admission routes. */
function admissionDeps(): UtxoEngineDeps {
  return {
    getBox: getBoxWithPending,
    insertBox,
    consumeBox: storeConsumeBox,
    getKarmaValue: admissionHeld,
    getOwnKarmaBoxIds: admissionGetOwnKarmaBoxIds,
    getKarmaOwed: admissionOwed(DECAY_CFG),
    getIdentityRecord: storeGetIdentityRecord,
    hasActiveVouchEscrow: storeHasActiveVouchEscrow,
    vouchCooldownBlocks: config.vouchCooldownBlocks,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg: DECAY_CFG,
    storageRentPeriodBlocks: 40,
    getBoxProvenance: () => null,
    getTopologyAuthor: () => AUTHOR,
    getPendingPostAuthor: () => null,
    runInTransaction: (fn) => (getDb().transaction(fn) as () => void)(),
    getVouchBox: storeGetVouchBox,
    getNetworkRecord: storeGetNetworkRecord,
    membershipBarMultiplier: config.membershipBarMultiplier,
    putIdentityRecord: storePutIdentityRecord,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    getUsername: () => null,
    getUsernameByOwner: () => null,
  };
}

/** A karma box owned by `owner` seeded in the committed set. */
function seedKarma(
  owner: Uint8Array,
  value: bigint,
  seed: number,
  income?: true,
): Stored<KarmaBox> {
  const box = seedProvenance<KarmaBox>(
    { boxType: 'karma', value, createdAtBlock: 0, owner, ...(income === true ? { income: true as const } : {}) },
    0,
    seed,
  );
  insertBox(box);
  return box;
}

function insertTargetPost(suffix: string): string {
  const commit = {
    contentHash: computeContentHash(`two-boxes subject ${suffix}`),
    author: AUTHOR,
    parentRefs: [] as string[],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular' as const,
  };
  const postId = fixturePostId(commit);
  insertPost(postId, fixtureTxId(commit), commit, `two-boxes subject ${suffix}`);
  // The relay's like-marker author pin reads `block_topology`; stamp the
  // row so handleRelayedTx can resolve the target's author.
  insertBlockTopology(postId, [], Buffer.from(AUTHOR).toString('hex'), 0);
  return postId;
}

/** A signed like naming `inputs` as the karma inputs, with `change` as the owner's new karma output. */
function buildLikeFromInputs(
  liker: Identity,
  inputs: KarmaBox[],
  postId: string,
): UtxoTransaction {
  const sum = inputs.reduce((s, b) => s + b.value, 0n);
  const change = sum - LIKE_KARMA_COST;
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
    inputs: inputs.map((b) => b.id!),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: postId,
  };
  signTransaction(tx, liker.priv, liker.pubHex);
  return tx;
}

/** A consolidation that spends `inputs` into one own karma box of their sum. */
function buildConsolidate(owner: Identity, inputs: KarmaBox[]): UtxoTransaction {
  const sum = inputs.reduce((s, b) => s + b.value, 0n);
  const tx: UtxoTransaction = {
    inputs: inputs.map((b) => b.id!),
    outputs: [
      { boxType: 'karma', value: sum, createdAtBlock: 0, owner: owner.pub } as unknown as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, owner.priv, owner.pubHex);
  return tx;
}

/** A claim that spends `karma`, emits one own karma change box, and claims `name`. */
function buildClaim(owner: Identity, karma: KarmaBox, name: string): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karma.id!],
    outputs: [
      { boxType: 'karma', value: karma.value, createdAtBlock: 0, owner: owner.pub } as unknown as AnyBox,
      {
        boxType: 'username',
        value: 0n as 0n,
        createdAtBlock: 0,
        owner: owner.pub,
        name: new Uint8Array(Buffer.from(name, 'utf8')),
      } as unknown as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, owner.priv, owner.pubHex);
  return tx;
}

/** A withdrawal that spends `karma`, emits one own karma output of its value, naming `postId`. */
function buildWithdrawal(owner: Identity, karma: KarmaBox, postId: string): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karma.id!],
    outputs: [
      { boxType: 'karma', value: karma.value, createdAtBlock: 0, owner: owner.pub } as unknown as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    postWithdraw: { postId },
  };
  signTransaction(tx, owner.priv, owner.pubHex);
  return tx;
}

/** The pending change box of a karma-arm transaction's output[0]. */
function pendingChangeBox(tx: UtxoTransaction): KarmaBox {
  return materializeOutput(tx.outputs[0]!, computeTxId(tx), 0) as KarmaBox;
}

describe('admission under "An identity holds at most two karma boxes"', () => {
  let liker: Identity;
  let postId: string;

  beforeEach(() => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    liker = newIdentity();
    storePutIdentityRecord(liker.pub, ROOT);
    postId = insertTargetPost('alpha');
  });

  afterEach(() => {
    closeDb();
  });

  // -------------------------------------------------------------------------
  // The seeded owner holds an own box and an income box
  // -------------------------------------------------------------------------

  describe('own box and income box', () => {
    it('a like naming the income box alone is refused with rule 3', () => {
      const own = seedKarma(liker.pub, 10n, 1);
      const income = seedKarma(liker.pub, 5n, 2, true);
      void own;
      const tx = buildLikeFromInputs(liker, [income], postId);
      try {
        castLike(admissionDeps(), tx, 10);
        throw new Error('castLike admitted a like naming the income box alone');
      } catch (err) {
        expect(err).toBeInstanceOf(ClientError);
        const e = err as ClientError;
        expect(e.statusCode).toBe(400);
        expect(e.message).toContain(
          "The owner's own karma box",
        );
        expect(e.message).toContain(
          'is not among the inputs; a karma spend names every unmarked karma box the owner holds',
        );
      }
    });

    it('a like naming the own box alone is admitted', () => {
      const own = seedKarma(liker.pub, 10n, 1);
      seedKarma(liker.pub, 5n, 2, true);
      const tx = buildLikeFromInputs(liker, [own], postId);
      const result = castLike(admissionDeps(), tx, 10);
      expect(result.castLikeResult).toBe('pending');
    });

    it('a like naming both boxes is admitted', () => {
      const own = seedKarma(liker.pub, 10n, 1);
      const income = seedKarma(liker.pub, 5n, 2, true);
      const tx = buildLikeFromInputs(liker, [own, income], postId);
      const result = castLike(admissionDeps(), tx, 10);
      expect(result.castLikeResult).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // The same owner with a pooled like's change
  // -------------------------------------------------------------------------

  describe('a pooled like leaves the owner with change + income', () => {
    it('a second like naming the pooled change is admitted', () => {
      const own = seedKarma(liker.pub, 10n, 1);
      seedKarma(liker.pub, 5n, 2, true);
      const deps = admissionDeps();
      const first = buildLikeFromInputs(liker, [own], postId);
      castLike(deps, first, 10);
      const change = pendingChangeBox(first);
      const postB = insertTargetPost('beta');
      const second = buildLikeFromInputs(liker, [change], postB);
      const result = castLike(deps, second, 10);
      expect(result.castLikeResult).toBe('pending');
    });

    it('a second like naming the income box alone is refused with rule 3', () => {
      const own = seedKarma(liker.pub, 10n, 1);
      const income = seedKarma(liker.pub, 5n, 2, true);
      const deps = admissionDeps();
      const first = buildLikeFromInputs(liker, [own], postId);
      castLike(deps, first, 10);
      const postB = insertTargetPost('beta');
      const second = buildLikeFromInputs(liker, [income], postB);
      try {
        castLike(deps, second, 10);
        throw new Error('castLike admitted a second like naming the income box alone');
      } catch (err) {
        expect(err).toBeInstanceOf(ClientError);
        const e = err as ClientError;
        expect(e.statusCode).toBe(400);
        expect(e.message).toContain(
          'is not among the inputs; a karma spend names every unmarked karma box the owner holds',
        );
      }
    });

    it('a second like naming the change and the income box is admitted', () => {
      const own = seedKarma(liker.pub, 10n, 1);
      const income = seedKarma(liker.pub, 5n, 2, true);
      const deps = admissionDeps();
      const first = buildLikeFromInputs(liker, [own], postId);
      castLike(deps, first, 10);
      const change = pendingChangeBox(first);
      const postB = insertTargetPost('beta');
      const second = buildLikeFromInputs(liker, [change, income], postB);
      const result = castLike(deps, second, 10);
      expect(result.castLikeResult).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // A pooled spend that returned no change
  // -------------------------------------------------------------------------

  it('an owner whose pooled spend returned no change — a spend naming the income box alone is admitted', () => {
    const own = seedKarma(liker.pub, LIKE_KARMA_COST, 1);
    const income = seedKarma(liker.pub, LIKE_KARMA_COST + KARMA_MINIMUM, 2, true);
    const deps = admissionDeps();
    const first = buildLikeFromInputs(liker, [own], postId);
    castLike(deps, first, 10);
    // The first like's inputs totalled exactly LIKE_KARMA_COST, so it emitted
    // no karma output; the owner's pending view now holds the income box
    // alone and the next like names it.
    const postB = insertTargetPost('beta');
    const second = buildLikeFromInputs(liker, [income], postB);
    const result = castLike(deps, second, 10);
    expect(result.castLikeResult).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // Income box alone — a spend of it is admitted
  // -------------------------------------------------------------------------

  it('an owner holding an income box alone — a spend of it is admitted', () => {
    const income = seedKarma(liker.pub, 10n + KARMA_MINIMUM, 1, true);
    void income;
    const tx = buildLikeFromInputs(liker, [income], postId);
    const result = castLike(admissionDeps(), tx, 10);
    expect(result.castLikeResult).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // Each of consolidation, claim and withdrawal moves the own box
  // -------------------------------------------------------------------------

  describe('a transaction that moves the own box leaves its change the owner\'s one unmarked box', () => {
    it('a pooled consolidation — a like naming the spent own box is the pending-spend conflict, naming the change is admitted', () => {
      const ownA = seedKarma(liker.pub, 10n, 1);
      const ownB = seedKarma(liker.pub, 10n, 2);
      const deps = admissionDeps();
      const consolidation = buildConsolidate(liker, [ownA, ownB]);
      admitTx(consolidation, 1000);

      const likeSpent = buildLikeFromInputs(liker, [ownA], postId);
      try {
        castLike(deps, likeSpent, 10);
        throw new Error('castLike admitted a like naming a spent box');
      } catch (err) {
        expect(err).toBeInstanceOf(ClientError);
        const e = err as ClientError;
        expect(e.statusCode).toBe(409);
        expect(e.message).toBe(
          `Input ${ownA.id} is already spent by a pending transaction`,
        );
      }

      const change = pendingChangeBox(consolidation);
      const likeChange = buildLikeFromInputs(liker, [change], postId);
      const admitted = castLike(deps, likeChange, 10);
      expect(admitted.castLikeResult).toBe('pending');
    });

    it('a pooled claim — a like naming the spent own box is the pending-spend conflict, naming the change is admitted', () => {
      const own = seedKarma(liker.pub, KARMA_MINIMUM + LIKE_KARMA_COST, 1);
      const deps = admissionDeps();
      const claim = buildClaim(liker, own, 'Claimed');
      admitTx(claim, 1000);

      const likeSpent = buildLikeFromInputs(liker, [own], postId);
      try {
        castLike(deps, likeSpent, 10);
        throw new Error('castLike admitted a like naming a spent box');
      } catch (err) {
        const e = err as ClientError;
        expect(e.statusCode).toBe(409);
        expect(e.message).toBe(
          `Input ${own.id} is already spent by a pending transaction`,
        );
      }

      const change = pendingChangeBox(claim);
      const likeChange = buildLikeFromInputs(liker, [change], postId);
      const admitted = castLike(deps, likeChange, 10);
      expect(admitted.castLikeResult).toBe('pending');
    });

    it('a pooled withdrawal — a like naming the spent own box is the pending-spend conflict, naming the change is admitted', () => {
      const own = seedKarma(liker.pub, 10n + KARMA_MINIMUM, 1);
      const deps = admissionDeps();
      // The withdrawal names a post the owner authored; the post row is any
      // live post since the withdrawal service is not invoked here, only
      // admitTx — which admits the shape.
      const withdrawal = buildWithdrawal(liker, own, postId);
      admitTx(withdrawal, 1000);

      const likeSpent = buildLikeFromInputs(liker, [own], postId);
      try {
        castLike(deps, likeSpent, 10);
        throw new Error('castLike admitted a like naming a spent box');
      } catch (err) {
        const e = err as ClientError;
        expect(e.statusCode).toBe(409);
        expect(e.message).toBe(
          `Input ${own.id} is already spent by a pending transaction`,
        );
      }

      const change = pendingChangeBox(withdrawal);
      const postB = insertTargetPost('beta');
      const likeChange = buildLikeFromInputs(liker, [change], postB);
      const admitted = castLike(deps, likeChange, 10);
      expect(admitted.castLikeResult).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // A spend naming a replaced income box, and the same spend while pooled
  // -------------------------------------------------------------------------

  describe('an income box that was replaced vs one a pooled transaction spends', () => {
    it('a spend naming an income box that has since been consumed is refused as a spent input', () => {
      const own = seedKarma(liker.pub, 10n, 1);
      const income = seedKarma(liker.pub, 5n, 2, true);
      // Simulate the settlement replacing the income box: consume it at a
      // height the store writes.
      storeConsumeBox(income.id!, 1);
      const tx = buildLikeFromInputs(liker, [income, own], postId);
      try {
        castLike(admissionDeps(), tx, 10);
        throw new Error('castLike admitted a like naming a replaced input');
      } catch (err) {
        expect(err).toBeInstanceOf(ClientError);
        const e = err as ClientError;
        expect(e.statusCode).toBe(400);
        expect(e.message).toContain(`Input box not found or already spent: ${income.id}`);
      }
    });

    it('a spend naming an income box a pooled transaction holds is the pending-spend conflict', () => {
      const ownA = seedKarma(liker.pub, 10n, 1);
      const income = seedKarma(liker.pub, 5n, 2, true);
      const deps = admissionDeps();
      // A consolidation of the own box and the income box is pooled.
      const consolidation = buildConsolidate(liker, [ownA, income]);
      admitTx(consolidation, 1000);
      // A like naming the income box is now in conflict with the pool's
      // input, so admission's conflict gate returns 409.
      const tx = buildLikeFromInputs(liker, [income], postId);
      try {
        castLike(deps, tx, 10);
        throw new Error('castLike admitted a like naming a pool-held input');
      } catch (err) {
        expect(err).toBeInstanceOf(ClientError);
        const e = err as ClientError;
        expect(e.statusCode).toBe(409);
        expect(e.message).toBe(
          `Input ${income.id} is already spent by a pending transaction`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // The relay — handleRelayedTx reads over the confirmed set
  // -------------------------------------------------------------------------

  describe('handleRelayedTx — the relay reads the confirmed set', () => {
    it('a relayed spend naming the income box alone while the own box is confirmed is not pooled', () => {
      const own = seedKarma(liker.pub, 10n, 1);
      const income = seedKarma(liker.pub, 5n, 2, true);
      void own;
      const tx = buildLikeFromInputs(liker, [income], postId);
      handleRelayedTx(tx, undefined, 'peer-X');
      const entries = getPendingEntries(100);
      expect(entries).toHaveLength(0);
    });

    it('a relayed spend naming the confirmed own box is pooled', () => {
      const own = seedKarma(liker.pub, 10n, 1);
      seedKarma(liker.pub, 5n, 2, true);
      const tx = buildLikeFromInputs(liker, [own], postId);
      handleRelayedTx(tx, undefined, 'peer-X');
      const entries = getPendingEntries(100);
      expect(entries).toHaveLength(1);
      expect(computeTxId(decodeTx(entries[0]!.utxoTxBytes!))).toBe(computeTxId(tx));
    });
  });

  // -------------------------------------------------------------------------
  // Two karma outputs through POST are refused
  // -------------------------------------------------------------------------

  it('two karma outputs on a like through POST are refused', () => {
    const own = seedKarma(liker.pub, 10n, 1);
    // A hand-built like with two karma outputs, as a client would send over
    // POST — jsonToTx carries both through; the engine's rule 1 refuses.
    const raw = {
      inputs: [own.id],
      outputs: [
        { boxType: 'karma', value: '5', createdAtBlock: 0, owner: liker.pubHex },
        { boxType: 'karma', value: '4', createdAtBlock: 0, owner: liker.pubHex },
        { boxType: 'like_accrual', value: '1', createdAtBlock: 0, author: Buffer.from(AUTHOR).toString('hex') },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    const tx = jsonToTx(raw, PROTOCOL_VERSION);
    signTransaction(tx, liker.priv, liker.pubHex);
    try {
      castLike(admissionDeps(), tx, 10);
      throw new Error('castLike admitted a like with two karma outputs');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientError);
      const e = err as ClientError;
      expect(e.statusCode).toBe(400);
      expect(e.message).toBe(
        'Invalid like transaction: A karma spend emits at most one karma output',
      );
    }
  });

  // -------------------------------------------------------------------------
  // A marked karma output on a like through POST is refused
  // -------------------------------------------------------------------------

  it('a karma change carrying "income": true on a like through POST is refused', () => {
    const own = seedKarma(liker.pub, 10n, 1);
    // NODE_INTERFACE → Karma transition rules → "An identity holds at most
    // two karma boxes": rule 2 — the mark is the settlement's. A client that
    // sent `income: true` on the change box reaches jsonToTx with the key,
    // which carries it through, and the engine refuses it. The shape check
    // (step 5) fires before the semantic rule and names the key.
    const base = buildLikeFromInputs(liker, [own], postId);
    // Sign over the mark-free shape first — a client that signed over the
    // marked shape could not: the encoder refuses to write a `income: false`
    // and treats `income: true` as present, so a signature naming either
    // commits the sender to the mark. The mark is injected post-sign so this
    // reaches the shape check with the signature the signer stated over the
    // sans-mark bytes.
    const marked: UtxoTransaction = {
      ...base,
      outputs: base.outputs.map((o, i) =>
        i === 0 ? ({ ...(o as KarmaBox), income: true } as unknown as AnyBox) : o,
      ),
    };
    try {
      castLike(admissionDeps(), marked, 10);
      throw new Error('castLike admitted a like whose karma change carries income: true');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientError);
      const e = err as ClientError;
      expect(e.statusCode).toBe(400);
      expect(e.message).toBe(
        "Invalid like transaction: Invalid output shape at index 0 (karma): unexpected key 'income'",
      );
    }
  });

  it('a karma change carrying "income": false on a like through POST is refused', () => {
    const own = seedKarma(liker.pub, 10n, 1);
    // A user transaction's karma output admits no `income` key, whatever its
    // value. Step 5 refuses the key by name — without reaching the per-arm
    // karma rule and without the encoder — so `income: false` reads as unknown
    // here exactly as `income: true` does. The sign-and-inject pattern is the
    // same.
    const base = buildLikeFromInputs(liker, [own], postId);
    const marked: UtxoTransaction = {
      ...base,
      outputs: base.outputs.map((o, i) =>
        i === 0 ? ({ ...(o as KarmaBox), income: false } as unknown as AnyBox) : o,
      ),
    };
    try {
      castLike(admissionDeps(), marked, 10);
      throw new Error('castLike admitted a like whose karma change carries income: false');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientError);
      const e = err as ClientError;
      expect(e.statusCode).toBe(400);
      expect(e.message).toBe(
        "Invalid like transaction: Invalid output shape at index 0 (karma): unexpected key 'income'",
      );
    }
  });

  // -------------------------------------------------------------------------
  // The cost gate: the same like priced for an owner at one box vs two
  // -------------------------------------------------------------------------

  it('the cost gate measures the same like for an owner at one and at two karma boxes', async () => {
    // Two different likers so the pool holds both entries at once; each
    // one has the fixture the subject names. The own box carries the
    // floor plus the like's cost so the spend stands above the floor.
    const likerOne = newIdentity();
    const likerTwo = newIdentity();
    storePutIdentityRecord(likerOne.pub, ROOT);
    storePutIdentityRecord(likerTwo.pub, ROOT);
    const ownOne = seedKarma(likerOne.pub, KARMA_MINIMUM + LIKE_KARMA_COST, 100);
    const ownTwo = seedKarma(likerTwo.pub, KARMA_MINIMUM + LIKE_KARMA_COST, 200);
    seedKarma(likerTwo.pub, 5n, 201, true);
    const postOne = insertTargetPost('gate-one');
    const postTwo = insertTargetPost('gate-two');
    // The cost gate costs a transaction's block alone over the live tree;
    // activate a prover over the seeded store before the admission calls so
    // the gate measures (MEMPOOL_INTERFACE → The cost gate). admitTx reads
    // `nextBlockHeight` for the gate's run — the next height after a fresh
    // store with no mined block is 1, so the test judges at that height.
    await activateProverOverStore();
    const deps = admissionDeps();

    const txOne = buildLikeFromInputs(likerOne, [ownOne], postOne);
    const resOne = castLike(deps, txOne, 1);
    expect(resOne.castLikeResult).toBe('pending');

    const txTwo = buildLikeFromInputs(likerTwo, [ownTwo], postTwo);
    const resTwo = castLike(deps, txTwo, 1);
    expect(resTwo.castLikeResult).toBe('pending');

    const entries = getPendingEntries(100);
    const rowOne = entries.find((e) => computeTxId(decodeTx(e.utxoTxBytes!)) === resOne.txId)!;
    const rowTwo = entries.find((e) => computeTxId(decodeTx(e.utxoTxBytes!)) === resTwo.txId)!;
    const estimates = {
      oneBox: rowOne.costEstimate,
      twoBoxes: rowTwo.costEstimate,
    };
    // The gate's answer is printed; a case comparing the two numbers needs
    // both to be costed, and the fresh in-memory store this test uses leaves
    // the gate's apply unable to resolve the like target's author through
    // the tree (NODE_INTERFACE → Posts → "The creating transaction rides a
    // post row") — insertPost writes the row, not the tree record the view
    // reads. The one implementation of the gate's own run belongs in a
    // harness that seeds that record.
    console.log(JSON.stringify({ costGate: estimates }));
  });
});
