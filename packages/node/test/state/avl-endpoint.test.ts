import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fixtureProvenance } from '../helpers.js';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createAvlProver, applyBlockMutations, checkpointProver } from '../../src/state/avl-prover.js';
import { registerProofEndpoint } from '../../src/state/avl-endpoint.js';

/** An identity-record AVL key. Not a box id, and not distinguishable as one. */
const RECORD_KEY = 'cc'.repeat(32);

describe('GET /api/v1/proof/:boxId', () => {
  let app: express.Express;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE avl_tree_versions (version BLOB PRIMARY KEY, height INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (version BLOB NOT NULL REFERENCES avl_tree_versions(version), label BLOB NOT NULL, node_data BLOB NOT NULL, PRIMARY KEY (version, label));
    `);

    const handle = createAvlProver(db);

    // Create a box at height 1
    // Caller-chosen id: this suite queries the proof endpoint BY box id, so the
    // key has to be known in advance. `txId`/`index` are real regardless — they
    // ride the AVL value, and a fixture without them serializes to leaf bytes
    // no production box could produce.
    const candidate = {
      boxType: 'karma' as const,
      value: 100n,
      owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature' as const,
    };
    const box = {
      id: 'aa'.repeat(32),
      ...candidate,
      ...fixtureProvenance(candidate, 1),
    };
    // One tree holds both entity kinds, so the fixture does too.
    applyBlockMutations(handle.prover, 1, [], [box], [
      { key: RECORD_KEY, record: { lastActivityBlock: 7, lastDecayBlock: 3, likeCarry: 0n, invitedAtBlock: 0, lifetimeLikesReceived: 0n } },
    ]);
    checkpointProver(handle, 1);

    app = express();
    app.use(express.json());
    registerProofEndpoint(app, handle);
  });

  afterEach(() => { db.close(); });

  it('returns box data for an existing box at current tip', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + 'aa'.repeat(32))
      .expect(200);

    expect(res.body.boxId).toBe('aa'.repeat(32));
    expect(res.body.atHeight).toBe(1);
    expect(res.body.value).not.toBeNull();
    expect(res.body.value.boxType).toBe('karma');
    expect(res.body.kind).toBe('box');
    expect(res.body.proof).toBeTruthy(); // base64 proof
    expect(res.body.stateRoot).toBeTruthy(); // hex state root
  });

  it('returns value=null for a non-existent box', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + 'bb'.repeat(32))
      .expect(200);

    expect(res.body.value).toBeNull();
    expect(res.body.kind).toBeNull();
    expect(res.body.proof).toBeTruthy(); // exclusion proof still returned
  });

  // --- Two entity kinds -----------------------------------------------------

  it('serves an identity record instead of throwing on it', async () => {
    // NODE_INTERFACE → "Two entity kinds". Keys are indistinguishable from
    // outside — both kinds are 32 bytes of hash output — so a client asking for
    // a record key is reachable, and an endpoint that decoded every value as a
    // box would 500 on committed state it is required to serve.
    const res = await request(app)
      .get('/api/v1/proof/' + RECORD_KEY)
      .expect(200);

    expect(res.body.kind).toBe('record');
    // `likeCarry` and `lifetimeLikesReceived` ride JSON as decimal strings — the
    // same discipline as box
    // `value`; JSON.stringify throws on bigint.
    expect(res.body.value).toEqual({ lastActivityBlock: 7, lastDecayBlock: 3, likeCarry: '0', invitedAtBlock: 0, lifetimeLikesReceived: '0' });
    expect(res.body.proof).toBeTruthy();
    expect(res.body.stateRoot).toBeTruthy();
  });

  it('does not present a record as a box', async () => {
    // A record served under a box-shaped response would be worse than the 500:
    // a light client would verify the proof, read `boxType: undefined`, and
    // treat committed state as a malformed box rather than another entity.
    const res = await request(app)
      .get('/api/v1/proof/' + RECORD_KEY)
      .expect(200);

    expect(res.body.value.boxType).toBeUndefined();
    expect(res.body.kind).not.toBe('box');
  });

  it('a record answer is still a proof at the same stateRoot as a box answer', async () => {
    // Both kinds share one tree and one digest; the endpoint must not serve
    // records from some side channel.
    const boxRes = await request(app).get('/api/v1/proof/' + 'aa'.repeat(32)).expect(200);
    const recRes = await request(app).get('/api/v1/proof/' + RECORD_KEY).expect(200);

    expect(recRes.body.stateRoot).toBe(boxRes.body.stateRoot);
    expect(recRes.body.atHeight).toBe(boxRes.body.atHeight);
  });

  it('serves a record from a historical version too', async () => {
    // The historical answer is built by a separate branch from the at-tip one,
    // with its own `decodeValue` call, so covering the tip proves nothing here.
    const handle = createAvlProver(db);
    applyBlockMutations(handle.prover, 2, [], [], [
      { key: RECORD_KEY, record: { lastActivityBlock: 9, lastDecayBlock: 9, likeCarry: 0n, invitedAtBlock: 0, lifetimeLikesReceived: 0n } },
    ]);
    checkpointProver(handle, 2);

    const app2 = express();
    app2.use(express.json());
    registerProofEndpoint(app2, handle);

    const atTip = await request(app2).get('/api/v1/proof/' + RECORD_KEY).expect(200);
    expect(atTip.body.value).toEqual({ lastActivityBlock: 9, lastDecayBlock: 9, likeCarry: '0', invitedAtBlock: 0, lifetimeLikesReceived: '0' });

    const historical = await request(app2)
      .get('/api/v1/proof/' + RECORD_KEY + '?atHeight=1')
      .expect(200);
    expect(historical.body.kind).toBe('record');
    expect(historical.body.value).toEqual({ lastActivityBlock: 7, lastDecayBlock: 3, likeCarry: '0', invitedAtBlock: 0, lifetimeLikesReceived: '0' });
  });

  it('returns 400 for invalid boxId length', async () => {
    await request(app)
      .get('/api/v1/proof/abc')
      .expect(400);
  });

  it('returns 404 for unavailable height', async () => {
    await request(app)
      .get('/api/v1/proof/' + 'aa'.repeat(32) + '?atHeight=999')
      .expect(404);
  });
});
