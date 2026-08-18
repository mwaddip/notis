// ---------------------------------------------------------------------------
// Vouch routes THROUGH THE JSON EDGE (NODE_INTERFACE → Vouches, "The JSON
// edge").
//
// ⚠ Service-level coverage cannot stand in for these. A test that hands
// `castVouch`/`initiateUnvouch` raw `Uint8Array` objects never touches
// `jsonToTx`, so it cannot see a `BINARY_BOX_FIELDS` entry missing for
// `voucherId`/`targetId` — over real HTTP those arrive as hex strings and die
// at `validateTx`'s step-4 `bytes32` schema. The route pair can be unreachable
// with the whole suite green; only this edge notices.
//
// The last group drives the demo UI's own builders, lifted out of
// `public/index.html` rather than restated here. The page is the only producer
// of these two transaction shapes, and a builder that emits a shape the routes
// reject is invisible to every test that constructs its own.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import Database from 'better-sqlite3';
import {
  computeBoxId,
  computeTxId,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
} from '@dagsocial/types';
import type {
  AnyBox,
  CandidateOf,
  KarmaBox,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';

import {
  fixtureProvenance,
  rawPublicKey,
  seedProvenance,
  signTransaction,
  txToJson,
  type Stored,
} from '../helpers.js';
import {
  initDb,
  closeDb,
  getDb,
  getBox as storeGetBox,
  getKarmaBox,
  getKarmaBoxes,
  insertBox,
  consumeBox,
  getIdentityRecord,
  hasActiveVouchEscrow,
} from '../../src/store/index.js';
import { castVouch, initiateUnvouch } from '../../src/services/vouch.js';

/** The cooldown this fixture's engine deps declare; the escrow's floor reads it. */
const COOLDOWN = 2;

/**
 * The `VouchEscrowBox` an unvouch outputs.
 *
 * ⚠ **`releaseAtBlock` is the producer's, constrained only by a FLOOR** — a
 * transaction cannot commit to the height of the block that will carry it, so an
 * exact pin would make every unvouch valid in exactly one block (NODE_INTERFACE →
 * Vouch transition rules). These fixtures validate at height 0, so the floor is
 * `COOLDOWN`.
 */
function unvouchEscrow(value: bigint, owner: Uint8Array) {
  return {
    boxType: 'vouch_escrow' as const,
    value,
    owner,
    // The route validates at `HEIGHT`, so the floor is `HEIGHT + COOLDOWN`.
    // Clearing it by a margin is legal because only the floor is a rule —
    // releasing late costs the voucher and nobody else.
    releaseAtBlock: HEIGHT + COOLDOWN,
  };
}
import { materializeOutput } from '../../src/services/utxo-engine.js';
import { jsonToTx } from '../../src/routes/json-to-tx.js';
import { createRouter } from '../../src/routes/vouches.js';
import { extractDeclaration } from '../unit/extract-declaration.js';

const HEIGHT = 100;

const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

interface UiBuilders {
  jsonBigint: (key: string, value: unknown) => unknown;
  buildVouchTx: (
    karmaBox: { total: bigint; boxes: Array<{ boxId: string; value: bigint }> },
    targetIdHex: string,
    pubKeyHex: string,
  ) => Record<string, unknown>;
  buildUnvouchTx: (
    vouchBoxId: string,
    stakeValue: bigint,
    pubKeyHex: string,
    releaseAtBlock: number,
  ) => Record<string, unknown>;
}

/**
 * The page's vouch builders and its bigint replacer, lifted by name from
 * `public/index.html` — the same extraction the crypto mirrors use.
 *
 * Lifted rather than restated: a builder copied into a test asserts agreement
 * between the test and itself, and the page is served statically with no
 * bundler, so nothing else ties the two together.
 */
function loadUiBuilders(): UiBuilders {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const lift = (header: string): string => extractDeclaration(html, header, 'index.html');
  return new Function(
    [
      lift('const PROTOCOL_VERSION ='),
      lift('const VOUCH_KARMA_AMOUNT ='),
      lift('function jsonBigint('),
      lift('function selectBoxes('),
      lift('function buildVouchTx('),
      lift('function buildUnvouchTx('),
      'return { jsonBigint, buildVouchTx, buildUnvouchTx };',
    ].join('\n\n'),
  )() as UiBuilders;
}

const ui = loadUiBuilders();

describe('vouch routes — the JSON edge', () => {
  let db: Database.Database;
  let voucher: { pub: Uint8Array; hex: string; priv: KeyObject };
  let target: { pub: Uint8Array; hex: string };

  function makeKeys() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = rawPublicKey(publicKey);
    return { pub, hex: Buffer.from(pub).toString('hex'), priv: privateKey };
  }

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
      // ⛔ The real predicate, not a stub. The cast gate reads escrow BOXES now
      // (NODE_INTERFACE → Vouch transition rules), so a route test that stubbed
      // it would assert the router while leaving the rule it fronts untested.
      hasActiveVouchEscrow,
      vouchCooldownBlocks: COOLDOWN,
      // No like reaches this router, so the marker's author pin has nothing to
      // resolve — stated rather than stubbed silently.
      getTopologyAuthor: () => null,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  /** Drive the real router over real HTTP, exactly as a client would. */
  async function request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve) => {
      const deps = {
        ...engineDeps(),
        castVouch,
        initiateUnvouch,
        getCurrentHeight: () => HEIGHT,
      };
      const app = express();
      app.use(express.json());
      app.use(createRouter(deps));
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        // Content-Length is set explicitly rather than left to Node. Node
        // disables chunked-encoding-by-default for DELETE (as for GET/HEAD/
        // OPTIONS), so a written body would go out with no framing header at
        // all and `express.json()` — which needs `content-length` or
        // `transfer-encoding` to believe a body exists — would hand the
        // handler `{}`, producing a "tx required" 400. A test artifact, not a
        // product defect: every real client (fetch, curl -d, axios) sets the
        // header itself.
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = http.request(
          {
            hostname: 'localhost',
            port: addr.port,
            path,
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(payload ? { 'Content-Length': String(payload.length) } : {}),
            },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              server.close();
              try {
                resolve({ status: res.statusCode!, data: JSON.parse(d) });
              } catch {
                resolve({ status: res.statusCode!, data: d });
              }
            });
          },
        );
        if (payload) req.write(payload);
        req.end();
      });
    });
  }

  function seedKarma(owner: Uint8Array, value: bigint, nonce = 0): Stored<KarmaBox> {
    const box = seedProvenance<KarmaBox>(
      {
        boxType: 'karma' as const,
        value,
        owner,
      },
      1,
      nonce,
    );
    insertBox(box);
    return box;
  }

  function seedVouchBox(
    voucherId: Uint8Array,
    targetId: Uint8Array,
    nonce = 0,
  ): Stored<VouchBox> {
    const box = seedProvenance<VouchBox>(
      {
        boxType: 'vouch' as const,
        value: VOUCH_KARMA_AMOUNT,
        voucherId,
        targetId,
      },
      1,
      nonce,
    );
    insertBox(box);
    return box;
  }

  /**
   * A signed vouch cast built with RAW BYTES — the reference construction.
   * `txToJson` then hex-encodes it into what a client actually sends.
   */
  function rawVouchCast(karmaBox: KarmaBox): UtxoTransaction {
    const change: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: karmaBox.value - VOUCH_KARMA_AMOUNT,
      owner: voucher.pub,
    };
    const vouchOut: CandidateOf<VouchBox> = {
      boxType: 'vouch' as const,
      value: VOUCH_KARMA_AMOUNT,
      voucherId: voucher.pub,
      targetId: target.pub,
    };
    const tx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [change, vouchOut],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.priv, voucher.hex);
    return tx;
  }

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    voucher = makeKeys();
    target = makeKeys();
  });

  afterEach(() => {
    closeDb();
  });

  // -------------------------------------------------------------------------
  // Cast
  // -------------------------------------------------------------------------

  it('POST /vouches accepts a JSON-built cast with hex voucherId/targetId', async () => {
    const karmaBox = seedKarma(voucher.pub, VOUCH_MIN_BALANCE + VOUCH_KARMA_AMOUNT);
    const tx = rawVouchCast(karmaBox);
    const json = txToJson(tx);

    // What actually crosses the wire: both VouchBox identity fields as hex
    // STRINGS. Before `BINARY_BOX_FIELDS` gained them this is where it died.
    const vouchJson = (json.outputs as Array<Record<string, unknown>>)[1]!;
    expect(typeof vouchJson['voucherId']).toBe('string');
    expect(typeof vouchJson['targetId']).toBe('string');
    expect(vouchJson['voucherId']).toBe(voucher.hex);
    expect(vouchJson['targetId']).toBe(target.hex);

    const res = await request('/', 'POST', { tx: json });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body['status']).toBe('pending');
    expect(body['txId']).toBe(computeTxId(tx));
    expect(body['expiresAtHeight']).toBeGreaterThan(HEIGHT);
  });

  it('id integrity: the JSON edge converts hex to bytes BEFORE the id preimage', async () => {
    // The class-4 discriminator. `canonicalBoxBytes` hashes whatever the field
    // holds, so a hex STRING and its 32 bytes produce different box ids — and
    // different tx ids. If the conversion happened after the preimage (or not
    // at all), the two constructions would disagree here while both still
    // "working" end to end. Nothing else in the suite would notice.
    const karmaBox = seedKarma(voucher.pub, VOUCH_MIN_BALANCE + VOUCH_KARMA_AMOUNT);
    const raw = rawVouchCast(karmaBox);
    const throughEdge = jsonToTx(txToJson(raw));

    expect(computeTxId(throughEdge)).toBe(computeTxId(raw));

    const txId = computeTxId(raw);
    const edgeBox = materializeOutput(throughEdge.outputs[1]!, txId, 1);
    const rawBox = materializeOutput(raw.outputs[1]!, txId, 1);
    expect(edgeBox.id).toBe(rawBox.id);

    // And the field really is bytes on the far side, not a 64-char string.
    const edgeVouch = throughEdge.outputs[1] as CandidateOf<VouchBox>;
    expect(edgeVouch.voucherId).toBeInstanceOf(Uint8Array);
    expect(edgeVouch.targetId).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(edgeVouch.voucherId).toString('hex')).toBe(voucher.hex);
    expect(Buffer.from(edgeVouch.targetId).toString('hex')).toBe(target.hex);
  });

  it('POST /vouches requires a tx — a bare identity body 400s', async () => {
    // The gate sits ahead of `jsonToTx`, so a body with no `tx` is refused
    // without a decode attempt. Naming identities rather than a transaction is
    // the shape that reaches it.
    const res = await request('/', 'POST', { userId: voucher.hex, targetId: target.hex });
    expect(res.status).toBe(400);
    expect((res.data as Record<string, unknown>)['reason']).toBe('tx required');
  });

  // -------------------------------------------------------------------------
  // Unvouch
  // -------------------------------------------------------------------------

  it('DELETE /vouches/:targetId accepts a JSON-built unvouch', async () => {
    const vouchBox = seedVouchBox(voucher.pub, target.pub);
    const tx: UtxoTransaction = {
      inputs: [vouchBox.id!],
      // ⛔ **An escrow output, not zero outputs.** The unvouch conserves now: the
      // stake moves into a `VouchEscrowBox` rather than being destroyed with a
      // node-local row remembering to re-mint it (ARCHITECTURE → Vouch boxes).
      outputs: [unvouchEscrow(vouchBox.value, voucher.pub)],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.priv, voucher.hex);

    const res = await request(`/${target.hex}`, 'DELETE', { tx: txToJson(tx) });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body['status']).toBe('pending');
    expect(body['txId']).toBe(computeTxId(tx));
    expect(body['karmaReturnsAtBlock']).toBeGreaterThan(HEIGHT);
  });

  // -------------------------------------------------------------------------
  // The read surface an unvouch builder needs
  // -------------------------------------------------------------------------

  it('GET /vouches?voucher=X names the VouchBox each entry would spend', async () => {
    const vouchBox = seedVouchBox(voucher.pub, target.pub);

    const res = await request(`/?voucher=${voucher.hex}`, 'GET');
    expect(res.status).toBe(200);
    const body = res.data as { vouches: Array<Record<string, unknown>>; count: number };
    expect(body.count).toBe(1);
    expect(body.vouches[0]).toEqual({
      boxId: vouchBox.id,
      // ⛔ **The stake, because an unvouch's escrow must carry the CONSUMED
      // BOX'S value and never `VOUCH_KARMA_AMOUNT`** (TYPES_INTERFACE →
      // VouchEscrowBox). Without it the client has to reach for the constant,
      // which is right only by coincidence of the cast pin.
      value: vouchBox.value.toString(),
      voucherId: voucher.hex,
      targetId: target.hex,
    });
    // Without a `boxId` in the listing an unvouch is unbuildable from the API
    // alone: the transaction spends a NAMED box, and this is the only read
    // surface that exposes one.
    expect(body.vouches[0]!['boxId']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the boxId a listing hands out is the one an unvouch can actually spend', async () => {
    // End-to-end closure of the loop: list, then spend exactly what was listed.
    seedVouchBox(voucher.pub, target.pub);
    const listed = (
      (await request(`/?voucher=${voucher.hex}`, 'GET')).data as {
        vouches: Array<{ boxId: string }>;
      }
    ).vouches[0]!.boxId;

    const tx: UtxoTransaction = {
      inputs: [listed],
      outputs: [unvouchEscrow(VOUCH_KARMA_AMOUNT, voucher.pub)],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.priv, voucher.hex);

    const res = await request(`/${target.hex}`, 'DELETE', { tx: txToJson(tx) });
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // The bodies the demo UI's two buttons actually send
  // -------------------------------------------------------------------------

  describe('the page builders, lifted from index.html', () => {
    /** `fetchKarmaBox()`'s return shape, over boxes that are really in the store. */
    const karmaState = (...boxes: Array<Stored<KarmaBox>>) => ({
      total: boxes.reduce((sum, b) => sum + b.value, 0n),
      boxes: boxes.map((b) => ({ boxId: b.id!, value: b.value })),
    });

    /**
     * Serialize as the page does — its own bigint replacer — then sign the
     * txId the node derives from the decoded result. That the page's own
     * `computeTxId` agrees on that hash is pinned in `ui-crypto-mirror`; here
     * the subject is the body, so the signature is taken as given.
     */
    function signedBody(uiTx: Record<string, unknown>): Record<string, unknown> {
      const wire = JSON.parse(JSON.stringify(uiTx, ui.jsonBigint)) as Record<string, unknown>;
      const sig = cryptoSign(
        null,
        Buffer.from(computeTxId(jsonToTx(wire)), 'hex'),
        voucher.priv,
      );
      return { ...wire, signatures: { [voucher.hex]: Buffer.from(sig).toString('hex') } };
    }

    it('POST /vouches accepts what the vouch button sends', async () => {
      const karma = seedKarma(voucher.pub, VOUCH_MIN_BALANCE + VOUCH_KARMA_AMOUNT);
      const body = signedBody(ui.buildVouchTx(karmaState(karma), target.hex, voucher.hex));

      const res = await request('/', 'POST', { tx: body });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect((res.data as Record<string, unknown>)['status']).toBe('pending');
    });

    it('DELETE /vouches/:targetId accepts what the unvouch button sends', async () => {
      const vouchBox = seedVouchBox(voucher.pub, target.pub);
      // Read the id AND the stake the way the button reads them: off the
      // `?voucher=` listing, the only surface that names either. ⛔ **The stake
      // matters as much as the id** — the escrow must carry the consumed box's
      // value, so a client that had only the id would have to reach for
      // `VOUCH_KARMA_AMOUNT` (TYPES_INTERFACE → VouchEscrowBox).
      const listed = (
        (await request(`/?voucher=${voucher.hex}`, 'GET')).data as {
          vouches: Array<{ boxId: string; value: string }>;
        }
      ).vouches[0]!;
      expect(listed.boxId).toBe(vouchBox.id);

      const res = await request(`/${target.hex}`, 'DELETE', {
        tx: signedBody(
          ui.buildUnvouchTx(
            listed.boxId,
            BigInt(listed.value),
            voucher.hex,
            HEIGHT + COOLDOWN,
          ),
        ),
      });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect((res.data as Record<string, unknown>)['status']).toBe('pending');
    });
  });
});
