// NODE_INTERFACE → HTTP API → "A write request's transaction is checked whole
// before anything reads it"
import { makeTestConfig, seedProvenance, toHex, txToJson } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createPrivateKey, sign as cryptoSign } from 'crypto';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { insertBox } from '../../src/store/utxo.js';
import { putIdentityRecord } from '../../src/store/identity-records.js';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import {
  computeContentHash,
  computeTxId,
  encodeTx,
  generateKeyPair,
  MAX_BLOCK_BODY_BYTES,
  MAX_TX_BYTES,
  PROTOCOL_VERSION,
  profileFor,
} from '@dagsocial/types';
import type {
  CandidateOf,
  CreditBox,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';

function makeConfig(overrides?: Partial<Config>): Config {
  return makeTestConfig({
    port: 0,
    dbPath: ':memory:',
    networkType: 'testnet',
    profile: profileFor('testnet'),
    nodeRole: 'server',
    blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
    orderingBlockPowTargetBits: 3072,
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 50,
    ...overrides,
  });
}

interface Response { status: number; data: unknown; }

// NODE_INTERFACE → Route error policy: a route carries either a
// `{ error: <message> }` body or `{ error: <status>, reason: <message> }`.
// The field a test reads is "whichever carries the words" — the message in
// the first, `reason` in the second.
function message(data: unknown): string {
  const d = data as Record<string, unknown>;
  if (typeof d?.reason === 'string') return d.reason;
  return String(d?.error);
}

async function request(
  baseUrl: string,
  path: string,
  method: 'POST' | 'DELETE',
  body: unknown,
): Promise<Response> {
  return new Promise((resolve) => {
    const url = new URL(baseUrl + path);
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: d });
          }
        });
      },
    );
    req.write(payload);
    req.end();
  });
}

describe('write edge — a write request\'s transaction is checked whole', () => {
  let server: http.Server;
  let baseUrl: string;

  let sender: ReturnType<typeof generateKeyPair>;
  let senderPriv: ReturnType<typeof createPrivateKey>;
  let senderHex: string;
  let receiver: ReturnType<typeof generateKeyPair>;

  let inviter: ReturnType<typeof generateKeyPair>;

  const vouchTargetHex = 'ab'.repeat(32);

  // A per-test nonce that keeps every seeded credit box distinct — a credit
  // output a prior test's transfer pooled would answer 409 instead of
  // whatever the test is measuring, and nothing resets the pool here.
  let boxNonce = 1_000;

  beforeAll(() => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    sender = generateKeyPair();
    senderPriv = createPrivateKey({ key: Buffer.from(sender.secretKey), format: 'der', type: 'pkcs8' });
    senderHex = toHex(sender.publicKey);
    receiver = generateKeyPair();

    inviter = generateKeyPair();
    // A root (ARCHITECTURE → Roots) — a holder the invite path reads for its
    // own words, which the edge pre-empts for every malformed invite.
    putIdentityRecord(inviter.publicKey, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    const karmaBox = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 1_000n,
      createdAtBlock: 0,
      owner: inviter.publicKey,
    }, 1, 103);
    insertBox(karmaBox);

    const app = createApp(makeConfig());
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    closeDb();
  });

  // Seed a credit box with a per-test nonce and return it as a signed
  // transfer's input. Every call seeds a fresh box, so one test's pooled
  // transfer never shadows another's assertion.
  function freshCreditInput(value: bigint): string {
    const box = seedProvenance<CreditBox>({
      boxType: 'credit',
      value,
      createdAtBlock: 0,
      owner: sender.publicKey,
    }, 1, ++boxNonce);
    insertBox(box);
    return box.id;
  }

  function buildSignedTransferOverFresh(amount: bigint, inputValue: bigint): UtxoTransaction {
    const inputBoxId = freshCreditInput(inputValue);
    const change = inputValue - amount;
    const outputs: CandidateOf<CreditBox>[] = [{
      boxType: 'credit',
      value: amount,
      createdAtBlock: 0,
      owner: receiver.publicKey,
    }];
    if (change > 0n) {
      outputs.push({
        boxType: 'credit',
        value: change,
        createdAtBlock: 0,
        owner: sender.publicKey,
      });
    }
    const tx: UtxoTransaction = {
      inputs: [inputBoxId],
      outputs,
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const sig = cryptoSign(null, Buffer.from(computeTxId(tx), 'hex'), senderPriv);
    tx.signatures[senderHex] = new Uint8Array(sig);
    return tx;
  }

  // Build a transfer whose encoding is exactly `targetBytes` long, with its
  // one input a 64-hex id the store does not hold. Approaches target in two
  // passes: first fill with v=1 credit outputs up to the next-to-last that
  // fits, then widen individual outputs' `value` fields one VLQ band at a
  // time — each widening adds exactly one byte (TYPES_INTERFACE → Layout —
  // Boxes; `vlqU64` writes one byte per seven bits of magnitude). Returns
  // the transaction and the actual encoded length; the caller asserts the
  // length so a mismatch is a loud test failure.
  function buildTransferToSize(
    inputBoxId: string,
    targetBytes: number,
  ): { tx: UtxoTransaction; encodedLength: number } {
    const makeTx = (outputs: CandidateOf<CreditBox>[]): UtxoTransaction => ({
      inputs: [inputBoxId],
      outputs,
      signatures: { [senderHex]: new Uint8Array(64) },
      protocolVersion: PROTOCOL_VERSION,
    });
    const oneOutput = (value: bigint): CandidateOf<CreditBox> => ({
      boxType: 'credit',
      value,
      createdAtBlock: 0,
      owner: receiver.publicKey,
    });
    // The VLQ bands' first representative: value at the floor of each byte
    // width.
    const bands: bigint[] = [1n, 128n, 16384n, 1n << 21n, 1n << 28n, 1n << 35n, 1n << 42n, 1n << 49n, 1n << 56n];

    const outputs: CandidateOf<CreditBox>[] = [];
    let size = encodeTx(makeTx(outputs)).length;
    // Pack in v=1 outputs while the encoding stays at or below target.
    while (true) {
      outputs.push(oneOutput(1n));
      const next = encodeTx(makeTx(outputs)).length;
      if (next > targetBytes) {
        outputs.pop();
        break;
      }
      size = next;
      if (size === targetBytes) return { tx: makeTx(outputs), encodedLength: size };
    }
    // Widen outputs' values one VLQ band at a time — each band adds exactly
    // one byte. Walk the outputs; for each, try bands until the encoding
    // reaches target or widening overshoots.
    for (let i = 0; i < outputs.length && size < targetBytes; i++) {
      for (let band = 1; band < bands.length && size < targetBytes; band++) {
        const prev = outputs[i]!.value;
        outputs[i] = { ...outputs[i]!, value: bands[band]! };
        const next = encodeTx(makeTx(outputs)).length;
        if (next > targetBytes) {
          outputs[i] = { ...outputs[i]!, value: prev };
          break;
        }
        size = next;
      }
    }
    return { tx: makeTx(outputs), encodedLength: size };
  }

  // -------------------------------------------------------------------------
  // Plain `it` — holds on both sides.
  // -------------------------------------------------------------------------

  it('a well-formed signed credit transfer is pooled (200)', async () => {
    const tx = buildSignedTransferOverFresh(1_000_000n, 1_000_000n);
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(tx) });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  });

  it('a well-formed signed credit transfer with no protocolVersion key is pooled (200)', async () => {
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    delete json.protocolVersion;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  });

  it('a transfer at exactly MAX_TX_BYTES, input nowhere, answers 400 "Input box not found", never 413', async () => {
    const missingInput = 'cc'.repeat(32);
    const { tx, encodedLength } = buildTransferToSize(missingInput, MAX_TX_BYTES);
    expect(encodedLength).toBe(MAX_TX_BYTES);
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('Input box not found');
  });

  // -------------------------------------------------------------------------
  // Hex that is not lowercase, or not even-length
  // -------------------------------------------------------------------------

  it('a signed transfer whose signature is spelled in uppercase answers 400 — the JSON form', async () => {
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    const sigs = { ...(json.signatures as Record<string, string>) };
    sigs[senderHex] = sigs[senderHex]!.toUpperCase();
    json.signatures = sigs;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status).toBe(400);
  });

  it('a signed transfer with "zz" appended to its signature answers 400 — the JSON form', async () => {
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    const sigs = { ...(json.signatures as Record<string, string>) };
    sigs[senderHex] = sigs[senderHex]! + 'zz';
    json.signatures = sigs;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status).toBe(400);
  });

  it('a signed transfer with an odd-length signature answers 400 — the JSON form', async () => {
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    const sigs = { ...(json.signatures as Record<string, string>) };
    sigs[senderHex] = sigs[senderHex]! + 'a';
    json.signatures = sigs;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status).toBe(400);
  });

  it('a signed transfer whose output `owner` is spelled in uppercase answers 400 naming outputs[0].owner', async () => {
    // The transaction is otherwise one the node would pool: the same bytes,
    // the same id, the same valid signature — only the JSON spelling of its
    // first output's `owner` is uppercase, and the strict `hexToBytes`
    // refuses it at the JSON form.
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    const outs = (json.outputs as Record<string, unknown>[]).map((o) => ({ ...o }));
    outs[0]!.owner = (outs[0]!.owner as string).toUpperCase();
    json.outputs = outs;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('outputs[0].owner');
  });

  it('POST /posts whose commit `author` is spelled in uppercase answers 400 naming post author', async () => {
    // The post commit's domains hold under the uppercase decode's bytes, so
    // the one refusal is the strict hex decoder at the JSON edge.
    const content = 'hi';
    const authorLower = 'ab'.repeat(32);
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: '1', createdAtBlock: 0, owner: authorLower }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: {
        contentHash: Buffer.from(computeContentHash(content)).toString('hex'),
        author: authorLower.toUpperCase(),
        parentRefs: [],
        protocolVersion: PROTOCOL_VERSION,
        type: 'regular',
      },
    };
    const res = await request(baseUrl, '/posts', 'POST', { tx, content });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('post author');
  });

  it('POST /posts whose commit `contentHash` is spelled in uppercase answers 400 naming post contentHash', async () => {
    const content = 'hi';
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: '1', createdAtBlock: 0, owner: 'ab'.repeat(32) }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: {
        contentHash: Buffer.from(computeContentHash(content)).toString('hex').toUpperCase(),
        author: 'ab'.repeat(32),
        parentRefs: [],
        protocolVersion: PROTOCOL_VERSION,
        type: 'regular',
      },
    };
    const res = await request(baseUrl, '/posts', 'POST', { tx, content });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('post contentHash');
  });

  it('POST /vouches with a one-byte `targetId` answers 400 in the output shape\'s words, not castVouch\'s', async () => {
    // The JSON form admits a `targetId` that decodes to one byte (even length,
    // lowercase), so the refusal that holds the shape check is the schema's
    // own words at the edge — not `castVouch`'s "Invalid vouch target", which
    // is what the response reads when the shape check is removed.
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [{
        boxType: 'vouch',
        value: '1',
        createdAtBlock: 0,
        voucherId: '00'.repeat(32),
        targetId: '00',
      }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const res = await request(baseUrl, '/vouches', 'POST', { tx });
    expect(res.status).toBe(400);
    const msg = message(res.data);
    expect(msg).toContain('Invalid output shape');
    expect(msg).toContain('targetId');
    expect(msg).not.toContain('Invalid vouch target');
  });

  it('a signed transfer whose output value is spelled with one leading zero answers 400 naming outputs[0].value', async () => {
    // The transaction is otherwise one the node would pool — the leading
    // zero is a second spelling of a value the sender signed under exactly
    // one spelling.
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    const outs = (json.outputs as Record<string, unknown>[]).map((o) => ({ ...o }));
    outs[0]!.value = '0' + (outs[0]!.value as string);
    json.outputs = outs;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('outputs[0].value');
  });

  it('an uppercase input id on DELETE /vouches/:targetId answers 400 naming inputs', async () => {
    const inputId = 'EF'.repeat(32);
    const tx = {
      inputs: [inputId],
      outputs: [{ boxType: 'vouch_escrow', value: '1', releaseAtBlock: 100, voucherId: '00'.repeat(32) }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const res = await request(baseUrl, `/vouches/${vouchTargetHex}`, 'DELETE', { tx });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('inputs');
  });

  // -------------------------------------------------------------------------
  // Amount outside the decimal domain
  // -------------------------------------------------------------------------

  it('a signed transfer whose output value is zero-padded to 20 digits answers 400 — the JSON form, not the per-byte floor', async () => {
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    const outs = (json.outputs as Record<string, unknown>[]).map((o) => ({ ...o }));
    outs[0]!.value = '00000000000000000005';
    json.outputs = outs;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status).toBe(400);
    // A padded amount is refused by the JSON form at the edge, before the
    // per-byte floor reads a value.
    expect(message(res.data)).not.toContain('per-byte minimum');
  });

  // -------------------------------------------------------------------------
  // A present `protocolVersion: null` reaches the envelope
  // -------------------------------------------------------------------------

  it('POST /credits/transfer with `protocolVersion: null` answers 400 naming protocolVersion', async () => {
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    json.protocolVersion = null;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('protocolVersion');
  });

  it('POST /posts whose commit carries `protocolVersion: null` answers 400 naming protocolVersion', async () => {
    const content = 'hi';
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: '1', createdAtBlock: 0, owner: 'ab'.repeat(32) }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: {
        contentHash: Buffer.from(computeContentHash(content)).toString('hex'),
        author: 'ab'.repeat(32),
        parentRefs: [],
        protocolVersion: null,
        type: 'regular',
      },
    };
    const res = await request(baseUrl, '/posts', 'POST', { tx, content });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('protocolVersion');
  });

  // -------------------------------------------------------------------------
  // A binary box field that is not a string
  // -------------------------------------------------------------------------

  it('POST /usernames with owner `{length:5}` answers 400 naming owner', async () => {
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [{
        boxType: 'username',
        value: '0',
        owner: { length: 5 },
        name: Buffer.from('alice').toString('hex'),
      }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const res = await request(baseUrl, '/usernames', 'POST', { tx });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('owner');
  });

  it('POST /vouches with voucherId `{length:5}` answers 400 naming voucherId', async () => {
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [{
        boxType: 'vouch',
        value: '1',
        voucherId: { length: 5 },
        targetId: '00'.repeat(32),
      }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const res = await request(baseUrl, '/vouches', 'POST', { tx });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('voucherId');
  });

  it('POST /invites with inviteePublicKey `{length:5}` answers 400 naming inviteePublicKey', async () => {
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [{
        boxType: 'bond',
        value: '25',
        inviterId: '00'.repeat(32),
        inviteePublicKey: { length: 5 },
      }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const res = await request(baseUrl, '/invites', 'POST', { tx });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('inviteePublicKey');
  });

  // -------------------------------------------------------------------------
  // An absent key is named
  // -------------------------------------------------------------------------

  it('POST /credits/transfer with no `signatures` key answers 400 naming signatures', async () => {
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    delete json.signatures;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('signatures');
  });

  it('POST /credits/transfer with no `outputs` key answers 400 naming the key, not the service\'s own words', async () => {
    const tx = buildSignedTransferOverFresh(50_000_000n, 100_000_000n);
    const json = txToJson(tx) as Record<string, unknown>;
    delete json.outputs;
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: json });
    expect(res.status).toBe(400);
    const err = message(res.data);
    expect(err).toContain('outputs');
    // The service's own words name "credit transfer outputs must all be
    // CreditBoxes"; the edge's refusal names the absent key alone.
    expect(err).not.toContain('CreditBoxes');
  });

  // -------------------------------------------------------------------------
  // Wrong-shape outputs or inputs — 400 and nothing is logged.
  // -------------------------------------------------------------------------

  describe('a wrong-shape outputs or inputs is 400 and nothing is logged', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeAll(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) as unknown as ReturnType<typeof vi.spyOn>;
    });
    afterEach(() => {
      errorSpy.mockClear();
    });
    afterAll(() => {
      errorSpy.mockRestore();
    });

    it('POST /invites with `outputs: [null]` answers 400 and logs nothing', async () => {
      const tx = {
        inputs: ['aa'.repeat(32)],
        outputs: [null],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      const res = await request(baseUrl, '/invites', 'POST', { tx });
      expect(res.status).toBe(400);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('POST /invites with `outputs: "x"` answers 400 and logs nothing', async () => {
      const tx = {
        inputs: ['aa'.repeat(32)],
        outputs: 'x',
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      const res = await request(baseUrl, '/invites', 'POST', { tx });
      expect(res.status).toBe(400);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('POST /invites with `inputs: "abc"` answers 400 and logs nothing', async () => {
      const tx = {
        inputs: 'abc',
        outputs: [],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      const res = await request(baseUrl, '/invites', 'POST', { tx });
      expect(res.status).toBe(400);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // `tx` itself is not a plain object
  // -------------------------------------------------------------------------

  it('POST /credits/transfer with `tx: "x"` answers 400 naming tx', async () => {
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: 'x' });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('tx');
  });

  it('POST /credits/transfer with `tx: []` answers 400 naming tx', async () => {
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: [] });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('tx');
  });

  // -------------------------------------------------------------------------
  // A post commit with no `type`
  // -------------------------------------------------------------------------

  it('POST /posts with a commit carrying no `type` answers 400 naming type', async () => {
    const content = 'hi';
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: {
        contentHash: Buffer.from(computeContentHash(content)).toString('hex'),
        author: '11'.repeat(32),
        parentRefs: [],
        protocolVersion: PROTOCOL_VERSION,
      },
    };
    const res = await request(baseUrl, '/posts', 'POST', { tx, content });
    expect(res.status).toBe(400);
    expect(message(res.data)).toContain('type');
  });

  // -------------------------------------------------------------------------
  // Size — the pool's 413 is reachable before any store read
  // -------------------------------------------------------------------------

  it('POST /credits/transfer of 7 500 outputs with its one input nowhere answers 413 before any store read', async () => {
    const missingInput = 'ab'.repeat(32);
    const outputs: Record<string, unknown>[] = [];
    for (let i = 0; i < 7_500; i++) {
      outputs.push({ boxType: 'credit', value: '1', createdAtBlock: 0, owner: toHex(receiver.publicKey) });
    }
    const tx = {
      inputs: [missingInput],
      outputs,
      signatures: { [senderHex]: '00'.repeat(64) },
      protocolVersion: PROTOCOL_VERSION,
    };
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx });
    expect(res.status).toBe(413);
  });

  it('POST /invites with 15 000 distinct random 64-hex inputs answers 413 before any store read', async () => {
    const inputs: string[] = [];
    for (let i = 0; i < 15_000; i++) {
      const n = i.toString(16).padStart(10, '0');
      inputs.push('00'.repeat(27) + n);
    }
    const tx = {
      inputs,
      outputs: [{
        boxType: 'bond',
        value: '25',
        createdAtBlock: 0,
        inviterId: '00'.repeat(32),
        inviteePublicKey: '11'.repeat(32),
      }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const res = await request(baseUrl, '/invites', 'POST', { tx });
    expect(res.status).toBe(413);
  });

  it('POST /credits/transfer one byte over MAX_TX_BYTES, input nowhere, answers 413', async () => {
    const missingInput = 'cd'.repeat(32);
    const { tx, encodedLength } = buildTransferToSize(missingInput, MAX_TX_BYTES + 1);
    expect(encodedLength).toBe(MAX_TX_BYTES + 1);
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(413);
  });

  // -------------------------------------------------------------------------
  // NODE_INTERFACE → Credits: a transfer's outputs are credit or fee boxes
  // (→ Legal box transitions, the `CreditBox | CreditBox(s) and/or FeeBox` row).
  // -------------------------------------------------------------------------

  /** Build a signed transfer whose outputs are a credit to the receiver and one FeeBox. */
  function buildCreditPlusFee(inputValue: bigint, feeValue: bigint): UtxoTransaction {
    const inputBoxId = freshCreditInput(inputValue);
    const change = inputValue - feeValue;
    const tx: UtxoTransaction = {
      inputs: [inputBoxId],
      outputs: [
        { boxType: 'credit', value: change, createdAtBlock: 0, owner: receiver.publicKey },
        { boxType: 'fee', value: feeValue, createdAtBlock: 0 },
      ] as CandidateOf<CreditBox>[],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const sig = cryptoSign(null, Buffer.from(computeTxId(tx), 'hex'), senderPriv);
    tx.signatures[senderHex] = new Uint8Array(sig);
    return tx;
  }

  /** Build a signed transfer whose only output is one FeeBox taking the whole input. */
  function buildFeeOnly(inputValue: bigint): UtxoTransaction {
    const inputBoxId = freshCreditInput(inputValue);
    const tx: UtxoTransaction = {
      inputs: [inputBoxId],
      outputs: [{ boxType: 'fee', value: inputValue, createdAtBlock: 0 }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const sig = cryptoSign(null, Buffer.from(computeTxId(tx), 'hex'), senderPriv);
    tx.signatures[senderHex] = new Uint8Array(sig);
    return tx;
  }

  it('a transfer with a credit output and a fee output pools under a zero floor', async () => {
    const tx = buildCreditPlusFee(1_000_000n, 100_000n);
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(tx) });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  });

  it('a transfer whose one output is a fee box reaches validateTx and pools under a zero floor', async () => {
    // NODE_INTERFACE → Legal box transitions: "A transaction whose only output
    // is the FeeBox is legal". Conservation holds — the input and the fee are
    // the same value — so `validateTx` admits and `admitTx` pools under floor 0.
    const tx = buildFeeOnly(500_000n);
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(tx) });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  });

  it('a transfer of credit outputs only is pooled under a zero floor', async () => {
    const tx = buildSignedTransferOverFresh(400_000n, 1_000_000n);
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(tx) });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  });

  it('a transfer with a karma output answers 400', async () => {
    // NODE_INTERFACE → Legal box transitions: the `CreditBox` row's outputs are
    // `CreditBox(s) and/or FeeBox`, nothing else. A karma output is neither.
    const inputBoxId = freshCreditInput(500_000n);
    const tx = {
      inputs: [inputBoxId],
      outputs: [{ boxType: 'karma', value: '500000', createdAtBlock: 0, owner: toHex(receiver.publicKey) }],
      signatures: { [senderHex]: '00'.repeat(64) },
      protocolVersion: PROTOCOL_VERSION,
    };
    const res = await request(baseUrl, '/credits/transfer', 'POST', { tx });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // NODE_INTERFACE → Withdrawal: an unknown post answers 404.
  // -------------------------------------------------------------------------

  it('POST /posts/:id/withdraw of a post the node has never heard of answers 404', async () => {
    // The transaction passes the JSON edge; the service reads the unknown
    // postId's row — none — and the route carries the status its ClientError
    // names.
    const unknownId = '7f'.repeat(32);
    const inviterHex = toHex(inviter.publicKey);
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: '1', createdAtBlock: 0, owner: inviterHex }],
      signatures: { [inviterHex]: '00'.repeat(64) },
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId: unknownId },
    };
    const res = await request(baseUrl, `/posts/${unknownId}/withdraw`, 'POST', { tx });
    expect(res.status, JSON.stringify(res.data)).toBe(404);
  });

});

