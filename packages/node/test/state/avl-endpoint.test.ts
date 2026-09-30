import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openAvlDb, seedProvenance, uid } from '../helpers.js';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import {
  INDEX_MARKER,
  LIKE_MARKER,
  boxKey,
  boxRecordBytes,
  bytesToHex,
  castCountBytes,
  castCountKey,
  hexToBytes,
  holderKey,
  holderRecordBytes,
  identityKey,
  identityRecordBytes,
  karmaOfKey,
  likeKey,
  nameKey,
  nameRecordBytes,
  networkKey,
  networkRecordBytes,
  postKey,
  postRecordBytes,
  vouchPairKey,
  vouchPairValue,
} from '@dagsocial/types';
import type { IdentityRecord, KarmaBox } from '@dagsocial/types';
import type { TreeWrite } from '@dagsocial/consensus';
import { createAvlProver, performTreeWrites, checkpointProver } from '../../src/state/avl-prover.js';
import { registerProofEndpoint } from '../../src/state/avl-endpoint.js';

const identityId = uid('avl-endpoint/identity');
const owner = new Uint8Array(32).fill(0xaa);
const box = seedProvenance<KarmaBox>({ boxType: 'karma', value: 100n, createdAtBlock: 0, owner }, 1);

/** The box's tree key and an identity record's — both 130 hex, told apart only by their tag. */
const BOX_KEY = bytesToHex(boxKey(hexToBytes(box.id)));
const RECORD_KEY = bytesToHex(identityKey(identityId));
/** A box key the tree does not hold. */
const ABSENT_KEY = bytesToHex(boxKey(new Uint8Array(32).fill(0xbb)));

const record = (lastActivityBlock: number, lastDecayBlock: number): IdentityRecord => ({
  lastActivityBlock, lastDecayBlock, invitedAtBlock: 0, lifetimeLikesReceived: 0n,
  memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
});
const recordJson = (lastActivityBlock: number, lastDecayBlock: number) => ({
  lastActivityBlock, lastDecayBlock, invitedAtBlock: 0, lifetimeLikesReceived: '0',
  memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: '0', invitesUsed: 0,
});
const putRecord = (r: IdentityRecord): TreeWrite =>
  ({ tag: 'InsertOrUpdate', key: identityKey(identityId), value: identityRecordBytes(r) });

describe('GET /api/v1/proof/:key', () => {
  let app: express.Express;
  let db: Database.Database;

  beforeEach(() => {
    db = openAvlDb();

    const handle = createAvlProver(db);

    // One tree holds every entity kind, so the fixture holds a box and a record.
    performTreeWrites(handle.prover, 1, [
      { tag: 'Insert', key: boxKey(hexToBytes(box.id)), value: boxRecordBytes(box, box.txId, box.index) },
      putRecord(record(7, 3)),
    ], 'test');
    checkpointProver(handle, 1);

    app = express();
    app.use(express.json());
    registerProofEndpoint(app, handle);
  });

  afterEach(() => { db.close(); });

  it('returns box data for an existing box at current tip, echoing the key', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + BOX_KEY)
      .expect(200);

    expect(res.body.key).toBe(BOX_KEY);
    expect(res.body.atHeight).toBe(1);
    expect(res.body.value).not.toBeNull();
    expect(res.body.value.boxType).toBe('karma');
    expect(res.body.value.id).toBe(box.id);
    expect(res.body.kind).toBe('box');
    expect(res.body.proof).toBeTruthy(); // base64 proof
    expect(res.body.stateRoot).toBeTruthy(); // hex state root
  });

  it('returns value=null for a non-existent box', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + ABSENT_KEY)
      .expect(200);

    expect(res.body.value).toBeNull();
    expect(res.body.kind).toBeNull();
    expect(res.body.proof).toBeTruthy(); // exclusion proof still returned
  });

  // --- Every entity kind -----------------------------------------------------

  it('serves an identity record instead of throwing on it', async () => {
    // NODE_INTERFACE → Entity kinds. Every kind shares one key width, so a
    // client asking for a record key is reachable, and an endpoint that decoded
    // every value as a box would 500 on committed state it is required to serve.
    const res = await request(app)
      .get('/api/v1/proof/' + RECORD_KEY)
      .expect(200);

    expect(res.body.kind).toBe('record');
    // `lifetimeLikesReceived` rides JSON as a decimal string — the same
    // discipline as box `value`; JSON.stringify throws on bigint.
    expect(res.body.value).toEqual(recordJson(7, 3));
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
    const boxRes = await request(app).get('/api/v1/proof/' + BOX_KEY).expect(200);
    const recRes = await request(app).get('/api/v1/proof/' + RECORD_KEY).expect(200);

    expect(recRes.body.stateRoot).toBe(boxRes.body.stateRoot);
    expect(recRes.body.atHeight).toBe(boxRes.body.atHeight);
  });

  it('decodes every kind the layout adds by its first byte', async () => {
    const handle = createAvlProver(db);
    const [postId, liker, voucher, target] = ['post', 'liker', 'voucher', 'target']
      .map((label) => uid(`avl-endpoint/${label}`)) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    const nameBoxId = 'cd'.repeat(32);
    const writes: Array<[string, TreeWrite]> = [
      ['network', { tag: 'Insert', key: networkKey(), value: networkRecordBytes({ memberCount: 4 }) }],
      ['username', { tag: 'Insert', key: nameKey(new TextEncoder().encode('alice')), value: nameRecordBytes({ boxId: nameBoxId, claimedAtBlock: 2 }) }],
      ['holder', { tag: 'Insert', key: holderKey(identityId), value: holderRecordBytes({ claimAvailable: false, boxId: nameBoxId }) }],
      ['post', { tag: 'Insert', key: postKey(postId), value: postRecordBytes({ author: identityId, height: 2, standing: 'withdrawn' }) }],
      ['like', { tag: 'Insert', key: likeKey(postId, liker), value: Uint8Array.from(LIKE_MARKER) }],
      ['marker', { tag: 'Insert', key: karmaOfKey(owner, hexToBytes(box.id)), value: Uint8Array.from(INDEX_MARKER) }],
      ['pair', { tag: 'Insert', key: vouchPairKey(voucher, target), value: vouchPairValue(hexToBytes(nameBoxId)) }],
      ['count', { tag: 'Insert', key: castCountKey(voucher), value: castCountBytes(3) }],
    ];
    performTreeWrites(handle.prover, 2, writes.map(([, w]) => w), 'test');
    checkpointProver(handle, 2);
    const app2 = express();
    registerProofEndpoint(app2, handle);

    const served = async (write: TreeWrite) =>
      (await request(app2).get('/api/v1/proof/' + bytesToHex(write.key)).expect(200)).body;
    const at = (name: string) => writes.find(([n]) => n === name)![1];

    expect(await served(at('network'))).toMatchObject({ kind: 'network', value: { memberCount: 4 } });
    expect(await served(at('username'))).toMatchObject({ kind: 'username', value: { boxId: nameBoxId, claimedAtBlock: 2 } });
    expect(await served(at('holder'))).toMatchObject({ kind: 'holder', value: { claimAvailable: false, boxId: nameBoxId } });
    expect(await served(at('post'))).toMatchObject({ kind: 'post', value: { height: 2, standing: 'withdrawn' } });
    expect(await served(at('like'))).toMatchObject({ kind: 'like', value: {} });
    expect(await served(at('marker'))).toMatchObject({ kind: 'index', value: {} });
    expect(await served(at('pair'))).toMatchObject({ kind: 'index', value: { boxId: nameBoxId } });
    expect(await served(at('count'))).toMatchObject({ kind: 'index', value: { count: 3 } });
  });

  it('serves a record from a historical version too', async () => {
    // The historical answer is built by a separate branch from the at-tip one,
    // so covering the tip proves nothing here.
    const handle = createAvlProver(db);
    performTreeWrites(handle.prover, 2, [putRecord(record(9, 9))], 'test');
    checkpointProver(handle, 2);

    const app2 = express();
    app2.use(express.json());
    registerProofEndpoint(app2, handle);

    const atTip = await request(app2).get('/api/v1/proof/' + RECORD_KEY).expect(200);
    expect(atTip.body.value).toEqual(recordJson(9, 9));

    const historical = await request(app2)
      .get('/api/v1/proof/' + RECORD_KEY + '?atHeight=1')
      .expect(200);
    expect(historical.body.kind).toBe('record');
    expect(historical.body.value).toEqual(recordJson(7, 3));
  });

  // --- S4: the historical window restores under `finally` --------------------

  it('restores the prover to the live digest after a throw in the historical window', async () => {
    // NODE_INTERFACE → "The historical window restores under finally".
    // A throw between rollback(version) and rollback(currentVersion) must not
    // strand the shared prover at the historical digest.
    const handle = createAvlProver(db);
    performTreeWrites(handle.prover, 2, [putRecord(record(9, 9))], 'test');
    checkpointProver(handle, 2);

    const liveDigest = bytesToHex(handle.prover.digest());

    // Wrap performOneOperation to throw once on the historical path
    const original = handle.prover.performOneOperation.bind(handle.prover);
    let threw = false;
    handle.prover.performOneOperation = (op: Parameters<typeof handle.prover.performOneOperation>[0]) => {
      const historicalDigest = bytesToHex(handle.prover.digest());
      if (historicalDigest !== liveDigest && !threw) {
        threw = true;
        throw new Error('injected failure in historical window');
      }
      return original(op);
    };

    const app2 = express();
    app2.use(express.json());
    registerProofEndpoint(app2, handle);

    const res = await request(app2)
      .get('/api/v1/proof/' + BOX_KEY + '?atHeight=1')
      .expect(500);
    expect(res.body.error).toBe('internal error');
    expect(threw).toBe(true);

    // The prover must be back at the live digest
    expect(bytesToHex(handle.prover.digest())).toBe(liveDigest);

    // A subsequent proof at the live tip must still work
    handle.prover.performOneOperation = original;
    const tipRes = await request(app2)
      .get('/api/v1/proof/' + BOX_KEY)
      .expect(200);
    expect(tipRes.body.kind).toBe('box');
  });

  it('returns 400 for a key that is not hex of the tree key width', async () => {
    await request(app)
      .get('/api/v1/proof/abc')
      .expect(400);
  });

  it('returns 400 for a 64-hex key — a box id is not a tree key', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + box.id)
      .expect(400);
    expect(res.body.error).toMatch(/130 hex/);
  });

  it('returns 404 for unavailable height', async () => {
    await request(app)
      .get('/api/v1/proof/' + BOX_KEY + '?atHeight=999')
      .expect(404);
  });
});
