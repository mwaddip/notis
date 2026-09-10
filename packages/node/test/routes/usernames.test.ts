// NODE_INTERFACE → Usernames — the four routes
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { generateKeyPairSync } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertBox, getBox as storeGetBox, getKarmaBox, getKarmaValue, getBoxProvenance, hasActiveVouchEscrow } from '../../src/store/utxo.js';
import { getVouchBox } from '../../src/store/vouch-queries.js';
import { getIdentityRecord, putIdentityRecord, getNetworkRecord } from '../../src/store/identity-records.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { getUsername, getUsernameByOwner, putUsername } from '../../src/store/usernames.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
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
import { rawPublicKey, seedProvenance, signTransaction, txToJson } from '../helpers.js';
import { config } from '../../src/config.js';
import { beginBlockJournal, finishBlockJournal } from '../../src/store/journal.js';

const TEST_DB = '/tmp/dagsocial-test-routes-usernames.sqlite';

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
    getKarmaBox,
    getKarmaValue,
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
    try { require('fs').unlinkSync(TEST_DB); } catch {}
    initDb(TEST_DB);
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
    try { require('fs').unlinkSync(TEST_DB); } catch {}
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
    beginBlockJournal(1);
    putUsername({ nameLower: 'alice', name: 'Alice', owner: holder.hex, boxId: 'aa'.repeat(32), claimedAtBlock: 1 });
    finishBlockJournal();

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
    beginBlockJournal(10);
    putUsername({ nameLower: 'namea', name: 'NameA', owner: burnHolder.hex, boxId: boxA.id!, claimedAtBlock: 10 });
    finishBlockJournal();
    // Seed NameB under a different owner so the UNIQUE constraint is not hit
    const burnHolder2 = makeKeys();
    beginBlockJournal(11);
    putUsername({ nameLower: 'nameb', name: 'NameB', owner: burnHolder2.hex, boxId: boxB.id!, claimedAtBlock: 11 });
    finishBlockJournal();

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
});
