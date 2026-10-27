// NODE_INTERFACE → Backers — the three routes
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { setNet } from '../../src/services/net-instance.js';
import {
  applyBlockThroughIntake,
  liveProver,
  makeApplicableBlock,
} from '../helpers.js';
import { computeTxId, encodeTx } from '@dagsocial/types';
import {
  insertBox, getBox as storeGetBox, getKarmaBoxes, getKarmaValue,
  getBoxProvenance, hasActiveVouchEscrow, getBackerPoolBox, getBackerStakeBox,
} from '../../src/store/utxo.js';
import { getVouchBox } from '../../src/store/vouch-queries.js';
import { getIdentityRecord, putIdentityRecord, getNetworkRecord } from '../../src/store/identity-records.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { getUsername, getUsernameByOwner, putUsername } from '../../src/store/usernames.js';
import { validateTx } from '@dagsocial/consensus';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { createRouter } from '../../src/routes/backers.js';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { BackerStakeBox, BackerPoolBox, UtxoTransaction } from '@dagsocial/types';
import { seedProvenance, signTransaction, txToJson, rawPublicKey } from '../helpers.js';
import { config } from '../../src/config.js';
import { setMempoolCap, DEFAULT_MAX_MEMPOOL_ENTRIES, PendingSpendConflictError } from '../../src/store/mempool.js';
import { generateKeyPairSync } from 'crypto';
import { admissionOwed } from '../../src/services/karma-admission.js';

const TEST_DB = ':memory:';

function hex(id: Uint8Array): string { return Buffer.from(id).toString('hex'); }

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = rawPublicKey(publicKey);
  return { pub, hex: hex(pub), priv: privateKey };
}

let nonce = 2000;
function seedStake(owner: Uint8Array, weight: bigint): BackerStakeBox {
  const box = seedProvenance<BackerStakeBox>(
    { boxType: 'backer_stake', value: 0n as 0n, createdAtBlock: 1, owner, weight }, 1, nonce++,
  );
  insertBox(box);
  return box;
}

function seedPool(staked: bigint, accrual: bigint, value = 0n): BackerPoolBox {
  const box = seedProvenance<BackerPoolBox>(
    { boxType: 'backer_pool', value, staked, accrual, createdAtBlock: 1 }, 1, nonce++,
  );
  insertBox(box);
  return box;
}

function makeDeps(): UtxoEngineDeps {
  const db = getDb();
  return {
    getBox: (id: string) => {
      const box = storeGetBox(id);
      if (!box) return null;
      const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
      return r && r.spent_at_block === null ? box : null;
    },
    insertBox,
    consumeBox: (id: string, atBlock: number) => {
      db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
    },
    getKarmaOwed: admissionOwed({ staleThresholdBlocks: config.karmaStaleThresholdBlocks, decayIntervalBlocks: config.karmaDecayIntervalBlocks, decayAmount: config.karmaDecayAmount, karmaMinimum: config.karmaMinimum }),
    getKarmaValue,
    getOwnKarmaBoxIds: (owner: Uint8Array) =>
      getKarmaBoxes(owner).filter((b) => b.income !== true).map((b) => b.id!),
    getIdentityRecord,
    hasActiveVouchEscrow,
    vouchCooldownBlocks: 2,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg: {
      staleThresholdBlocks: config.karmaStaleThresholdBlocks,
      decayIntervalBlocks: config.karmaDecayIntervalBlocks,
      decayAmount: config.karmaDecayAmount,
      karmaMinimum: config.karmaMinimum,
    },
    storageRentPeriodBlocks: config.storageRentPeriodBlocks,
    getBoxProvenance,
    getTopologyAuthor: () => null,
    getPendingPostAuthor: () => null,
    runInTransaction: (fn) => db.transaction(fn)(),
    getVouchBox,
    getNetworkRecord,
    membershipBarMultiplier: config.membershipBarMultiplier,
    putIdentityRecord,
    protocolVersionSchedule: config.protocolVersionSchedule,
    getUsername,
    getUsernameByOwner,
  };
}

async function getReq(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      http.get({ hostname: 'localhost', port: addr.port, path }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode!, body: JSON.parse(d) }); });
      });
    });
  });
}

async function postReq(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const data = JSON.stringify(body);
      const req = http.request(
        { hostname: 'localhost', port: addr.port, path, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode!, body: JSON.parse(d) }); });
        },
      );
      req.write(data);
      req.end();
    });
  });
}

describe('backer routes', () => {
  const holder = makeKeys();
  const stranger = makeKeys();
  let app: express.Express;

  beforeAll(() => {
    initDb(TEST_DB);
    setMempoolCap(DEFAULT_MAX_MEMPOOL_ENTRIES);
    const deps = makeDeps();
    app = express();
    app.use(express.json());
    app.use(
      '/backers',
      createRouter({
        ...deps,
        getCurrentHeight,
        validateTx: (tx, i, h) => validateTx(deps, tx, i, h),
        getBackerPoolBox,
        getBackerStakeBox,
        backerSupply: 100n,
        creditFixedRateBlocks: 1_000_000,
      }),
    );
  });

  afterAll(() => {
    closeDb();
  });

  describe('GET /backers', () => {
    it('404 on a network with no pool box', async () => {
      const r = await getReq(app, '/backers');
      expect(r.status).toBe(404);
      expect(r.body.error).toContain('no backer pool');
    });

    it('returns pool summary once seeded', async () => {
      seedPool(50n, 1000n, 100n);
      const r = await getReq(app, '/backers');
      expect(r.status).toBe(200);
      expect(r.body.supply).toBe('100');
      expect(r.body.staked).toBe('50');
      expect(r.body.accrual).toBe('1000');
      expect(r.body.unreleased).toBe('100');
      expect(r.body.accrualEndsAtBlock).toBe(1_000_000);
    });
  });

  describe('GET /backers/:userId', () => {
    it('404 for a key with no stake', async () => {
      const r = await getReq(app, `/backers/${stranger.hex}`);
      expect(r.status).toBe(404);
      expect(r.body.error).toContain('no stake');
    });

    it('returns the stake and accrued for a seeded backer', async () => {
      seedStake(holder.pub, 20n);
      const r = await getReq(app, `/backers/${holder.hex}`);
      expect(r.status).toBe(200);
      expect(r.body.owner).toBe(holder.hex);
      expect(r.body.weight).toBe('20');
      expect(r.body.accrued).toBe((20n * 1000n / 100n).toString());
    });

    it('resolves an @handle', async () => {
      putUsername({ nameLower: 'alice', name: 'alice', owner: holder.hex, boxId: 'fakebox', claimedAtBlock: 1 });
      const r = await getReq(app, '/backers/@alice');
      expect(r.status).toBe(200);
      expect(r.body.owner).toBe(holder.hex);
    });

    it('404 for an unknown handle', async () => {
      const r = await getReq(app, '/backers/@nobody');
      expect(r.status).toBe(404);
      expect(r.body.error).toContain('unknown handle');
    });

    it('400 for a malformed key', async () => {
      const r = await getReq(app, '/backers/xyz');
      expect(r.status).toBe(400);
    });
  });

  describe('POST /backers/unstake', () => {
    it('accepts a valid unstake transaction', async () => {
      const stake = seedStake(holder.pub, 100n);
      const tx: UtxoTransaction = {
        inputs: [stake.id!],
        outputs: [
          { boxType: 'backer_stake', value: 0n, createdAtBlock: 1, owner: holder.pub, weight: 60n } as any,
          { boxType: 'backer_unstake', value: 0n, createdAtBlock: 1, owner: holder.pub, weight: 40n } as any,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, holder.priv, holder.hex);
      const r = await postReq(app, '/backers/unstake', { tx: txToJson(tx) });
      expect(r.body.error ?? '').toBe('');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('pending');
      expect(r.body.txId).toBeDefined();
    });

    it('400 for a missing tx', async () => {
      const r = await postReq(app, '/backers/unstake', {});
      expect(r.status).toBe(400);
      expect(r.body.error).toContain('unstake transaction');
    });

    // -------------------------------------------------------------------------
    // MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
    // before anything reads state."
    // NODE_INTERFACE → Service Layer Architecture → "A transaction the pool
    // already holds is answered as held."
    // -------------------------------------------------------------------------
    it('a conflicting spend answers 409 naming the box', async () => {
      const boxId = 'ab'.repeat(32);
      const deps = makeDeps();
      const conflictApp = express();
      conflictApp.use(express.json());
      conflictApp.use('/backers', createRouter({
        ...deps,
        getCurrentHeight,
        validateTx: (): never => { throw new PendingSpendConflictError(boxId); },
        getBackerPoolBox,
        getBackerStakeBox,
        backerSupply: 100n,
        creditFixedRateBlocks: 1_000_000,
      }));
      const stake = seedStake(holder.pub, 50n);
      const tx: UtxoTransaction = {
        inputs: [stake.id!],
        outputs: [
          { boxType: 'backer_stake', value: 0n, createdAtBlock: 1, owner: holder.pub, weight: 30n } as any,
          { boxType: 'backer_unstake', value: 0n, createdAtBlock: 1, owner: holder.pub, weight: 20n } as any,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, holder.priv, holder.hex);
      const r = await postReq(conflictApp, '/backers/unstake', { tx: txToJson(tx) });
      expect(r.status).toBe(409);
      expect(r.body.error).toContain(boxId);
      expect(r.body.error).toMatch(/already spent by a pending/i);
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
  let heldApp: express.Express;
  let heldHolder: ReturnType<typeof makeKeys>;
  let heldStake: BackerStakeBox;
  let broadcastTx: ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };

  beforeAll(async () => {
    heldDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-held-backers-'));
    initDb(join(heldDir, 'store.sqlite'));
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    setMempoolCap(DEFAULT_MAX_MEMPOOL_ENTRIES);

    heldHolder = makeKeys();
    heldStake = seedStake(heldHolder.pub, 100n);
    seedPool(100n, 0n, 100n);

    const deps = makeDeps();
    heldApp = express();
    heldApp.use(express.json());
    heldApp.use(
      '/backers',
      createRouter({
        ...deps,
        getCurrentHeight,
        validateTx: (tx, i, h) => validateTx(deps, tx, i, h),
        getBackerPoolBox,
        getBackerStakeBox,
        backerSupply: 100n,
        creditFixedRateBlocks: 1_000_000,
      }),
    );

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

  it('POST /backers/unstake', async () => {
    const tx: UtxoTransaction = {
      inputs: [heldStake.id!],
      outputs: [
        { boxType: 'backer_stake', value: 0n, createdAtBlock: 1, owner: heldHolder.pub, weight: 60n } as any,
        { boxType: 'backer_unstake', value: 0n, createdAtBlock: 1, owner: heldHolder.pub, weight: 40n } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, heldHolder.priv, heldHolder.hex);
    const txJson = txToJson(tx);

    const r1 = await postReq(heldApp, '/backers/unstake', { tx: txJson });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);

    const block = await makeApplicableBlock({ height: 1 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const publishesBefore = broadcastTx.mock.calls.length;
    const r2 = await postReq(heldApp, '/backers/unstake', { tx: txJson });
    expect(r2.status).toBe(r1.status);
    expect(r2.body).toEqual(r1.body);
    expect(r2.body.expiresAtHeight).toBe(r1.body.expiresAtHeight);

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
    const holder = makeKeys();
    const stake = seedStake(holder.pub, 100n);

    const tx: UtxoTransaction = {
      inputs: [stake.id!],
      outputs: [
        { boxType: 'backer_stake', value: 0n, createdAtBlock: 1, owner: holder.pub, weight: 60n } as any,
        { boxType: 'backer_unstake', value: 0n, createdAtBlock: 1, owner: holder.pub, weight: 40n } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.priv, holder.hex);
    const txJson = txToJson(tx);

    const r1 = await postReq(heldApp, '/backers/unstake', { tx: txJson });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);

    const block = await makeApplicableBlock({ height: getCurrentHeight() + 1 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const otherSig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) otherSig[i] = i + 1;
    const otherTxJson = {
      ...txJson,
      signatures: { [holder.hex]: Buffer.from(otherSig).toString('hex') },
    };

    const publishesBefore = broadcastTx.mock.calls.length;
    const r2 = await postReq(heldApp, '/backers/unstake', { tx: otherTxJson });
    expect(r2.status).toBe(r1.status);
    expect(r2.body).toEqual(r1.body);

    const calls = broadcastTx.mock.calls;
    expect(calls.length).toBe(publishesBefore + 1);
    const sentTx = calls[publishesBefore]![0] as UtxoTransaction;
    const pooledBytes = Buffer.from(encodeTx(tx)).toString('hex');
    const sentBytes = Buffer.from(encodeTx(sentTx)).toString('hex');
    const requestTx: UtxoTransaction = { ...tx, signatures: { [holder.hex]: otherSig } };
    const requestBytes = Buffer.from(encodeTx(requestTx)).toString('hex');
    expect(sentBytes).toBe(pooledBytes);
    expect(sentBytes).not.toBe(requestBytes);
  });
});
