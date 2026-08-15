import {
  fixtureProvenance,
  labelNonce,
  seedAsOneTx,
  seedProvenance,
  signTransaction,
  txToJson,
} from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createPrivateKey, sign as cryptoSign, type KeyObject } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import {
  getKarmaBox, getKarmaBoxes, getBox as storeGetBox, insertBox as storeInsertBox } from '../../src/store/utxo.js';
import { getIdentityRecord as storeGetIdentityRecord } from '../../src/store/identity-records.js';
import { hasActiveVouchCooldown as storeHasActiveVouchCooldown } from '../../src/store/vouch-cooldowns.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import {
  createInvite,
  claimInvite,
  cancelInvite,
} from '../../src/services/invites.js';
import {
  generateKeyPair,
  computeBoxId,
  computeTxId,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  CandidateOf,
  InviteBox,
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
  buildClaimInviteTx: (
    inviteBoxId: string,
    inviteePubKeyHex: string,
  ) => Record<string, unknown>;
  buildCancelInviteTx: (inviteBoxId: string) => Record<string, unknown>;
}

/**
 * The page's three invite builders and its bigint replacer, lifted by name from
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
      lift('const PROTOCOL_VERSION ='),
      lift('const INVITE_KARMA_AMOUNT ='),
      lift('const INVITE_BOND_KARMA ='),
      lift('function jsonBigint('),
      lift('function selectBoxes('),
      lift('function buildCreateInviteTx('),
      lift('function buildClaimInviteTx('),
      lift('function buildCancelInviteTx('),
      'return { jsonBigint, buildCreateInviteTx, buildClaimInviteTx, buildCancelInviteTx };',
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
      hasActiveVouchCooldown: storeHasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => { (db.transaction(fn) as () => void)(); },
      createInvite,
      claimInvite,
      cancelInvite,
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

    inviterKp = generateKeyPair();
    inviterId = inviterKp.publicKey;
    inviterPubKeyHex = Buffer.from(inviterId).toString('hex');
    inviterPrivKeyObj = createPrivateKey({
      key: Buffer.from(inviterKp.secretKey),
      format: 'der',
      type: 'pkcs8',
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
      owner: inviterId,
      guard: 'owner_signature',
    }, 1, nonce);
    storeInsertBox(karma);
    return karma;
  }

  /** Seed an invite and its bond as the two outputs of one transaction. */
  function seedPair(label: string, invitee: Uint8Array): { invite: InviteBox; bond: BondBox } {
    const inviteCandidate = {
      boxType: 'invite' as const,
      value: 0n,
      inviterId,
      inviteePublicKey: invitee,
      guard: 'invite_dual' as const,
    };
    const bondCandidate = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteePublicKey: invitee,
      guard: 'block_apply' as const,
    };
    const [invite, bond] = seedAsOneTx([inviteCandidate, bondCandidate], 1, labelNonce(label));
    storeInsertBox(invite!);
    storeInsertBox(bond!);
    return { invite: invite as InviteBox, bond: bond as BondBox };
  }

  it('POST /invites creates invite and returns 201 with pending', async () => {
    const karma = seedKarma(100n, 1);
    const invitee = generateKeyPair().publicKey;

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n - INVITE_BOND_KARMA,
      owner: inviterId,
      guard: 'owner_signature',
    };
    const inviteBox: CandidateOf<InviteBox> = {
      boxType: 'invite',
      value: 0n,
      inviterId,
      inviteePublicKey: invitee,
      guard: 'invite_dual',
    };
    const bondBox: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteePublicKey: invitee,
      guard: 'block_apply',
    };

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [newKarma, inviteBox, bondBox],
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
    expect(typeof body.inviteBoxId).toBe('string');
    expect(typeof body.bondBoxId).toBe('string');
    // No secret in any of it — the response carries nothing the inviter has to
    // pass on out of band beyond what they already knew.
    expect(body.secretHash).toBeUndefined();
  });

  it('POST /invites with missing tx returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /invites/commit is gone', async () => {
    // The route died with the instrument it served: two steps, not three.
    const res = await request('/commit', 'POST', { tx: {} });
    expect(res.status).toBe(404);
  });

  it('POST /invites/claim claims an invite and returns 201 with pending', async () => {
    const inviteeKp = generateKeyPair();
    const inviteeHex = Buffer.from(inviteeKp.publicKey).toString('hex');
    const inviteePriv = createPrivateKey({
      key: Buffer.from(inviteeKp.secretKey), format: 'der', type: 'pkcs8',
    });
    const { invite } = seedPair('route-claim', inviteeKp.publicKey);

    const tx: UtxoTransaction = {
      inputs: [invite.id!],
      outputs: [{
        boxType: 'karma',
        value: INVITE_KARMA_AMOUNT,
        owner: inviteeKp.publicKey,
        guard: 'owner_signature',
      } as CandidateOf<KarmaBox>],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePriv, inviteeHex);

    const res = await request('/claim', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(body.userId).toBe(inviteeHex);
    expect(typeof body.karmaBoxId).toBe('string');
  });

  it('POST /invites/cancel cancels an open invite and returns 200 with pending', async () => {
    const invitee = generateKeyPair().publicKey;
    const { invite } = seedPair('route-cancel', invitee);

    const tx: UtxoTransaction = {
      inputs: [invite.id!],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKeyObj, inviterPubKeyHex);

    const res = await request('/cancel', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
  });

  it('POST /invites/cancel with the wrong signer returns 403', async () => {
    const inviteeKp = generateKeyPair();
    const inviteeHex = Buffer.from(inviteeKp.publicKey).toString('hex');
    const inviteePriv = createPrivateKey({
      key: Buffer.from(inviteeKp.secretKey), format: 'der', type: 'pkcs8',
    });
    const { invite } = seedPair('route-cancel-403', inviteeKp.publicKey);

    const tx: UtxoTransaction = {
      inputs: [invite.id!],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePriv, inviteeHex);

    const res = await request('/cancel', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(403);
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
      const funded = INVITE_BOND_KARMA + INVITE_KARMA_AMOUNT;
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
      expect(typeof data.inviteBoxId).toBe('string');
      expect(typeof data.bondBoxId).toBe('string');

      const [change, invite, bond] = jsonToTx(body).outputs as [KarmaBox, InviteBox, BondBox];
      expect(change.value).toBe(funded - INVITE_BOND_KARMA);
      expect(invite.value).toBe(0n);
      expect(bond.value).toBe(INVITE_BOND_KARMA);
    });

    it('POST /invites/claim accepts what the Claim button sends', async () => {
      const invitee = inviteeKeys();
      const { invite } = seedPair('ui-claim', invitee.pub);

      const body = signedBody(
        ui.buildClaimInviteTx(invite.id!, invitee.hex),
        invitee.priv,
        invitee.hex,
      );

      const res = await request('/claim', 'POST', { tx: body });
      expect(res.status, JSON.stringify(res.data)).toBe(201);
      const data = res.data as Record<string, unknown>;
      expect(data.status).toBe('pending');
      // The mint landed on the invitee, and the surplus was admitted: the
      // InviteBox held 0 and the karma output holds INVITE_KARMA_AMOUNT.
      expect(data.userId).toBe(invitee.hex);
      const [minted] = jsonToTx(body).outputs as [KarmaBox];
      expect(minted.value).toBe(INVITE_KARMA_AMOUNT);
    });

    it('POST /invites/cancel accepts what the Cancel button sends', async () => {
      const invitee = inviteeKeys();
      const { invite } = seedPair('ui-cancel', invitee.pub);

      const body = signedBody(
        ui.buildCancelInviteTx(invite.id!),
        inviterPrivKeyObj,
        inviterPubKeyHex,
      );

      const res = await request('/cancel', 'POST', { tx: body });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect((res.data as Record<string, unknown>).status).toBe('pending');
      // Zero outputs is the shape — the bond is neither named nor spent here.
      expect(jsonToTx(body).outputs).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // NODE_INTERFACE → Route error policy. These routes answer with the bare
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
      const res = await request('/cancel', 'POST', { tx: EMPTY_TX }, {
        cancelInvite: () => {
          throw new ClientError('not the inviter', 403);
        },
      });

      expect(res.status).toBe(403);
      expect((res.data as Record<string, unknown>).error).toBe('not the inviter');
    });

    it('maps a full mempool to 503 with a generic body', async () => {
      const res = await request('/claim', 'POST', { tx: EMPTY_TX }, {
        claimInvite: () => {
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
