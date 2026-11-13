// MINING_INTERFACE → Consolidation — the miner's consolidation module. Each
// case enters through the module's exports: the key-file reader, the check
// (with a stub node behind `HttpFetch` that serves `/status`, pages the
// listing and records each `POST`), and the cadence. Keys are generated per
// case (`generateKeyPairSync('ed25519')`); files live under `mkdtempSync`.

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bytesToHex,
  computeTxId,
  encodeTx,
  MAX_TX_BYTES,
  PAGE_LIMIT_MAX,
  profileFor,
  protocolVersionAt,
} from '@dagsocial/types';
import type { UtxoTransaction, CreditBox } from '@dagsocial/types';
import { verifyEd25519 } from '@dagsocial/validation';
import type { HttpFetch } from '@dagsocial/node-reads';

import { jsonToTx } from '../../src/routes/json-to-tx.js';
import {
  readMinerKey,
  runConsolidateCheck,
  createCadence,
} from '../../src/miner-consolidate.js';

// MINING_INTERFACE → Consolidation → "The interval follows the network's coinbase lock and rent period." —
// testnet's interval reads 100 (the default `newCaseState` names below),
// restated in the file for assertions that keyword it.
const MIN = 100;

/** A pair of ed25519 keys for the case, both as the file reader expects them. */
interface CaseKey {
  readonly publicKeyHex: string;
  readonly secretKeyHex: string;    // the PKCS8 DER secret, hex
  readonly privKeyBase64: string;   // the same DER, base64 (the web client's form)
}

function makeKey(): CaseKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return {
    publicKeyHex: pubDer.subarray(-32).toString('hex'),
    secretKeyHex: privDer.toString('hex'),
    privKeyBase64: privDer.toString('base64'),
  };
}

function tmp(name: string): { dir: string; file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'miner-consolidate-'));
  const file = join(dir, name);
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// -------------------------------------------------------------------------
// The key-file reader
// -------------------------------------------------------------------------

describe('readMinerKey', () => {
  it('a gen-miner-key.mjs file gives the key and signs verifiably', () => {
    const k = makeKey();
    const t = tmp('miner.json');
    try {
      writeFileSync(t.file, JSON.stringify({ publicKey: k.publicKeyHex, secretKeyHex: k.secretKeyHex }));
      const held = readMinerKey(t.file, null);
      expect(held.publicKeyHex).toBe(k.publicKeyHex);
      // The signing key signs a 32-byte message and the signature verifies
      // against the file's public key — the one property the reader guarantees.
      const msg = randomBytes(32);
      const sig = heldSign(held, msg);
      expect(verifyEd25519(sig, msg, Buffer.from(k.publicKeyHex, 'hex'))).toBe(true);
    } finally { t.done(); }
  });

  it('a clear identity file gives the key and signs verifiably', () => {
    const k = makeKey();
    const t = tmp('web.json');
    try {
      writeFileSync(t.file, JSON.stringify({ version: 1, pubKeyHex: k.publicKeyHex, privKeyBase64: k.privKeyBase64 }));
      const held = readMinerKey(t.file, null);
      expect(held.publicKeyHex).toBe(k.publicKeyHex);
      const msg = randomBytes(32);
      const sig = heldSign(held, msg);
      expect(verifyEd25519(sig, msg, Buffer.from(k.publicKeyHex, 'hex'))).toBe(true);
    } finally { t.done(); }
  });

  it('an encrypted envelope refuses, with the file in the message', () => {
    const t = tmp('encrypted.json');
    try {
      const envelope = {
        version: 1,
        pubKeyHex: 'aa'.repeat(32),
        kdf: { name: 'scrypt', salt: '00'.repeat(16), N: 65536, r: 8, p: 1 },
        cipher: { name: 'chacha20-poly1305', nonce: '00'.repeat(12) },
        ciphertext: '00'.repeat(48),
      };
      writeFileSync(t.file, JSON.stringify(envelope));
      expect(() => readMinerKey(t.file, null)).toThrow(new RegExp(escapeRegex(t.file)));
    } finally { t.done(); }
  });

  it("an encrypted envelope's refusal says it is an encrypted envelope", () => {
    // The envelope carries every ordinary-form field (`pubKeyHex` beside the
    // crypto fields), so the "carries neither …" line would refuse it too —
    // the envelope's own refusal is the one the diagnostic reader reads.
    const t = tmp('encrypted.json');
    try {
      const k = makeKey();
      const envelope = {
        version: 1,
        pubKeyHex: k.publicKeyHex,
        privKeyBase64: k.privKeyBase64,
        kdf: { name: 'scrypt', salt: '00'.repeat(16), N: 65536, r: 8, p: 1 },
        cipher: { name: 'chacha20-poly1305', nonce: '00'.repeat(12) },
        ciphertext: '00'.repeat(48),
      };
      writeFileSync(t.file, JSON.stringify(envelope));
      expect(() => readMinerKey(t.file, null)).toThrow(/encrypted identity envelope/);
    } finally { t.done(); }
  });

  it('a file that parses as neither form refuses, with the file in the message', () => {
    const t = tmp('garbage.json');
    try {
      writeFileSync(t.file, '{"not":"a key"}');
      expect(() => readMinerKey(t.file, null)).toThrow(new RegExp(escapeRegex(t.file)));
    } finally { t.done(); }
  });

  it('a secret that derives another key refuses, with the file in the message', () => {
    const k = makeKey();
    const other = makeKey();
    const t = tmp('mismatch.json');
    try {
      writeFileSync(t.file, JSON.stringify({ publicKey: other.publicKeyHex, secretKeyHex: k.secretKeyHex }));
      expect(() => readMinerKey(t.file, null)).toThrow(new RegExp(escapeRegex(t.file)));
    } finally { t.done(); }
  });

  it('a MINER_PUBKEY naming another key refuses, with the file in the message', () => {
    const k = makeKey();
    const other = makeKey();
    const t = tmp('miner.json');
    try {
      writeFileSync(t.file, JSON.stringify({ publicKey: k.publicKeyHex, secretKeyHex: k.secretKeyHex }));
      expect(() => readMinerKey(t.file, other.publicKeyHex)).toThrow(new RegExp(escapeRegex(t.file)));
    } finally { t.done(); }
  });

  it('a MINER_PUBKEY matching the file passes', () => {
    const k = makeKey();
    const t = tmp('miner.json');
    try {
      writeFileSync(t.file, JSON.stringify({ publicKey: k.publicKeyHex, secretKeyHex: k.secretKeyHex }));
      const held = readMinerKey(t.file, k.publicKeyHex);
      expect(held.publicKeyHex).toBe(k.publicKeyHex);
    } finally { t.done(); }
  });
});

// -------------------------------------------------------------------------
// The check
// -------------------------------------------------------------------------

interface StubBox {
  readonly boxId: string;        // 64 lowercase hex
  readonly value: bigint;
  readonly lockedUntilBlock?: number;
}

interface StubState {
  readonly tip: number;
  readonly protocolVersion: number;
  // What the stub's `/status` names. A string so a case can pass one the
  // types do not name.
  networkType: string;
  // Ordered as the node answers `GET /credits/:userId?pending=1`: value DESC, id ASC.
  readonly boxes: readonly StubBox[];
  // Each call is recorded, URL and body (JSON string or null for GET).
  readonly calls: Array<{ method: string; url: string; body: string | null }>;
  // Each submitted body (POST /credits/transfer) parsed from the request.
  readonly posts: Array<Record<string, unknown>>;
  // What the stub answers to a POST — `status` is 200 for the normal 2xx.
  postAnswer: { status: number; body: unknown };
  // Where the listing mis-serves a page — a corruption the check logs on.
  listingMalformed?: boolean;
  // Where the status read is refused (a 500 body).
  statusRefuse?: boolean;
  // Where only the first `/status` read is refused, the rest answered.
  refuseFirstStatus?: boolean;
  // Internal — how many `/status` reads the stub has served so far (or tried
  // to; a refused read still counts).
  statusReadCount: number;
}

function buildStub(state: StubState): HttpFetch {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init!.body : null;
    state.calls.push({ method, url, body });
    const u = new URL(url);
    if (u.pathname === '/status') {
      state.statusReadCount++;
      if (state.statusRefuse) {
        return new Response('upstream', { status: 500 });
      }
      if (state.refuseFirstStatus && state.statusReadCount === 1) {
        return new Response('upstream', { status: 500 });
      }
      return json({
        networkType: state.networkType,
        blockHeight: state.tip,
        protocolVersion: state.protocolVersion,
      });
    }
    if (u.pathname === '/credits/transfer' && method === 'POST') {
      const parsed = JSON.parse(body!) as { tx: Record<string, unknown> };
      state.posts.push(parsed.tx);
      return new Response(JSON.stringify(state.postAnswer.body), {
        status: state.postAnswer.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.pathname.startsWith('/credits/')) {
      if (state.listingMalformed) {
        return json({ not: 'a listing' });
      }
      const limit = Number(u.searchParams.get('limit') ?? String(PAGE_LIMIT_MAX));
      const after = u.searchParams.get('after');
      // The node pages `value DESC, id`; the stub's boxes already carry that order.
      let start = 0;
      if (after !== null) {
        const [valStr, idStr] = after.split(':');
        start = state.boxes.findIndex((b) =>
          b.value < BigInt(valStr!) || (b.value === BigInt(valStr!) && b.boxId > idStr!));
        if (start < 0) start = state.boxes.length;
      }
      const page = state.boxes.slice(start, start + limit);
      const hasMore = state.boxes.length > start + page.length;
      const last = page[page.length - 1];
      const next = hasMore && last ? `${last.value.toString()}:${last.boxId}` : null;
      return json({
        userId: u.pathname.slice('/credits/'.length),
        total: state.boxes.reduce((s, b) => s + b.value, 0n).toString(),
        boxes: page.map((b) => ({
          boxId: b.boxId,
          value: b.value.toString(),
          ...(b.lockedUntilBlock !== undefined ? { lockedUntilBlock: b.lockedUntilBlock } : {}),
        })),
        boxCount: state.boxes.length,
        next,
      });
    }
    return new Response('not found', { status: 404 });
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function heldSign(held: { signingKey: import('node:crypto').KeyObject }, msg: Uint8Array): Buffer {
  // The reader hands back a `KeyObject` — the one argument `crypto.sign`
  // takes on an Ed25519 key beside the 32 id bytes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:crypto').sign(null, Buffer.from(msg), held.signingKey) as Buffer;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeCaseBoxes(n: number, value: bigint): StubBox[] {
  const boxes: StubBox[] = [];
  for (let i = 0; i < n; i++) {
    boxes.push({ boxId: bytesToHex(randomBytes(32)), value });
  }
  // The node's order on the listing: value DESC, id ASC at equal value.
  boxes.sort((a, b) => (a.value === b.value ? a.boxId.localeCompare(b.boxId) : b.value > a.value ? 1 : -1));
  return boxes;
}

function newCaseState(
  tip: number,
  boxes: readonly StubBox[],
  networkType: string = 'testnet',
): StubState {
  const profile = profileFor(networkType as 'devnet' | 'testnet' | 'mainnet');
  const schedule = profile.protocolVersionSchedule;
  const protocolVersion = protocolVersionAt(schedule, tip + 1)!;
  return {
    tip,
    protocolVersion,
    networkType,
    boxes,
    calls: [],
    posts: [],
    postAnswer: { status: 200, body: { status: 'pending', txId: 'aa'.repeat(32), expiresAtHeight: tip + 60 } },
    statusReadCount: 0,
  };
}

function setupKey(): { key: CaseKey; file: string; done: () => void } {
  const key = makeKey();
  const t = tmp('miner.json');
  writeFileSync(t.file, JSON.stringify({ publicKey: key.publicKeyHex, secretKeyHex: key.secretKeyHex }));
  return { key, file: t.file, done: t.done };
}

describe('runConsolidateCheck', () => {
  it('with fewer than the minimum spendable boxes the check posts nothing', async () => {
    const { file, done } = setupKey();
    try {
      const state = newCaseState(1000, makeCaseBoxes(MIN - 1, 1_000_000n));
      const held = readMinerKey(file, null);
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: held,
        httpFetch: buildStub(state),
        logger: () => {},
      });
      // The check read `/status` and the credits listing — the positive
      // controls that tell "the check saw too few" from "the check did
      // nothing".
      expect(state.calls.some((c) => new URL(c.url).pathname === '/status')).toBe(true);
      expect(state.calls.some((c) => new URL(c.url).pathname.startsWith('/credits/'))).toBe(true);
      expect(outcome.sent).toBe(false);
      expect(state.posts).toHaveLength(0);
    } finally { done(); }
  });

  it('at the minimum spendable the check posts one transaction, and logs its id and input count', async () => {
    const { file, done } = setupKey();
    try {
      const state = newCaseState(1000, makeCaseBoxes(MIN, 1_000_000n));
      const held = readMinerKey(file, null);
      const lines: string[] = [];
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: held,
        httpFetch: buildStub(state),
        logger: (l) => lines.push(l),
      });
      expect(outcome.sent).toBe(true);
      expect(outcome.inputCount).toBe(MIN);
      expect(state.posts).toHaveLength(1);
      // MINING_INTERFACE → Consolidation → "A check spends what the pending view leaves spendable." — the paragraph's tail:
      // "A consolidation the node answers `pending` logs one line naming its
      // id and its input count." — the id is the one over the posted
      // transaction, recomputed from the stub's record.
      const posted = jsonToTx(state.posts[0]!, state.protocolVersion);
      const txId = computeTxId(posted);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(txId);
      expect(lines[0]).toContain(String(MIN));
    } finally { done(); }
  });

  it('a lock above tip + 1 is not spendable, at and below it is', async () => {
    const { file, done } = setupKey();
    try {
      const tip = 1000;
      // MIN−1 unlockable boxes beside one locked at tip + 2 — total MIN boxes
      // but the count against the threshold stays at MIN−1, below it, so no
      // transaction is sent.
      const boxes: StubBox[] = [
        ...makeCaseBoxes(MIN - 1, 1_000_000n),
        { boxId: bytesToHex(randomBytes(32)), value: 1_000_000n, lockedUntilBlock: tip + 2 },
      ];
      const state = newCaseState(tip, boxes);
      const held = readMinerKey(file, null);
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: held,
        httpFetch: buildStub(state),
        logger: () => {},
      });
      // The check read the listing — a positive control that tells "the lock
      // was over the ceiling" from "the check did nothing".
      expect(state.calls.some((c) => new URL(c.url).pathname.startsWith('/credits/'))).toBe(true);
      expect(outcome.sent).toBe(false);
    } finally { done(); }
  });

  it('a lock at tip + 1 is spendable, a lock absent is spendable', async () => {
    const { file, done } = setupKey();
    try {
      const tip = 1000;
      // Three spendable boxes short of the MIN; one locked at tip+1 (spendable)
      // and one unlocked bring the count to MIN, so the check posts and the
      // input count is MIN. (Guards against classifying tip+1 as non-spendable.)
      const boxes: StubBox[] = [
        ...makeCaseBoxes(MIN - 2, 1_000_000n),
        { boxId: bytesToHex(randomBytes(32)), value: 1_000_000n, lockedUntilBlock: tip + 1 },
        { boxId: bytesToHex(randomBytes(32)), value: 1_000_000n },
      ];
      const state = newCaseState(tip, boxes);
      const held = readMinerKey(file, null);
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: held,
        httpFetch: buildStub(state),
        logger: () => {},
      });
      expect(outcome.sent).toBe(true);
      expect(outcome.inputCount).toBe(MIN);
    } finally { done(); }
  });

  it('the posted transaction carries the listing order, the sum output, the tip and the era, verifiably signed', async () => {
    const { key, file, done } = setupKey();
    try {
      const tip = 1000;
      const boxes = makeCaseBoxes(MIN, 1_000_000n);
      const state = newCaseState(tip, boxes);
      const held = readMinerKey(file, null);
      await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: held,
        httpFetch: buildStub(state),
        logger: () => {},
      });
      expect(state.posts).toHaveLength(1);
      const posted = state.posts[0]!;
      const parsed = jsonToTx(posted, state.protocolVersion);
      // Inputs in the listing's order.
      expect(parsed.inputs).toEqual(boxes.map((b) => b.boxId));
      // One credit output to the key, value the inputs' sum.
      expect(parsed.outputs).toHaveLength(1);
      const out = parsed.outputs[0] as CreditBox;
      expect(out.boxType).toBe('credit');
      expect(bytesToHex(out.owner)).toBe(key.publicKeyHex);
      expect(out.value).toBe(boxes.reduce((s, b) => s + b.value, 0n));
      expect(out.createdAtBlock).toBe(tip);
      expect(out.lockedUntilBlock).toBeUndefined();
      // The era the node reported, never a module constant.
      expect(parsed.protocolVersion).toBe(state.protocolVersion);
      // One signature by the key, verifying over the id.
      const idBytes = Buffer.from(computeTxId(parsed), 'hex');
      expect(Object.keys(parsed.signatures)).toEqual([key.publicKeyHex]);
      const sig = parsed.signatures[key.publicKeyHex]!;
      expect(verifyEd25519(sig, idBytes, Buffer.from(key.publicKeyHex, 'hex'))).toBe(true);
    } finally { done(); }
  });

  it('every listing read carries pending=1, and the read stops once a full transaction is held', async () => {
    const { file, done } = setupKey();
    try {
      // Far more spendable boxes than one transaction carries — the check
      // holds its load on the first few pages and stops short of the end.
      const boxes = makeCaseBoxes(10 * PAGE_LIMIT_MAX, 1_000_000n);
      const state = newCaseState(1000, boxes);
      const held = readMinerKey(file, null);
      await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: held,
        httpFetch: buildStub(state),
        logger: () => {},
      });
      const gets = state.calls.filter((c) => c.method === 'GET' && c.url.includes('/credits/'));
      expect(gets.length).toBeGreaterThan(0);
      for (const g of gets) {
        const u = new URL(g.url);
        expect(u.searchParams.get('pending')).toBe('1');
      }
      // The read ended short of the listing — the last page carried a
      // non-null `next` the check never followed.
      expect(gets.length).toBeLessThan(10);
    } finally { done(); }
  });

  it('the transaction packs to the byte bound and the check answers full', async () => {
    const { file, done } = setupKey();
    try {
      // A page of equal-value boxes, more than any one transaction can carry,
      // so the byte bound is the stop rather than the listing's end.
      const boxes = makeCaseBoxes(500, 1_000_000n);
      const state = newCaseState(1000, boxes);
      const held = readMinerKey(file, null);
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: held,
        httpFetch: buildStub(state),
        logger: () => {},
      });
      expect(outcome.sent).toBe(true);
      expect(outcome.full).toBe(true);
      const parsed = jsonToTx(state.posts[0]!, state.protocolVersion);
      // The transaction encodes within the byte bound …
      expect(encodeTx(parsed).length).toBeLessThanOrEqual(MAX_TX_BYTES);
      // … and one more input would carry it past, so this is the bound's
      // own stop rather than the listing's.
      const extraBox = boxes[parsed.inputs.length];
      expect(extraBox).toBeDefined();
      const extended: UtxoTransaction = {
        ...parsed,
        inputs: [...parsed.inputs, extraBox!.boxId],
      };
      expect(encodeTx(extended).length).toBeGreaterThan(MAX_TX_BYTES);
    } finally { done(); }
  });

  it('with fewer spendable boxes than fit the check answers not full', async () => {
    const { file, done } = setupKey();
    try {
      // MIN spendable boxes — enough to post, well under the byte bound.
      const boxes = makeCaseBoxes(MIN, 1_000_000n);
      const state = newCaseState(1000, boxes);
      const held = readMinerKey(file, null);
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: held,
        httpFetch: buildStub(state),
        logger: () => {},
      });
      expect(outcome.sent).toBe(true);
      expect(outcome.full).toBe(false);
    } finally { done(); }
  });

  it('a refused submit is logged once and does not throw', async () => {
    const { file, done } = setupKey();
    try {
      const state = newCaseState(1000, makeCaseBoxes(MIN, 1_000_000n));
      state.postAnswer.status = 400;
      state.postAnswer.body = { error: 'refused' };
      const lines: string[] = [];
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: buildStub(state),
        logger: (l) => lines.push(l),
      });
      expect(outcome.sent).toBe(false);
      expect(lines).toHaveLength(1);
    } finally { done(); }
  });

  it('a refused status read is logged once and does not throw', async () => {
    const { file, done } = setupKey();
    try {
      const state = newCaseState(1000, makeCaseBoxes(MIN, 1_000_000n));
      state.statusRefuse = true;
      const lines: string[] = [];
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: buildStub(state),
        logger: (l) => lines.push(l),
      });
      expect(outcome.sent).toBe(false);
      expect(lines).toHaveLength(1);
    } finally { done(); }
  });

  it('a malformed listing is logged once and does not throw', async () => {
    const { file, done } = setupKey();
    try {
      const state = newCaseState(1000, makeCaseBoxes(MIN, 1_000_000n));
      state.listingMalformed = true;
      const lines: string[] = [];
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: buildStub(state),
        logger: (l) => lines.push(l),
      });
      expect(outcome.sent).toBe(false);
      expect(lines).toHaveLength(1);
    } finally { done(); }
  });

  it('a 200 submit answer whose status is not pending is logged once and read as not sent', async () => {
    const { file, done } = setupKey();
    try {
      const state = newCaseState(1000, makeCaseBoxes(MIN, 1_000_000n));
      // A 200 the reader admits, but with a status the check refuses.
      state.postAnswer.status = 200;
      state.postAnswer.body = { status: 'refused' };
      const lines: string[] = [];
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: buildStub(state),
        logger: (l) => lines.push(l),
      });
      // The transaction was posted — the stub recorded it — but the answer's
      // status is not `pending`, so the outcome reads as not sent.
      expect(state.posts).toHaveLength(1);
      expect(outcome.sent).toBe(false);
      expect(lines).toHaveLength(1);
    } finally { done(); }
  });

  // MINING_INTERFACE → Consolidation → "The interval follows the network's coinbase lock and rent period." —
  // devnet 15, testnet 100, mainnet 100 (`profileFor` over the stub's
  // `/status`). The outcome answers the interval the check read.
  it('the check reads the interval from the network /status names: devnet 15, testnet 100, mainnet 100', async () => {
    const { file, done } = setupKey();
    try {
      for (const [networkType, expected] of [
        ['devnet', 15],
        ['testnet', 100],
        ['mainnet', 100],
      ] as const) {
        const state = newCaseState(1000, [], networkType);
        const outcome = await runConsolidateCheck({
          nodeUrl: 'http://stub',
          key: readMinerKey(file, null),
          httpFetch: buildStub(state),
          logger: () => {},
        });
        expect((outcome as unknown as { interval: number | null }).interval).toBe(expected);
      }
    } finally { done(); }
  });

  // MINING_INTERFACE → Consolidation → "The interval follows the network's coinbase lock and rent period." —
  // on devnet the interval is 15. One fewer than the interval sends nothing;
  // exactly the interval sends one transaction naming each spendable box.
  it('on devnet 14 spendable boxes send nothing and 15 send one transaction of 15 inputs', async () => {
    const { file, done } = setupKey();
    try {
      const below = newCaseState(1000, makeCaseBoxes(14, 1_000_000n), 'devnet');
      const belowOutcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: buildStub(below),
        logger: () => {},
      });
      expect(belowOutcome.sent).toBe(false);
      expect(below.posts).toHaveLength(0);

      const atExactly = newCaseState(1000, makeCaseBoxes(15, 1_000_000n), 'devnet');
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: buildStub(atExactly),
        logger: () => {},
      });
      expect(outcome.sent).toBe(true);
      expect(outcome.inputCount).toBe(15);
      expect(atExactly.posts).toHaveLength(1);
    } finally { done(); }
  });

  // MINING_INTERFACE → Consolidation → "A check runs once an interval, never inside a work window." —
  // a `/status` whose `networkType` the types do not name has no interval,
  // and the check answers idle with one log line.
  it('a /status whose networkType the types do not name logs one line and sends nothing', async () => {
    const { file, done } = setupKey();
    try {
      // `profileFor` is only called when the stub builds its state, so the
      // bogus name is set after newCaseState has seeded the stub profile.
      const state = newCaseState(1000, makeCaseBoxes(MIN, 1_000_000n), 'testnet');
      state.networkType = 'notanetwork';
      const lines: string[] = [];
      const outcome = await runConsolidateCheck({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: buildStub(state),
        logger: (l) => lines.push(l),
      });
      expect(outcome.sent).toBe(false);
      expect(state.posts).toHaveLength(0);
      expect(lines).toHaveLength(1);
    } finally { done(); }
  });
});

// -------------------------------------------------------------------------
// The cadence
// -------------------------------------------------------------------------

describe('createCadence', () => {
  it('the first tick checks; a tick fewer than the minimum heights later does not; at the minimum does', async () => {
    const { file, done } = setupKey();
    try {
      // Below-MIN stock — every check returns `sent: false, full: false`, so
      // the cadence's next due height is the last check's + MIN.
      const smallBoxes = makeCaseBoxes(MIN - 1, 1_000_000n);
      let httpCalls = 0;
      const cadence = createCadence({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: async (url: string, init?: RequestInit) => {
          httpCalls++;
          return buildStub(newCaseState(1000, smallBoxes))(url, init);
        },
        logger: () => {},
      });

      // TICK 1 at height 1: the first-ever tick, must check.
      await cadence.tick(1);
      const afterFirst = httpCalls;
      expect(afterFirst).toBeGreaterThan(0);

      // TICK 2 at height MIN − 1 above the first: one short of the next due,
      // must NOT check.
      await cadence.tick(1 + MIN - 1);
      expect(httpCalls).toBe(afterFirst);

      // TICK 3 at height MIN above the first: at the next due, must check.
      await cadence.tick(1 + MIN);
      expect(httpCalls).toBeGreaterThan(afterFirst);
    } finally { done(); }
  });

  it('after a full check the next tick height checks', async () => {
    const { file, done } = setupKey();
    try {
      // Stock big enough that the first check is full; the cadence's next
      // tick, one height later, must check again.
      const bigBoxes = makeCaseBoxes(500, 1_000_000n);
      let httpCalls = 0;
      const cadence = createCadence({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: async (url: string, init?: RequestInit) => {
          httpCalls++;
          return buildStub(newCaseState(2000, bigBoxes))(url, init);
        },
        logger: () => {},
      });
      // First tick checks and the check is full.
      await cadence.tick(2000);
      const afterFirst = httpCalls;
      expect(afterFirst).toBeGreaterThan(0);
      // The very next template height — no gap — must check again.
      await cadence.tick(2001);
      expect(httpCalls).toBeGreaterThan(afterFirst);
    } finally { done(); }
  });

  it('a tick whose check fails still moves the height forward so the next due height checks', async () => {
    const { file, done } = setupKey();
    try {
      const boxes = makeCaseBoxes(MIN, 1_000_000n);
      let httpCalls = 0;
      let makeFail = true;
      const cadence = createCadence({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: async (url: string, init?: RequestInit) => {
          httpCalls++;
          const state = newCaseState(1000, boxes);
          if (makeFail) state.statusRefuse = true;
          return buildStub(state)(url, init);
        },
        logger: () => {},
      });
      await cadence.tick(1);                // first tick: /status refused
      const afterFirst = httpCalls;
      makeFail = false;
      await cadence.tick(1 + MIN);          // at the next due height the cadence checks again
      expect(httpCalls).toBeGreaterThan(afterFirst);
    } finally { done(); }
  });

  // MINING_INTERFACE → Consolidation → "A check runs once an interval, never inside a work window." —
  // on devnet the interval is 15. A below-interval stock keeps the check
  // idle, so the state's own interval is 15; the cadence is not due 14
  // heights above its first check, and is due 15 above it.
  it('on devnet the cadence does not check 14 heights later, and does check 15 later', async () => {
    const { file, done } = setupKey();
    try {
      const boxes = makeCaseBoxes(10, 1_000_000n);  // below devnet's 15
      let httpCalls = 0;
      const cadence = createCadence({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: async (url: string, init?: RequestInit) => {
          httpCalls++;
          return buildStub(newCaseState(1000, boxes, 'devnet'))(url, init);
        },
        logger: () => {},
      });
      // First tick: checks.
      await cadence.tick(1);
      const afterFirst = httpCalls;
      expect(afterFirst).toBeGreaterThan(0);
      // 14 heights above the first check: short of devnet's 15, no check.
      await cadence.tick(1 + 14);
      expect(httpCalls).toBe(afterFirst);
      // 15 heights above the first check: at devnet's interval, checks.
      await cadence.tick(1 + 15);
      expect(httpCalls).toBeGreaterThan(afterFirst);
    } finally { done(); }
  });

  // MINING_INTERFACE → Consolidation → "A check runs once an interval, never inside a work window." —
  // a first check whose `/status` read is refused reads no interval, so the
  // cadence keeps no state and the next height checks again.
  it('a first check whose /status read is refused leaves no interval; the next height checks again', async () => {
    const { file, done } = setupKey();
    try {
      const state = newCaseState(1000, []);
      state.refuseFirstStatus = true;  // only the first /status is refused
      const stub = buildStub(state);
      const cadence = createCadence({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: stub,
        logger: () => {},
      });
      await cadence.tick(1);               // first tick: /status refused
      const afterFirst = state.calls.length;
      await cadence.tick(2);               // next height: cadence has no state, must check
      expect(state.calls.length).toBeGreaterThan(afterFirst);
    } finally { done(); }
  });

  // MINING_INTERFACE → Consolidation → "A check runs once an interval, never inside a work window." —
  // on devnet the interval is 15; a check that reads it and fails
  // afterwards (/credits malformed) keeps it, so the cadence's next due
  // sits at `thatHeight + 15`.
  it('a later check that fails after reading the interval keeps the interval it read', async () => {
    const { file, done } = setupKey();
    try {
      const state = newCaseState(1000, [], 'devnet');  // interval 15
      const stub = buildStub(state);
      const cadence = createCadence({
        nodeUrl: 'http://stub',
        key: readMinerKey(file, null),
        httpFetch: stub,
        logger: () => {},
      });
      // First tick: /status OK, /credits OK, 0 boxes → idle. State's
      // interval is 15.
      await cadence.tick(1);
      const afterFirst = state.calls.length;

      // Break /credits for the second tick at the next due (1 + 15 = 16).
      // /status is still read (interval 15), /credits malformed → idle.
      // State's height moves to 16 and keeps the interval 15.
      state.listingMalformed = true;
      await cadence.tick(1 + 15);
      const afterSecond = state.calls.length;
      expect(afterSecond).toBeGreaterThan(afterFirst);

      // Restore /credits. A tick 14 above the second check is short of the
      // next due (16 + 15 = 31), so the cadence must not check. A tick at
      // 31 is at due, so it must check.
      state.listingMalformed = false;
      await cadence.tick(1 + 15 + 14);
      expect(state.calls.length).toBe(afterSecond);
      await cadence.tick(1 + 15 + 15);
      expect(state.calls.length).toBeGreaterThan(afterSecond);
    } finally { done(); }
  });
});
