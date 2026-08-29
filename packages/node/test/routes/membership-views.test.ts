// ---------------------------------------------------------------------------
// Membership views through the live routes — NODE_INTERFACE → UTXO queries,
// NODE_INTERFACE → Status, NODE_INTERFACE → Vouches, NODE_INTERFACE →
// Invites, NODE_INTERFACE → Three entity kinds.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import {
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  VOUCH_KARMA_AMOUNT,
  PROTOCOL_VERSION,
  membershipBar,
  memberLikesBar,
} from '@dagsocial/types';
import type {
  AnyBox,
  CandidateOf,
  KarmaBox,
  VouchBox,
  UtxoTransaction,
} from '@dagsocial/types';
import {
  initDb,
  closeDb,
  getDb,
  getKarmaBox,
  getKarmaBoxes,
  getBox as storeGetBox,
  getKarmaTotal,
  getKarmaBoxesPage,
  getCreditValue,
  getCreditBoxesPage,
  getBondBoxesPage,
  insertBox,
  consumeBox,
  getIdentityRecord,
  putIdentityRecord,
  hasActiveVouchEscrow,
  getVouchBox,
  getNetworkRecord,
  getKarmaValue,
} from '../../src/store/index.js';
import { getBoxWithPending } from '../../src/store/mempool.js';
import { createRouter as utxoRoutes } from '../../src/routes/utxo.js';
import { createRouter as blockRoutes } from '../../src/routes/blocks.js';
import { createRouter as vouchRoutes } from '../../src/routes/vouches.js';
import { createRouter as inviteRoutes } from '../../src/routes/invites.js';
import { castVouch, initiateUnvouch } from '../../src/services/vouch.js';
import { createInvite } from '../../src/services/invites.js';
import { registerProofEndpoint } from '../../src/state/avl-endpoint.js';
import {
  createAvlProver,
} from '../../src/state/avl-prover.js';
import {
  serializeNetworkRecord,
} from '../../src/state/serialize-box.js';
import { networkRecordKey } from '../../src/store/identity-records.js';
import {
  rawPublicKey,
  seedProvenance,
  signTransaction,
  txToJson,
} from '../helpers.js';
import { config } from '../../src/config.js';
import type Database from 'better-sqlite3';

const DECAY_CFG = {
  staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
  decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
  decayAmount: KARMA_DECAY_AMOUNT,
  karmaMinimum: KARMA_MINIMUM,
};

const HEIGHT = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = rawPublicKey(publicKey);
  return { pub, hex: Buffer.from(pub).toString('hex'), priv: privateKey };
}

function seedKarma(owner: Uint8Array, value: bigint, nonce = 0) {
  const box = seedProvenance<KarmaBox>(
    { boxType: 'karma' as const, value, createdAtBlock: 0, owner },
    1, nonce,
  );
  insertBox(box);
  return box;
}

// ---------------------------------------------------------------------------
// /karma/:userId — the seven membership fields
// ---------------------------------------------------------------------------

describe('/karma/:userId membership fields', () => {
  let db: Database.Database;
  let resident: { pub: Uint8Array; hex: string };
  let member: { pub: Uint8Array; hex: string };
  let root: { pub: Uint8Array; hex: string };
  let lapsed: { pub: Uint8Array; hex: string };

  function karmaRequest(path: string): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve) => {
      const deps = {
        getKarmaTotal,
        getKarmaBoxesPage,
        getIdentityRecord,
        getCreditValue,
        getCreditBoxesPage,
        getBondBoxesPage,
        getCurrentHeight: () => HEIGHT,
        decayCfg: DECAY_CFG,
        getNetworkRecord,
        membershipBarMultiplier: config.membershipBarMultiplier,
        getUtxoEngineDeps: () => ({
          getBox: getBoxWithPending,
          insertBox,
          consumeBox,
          getKarmaBox,
          getKarmaValue,
          hasActiveVouchEscrow,
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
          getNetworkRecord,
          membershipBarMultiplier: config.membershipBarMultiplier,
          putIdentityRecord: () => {},
        }),
      };
      const app = express();
      app.use(express.json());
      app.use(utxoRoutes(deps));
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        http.get(
          { hostname: 'localhost', port: addr.port, path },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              server.close();
              resolve({ status: res.statusCode!, data: JSON.parse(d) });
            });
          },
        );
      });
    });
  }

  beforeAll(() => {
    initDb(':memory:');
    db = getDb();
    db.prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 2)').run();

    // Resident: has a record, not a member
    resident = makeKeys();
    seedKarma(resident.pub, 100n, 1);
    putIdentityRecord(resident.pub, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 5n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });

    // Member: memberSinceBlock > 0 AND memberVouches >= memberBar
    member = makeKeys();
    seedKarma(member.pub, 100n, 2);
    putIdentityRecord(member.pub, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 10n,
      memberSinceBlock: 3, memberBar: 1, memberVouches: 3, memberLikes: 4n, invitesUsed: 1,
    });

    // Root: memberSinceBlock > 0, memberBar = 0
    root = makeKeys();
    seedKarma(root.pub, 100n, 3);
    putIdentityRecord(root.pub, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 1, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 5,
    });

    // Lapsed member: memberSinceBlock > 0 BUT memberVouches < memberBar
    lapsed = makeKeys();
    seedKarma(lapsed.pub, 100n, 4);
    putIdentityRecord(lapsed.pub, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 10n,
      memberSinceBlock: 3, memberBar: 2, memberVouches: 1, memberLikes: 4n, invitesUsed: 1,
    });
  });

  afterAll(() => closeDb());

  it('a resident: member=false, invitesAvailable=0', async () => {
    const { data } = await karmaRequest(`/karma/${resident.hex}`);
    expect(data.member).toBe(false);
    expect(data.invitesAvailable).toBe(0);
    expect(data.memberSinceBlock).toBe(0);
    expect(data.memberBar).toBe(0);
    expect(data.memberVouches).toBe(0);
    expect(data.memberLikes).toBe('0');
    expect(data.invitesUsed).toBe(0);
  });

  it('a member: member=true, invitesAvailable computed', async () => {
    const { data } = await karmaRequest(`/karma/${member.hex}`);
    expect(data.member).toBe(true);
    // With N=2, membershipBarMultiplier=1: D = max(1, icbrt(2)) = 1
    // invitesAvailable = max(0, floor(3/1) - 1) = 2
    expect(data.invitesAvailable).toBe(2);
    expect(data.memberSinceBlock).toBe(3);
    expect(data.memberBar).toBe(1);
    expect(data.memberVouches).toBe(3);
    expect(data.memberLikes).toBe('4');
    expect(data.invitesUsed).toBe(1);
  });

  it('a root: member=true, invitesAvailable=null', async () => {
    const { data } = await karmaRequest(`/karma/${root.hex}`);
    expect(data.member).toBe(true);
    expect(data.invitesAvailable).toBeNull();
    expect(data.memberSinceBlock).toBe(1);
    expect(data.memberBar).toBe(0);
  });

  it('a lapsed member: member=false, invitesAvailable=0', async () => {
    const { data } = await karmaRequest(`/karma/${lapsed.hex}`);
    expect(data.member).toBe(false);
    expect(data.invitesAvailable).toBe(0);
    expect(data.memberSinceBlock).toBe(3);
    expect(data.memberBar).toBe(2);
    expect(data.memberVouches).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// /status — inviteBondMin, inviteBondMax, membership
// ---------------------------------------------------------------------------

describe('/status membership fields', () => {
  let db: Database.Database;

  function statusRequest(): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve) => {
      const deps = {
        getOrderingBlock: () => null,
        getOrderingBlockHash: () => null,
        getCurrentHeight: () => 42,
        getPostCount: () => 10,
        getPendingPostCount: () => 2,
        getTotalKarma: () => 500n,
        getLiquidKarma: () => 400n,
        getTotalCredits: () => 100n,
        networkType: 'devnet',
        inviteProbationBlocks: 43200,
        vouchCooldownBlocks: 60,
        inviteBondMin: 5n,
        inviteBondMax: 10000n,
        getNetworkRecord: () => ({ memberCount: 4 }),
        membershipBarMultiplier: 1,
      };
      const app = express();
      app.use(express.json());
      app.use(blockRoutes(deps));
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        http.get(
          { hostname: 'localhost', port: addr.port, path: '/status' },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              server.close();
              resolve({ status: res.statusCode!, data: JSON.parse(d) });
            });
          },
        );
      });
    });
  }

  beforeAll(() => {
    initDb(':memory:');
    db = getDb();
    db.prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 4)').run();
  });

  afterAll(() => closeDb());

  it('carries inviteBondMin and inviteBondMax as decimal strings', async () => {
    const { data } = await statusRequest();
    expect(data.inviteBondMin).toBe('5');
    expect(data.inviteBondMax).toBe('10000');
  });

  it('carries membership { memberCount, memberBar, memberLikesBar }', async () => {
    const { data } = await statusRequest();
    const m = data.membership as { memberCount: number; memberBar: number; memberLikesBar: number };
    expect(m.memberCount).toBe(4);
    // D(4, 1) = max(1, icbrt(4)) = 1; Y(4, 1) = 2*1 = 2
    expect(m.memberBar).toBe(membershipBar(4, 1));
    expect(m.memberLikesBar).toBe(memberLikesBar(4, 1));
  });
});

// ---------------------------------------------------------------------------
// POST /vouches — the four 400s through the route
// ---------------------------------------------------------------------------

describe('POST /vouches — the four membership 400s', () => {
  let db: Database.Database;
  let voucher: { pub: Uint8Array; hex: string; priv: KeyObject };
  let target: { pub: Uint8Array; hex: string };

  function engineDeps() {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      insertBox: (box: AnyBox) => insertBox(box),
      consumeBox: (id: string, atBlock: number) => consumeBox(id, atBlock),
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array): bigint =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      getIdentityRecord,
      hasActiveVouchEscrow,
      vouchCooldownBlocks: 2,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      decayCfg: DECAY_CFG,
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
      getTopologyAuthor: () => null,
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
      getVouchBox,
      getNetworkRecord,
      membershipBarMultiplier: config.membershipBarMultiplier,
      putIdentityRecord: (id: Uint8Array, rec: any) => putIdentityRecord(id, rec),
    };
  }

  function vouchRequest(
    body: unknown,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve) => {
      const deps = {
        ...engineDeps(),
        castVouch,
        initiateUnvouch,
        getCurrentHeight: () => HEIGHT,
      };
      const app = express();
      app.use(express.json());
      app.use(vouchRoutes(deps));
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const payload = Buffer.from(JSON.stringify(body));
        const req = http.request(
          {
            hostname: 'localhost',
            port: addr.port,
            path: '/',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(payload.length),
            },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              server.close();
              resolve({ status: res.statusCode!, data: JSON.parse(d) });
            });
          },
        );
        req.write(payload);
        req.end();
      });
    });
  }

  function buildVouchTx(): UtxoTransaction {
    const karma = getKarmaBox(voucher.pub)!;
    const change: CandidateOf<KarmaBox> = {
      boxType: 'karma', value: karma.value - VOUCH_KARMA_AMOUNT,
      createdAtBlock: HEIGHT, owner: voucher.pub,
    };
    const vouchOut: CandidateOf<VouchBox> = {
      boxType: 'vouch', value: VOUCH_KARMA_AMOUNT,
      createdAtBlock: HEIGHT, voucherId: voucher.pub, targetId: target.pub,
    };
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [change, vouchOut],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.priv, voucher.hex);
    return tx;
  }

  beforeAll(() => {
    initDb(':memory:');
    db = getDb();
    db.prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    voucher = makeKeys();
    target = makeKeys();
  });

  afterAll(() => closeDb());

  it('not a member → 400', async () => {
    seedKarma(voucher.pub, 100n, 10);
    putIdentityRecord(voucher.pub, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    putIdentityRecord(target.pub, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });

    const tx = buildVouchTx();
    const res = await vouchRequest({ tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(String((res.data as any).reason ?? (res.data as any).error)).toMatch(/member/i);
  });

  it('target has no record → 400', async () => {
    // Make voucher a root so the member check passes
    putIdentityRecord(voucher.pub, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 1, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    // Remove target record
    db.prepare('DELETE FROM identity_records WHERE identity_id = ?').run(Buffer.from(target.pub));

    const tx = buildVouchTx();
    const res = await vouchRequest({ tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(String((res.data as any).reason ?? (res.data as any).error)).toMatch(/record/i);
  });

  it('self-vouch → 400', async () => {
    // Restore target record and make target = voucher
    putIdentityRecord(target.pub, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    // Build a self-vouch
    const change: CandidateOf<KarmaBox> = {
      boxType: 'karma', value: 99n,
      createdAtBlock: HEIGHT, owner: voucher.pub,
    };
    const selfVouch: CandidateOf<VouchBox> = {
      boxType: 'vouch', value: VOUCH_KARMA_AMOUNT,
      createdAtBlock: HEIGHT, voucherId: voucher.pub, targetId: voucher.pub,
    };
    const karma = getKarmaBox(voucher.pub)!;
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [change, selfVouch],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.priv, voucher.hex);
    const res = await vouchRequest({ tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(String((res.data as any).reason ?? (res.data as any).error)).toMatch(/yourself/i);
  });

  it('duplicate pair → 400', async () => {
    // Seed a live vouch for (voucher, target)
    const vouchBox = seedProvenance<VouchBox>(
      { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: 0,
        voucherId: voucher.pub, targetId: target.pub },
      1, 99,
    );
    insertBox(vouchBox);

    const tx = buildVouchTx();
    const res = await vouchRequest({ tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(String((res.data as any).reason ?? (res.data as any).error)).toMatch(/live vouch/i);
  });
});

// ---------------------------------------------------------------------------
// POST /invites — the membership 400
// ---------------------------------------------------------------------------

describe('POST /invites — membership 400', () => {
  let db: Database.Database;
  let inviter: { pub: Uint8Array; hex: string; priv: KeyObject };

  function inviteRequest(
    body: unknown,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve) => {
      const deps = {
        getBox: (id: string): AnyBox | null => {
          const box = storeGetBox(id);
          if (!box) return null;
          const r = db
            .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
            .get(id) as { spent_at_block: number | null } | undefined;
          return r && r.spent_at_block === null ? box : null;
        },
        insertBox: (box: AnyBox) => insertBox(box),
        consumeBox: (id: string, atBlock: number) => consumeBox(id, atBlock),
        getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
        getKarmaValue: (owner: Uint8Array): bigint =>
          getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
        getIdentityRecord,
        hasActiveVouchEscrow,
        vouchCooldownBlocks: 2,
        inviteBondMin: config.inviteBondMin,
        inviteBondMax: config.inviteBondMax,
        decayCfg: DECAY_CFG,
        storageRentPeriodBlocks: 40,
        getBoxProvenance: () => null,
        getTopologyAuthor: () => null,
        getPendingPostAuthor: () => null,
        runInTransaction: (fn: () => void) => {
          (db.transaction(fn) as () => void)();
        },
        getVouchBox,
        getNetworkRecord,
        membershipBarMultiplier: config.membershipBarMultiplier,
        putIdentityRecord: (id: Uint8Array, rec: any) => putIdentityRecord(id, rec),
        createInvite,
        getCurrentHeight: () => HEIGHT,
      };
      const app = express();
      app.use(express.json());
      app.use(inviteRoutes(deps));
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const payload = Buffer.from(JSON.stringify(body));
        const req = http.request(
          {
            hostname: 'localhost',
            port: addr.port,
            path: '/',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(payload.length),
            },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              server.close();
              resolve({ status: res.statusCode!, data: JSON.parse(d) });
            });
          },
        );
        req.write(payload);
        req.end();
      });
    });
  }

  beforeAll(() => {
    initDb(':memory:');
    db = getDb();
    db.prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    inviter = makeKeys();
    seedKarma(inviter.pub, 1000n, 20);
    // A resident — not a member or root.
    putIdentityRecord(inviter.pub, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
  });

  afterAll(() => closeDb());

  it('not a member/root → 400', async () => {
    const invitee = new Uint8Array(32).fill(0xdd);
    const karma = getKarmaBox(inviter.pub)!;
    const bondValue = config.inviteBondMin;
    const change: CandidateOf<KarmaBox> = {
      boxType: 'karma', value: karma.value - bondValue,
      createdAtBlock: HEIGHT, owner: inviter.pub,
    };
    const bond = {
      boxType: 'bond' as const, value: bondValue,
      createdAtBlock: HEIGHT,
      inviterId: inviter.pub,
      inviteePublicKey: invitee,
    };
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [change, bond],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviter.priv, inviter.hex);
    const res = await inviteRequest({ tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(String((res.data as any).reason ?? (res.data as any).error)).toMatch(/member|root/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/proof/:boxId — kind: 'network' for the network key
// ---------------------------------------------------------------------------

describe('proof endpoint — kind: network', () => {
  it('serves the network record as kind: network', async () => {
    const proofDb = new (await import('better-sqlite3')).default(':memory:');
    proofDb.pragma('journal_mode = WAL');
    proofDb.exec(`
      CREATE TABLE avl_tree_versions (version BLOB PRIMARY KEY, height INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (version BLOB NOT NULL REFERENCES avl_tree_versions(version), label BLOB NOT NULL, node_data BLOB NOT NULL, PRIMARY KEY (version, label));
    `);

    const handle = createAvlProver(proofDb);
    const nrKey = networkRecordKey();
    const nrBytes = serializeNetworkRecord({ memberCount: 42 });

    // Insert via InsertOrUpdate
    handle.prover.performOneOperation({
      tag: 'InsertOrUpdate',
      key: Buffer.from(nrKey, 'hex'),
      value: nrBytes,
    });
    handle.prover.generateProofAndUpdateStorage([
      [new Uint8Array(32), new Uint8Array([0, 0, 0, 1])],
    ]);

    const app = express();
    app.use(express.json());
    registerProofEndpoint(app, handle);

    const supertest = (await import('supertest')).default;
    const res = await supertest(app)
      .get(`/api/v1/proof/${nrKey}`)
      .expect(200);

    expect(res.body.kind).toBe('network');
    expect(res.body.value).toEqual({ memberCount: 42 });
    expect(res.body.proof).toBeTruthy();

    proofDb.close();
  });
});
