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

// MINING_INTERFACE → Consolidation → "A check runs every `CONSOLIDATE_MIN_BOXES` heights, never inside a work window." —
// the value in `CONSTANTS → Producer policy` (100), restated in the file
// for assertions that keyword it rather than the module.
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
}

function buildStub(state: StubState): HttpFetch {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init!.body : null;
    state.calls.push({ method, url, body });
    const u = new URL(url);
    if (u.pathname === '/status') {
      if (state.statusRefuse) {
        return new Response('upstream', { status: 500 });
      }
      return json({
        networkType: 'devnet',
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

function newCaseState(tip: number, boxes: readonly StubBox[]): StubState {
  const profile = profileFor('devnet');
  const schedule = profile.protocolVersionSchedule;
  const protocolVersion = protocolVersionAt(schedule, tip + 1)!;
  return {
    tip,
    protocolVersion,
    boxes,
    calls: [],
    posts: [],
    postAnswer: { status: 200, body: { status: 'pending', txId: 'aa'.repeat(32), expiresAtHeight: tip + 60 } },
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

  it('at the minimum spendable the check posts one transaction', async () => {
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
      expect(lines).toEqual([]);
      expect(outcome.sent).toBe(true);
      expect(outcome.inputCount).toBe(MIN);
      expect(state.posts).toHaveLength(1);
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
});
