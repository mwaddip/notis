import { seedProvenance, txToJson } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createPrivateKey, sign } from 'crypto';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  getKarmaBox,
  getKarmaBoxesPage,
  getKarmaValue,
  getKarmaTotal,
  getCreditBoxesPage,
  getCreditValue,
  getBondBoxesPage,
  insertBox,
  getBox,
  consumeBox,
} from '../../src/store/utxo.js';
import { getIdentityRecord, putIdentityRecord } from '../../src/store/identity-records.js';
import { getBoxWithPending } from '../../src/store/mempool.js';
import { setNet } from '../../src/services/net-instance.js';
import {
  generateKeyPair,
  computeTxId,
  selectBoxes,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  BondBox,
  CandidateOf,
  CreditBox,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { createRouter } from '../../src/routes/utxo.js';
import { jsonToTx } from '../../src/routes/json-to-tx.js';
import { unlinkSync } from 'fs';
import { config } from '../../src/config.js';
const TEST_DB = '/tmp/dagsocial-test-routes-utxo.sqlite';

const DECAY_CFG = {
  staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
  decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
  decayAmount: KARMA_DECAY_AMOUNT,
  karmaMinimum: KARMA_MINIMUM,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  height = 100,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      getKarmaTotal,
      getKarmaBoxesPage,
      getIdentityRecord,
      getCreditValue,
      getCreditBoxesPage,
      getBondBoxesPage,
      getCurrentHeight: () => height,
      decayCfg: DECAY_CFG,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      getUtxoEngineDeps: () => ({
        // The pending view, as server.ts wires the submission routes: a grant
        // spending the change box of one still pooled resolves its input here.
        getBox: getBoxWithPending,
        insertBox,
        consumeBox,
        getKarmaBox,
        getKarmaValue,
        hasActiveVouchEscrow: () => false,
        vouchCooldownBlocks: 2,
        inviteBondMin: config.inviteBondMin,
        inviteBondMax: config.inviteBondMax,
        decayCfg: DECAY_CFG,
        storageRentPeriodBlocks: 40,
        getBoxProvenance: () => null,
        getTopologyAuthor: () => null,
        getPendingPostAuthor: () => null,
        getIdentityRecord,
        getKarmaBoxes: (owner: Uint8Array) => [getKarmaBox(owner)].filter(Boolean) as KarmaBox[],
        runInTransaction: (fn: () => void) => fn(),
        getVouchBox: () => null,
        getNetworkRecord: () => ({ memberCount: 1 }),
        membershipBarMultiplier: 1,
        putIdentityRecord: () => {},
        protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      }),
    };
    const app = express();
    app.use(express.json());
    app.use(createRouter(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const req = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path,
          method,
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: d });
            }
          });
        },
      );
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UTXO routes', () => {
  let karmaUserId: Uint8Array;
  let karmaUserIdHex: string;
  let creditUserId: Uint8Array;
  let creditUserIdHex: string;
  let inviteUserId: Uint8Array;
  let inviteUserIdHex: string;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    const kp1 = generateKeyPair();
    karmaUserId = kp1.publicKey;
    karmaUserIdHex = Buffer.from(karmaUserId).toString('hex');
    const karmaBox = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 42n,
      owner: kp1.publicKey,
    }, 1);
    insertBox(karmaBox);

    // Second karma box for same user — multi-box total must sum across all boxes
    const karmaBox2 = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 58n,
      owner: kp1.publicKey,
    }, 1);
    insertBox(karmaBox2);

    // User with credits
    const kp2 = generateKeyPair();
    creditUserId = kp2.publicKey;
    creditUserIdHex = Buffer.from(creditUserId).toString('hex');
    const creditBox = seedProvenance<CreditBox>({
      boxType: 'credit',
      value: 99n,
      owner: kp2.publicKey,
      createdAtBlock: 100,
    }, 1);
    insertBox(creditBox);

    // An inviter with a live bond — the whole of what an invite leaves
    // behind (ARCHITECTURE → Invite System).
    const kp3 = generateKeyPair();
    inviteUserId = kp3.publicKey;
    inviteUserIdHex = Buffer.from(inviteUserId).toString('hex');
    const inviteePublicKey = new Uint8Array(32).fill(0xbb);
    const bondBox = seedProvenance<BondBox>({
      boxType: 'bond' as const,
      value: 5n,
      inviterId: inviteUserId,
      inviteePublicKey,
    }, 1);
    insertBox(bondBox);

    // A settled bond for the same inviter — should NOT appear
    const settledBond = seedProvenance<BondBox>({
      boxType: 'bond' as const,
      value: 3n,
      inviterId: inviteUserId,
      inviteePublicKey: new Uint8Array(32).fill(0xcc),
    }, 1);
    insertBox(settledBond);
    consumeBox(settledBond.id!, 10);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('GET /karma/:userId returns karma balance with effective and boxCount', async () => {
    const res = await request(`/karma/${karmaUserIdHex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(karmaUserIdHex);
    expect(body.total).toBe('100');
    expect(body.effective).toBe('100');
    expect(Array.isArray(body.boxes)).toBe(true);
    expect(body.boxes).toHaveLength(2);
    expect(body.boxCount).toBe(2);
    const boxValues = (body.boxes as unknown[]).map((b: unknown) => (b as Record<string, unknown>).value);
    expect(boxValues).toEqual(expect.arrayContaining(['42', '58']));
    expect(body.lifetimeLikesReceived).toBe('0');
  });

  it('GET /karma/:userId with effective < total for a stale identity', async () => {
    // Set up a stale identity record: last activity far in the past
    putIdentityRecord(karmaUserId, {
      lastActivityBlock: 1,
      lastDecayBlock: 1,
      invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });

    const res = await request(`/karma/${karmaUserIdHex}`, 'GET', undefined, 100000);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(BigInt(body.effective as string)).toBeLessThan(BigInt(body.total as string));

    // Clean up identity record
    putIdentityRecord(karmaUserId, {
      lastActivityBlock: 0,
      lastDecayBlock: 0,
      invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });
  });

  it('GET /karma/:userId serves lifetimeLikesReceived as a decimal string', async () => {
    putIdentityRecord(karmaUserId, {
      lastActivityBlock: 0,
      lastDecayBlock: 0,
      invitedAtBlock: 0,
      lifetimeLikesReceived: 7n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });
    const res = await request(`/karma/${karmaUserIdHex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.lifetimeLikesReceived).toBe('7');

    putIdentityRecord(karmaUserId, {
      lastActivityBlock: 0,
      lastDecayBlock: 0,
      invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });
  });

  it('GET /karma/:userId serves lifetimeLikesReceived "0" when no record', async () => {
    const noRecordHex = 'ff'.repeat(32);
    const res = await request(`/karma/${noRecordHex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.lifetimeLikesReceived).toBe('0');
  });

  it('GET /credits/:userId returns credit balance with boxCount', async () => {
    const res = await request(`/credits/${creditUserIdHex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(creditUserIdHex);
    expect(body.total).toBe('99');
    expect(Array.isArray(body.boxes)).toBe(true);
    expect(body.boxes).toHaveLength(1);
    expect(body.boxCount).toBe(1);
    const b0 = (body.boxes as unknown[])[0] as Record<string, unknown>;
    expect(typeof b0.boxId).toBe('string');
    expect(b0.value).toBe('99');
  });

  it('GET /invites/:userId returns unspent bonds only, with bondCount', async () => {
    const res = await request(`/invites/${inviteUserIdHex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.open).toBeUndefined();
    expect(Array.isArray(body.bonds)).toBe(true);
    expect(body.bonds).toHaveLength(1);
    expect(body.bondCount).toBe(1);
    const bond = (body.bonds as Record<string, unknown>[])[0]!;
    expect(bond.inviterId).toBe(inviteUserIdHex);
    expect(bond.inviteePublicKey).toBe('bb'.repeat(32));
  });

  it('GET /invites/:userId answers { bonds: [], bondCount: 0, next: null } for an inviter with no live bond', async () => {
    const kp = generateKeyPair();
    const hex = Buffer.from(kp.publicKey).toString('hex');
    const res = await request(`/invites/${hex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.bonds).toEqual([]);
    expect(body.bondCount).toBe(0);
    expect(body.next).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // NODE_INTERFACE → UTXO queries: the empty page
  // ---------------------------------------------------------------------------

  it('GET /karma/:userId answers the empty page for an identity with a record and no box', async () => {
    const kp = generateKeyPair();
    const hex = Buffer.from(kp.publicKey).toString('hex');
    putIdentityRecord(kp.publicKey, {
      lastActivityBlock: 7,
      lastDecayBlock: 3,
      invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });
    const res = await request(`/karma/${hex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(hex);
    expect(body.boxes).toEqual([]);
    expect(body.boxCount).toBe(0);
    expect(body.total).toBe('0');
    expect(body.effective).toBe('0');
    expect(body.next).toBeNull();
    expect(body.lastActivityBlock).toBe(7);
    expect(body.lastDecayBlock).toBe(3);
    expect(typeof body.height).toBe('number');
  });

  it('GET /karma/:userId answers the empty page for an identity the node has never seen', async () => {
    const kp = generateKeyPair();
    const hex = Buffer.from(kp.publicKey).toString('hex');
    const res = await request(`/karma/${hex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.boxes).toEqual([]);
    expect(body.boxCount).toBe(0);
    expect(body.total).toBe('0');
    expect(body.effective).toBe('0');
    expect(body.next).toBeNull();
    expect(body.lastActivityBlock).toBe(0);
    expect(body.lastDecayBlock).toBe(0);
  });

  it('GET /credits/:userId answers the empty page for an identity with no credit box', async () => {
    const kp = generateKeyPair();
    const hex = Buffer.from(kp.publicKey).toString('hex');
    const res = await request(`/credits/${hex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(hex);
    expect(body.boxes).toEqual([]);
    expect(body.boxCount).toBe(0);
    expect(body.total).toBe('0');
    expect(body.next).toBeNull();
  });

  it('malformed after → 400 on /karma', async () => {
    const res = await request(`/karma/${karmaUserIdHex}?after=malformed`);
    expect(res.status).toBe(400);
  });

  it('malformed after → 400 on /credits', async () => {
    const res = await request(`/credits/${creditUserIdHex}?after=malformed`);
    expect(res.status).toBe(400);
  });

  it('malformed after → 400 on /invites', async () => {
    const res = await request(`/invites/${inviteUserIdHex}?after=zz`);
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Credit transfer tests
  // ---------------------------------------------------------------------------

  describe('POST /credits/transfer (client-built tx)', () => {
    let senderPubKey: Uint8Array;
    let senderPrivKey: Uint8Array;
    let senderHex: string;
    let receiverPubKey: Uint8Array;
    let seededBoxId: string;

    beforeAll(() => {
      const sender = generateKeyPair();
      senderPubKey = sender.publicKey;
      senderPrivKey = sender.secretKey;
      senderHex = Buffer.from(senderPubKey).toString('hex');

      const receiver = generateKeyPair();
      receiverPubKey = receiver.publicKey;

      const box = seedProvenance<CreditBox>({
        boxType: 'credit',
        value: 200_000n,
        owner: senderPubKey,
        createdAtBlock: 100,
      }, 1);
      seededBoxId = box.id;
      insertBox(box);
    });

    /** Build and sign the transfer the way the demo UI does. */
    function buildSignedTransfer(amount: bigint): UtxoTransaction {
      const unlocked = getCreditBoxesPage(senderPubKey, { limit: 100 }).rows;
      const selected = selectBoxes(unlocked, amount);
      const totalSelected = selected.reduce((s, b) => s + b.value, 0n);
      const change = totalSelected - amount;

      const outputs: CandidateOf<CreditBox>[] = [{
        boxType: 'credit',
        value: amount,
        createdAtBlock: 100,
        owner: receiverPubKey,
      }];
      if (change > 0n) {
        outputs.push({
          boxType: 'credit',
          value: change,
          createdAtBlock: 100,
          owner: senderPubKey,
        });
      }

      const tx: UtxoTransaction = {
        inputs: selected.map(b => b.id!),
        outputs,
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      const privKey = createPrivateKey({
        key: Buffer.from(senderPrivKey),
        format: 'der',
        type: 'pkcs8',
      });
      const sig = sign(null, Buffer.from(computeTxId(tx), 'hex'), privKey);
      tx.signatures[senderHex] = new Uint8Array(sig);
      return tx;
    }

    /** Spend one specific box to the receiver, signed by the sender. */
    function spendBox(boxId: string, value: bigint): UtxoTransaction {
      const tx: UtxoTransaction = {
        inputs: [boxId],
        outputs: [{ boxType: 'credit', value, createdAtBlock: 0, owner: receiverPubKey } as CandidateOf<CreditBox>],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      const privKey = createPrivateKey({ key: Buffer.from(senderPrivKey), format: 'der', type: 'pkcs8' });
      tx.signatures[senderHex] = new Uint8Array(sign(null, Buffer.from(computeTxId(tx), 'hex'), privKey));
      return tx;
    }

    it('admits a box locked until L at tip = L - 1, and refuses it at tip = L - 2', async () => {
      // Admission judges at tip + 1 (NODE_INTERFACE → validateTx). A box locked
      // until L is spendable in the block at height L, so the route whose tip is
      // L - 1 admits it — one block earlier than a tip-height judge would. The
      // pair isolates the lock: the same signed transaction, only the tip moves.
      const L = 300;
      const locked = seedProvenance<CreditBox>({
        boxType: 'credit',
        value: 50_000n,
        owner: senderPubKey,
        createdAtBlock: 0,
        lockedUntilBlock: L,
      }, 77);
      insertBox(locked);

      // Tip L - 2 → judged at L - 1 → still locked.
      const early = await request('/credits/transfer', 'POST', { tx: txToJson(spendBox(locked.id!, 50_000n)) }, L - 2);
      expect(early.status).toBe(400);

      // Tip L - 1 → judged at L → spendable.
      const atTip = await request('/credits/transfer', 'POST', { tx: txToJson(spendBox(locked.id!, 50_000n)) }, L - 1);
      expect(atTip.status).toBe(200);
    });

    it('rejects a missing tx', async () => {
      const res = await request('/credits/transfer', 'POST', {});
      expect(res.status).toBe(400);
      expect((res.data as Record<string, unknown>).error).toContain('tx');
    });

    it('rejects a malformed tx (decode failure)', async () => {
      const res = await request('/credits/transfer', 'POST', {
        tx: { inputs: [], outputs: [{ boxType: 'credit', value: 'not-a-number' }] },
      });
      expect(res.status).toBe(400);
    });

    const CREDIT_OUT = {
      boxType: 'credit',
      value: '10',
      owner: 'ab'.repeat(32),
    };

    // The envelope gate as the HTTP backstop (NODE_INTERFACE → "Transaction
    // envelope shape").

    it('backstops a non-array inputs with a 400, not the pre-gate 500', async () => {
      const res = await request('/credits/transfer', 'POST', {
        tx: { inputs: 5, outputs: [CREDIT_OUT], signatures: {}, protocolVersion: PROTOCOL_VERSION },
      });
      expect(res.status).toBe(400);
      expect(String((res.data as Record<string, unknown>).error)).toContain(
        'inputs must be an array',
      );
    });

    // A transaction carries its own `protocolVersion`, and the block header's
    // gate says nothing about it. Without a check at this edge a client that
    // signs a junk version has it pooled and applied end-to-end.
    it('backstops a junk protocolVersion with a 400', async () => {
      const res = await request('/credits/transfer', 'POST', {
        tx: {
          inputs: [seededBoxId],
          outputs: [CREDIT_OUT],
          signatures: {},
          protocolVersion: 'x',
        },
      });
      expect(res.status).toBe(400);
      expect(String((res.data as Record<string, unknown>).error)).toContain(
        'protocolVersion must be the era',
      );
    });

    it('backstops a non-hex input id with a 400', async () => {
      const res = await request('/credits/transfer', 'POST', {
        tx: {
          inputs: ['not-a-box-id'],
          outputs: [CREDIT_OUT],
          signatures: {},
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      expect(res.status).toBe(400);
      expect(String((res.data as Record<string, unknown>).error)).toContain(
        'inputs[0] must be 64 lowercase hex characters',
      );
    });

    it('jsonToTx omits preimages rather than emitting a present-undefined key', async () => {
      const tx = jsonToTx({
        inputs: [seededBoxId],
        outputs: [CREDIT_OUT],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      }, PROTOCOL_VERSION);
      expect(Object.hasOwn(tx, 'preimages')).toBe(false);
      expect(Object.keys(tx)).not.toContain('preimages');
    });

    it('rejects a forged signature with 400 — invalid tx, per the contract', async () => {
      const tx = buildSignedTransfer(50_000n);
      tx.signatures[senderHex] = new Uint8Array(64).fill(0xaa);
      const res = await request('/credits/transfer', 'POST', { tx: txToJson(tx) });
      expect(res.status).toBe(400);
      expect(String((res.data as Record<string, unknown>).error)).toContain(
        'Invalid credit transfer',
      );
    });

    it('pools a valid transfer, answers pending, broadcasts — and settles nothing', async () => {
      // Declared with the parameter it is actually called with: a zero-arity
      // mock types `mock.calls[0]` as the empty tuple, so the assertion below
      // reads argument 0 of a call the type system says takes none.
      const broadcastTx = vi.fn((_tx: UtxoTransaction) => Promise.resolve());
      setNet({ broadcastTx } as unknown as Parameters<typeof setNet>[0]);

      const tx = buildSignedTransfer(50_000n);
      const res = await request('/credits/transfer', 'POST', { tx: txToJson(tx) });

      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      expect(body.status).toBe('pending');
      expect(body.txId).toBe(computeTxId(tx));
      expect(typeof body.expiresAtHeight).toBe('number');
      expect(body.sent).toBeUndefined();
      expect(body.change).toBeUndefined();

      // The input box is still unspent — the HTTP call settles nothing.
      expect(getBox(seededBoxId)).not.toBeNull();
      expect(getCreditBoxesPage(receiverPubKey, { limit: 1 }).count).toBe(0);

      // The pooled tx went out to peers.
      expect(broadcastTx).toHaveBeenCalledTimes(1);
      const sent = broadcastTx.mock.calls[0]![0] as UtxoTransaction;
      expect(computeTxId(sent)).toBe(computeTxId(tx));
    });
  });

});
