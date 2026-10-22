// NODE_INTERFACE → Usernames — the four routes
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import http from 'http';
import { generateKeyPairSync } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertBox, getBox as storeGetBox, getKarmaValue, getBoxProvenance, hasActiveVouchEscrow } from '../../src/store/utxo.js';
import { getBoxWithPending, getOwnKarmaBoxIdsWithPending } from '../../src/store/mempool.js';
import { getVouchBox } from '../../src/store/vouch-queries.js';
import { getIdentityRecord, putIdentityRecord, getNetworkRecord } from '../../src/store/identity-records.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { getUsername, getUsernameByOwner, putUsername } from '../../src/store/usernames.js';
import { validateTx } from '@dagsocial/consensus';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { createRouter } from '../../src/routes/usernames.js';
import {
  PROTOCOL_VERSION,
  USERNAME_BURN_PRICE,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { KarmaBox, UsernameBox, UtxoTransaction } from '@dagsocial/types';
import {
  applyBlockThroughIntake,
  liveProver,
  makeApplicableBlock,
  rawPublicKey,
  seedProvenance,
  signTransaction,
  txToJson,
} from '../helpers.js';
import { config } from '../../src/config.js';
import { setMempoolCap, DEFAULT_MAX_MEMPOOL_ENTRIES, PendingSpendConflictError } from '../../src/store/mempool.js';
import { admissionOwed } from '../../src/services/karma-admission.js';
import { setNet } from '../../src/services/net-instance.js';
import { computeTxId, encodeTx } from '@dagsocial/types';

// A directory private to this run, so two runs of the suite on one machine
// never write the same store file.
let testDir: string;

function hex(id: Uint8Array): string { return Buffer.from(id).toString('hex'); }

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = rawPublicKey(publicKey);
  return { pub, hex: hex(pub), priv: privateKey };
}

let nonce = 100;
function seedKarma(owner: Uint8Array, value: bigint): KarmaBox {
  const box = seedProvenance<KarmaBox>(
    { boxType: 'karma', value, createdAtBlock: 1, owner }, 1, nonce++,
  );
  insertBox(box);
  return box;
}

function seedUsernameBox(owner: Uint8Array, name: string): UsernameBox {
  const box = seedProvenance<UsernameBox>(
    { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner, name: Buffer.from(name, 'utf8') }, 1, nonce++,
  );
  insertBox(box);
  return box;
}

function makeDeps(): UtxoEngineDeps {
  const db = getDb();
  return {
    // The pending view, as the write-side admission wires it
    // (NODE_INTERFACE → Service Layer Architecture → "One function admits").
    getBox: (id: string) => {
      const box = storeGetBox(id);
      if (box) {
        const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
        if (r && r.spent_at_block === null) return box;
      }
      return getBoxWithPending(id);
    },
    insertBox,
    consumeBox: (id: string, atBlock: number) => {
      db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
    },
    getKarmaOwed: admissionOwed({ staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS, decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM }),
    getKarmaValue,
    getOwnKarmaBoxIds: (owner: Uint8Array) =>
      getOwnKarmaBoxIdsWithPending(Buffer.from(owner).toString('hex')),
    getIdentityRecord,
    hasActiveVouchEscrow,
    vouchCooldownBlocks: 2,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg: {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
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

async function post(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const data = JSON.stringify(body);
      const req = http.request(
        { hostname: 'localhost', port: addr.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
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

async function get(app: express.Express, path: string): Promise<{ status: number; body: any }> {
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

describe('username routes', () => {
  let app: express.Express;
  let holder: ReturnType<typeof makeKeys>;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-routes-usernames-'));
    initDb(join(testDir, 'store.sqlite'));
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();
    holder = makeKeys();

    const deps = makeDeps();
    app = express();
    app.use(express.json());
    app.use('/usernames', createRouter({
      ...deps,
      getCurrentHeight,
      validateTx: (tx, h) => validateTx(deps, tx, h),
      getUsername,
      getUsernameByOwner,
    }));
  });

  afterAll(() => {
    closeDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  // --- GET /usernames/:name ---

  it('GET /usernames/:name — 404 when not held', async () => {
    const res = await get(app, '/usernames/Nobody');
    expect(res.status).toBe(404);
  });

  it('GET /usernames/:name — 400 for malformed name', async () => {
    const res = await get(app, '/usernames/a%20b');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name invalid');
  });

  it('GET /usernames/:name — returns the row, with and without @', async () => {
    putUsername({ nameLower: 'alice', name: 'Alice', owner: holder.hex, boxId: 'aa'.repeat(32), claimedAtBlock: 1 });

    const res1 = await get(app, '/usernames/Alice');
    expect(res1.status).toBe(200);
    expect(res1.body.name).toBe('Alice');
    expect(res1.body.owner).toBe(holder.hex);

    const res2 = await get(app, '/usernames/@Alice');
    expect(res2.status).toBe(200);
    expect(res2.body.name).toBe('Alice');
  });

  it('GET /usernames/:name — different-case lookup answers the name as typed', async () => {
    const res = await get(app, '/usernames/ALICE');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice');
  });

  // --- GET /usernames?owner= ---

  it('GET /usernames?owner= by key', async () => {
    const res = await get(app, `/usernames?owner=${holder.hex}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice');
  });

  it('GET /usernames?owner=@handle resolves', async () => {
    const res = await get(app, '/usernames?owner=@Alice');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice');
  });

  it('GET /usernames?owner= — 404 for identity with no name', async () => {
    const other = makeKeys();
    const res = await get(app, `/usernames?owner=${other.hex}`);
    expect(res.status).toBe(404);
  });

  it('GET /usernames?owner= — 400 for malformed value', async () => {
    const res = await get(app, '/usernames?owner=xyz');
    expect(res.status).toBe(400);
  });

  // --- POST /usernames/:name/burn — the box-id check ---

  it('POST /usernames/:name/burn — 400 if tx does not consume :name\'s box', async () => {
    const burnHolder = makeKeys();
    const kb = seedKarma(burnHolder.pub, 100n);
    const boxA = seedUsernameBox(burnHolder.pub, 'NameA');
    const boxB = seedUsernameBox(burnHolder.pub, 'NameB');
    putUsername({ nameLower: 'namea', name: 'NameA', owner: burnHolder.hex, boxId: boxA.id!, claimedAtBlock: 10 });
    // Seed NameB under a different owner so the UNIQUE constraint is not hit
    const burnHolder2 = makeKeys();
    putUsername({ nameLower: 'nameb', name: 'NameB', owner: burnHolder2.hex, boxId: boxB.id!, claimedAtBlock: 11 });

    // A valid burn of NameA, posted to /usernames/NameB/burn — wrong path
    const tx: UtxoTransaction = {
      inputs: [kb.id!, boxA.id!],
      outputs: [
        { boxType: 'karma', value: kb.value - USERNAME_BURN_PRICE, createdAtBlock: 10, owner: burnHolder.pub } as any,
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: 10 } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, burnHolder.priv, burnHolder.hex);

    const res = await post(app, '/usernames/NameB/burn', { tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('does not consume');
  });

  // --- POST /usernames (claim) ---

  it('POST /usernames — a valid claim pools and answers pending with the name as typed', async () => {
    const claimant = makeKeys();
    const kb = seedKarma(claimant.pub, 100n);
    putIdentityRecord(claimant.pub, { lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });

    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: kb.value, createdAtBlock: 1, owner: claimant.pub } as any,
        { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: claimant.pub, name: Buffer.from('Claimer', 'utf8') } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, claimant.priv, claimant.hex);

    const res = await post(app, '/usernames', { tx: txToJson(tx) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.name).toBe('Claimer');
    expect(typeof res.body.txId).toBe('string');
    expect(typeof res.body.expiresAtHeight).toBe('number');
  });

  it('POST /usernames — 400 name invalid', async () => {
    const claimant = makeKeys();
    const kb = seedKarma(claimant.pub, 100n);

    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: kb.value, createdAtBlock: 1, owner: claimant.pub } as any,
        { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: claimant.pub, name: Buffer.from('a b', 'utf8') } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, claimant.priv, claimant.hex);

    const res = await post(app, '/usernames', { tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name invalid');
  });

  it('POST /usernames — 400 name taken', async () => {
    // 'alice' was seeded in the beforeAll via putUsername
    const claimant = makeKeys();
    const kb = seedKarma(claimant.pub, 100n);

    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: kb.value, createdAtBlock: 1, owner: claimant.pub } as any,
        { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: claimant.pub, name: Buffer.from('Alice', 'utf8') } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, claimant.priv, claimant.hex);

    const res = await post(app, '/usernames', { tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name taken');
  });

  it('POST /usernames — 400 identity holds a name', async () => {
    // 'holder' already holds 'Alice'
    const kb = seedKarma(holder.pub, 100n);

    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: kb.value, createdAtBlock: 1, owner: holder.pub } as any,
        { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: holder.pub, name: Buffer.from('Different', 'utf8') } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.priv, holder.hex);

    const res = await post(app, '/usernames', { tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('identity holds a name');
  });

  it('POST /usernames — 400 when the transaction outputs no username box', async () => {
    const claimant = makeKeys();
    const kb = seedKarma(claimant.pub, 100n);

    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: kb.value, createdAtBlock: 1, owner: claimant.pub } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, claimant.priv, claimant.hex);

    const res = await post(app, '/usernames', { tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('username box');
  });

  it('POST /usernames — 409 while a pending claim carries the same canonical name', async () => {
    // First claim a fresh name successfully
    const c1 = makeKeys();
    const k1 = seedKarma(c1.pub, 100n);
    putIdentityRecord(c1.pub, { lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
    const tx1: UtxoTransaction = {
      inputs: [k1.id!],
      outputs: [
        { boxType: 'karma', value: k1.value, createdAtBlock: 1, owner: c1.pub } as any,
        { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: c1.pub, name: Buffer.from('Unique409', 'utf8') } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx1, c1.priv, c1.hex);
    const r1 = await post(app, '/usernames', { tx: txToJson(tx1) });
    expect(r1.status).toBe(200);

    // Second claim with same canonical name, different claimant
    const c2 = makeKeys();
    const k2 = seedKarma(c2.pub, 100n);
    putIdentityRecord(c2.pub, { lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
    const tx2: UtxoTransaction = {
      inputs: [k2.id!],
      outputs: [
        { boxType: 'karma', value: k2.value, createdAtBlock: 1, owner: c2.pub } as any,
        { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: c2.pub, name: Buffer.from('unique409', 'utf8') } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx2, c2.priv, c2.hex);
    const r2 = await post(app, '/usernames', { tx: txToJson(tx2) });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toContain('pending claim');
  });

  it('POST /usernames — 409 while the same claimant has a pending claim', async () => {
    // The claimant seeds one own karma box; the second claim chains
    // through the first claim's own-box change (NODE_INTERFACE → Karma
    // transition rules → "An identity holds at most two karma boxes").
    const c = makeKeys();
    const k1 = seedKarma(c.pub, 200n);
    putIdentityRecord(c.pub, { lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });

    const tx1: UtxoTransaction = {
      inputs: [k1.id!],
      outputs: [
        { boxType: 'karma', value: k1.value, createdAtBlock: 1, owner: c.pub } as any,
        { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: c.pub, name: Buffer.from('ClaimA409', 'utf8') } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx1, c.priv, c.hex);
    const r1 = await post(app, '/usernames', { tx: txToJson(tx1) });
    expect(r1.status).toBe(200);

    const { materializeOutput } = await import('@dagsocial/consensus');
    const { computeTxId } = await import('@dagsocial/types');
    const change1 = materializeOutput(tx1.outputs[0]!, computeTxId(tx1), 0) as KarmaBox;
    const tx2: UtxoTransaction = {
      inputs: [change1.id!],
      outputs: [
        { boxType: 'karma', value: change1.value, createdAtBlock: 1, owner: c.pub } as any,
        { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: c.pub, name: Buffer.from('ClaimB409', 'utf8') } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx2, c.priv, c.hex);
    const r2 = await post(app, '/usernames', { tx: txToJson(tx2) });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toContain('pending claim');
  });

  it('POST /usernames — 503 when the pool is full', async () => {
    getDb().prepare('DELETE FROM mempool').run();
    setMempoolCap(1);
    try {
      const c1 = makeKeys();
      const k1 = seedKarma(c1.pub, 100n);
      putIdentityRecord(c1.pub, { lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });

      // Fill the single slot
      const tx1: UtxoTransaction = {
        inputs: [k1.id!],
        outputs: [
          { boxType: 'karma', value: k1.value, createdAtBlock: 1, owner: c1.pub } as any,
          { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: c1.pub, name: Buffer.from('Fill503', 'utf8') } as any,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx1, c1.priv, c1.hex);
      const r1 = await post(app, '/usernames', { tx: txToJson(tx1) });
      expect(r1.status).toBe(200);

      // Second should hit 503
      const c2 = makeKeys();
      const k2 = seedKarma(c2.pub, 100n);
      putIdentityRecord(c2.pub, { lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
      const tx2: UtxoTransaction = {
        inputs: [k2.id!],
        outputs: [
          { boxType: 'karma', value: k2.value, createdAtBlock: 1, owner: c2.pub } as any,
          { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: c2.pub, name: Buffer.from('Over503', 'utf8') } as any,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx2, c2.priv, c2.hex);
      const r2 = await post(app, '/usernames', { tx: txToJson(tx2) });
      expect(r2.status).toBe(503);
      expect(r2.body.error).toBe('mempool full');
    } finally {
      setMempoolCap(DEFAULT_MAX_MEMPOOL_ENTRIES);
    }
  });

  // --- POST /usernames/:name/burn ---

  it('POST /usernames/:name/burn — a valid burn pools and answers pending', async () => {
    const burner = makeKeys();
    const kb = seedKarma(burner.pub, 100n);
    const uBox = seedUsernameBox(burner.pub, 'BurnMe');
    putUsername({ nameLower: 'burnme', name: 'BurnMe', owner: burner.hex, boxId: uBox.id!, claimedAtBlock: 1 });
    putIdentityRecord(burner.pub, { lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });

    const tx: UtxoTransaction = {
      inputs: [kb.id!, uBox.id!],
      outputs: [
        { boxType: 'karma', value: kb.value - USERNAME_BURN_PRICE, createdAtBlock: 1, owner: burner.pub } as any,
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: 1 } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, burner.priv, burner.hex);

    const res = await post(app, '/usernames/BurnMe/burn', { tx: txToJson(tx) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(typeof res.body.txId).toBe('string');
    expect(typeof res.body.expiresAtHeight).toBe('number');
  });

  it('POST /usernames/:name/burn — 404 for a name not held', async () => {
    const burner = makeKeys();
    const kb = seedKarma(burner.pub, 100n);
    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: kb.value - USERNAME_BURN_PRICE, createdAtBlock: 1, owner: burner.pub } as any,
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: 1 } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, burner.priv, burner.hex);

    const res = await post(app, '/usernames/NobodyHoldsThis/burn', { tx: txToJson(tx) });
    expect(res.status).toBe(404);
  });

  it('POST /usernames — a conflicting spend answers 409 naming the box', async () => {
    const boxId = 'ab'.repeat(32);
    const deps = makeDeps();
    const conflictApp = express();
    conflictApp.use(express.json());
    conflictApp.use('/usernames', createRouter({
      ...deps,
      getCurrentHeight,
      validateTx: (): never => { throw new PendingSpendConflictError(boxId); },
      getUsername,
      getUsernameByOwner,
    }));
    const c = makeKeys();
    const kb = seedKarma(c.pub, 100n);
    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'username', value: 0n, createdAtBlock: 1, owner: c.pub, name: Buffer.from('Conflict409', 'utf8') } as any,
        { boxType: 'karma', value: 100n, createdAtBlock: 1, owner: c.pub } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, c.priv, c.hex);
    const res = await post(conflictApp, '/usernames', { tx: txToJson(tx) });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(boxId);
    expect(res.body.error).toMatch(/already spent by a pending/i);
  });

  it('POST /usernames/:name/burn — a conflicting spend answers 409 naming the box', async () => {
    const boxId = 'cd'.repeat(32);
    const deps = makeDeps();
    const conflictApp = express();
    conflictApp.use(express.json());
    conflictApp.use('/usernames', createRouter({
      ...deps,
      getCurrentHeight,
      validateTx: (): never => { throw new PendingSpendConflictError(boxId); },
      getUsername,
      getUsernameByOwner,
    }));
    const burner = makeKeys();
    const kb = seedKarma(burner.pub, 100n);
    const uBox = seedUsernameBox(burner.pub, 'BurnConflict');
    putUsername({ nameLower: 'burnconflict', name: 'BurnConflict', owner: burner.hex, boxId: uBox.id!, claimedAtBlock: 1 });

    const tx: UtxoTransaction = {
      inputs: [kb.id!, uBox.id!],
      outputs: [
        { boxType: 'karma', value: 100n, createdAtBlock: 1, owner: burner.pub } as any,
        { boxType: 'karma_price', value: 0n, createdAtBlock: 1 } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, burner.priv, burner.hex);
    const res = await post(conflictApp, '/usernames/BurnConflict/burn', { tx: txToJson(tx) });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(boxId);
    expect(res.body.error).toMatch(/already spent by a pending/i);
  });

  it('POST /usernames/:name/burn — 400 for a wrong price', async () => {
    const burner = makeKeys();
    const kb = seedKarma(burner.pub, 100n);
    const uBox = seedUsernameBox(burner.pub, 'WrongPrice');
    putUsername({ nameLower: 'wrongprice', name: 'WrongPrice', owner: burner.hex, boxId: uBox.id!, claimedAtBlock: 1 });
    putIdentityRecord(burner.pub, { lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });

    const wrongPrice = USERNAME_BURN_PRICE - 1n;
    const tx: UtxoTransaction = {
      inputs: [kb.id!, uBox.id!],
      outputs: [
        { boxType: 'karma', value: kb.value - wrongPrice, createdAtBlock: 1, owner: burner.pub } as any,
        { boxType: 'karma_price', value: wrongPrice, createdAtBlock: 1 } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, burner.priv, burner.hex);

    const res = await post(app, '/usernames/WrongPrice/burn', { tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('price');
  });

  // --- owner alias resolution: wrong case, unknown and malformed ---

  it('GET /usernames?owner= — wrong-case handle resolves', async () => {
    const res = await get(app, '/usernames?owner=@ALICE');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice');
  });

  it('GET /usernames?owner= — unknown handle answers 404 with unknown handle', async () => {
    const res = await get(app, '/usernames?owner=@Nobody');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('unknown handle');
  });

  it('GET /usernames?owner= — malformed value answers 400', async () => {
    const res = await get(app, '/usernames?owner=!!!');
    expect(res.status).toBe(400);
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
  let claimant: ReturnType<typeof makeKeys>;
  let claimantKarma: KarmaBox;
  let burner: ReturnType<typeof makeKeys>;
  let burnerKarma: KarmaBox;
  let burnerUsernameBox: UsernameBox;
  let broadcastTx: ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };

  beforeAll(async () => {
    heldDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-held-usernames-'));
    initDb(join(heldDir, 'store.sqlite'));
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();
    setMempoolCap(DEFAULT_MAX_MEMPOOL_ENTRIES);

    claimant = makeKeys();
    claimantKarma = seedKarma(claimant.pub, 100n);
    putIdentityRecord(claimant.pub, {
      lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });

    burner = makeKeys();
    burnerKarma = seedKarma(burner.pub, 100n);
    burnerUsernameBox = seedUsernameBox(burner.pub, 'HeldBurn');
    putUsername({ nameLower: 'heldburn', name: 'HeldBurn', owner: burner.hex, boxId: burnerUsernameBox.id!, claimedAtBlock: 1 });
    putIdentityRecord(burner.pub, {
      lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });

    const deps = makeDeps();
    heldApp = express();
    heldApp.use(express.json());
    heldApp.use('/usernames', createRouter({
      ...deps,
      getCurrentHeight,
      validateTx: (tx, h) => validateTx(deps, tx, h),
      getUsername,
      getUsernameByOwner,
    }));

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

  it.fails('POST /usernames', async () => {
    const tx: UtxoTransaction = {
      inputs: [claimantKarma.id!],
      outputs: [
        { boxType: 'karma', value: claimantKarma.value, createdAtBlock: 1, owner: claimant.pub } as any,
        { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner: claimant.pub, name: Buffer.from('HeldClaim', 'utf8') } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, claimant.priv, claimant.hex);
    const txJson = txToJson(tx);

    const r1 = await post(heldApp, '/usernames', { tx: txJson });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);

    const block = await makeApplicableBlock({ height: 1 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const r2 = await post(heldApp, '/usernames', { tx: txJson });
    expect(r2.status).toBe(r1.status);
    expect(r2.body).toEqual(r1.body);
    expect(r2.body.expiresAtHeight).toBe(r1.body.expiresAtHeight);

    const calls = broadcastTx.mock.calls;
    const sentTx = calls[calls.length - 1]![0] as UtxoTransaction;
    const pooledBytes = Buffer.from(encodeTx(tx)).toString('hex');
    const sentBytes = Buffer.from(encodeTx(sentTx)).toString('hex');
    expect(sentBytes).toBe(pooledBytes);
    expect(computeTxId(sentTx)).toBe(computeTxId(tx));
  });

  it.fails('POST /usernames/:name/burn', async () => {
    const tx: UtxoTransaction = {
      inputs: [burnerKarma.id!, burnerUsernameBox.id!],
      outputs: [
        { boxType: 'karma', value: burnerKarma.value - USERNAME_BURN_PRICE, createdAtBlock: 1, owner: burner.pub } as any,
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: 1 } as any,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, burner.priv, burner.hex);
    const txJson = txToJson(tx);

    const r1 = await post(heldApp, '/usernames/HeldBurn/burn', { tx: txJson });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);

    const block = await makeApplicableBlock({ height: 2 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const r2 = await post(heldApp, '/usernames/HeldBurn/burn', { tx: txJson });
    expect(r2.status).toBe(r1.status);
    expect(r2.body).toEqual(r1.body);
    expect(r2.body.expiresAtHeight).toBe(r1.body.expiresAtHeight);

    const calls = broadcastTx.mock.calls;
    const sentTx = calls[calls.length - 1]![0] as UtxoTransaction;
    const pooledBytes = Buffer.from(encodeTx(tx)).toString('hex');
    const sentBytes = Buffer.from(encodeTx(sentTx)).toString('hex');
    expect(sentBytes).toBe(pooledBytes);
    expect(computeTxId(sentTx)).toBe(computeTxId(tx));
  });
});
