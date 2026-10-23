import {
  applyBlockThroughIntake,
  liveProver,
  makeApplicableBlock,
  seedProvenance,
  signTransaction,
  txToJson,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setNet } from '../../src/services/net-instance.js';
import express from 'express';
import http from 'http';
import { createPrivateKey } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import {
  getKarmaBoxes, getBox as storeGetBox, insertBox as storeInsertBox } from '../../src/store/utxo.js';
import { getIdentityRecord as storeGetIdentityRecord, putIdentityRecord as storePutIdentityRecord } from '../../src/store/identity-records.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import {
  createInvite,
} from '../../src/services/invites.js';
import {
  computeTxId,
  encodeTx,
  generateKeyPair,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  CandidateOf,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { createRouter } from '../../src/routes/invites.js';
import type { InvitesDeps } from '../../src/routes/invites.js';
import { ClientError } from '../../src/services/client-error.js';
import { config } from '../../src/config.js';
import { MempoolFullError, PendingSpendConflictError } from '../../src/store/mempool.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { admissionOwed } from '../../src/services/karma-admission.js';

// A directory private to this run, so two runs of the suite on one machine
// never write the same store file.
let testDir: string;

async function request(
  path: string,
  method: string,
  body?: unknown,
  depOverrides?: Partial<InvitesDeps>,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const db = getDb();
    const deps: InvitesDeps = {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getIdentityRecord: storeGetIdentityRecord,
      insertBox: (box: AnyBox) => { storeInsertBox(box); },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaOwed: admissionOwed({ staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS, decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM }),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      getOwnKarmaBoxIds: (owner: Uint8Array) =>
        getKarmaBoxes(owner).filter((b) => b.income !== true).map((b) => b.id!),
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
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
      getTopologyAuthor: () => null,
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => { (db.transaction(fn) as () => void)(); },
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      getUsername: () => null,
      getUsernameByOwner: () => null,
      createInvite,
      getCurrentHeight,
    };
    const app = express();
    app.use(express.json());
    app.use('/invites', createRouter({ ...deps, ...depOverrides }));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: '/invites' + path,
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
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
  });
}

describe('invites routes', () => {
  let inviterId: Uint8Array;
  let inviterKp: ReturnType<typeof generateKeyPair>;
  let inviterPrivKeyObj: ReturnType<typeof createPrivateKey>;
  let inviterPubKeyHex: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-routes-invites-'));
    initDb(join(testDir, 'store.sqlite'));
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    inviterKp = generateKeyPair();
    inviterId = inviterKp.publicKey;
    inviterPubKeyHex = Buffer.from(inviterId).toString('hex');
    inviterPrivKeyObj = createPrivateKey({
      key: Buffer.from(inviterKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
    storePutIdentityRecord(inviterId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
  });

  afterAll(() => {
    closeDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Seed a karma box for the inviter. */
  function seedKarma(value: bigint, nonce: number): KarmaBox {
    const karma = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value,
      createdAtBlock: 0,
      owner: inviterId,
    }, 1, nonce);
    storeInsertBox(karma);
    return karma;
  }

  it('POST /invites creates invite and returns 201 with pending', async () => {
    const karma = seedKarma(100n, 1);
    const invitee = generateKeyPair().publicKey;

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n - FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      owner: inviterId,
    };
    const bondBox: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      inviterId,
      inviteePublicKey: invitee,
    };

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [newKarma, bondBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKeyObj, inviterPubKeyHex);

    const res = await request('/', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
    expect(typeof body.bondBoxId).toBe('string');
    // ⛔ **`inviteBoxId` is gone from the response, and that is an API break**
    // (NODE_INTERFACE → Invites). There is no invite box for it to name.
    expect(body.inviteBoxId).toBeUndefined();
    // No secret in any of it — the response carries nothing the inviter has to
    // pass on out of band beyond what they already knew.
    expect(body.secretHash).toBeUndefined();
  });

  it('POST /invites with missing tx returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /invites/commit, /claim and /cancel are all gone', async () => {
    // ⛔ **There is ONE step.** `/commit` died with the instrument it served;
    // `/claim` and `/cancel` died with the transactions they submitted, because
    // the settlement grants the invitee out of the pool and nothing stays open
    // for a cancel to withdraw (NODE_INTERFACE → Invites).
    for (const path of ['/commit', '/claim', '/cancel']) {
      const res = await request(path, 'POST', { tx: {} });
      expect(res.status, path).toBe(404);
    }
  });

  // ---------------------------------------------------------------------------
  // NODE_INTERFACE → "Route error policy". These routes answer with the bare
  // `{ error: <message> }` shape, so the assertions below read `error`.
  // ---------------------------------------------------------------------------

  describe('error policy', () => {
    const SECRET = 'SQLITE_BUSY: database is locked at /srv/dagsocial.db';
    // A shape the edge admits (NODE_INTERFACE → HTTP API → "A write request's
    // transaction is checked whole before anything reads it") so the service's
    // mocked throw is what the response reaches.
    const EMPTY_TX = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: '1', createdAtBlock: 0, owner: '00'.repeat(32) }],
      signatures: {},
      protocolVersion: 1,
    };

    it('returns a generic 500 and logs when the service throws an unexpected error', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request('/', 'POST', { tx: EMPTY_TX }, {
          createInvite: () => {
            throw new Error(SECRET);
          },
        });

        expect(res.status).toBe(500);
        expect((res.data as Record<string, unknown>).error).toBe('Internal error');
        expect(JSON.stringify(res.data)).not.toContain('SQLITE_BUSY');
        expect(JSON.stringify(res.data)).not.toContain('/srv/dagsocial.db');
        expect(
          error.mock.calls.some((c) => c.some((a) => String((a as Error)?.message ?? a).includes('SQLITE_BUSY'))),
        ).toBe(true);
      } finally {
        error.mockRestore();
      }
    });

    it('control — an intentional rejection still returns its message with 400', async () => {
      const res = await request('/', 'POST', { tx: EMPTY_TX }, {
        createInvite: () => {
          throw new ClientError('Insufficient karma to invite: the bond is 25, inviter holds 3');
        },
      });

      expect(res.status).toBe(400);
      expect((res.data as Record<string, unknown>).error).toBe(
        'Insufficient karma to invite: the bond is 25, inviter holds 3',
      );
    });

    it('carries a typed status on the error instead of sniffing the message', async () => {
      const res = await request('/', 'POST', { tx: EMPTY_TX }, {
        createInvite: () => {
          throw new ClientError('not the inviter', 403);
        },
      });

      expect(res.status).toBe(403);
      expect((res.data as Record<string, unknown>).error).toBe('not the inviter');
    });

    it('a conflicting spend reaches the client as a 409 naming the box', async () => {
      const boxId = 'ab'.repeat(32);
      const res = await request('/', 'POST', { tx: EMPTY_TX }, {
        createInvite: () => {
          throw new PendingSpendConflictError(boxId);
        },
      });

      expect(res.status).toBe(409);
      const body = res.data as Record<string, unknown>;
      expect(body.error).toContain(boxId);
      expect(body.error).toMatch(/already spent by a pending/i);
    });

    it('maps a full mempool to 503 with a generic body', async () => {
      const res = await request('/', 'POST', { tx: EMPTY_TX }, {
        createInvite: () => {
          throw new MempoolFullError(10000);
        },
      });

      expect(res.status).toBe(503);
      expect(res.data).toEqual({ error: 'mempool full' });
    });

    it('keeps returning decode errors verbatim with 400', async () => {
      const res = await request('/', 'POST', {
        tx: { inputs: [], outputs: [{ boxType: 'karma', value: -1 }], signatures: {}, protocolVersion: 1 },
      });

      expect(res.status).toBe(400);
      expect(String((res.data as Record<string, unknown>).error)).toContain(
        'outputs[0].value must be a non-negative',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
// before anything reads state."
// NODE_INTERFACE → Service Layer Architecture → "A transaction the pool
// already holds is answered as held."
// ---------------------------------------------------------------------------
describe('a resubmit is answered as held', () => {
  let heldDir: string;
  let inviter: ReturnType<typeof generateKeyPair>;
  let inviterId: Uint8Array;
  let inviterPrivObj: ReturnType<typeof createPrivateKey>;
  let inviterHex: string;
  let heldKarma: KarmaBox;
  let broadcastTx: ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };

  function heldDeps(): InvitesDeps {
    const db = getDb();
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getIdentityRecord: storeGetIdentityRecord,
      insertBox: (box: AnyBox) => { storeInsertBox(box); },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaOwed: admissionOwed({ staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS, decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM }),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      getOwnKarmaBoxIds: (owner: Uint8Array) =>
        getKarmaBoxes(owner).filter((b) => b.income !== true).map((b) => b.id!),
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
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
      getTopologyAuthor: () => null,
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => { (db.transaction(fn) as () => void)(); },
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      getUsername: () => null,
      getUsernameByOwner: () => null,
      createInvite,
      getCurrentHeight,
    };
  }

  async function send(txJson: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve) => {
      const app = express();
      app.use(express.json());
      app.use('/invites', createRouter(heldDeps()));
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const r = http.request(
          {
            hostname: 'localhost',
            port: addr.port,
            path: '/invites/',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              server.close();
              try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) }); }
              catch { resolve({ status: res.statusCode ?? 0, data: d }); }
            });
          },
        );
        r.write(JSON.stringify({ tx: txJson }));
        r.end();
      });
    });
  }

  function buildInviteTx(): { tx: UtxoTransaction; txJson: Record<string, unknown> } {
    const invitee = generateKeyPair().publicKey;
    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n - FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      owner: inviterId,
    };
    const bondBox: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      inviterId,
      inviteePublicKey: invitee,
    };
    const tx: UtxoTransaction = {
      inputs: [heldKarma.id!],
      outputs: [newKarma, bondBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivObj, inviterHex);
    return { tx, txJson: txToJson(tx) };
  }

  beforeAll(async () => {
    heldDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-held-invites-'));
    initDb(join(heldDir, 'store.sqlite'));
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    inviter = generateKeyPair();
    inviterId = inviter.publicKey;
    inviterHex = Buffer.from(inviterId).toString('hex');
    inviterPrivObj = createPrivateKey({
      key: Buffer.from(inviter.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
    storePutIdentityRecord(inviterId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });

    heldKarma = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 0,
      owner: inviterId,
    }, 1);
    storeInsertBox(heldKarma);

    broadcastTx = vi.fn((_tx: UtxoTransaction) => Promise.resolve()) as unknown as typeof broadcastTx;
    const netStub = {
      penalizePeer: () => {},
      chainMoved: () => {},
      needHeaders: () => {},
      broadcastOrderingBlock: async () => {},
      broadcastTx,
      getConnectedPeers: () => [],
      tipApplied: () => {},
      setKarmaMembers: () => {},
      addKarmaMember: () => {},
      removeKarmaMember: () => {},
      requestPostBodies: async () => [],
    };
    setNet(netStub as unknown as Parameters<typeof setNet>[0]);

    await liveProver();
  });

  afterAll(() => {
    setNet(null as unknown as Parameters<typeof setNet>[0]);
    closeDb();
    rmSync(heldDir, { recursive: true, force: true });
  });

  it('POST /invites', async () => {
    const { tx, txJson } = buildInviteTx();

    const r1 = await send(txJson);
    expect(r1.status, JSON.stringify(r1.data)).toBe(201);

    const block = await makeApplicableBlock({ height: 1 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const publishesBefore = broadcastTx.mock.calls.length;
    const r2 = await send(txJson);
    expect(r2.status).toBe(r1.status);
    expect(r2.data).toEqual(r1.data);
    expect((r2.data as Record<string, unknown>).expiresAtHeight)
      .toBe((r1.data as Record<string, unknown>).expiresAtHeight);

    const calls = broadcastTx.mock.calls;
    expect(calls.length).toBe(publishesBefore + 1);
    const sentTx = calls[publishesBefore]![0] as UtxoTransaction;
    const pooledBytes = Buffer.from(encodeTx(tx)).toString('hex');
    const sentBytes = Buffer.from(encodeTx(sentTx)).toString('hex');
    expect(sentBytes).toBe(pooledBytes);
    expect(computeTxId(sentTx)).toBe(computeTxId(tx));
  });

  // MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
  // before anything reads state": the signatures ride outside the id preimage
  // (TYPES_INTERFACE → Layout — UtxoTransaction), so a resubmit whose
  // signature bytes differ shares the pooled entry's id, and the publish
  // reads the pooled bytes.
  it('other signature bytes, one id', async () => {
    const freshInviter = generateKeyPair();
    const freshInviterId = freshInviter.publicKey;
    const freshInviterHex = Buffer.from(freshInviterId).toString('hex');
    const freshInviterPriv = createPrivateKey({
      key: Buffer.from(freshInviter.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
    storePutIdentityRecord(freshInviterId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    const freshKarma = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 0,
      owner: freshInviterId,
    }, 1, 500);
    storeInsertBox(freshKarma);

    const invitee = generateKeyPair().publicKey;
    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n - FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      owner: freshInviterId,
    };
    const bondBox: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      inviterId: freshInviterId,
      inviteePublicKey: invitee,
    };
    const tx: UtxoTransaction = {
      inputs: [freshKarma.id!],
      outputs: [newKarma, bondBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, freshInviterPriv, freshInviterHex);
    const txJson = txToJson(tx);

    const r1 = await send(txJson);
    expect(r1.status, JSON.stringify(r1.data)).toBe(201);

    const block = await makeApplicableBlock({ height: getCurrentHeight() + 1 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const otherSig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) otherSig[i] = i + 1;
    const otherTxJson = {
      ...txJson,
      signatures: { [freshInviterHex]: Buffer.from(otherSig).toString('hex') },
    };

    const publishesBefore = broadcastTx.mock.calls.length;
    const r2 = await send(otherTxJson);
    expect(r2.status).toBe(r1.status);
    expect(r2.data).toEqual(r1.data);

    const calls = broadcastTx.mock.calls;
    expect(calls.length).toBe(publishesBefore + 1);
    const sentTx = calls[publishesBefore]![0] as UtxoTransaction;
    const pooledBytes = Buffer.from(encodeTx(tx)).toString('hex');
    const sentBytes = Buffer.from(encodeTx(sentTx)).toString('hex');
    const requestTx: UtxoTransaction = { ...tx, signatures: { [freshInviterHex]: otherSig } };
    const requestBytes = Buffer.from(encodeTx(requestTx)).toString('hex');
    expect(sentBytes).toBe(pooledBytes);
    expect(sentBytes).not.toBe(requestBytes);
  });
});
