import {
  labelNonce,
  seedProvenance,
  signTransaction,
  txToJson,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import {
  getKarmaBox, getKarmaBoxes, getBox as storeGetBox, insertBox as storeInsertBox } from '../../src/store/utxo.js';
import { getIdentityRecord as storeGetIdentityRecord, putIdentityRecord as storePutIdentityRecord } from '../../src/store/identity-records.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import {
  createInvite,
} from '../../src/services/invites.js';
import {
  generateKeyPair,
  computeTxId,
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
import { jsonToTx } from '../../src/routes/json-to-tx.js';
import { ClientError } from '../../src/services/client-error.js';
import { config } from '../../src/config.js';
import { MempoolFullError } from '../../src/store/mempool.js';
import { unlinkSync } from 'fs';
import { extractDeclaration } from '../unit/extract-declaration.js';

const TEST_DB = '/tmp/dagsocial-test-routes-invites.sqlite';

const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

interface UiBuilders {
  jsonBigint: (key: string, value: unknown) => unknown;
  buildCreateInviteTx: (
    karmaBox: { total: bigint; boxes: Array<{ boxId: string; value: bigint }> },
    pubKeyHex: string,
    inviteePubKeyHex: string,
  ) => Record<string, unknown>;
}

/**
 * The page's one invite builder and its bigint replacer, lifted by name from
 * `public/index.html` — the same extraction the crypto mirrors use.
 *
 * Lifted rather than restated: a builder copied into a test asserts agreement
 * between the test and itself, and the page is served statically with no
 * bundler, so nothing else ties the two together. The page is the only producer
 * of these three shapes.
 */
function loadUiBuilders(): UiBuilders {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const lift = (header: string): string => extractDeclaration(html, header, 'index.html');
  return new Function(
    [
      'let currentBlockHeight = 0;',
      lift('const PROTOCOL_VERSION ='),
      lift('let INVITE_BOND_DEFAULT ='),
      lift('function jsonBigint('),
      lift('function selectBoxes('),
      lift('function buildCreateInviteTx('),
      'return { jsonBigint, buildCreateInviteTx };',
    ].join('\n\n'),
  )() as UiBuilders;
}

const ui = loadUiBuilders();

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
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
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
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);
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
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
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
  // The bodies the demo UI's three invite buttons actually send.
  //
  // ⚠ A builder that emits a shape these routes reject is invisible to every
  // test above: each of them constructs its own transaction, so it asserts the
  // route against itself. Only a lifted builder makes the page the subject.
  // ---------------------------------------------------------------------------

  describe('the page builders, lifted from index.html', () => {
    /** `fetchKarmaBox()`'s return shape, over boxes that are really in the store. */
    const karmaState = (...boxes: KarmaBox[]) => ({
      total: boxes.reduce((sum, b) => sum + b.value, 0n),
      boxes: boxes.map((b) => ({ boxId: b.id!, value: b.value })),
    });

    /**
     * Serialize as the page does — through its own bigint replacer — then sign
     * the txId the node derives from the decoded result. That the page's own
     * `computeTxId` agrees on that hash is pinned in `ui-crypto-mirror`; here
     * the subject is the body, so the signature is taken as given.
     */
    function signedBody(
      uiTx: Record<string, unknown>,
      priv: ReturnType<typeof createPrivateKey>,
      pubHex: string,
    ): Record<string, unknown> {
      const wire = JSON.parse(JSON.stringify(uiTx, ui.jsonBigint)) as Record<string, unknown>;
      const sig = cryptoSign(null, Buffer.from(computeTxId(jsonToTx(wire)), 'hex'), priv);
      return { ...wire, signatures: { [pubHex]: Buffer.from(sig).toString('hex') } };
    }

    function inviteeKeys(): { pub: Uint8Array; hex: string; priv: KeyObject } {
      const kp = generateKeyPair();
      return {
        pub: kp.publicKey,
        hex: Buffer.from(kp.publicKey).toString('hex'),
        priv: createPrivateKey({
          key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8',
        }),
      };
    }

    it('POST /invites accepts what the Create Invite button sends', async () => {
      // Funded with bond + mint, so the two readings are distinguishable: a
      // builder deducting both leaves a zero change output — which still
      // balances, and so would still be accepted here. The change assertion
      // below is what separates them.
      const funded = FIXTURE_BOND_KARMA * 2n;
      const karma = seedKarma(funded, labelNonce('ui-create'));
      const invitee = inviteeKeys();

      const body = signedBody(
        ui.buildCreateInviteTx(karmaState(karma), inviterPubKeyHex, invitee.hex),
        inviterPrivKeyObj,
        inviterPubKeyHex,
      );

      const res = await request('/', 'POST', { tx: body });
      expect(res.status, JSON.stringify(res.data)).toBe(201);
      const data = res.data as Record<string, unknown>;
      expect(data.status).toBe('pending');
      expect(typeof data.bondBoxId).toBe('string');
      expect(data.inviteBoxId).toBeUndefined();

      // ⛔ **Two outputs, not three.** The page must build `karma + bond` and
      // nothing else: an invite box is not a type any more, so a builder still
      // emitting one is refused at the output schema.
      const outputs = jsonToTx(body).outputs as [KarmaBox, BondBox];
      expect(outputs).toHaveLength(2);
      const [change, bond] = outputs;
      expect(change.value).toBe(funded - FIXTURE_BOND_KARMA);
      expect(bond.boxType).toBe('bond');
      expect(bond.value).toBe(FIXTURE_BOND_KARMA);
    });

  });

  // ---------------------------------------------------------------------------
  // NODE_INTERFACE → "Route error policy". These routes answer with the bare
  // `{ error: <message> }` shape, so the assertions below read `error`.
  // ---------------------------------------------------------------------------

  describe('error policy', () => {
    const SECRET = 'SQLITE_BUSY: database is locked at /srv/dagsocial.db';
    const EMPTY_TX = { inputs: [], outputs: [], signatures: {}, protocolVersion: 1 };

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
      const res = await request('/', 'POST', { tx: { outputs: [{ value: -1 }] } });

      expect(res.status).toBe(400);
      expect(String((res.data as Record<string, unknown>).error)).toContain(
        'box value must be a non-negative bigint',
      );
    });
  });
});
