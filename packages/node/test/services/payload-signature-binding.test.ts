// ---------------------------------------------------------------------------
// Payload-signature binding (NODE_INTERFACE → Legal box transitions).
//
// Each test reproduces a consensus defect that was admitted through the shared
// validator before the fix: a payload on the wrong transition, or a stray
// signature key flipping the rent path. Every exploit builds through
// `validateTx` at the same step ordering block-apply runs per embedded tx.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PROTOCOL_VERSION,
  boxRecordBytes,
  STORAGE_RENT_PER_BYTE,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  computeContentHash,
  VOUCH_KARMA_AMOUNT,
} from '@dagsocial/types';
import type {
  CreditBox,
  KarmaBox,
  UtxoTransaction,
  PostCommit,
  PostWithdrawCommit,
} from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  getBox,
  getBoxProvenance,
  insertBox,
  consumeBox,
  getKarmaBox,
  getKarmaValue,
} from '../../src/store/utxo.js';
import { getIdentityRecord, putIdentityRecord, getNetworkRecord } from '../../src/store/identity-records.js';
import { getVouchBox } from '../../src/store/vouch-queries.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import {
  makeTestIdentity,
  seedProvenance,
  signTransaction,
  toHex,
  type Stored,
} from '../helpers.js';
import { config } from '../../src/config.js';

const RENT_PERIOD = 40;

function makeDeps(topologyAuthors: Map<string, Uint8Array> = new Map()): UtxoEngineDeps {
  return {
    getBox,
    insertBox,
    consumeBox,
    getKarmaBox,
    getKarmaValue,
    getIdentityRecord,
    hasActiveVouchEscrow: () => false,
    vouchCooldownBlocks: 2,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg: {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    },
    storageRentPeriodBlocks: RENT_PERIOD,
    getBoxProvenance,
    getTopologyAuthor: (id: string) => topologyAuthors.get(id) ?? null,
    getPendingPostAuthor: () => null,
    runInTransaction: (fn) => fn(),
    getVouchBox,
    getNetworkRecord,
    membershipBarMultiplier: 1,
    putIdentityRecord,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    getUsername: () => null,
    getUsernameByOwner: () => null,
  };
}

describe('payload-signature binding', () => {
  let deps: UtxoEngineDeps;
  let alice: ReturnType<typeof makeTestIdentity>;
  let bob: ReturnType<typeof makeTestIdentity>;
  const topologyAuthors = new Map<string, Uint8Array>();

  beforeEach(() => {
    initDb(':memory:');
    topologyAuthors.clear();
    alice = makeTestIdentity();
    bob = makeTestIdentity();
    deps = makeDeps(topologyAuthors);
  });

  afterEach(() => closeDb());

  function seedKarma(owner: ReturnType<typeof makeTestIdentity>, value: bigint, nonce = 0): Stored<KarmaBox> {
    const box = seedProvenance<KarmaBox>(
      { boxType: 'karma', value, owner: owner.userId, createdAtBlock: 0 },
      1, nonce,
    );
    insertBox(box);
    return box;
  }

  function seedCredit(owner: ReturnType<typeof makeTestIdentity>, value: bigint, createdAt: number, nonce = 0): Stored<CreditBox> {
    const box = seedProvenance<CreditBox>(
      { boxType: 'credit', value, owner: owner.userId, createdAtBlock: createdAt },
      createdAt, nonce,
    );
    insertBox(box);
    return box;
  }

  // ---- F2: a credit self-transfer carrying a `post` is rejected ----

  describe('F2 — post payload on a credit transition', () => {
    it('rejects a credit self-transfer carrying a post payload', () => {
      const height = 10;
      const box = seedCredit(alice, 100_000n, height - 5);
      const commit: PostCommit = {
        contentHash: computeContentHash('hello'),
        author: alice.userId,
        parentRefs: [],
        protocolVersion: PROTOCOL_VERSION,
        type: 'regular',
      };
      const tx: UtxoTransaction = {
        inputs: [box.id!],
        outputs: [
          { boxType: 'credit', value: 100_000n, owner: alice.userId, createdAtBlock: height },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
        post: commit,
      };
      signTransaction(tx, alice.privateKey, toHex(alice.userId));
      const result = validateTx(deps, tx, height);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('karma transition');
    });
  });

  // ---- F1a: a credit self-transfer carrying a `postWithdraw` is rejected ----

  describe('F1a — postWithdraw payload on a credit transition', () => {
    it('rejects a credit self-transfer carrying a postWithdraw payload', () => {
      const height = 10;
      const box = seedCredit(alice, 100_000n, height - 5);
      const postWithdraw: PostWithdrawCommit = {
        postId: '00'.repeat(32),
      };
      const tx: UtxoTransaction = {
        inputs: [box.id!],
        outputs: [
          { boxType: 'credit', value: 100_000n, owner: alice.userId, createdAtBlock: height },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
        postWithdraw,
      };
      signTransaction(tx, alice.privateKey, toHex(alice.userId));
      const result = validateTx(deps, tx, height);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('karma transition');
    });
  });

  // ---- F1b: a karma vouch cast carrying a `postWithdraw` is rejected ----

  describe('F1b — postWithdraw payload riding a vouch cast', () => {
    it('rejects a karma vouch carrying a postWithdraw payload', () => {
      const height = 10;
      const karmaBox = seedKarma(alice, VOUCH_KARMA_AMOUNT + 1n, 100);

      putIdentityRecord(alice.userId, {
        memberSinceBlock: 1,
        memberVouches: 2,
        memberBar: 1,
        invitedAtBlock: 1,
        invitesUsed: 0,
        lastActivityBlock: 1,
        lastDecayBlock: 0,
        lifetimeLikesReceived: 0n,
        memberLikes: 0n,
      });
      putIdentityRecord(bob.userId, {
        memberSinceBlock: 0,
        memberVouches: 0,
        memberBar: 1,
        invitedAtBlock: 1,
        invitesUsed: 0,
        lastActivityBlock: 0,
        lastDecayBlock: 0,
        lifetimeLikesReceived: 0n,
        memberLikes: 0n,
      });

      const postWithdraw: PostWithdrawCommit = {
        postId: '00'.repeat(32),
      };
      const tx: UtxoTransaction = {
        inputs: [karmaBox.id!],
        outputs: [
          { boxType: 'karma', value: 1n, owner: alice.userId, createdAtBlock: height },
          {
            boxType: 'vouch', value: VOUCH_KARMA_AMOUNT,
            voucherId: alice.userId, targetId: bob.userId,
            createdAtBlock: height,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
        postWithdraw,
      };
      signTransaction(tx, alice.privateKey, toHex(alice.userId));
      const result = validateTx(deps, tx, height);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('PostWithdraw transition requires exactly one karma output');
    });
  });

  // ---- F3: stray signature on a rent-eligible credit box ----

  describe('F3 — stray signature flips the rent path', () => {
    it('rejects a rent-eligible box with one stray signature redirected to a stranger', () => {
      const height = 100;
      const box = seedCredit(alice, 100_000_000n, height - RENT_PERIOD - 1);

      const tx: UtxoTransaction = {
        inputs: [box.id!],
        outputs: [
          { boxType: 'credit', value: box.value, owner: bob.userId, createdAtBlock: height },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, bob.privateKey, toHex(bob.userId));
      const result = validateTx(deps, tx, height);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('unrequired key');
    });

    it('an honest unsigned rent collection (same owner successor) still passes', () => {
      const height = 100;
      const box = seedCredit(alice, 100_000_000n, height - RENT_PERIOD - 1);
      const prov = getBoxProvenance(box.id!)!;
      const charge = STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(box, prov.txId, prov.index).length);

      const tx: UtxoTransaction = {
        inputs: [box.id!],
        outputs: [
          { boxType: 'credit', value: box.value - charge, owner: alice.userId, createdAtBlock: height },
          { boxType: 'fee', value: charge, createdAtBlock: height },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      const result = validateTx(deps, tx, height);
      expect(result.valid).toBe(true);
    });

    it('an ordinary signed credit transfer (non-rent-eligible) still passes', () => {
      const height = 10;
      const box = seedCredit(alice, 100_000n, height - 5);

      const tx: UtxoTransaction = {
        inputs: [box.id!],
        outputs: [
          { boxType: 'credit', value: 90_000n, owner: bob.userId, createdAtBlock: height },
          { boxType: 'fee', value: 10_000n, createdAtBlock: height },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, alice.privateKey, toHex(alice.userId));
      const result = validateTx(deps, tx, height);
      expect(result.valid).toBe(true);
    });
  });
});
