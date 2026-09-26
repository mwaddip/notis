import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { EdwardsPoint } from '@noble/curves/abstract/edwards.js';
import { verifyEd25519, verifyEd25519Batch } from '../src/index.js';
import type { Ed25519BatchEntry } from '../src/index.js';
import { coefficientFrom, coefficientsOf, transcriptOf, windowBitsFor } from '../src/ed25519-batch.js';
import { RFC8032_VECTORS } from './rfc8032-vectors.js';

// verifyEd25519Batch — VALIDATION_INTERFACE → verifyEd25519Batch: `true` exactly when every entry
// passes `verifyEd25519`, checked as one cofactored equation under coefficients derived from the
// whole batch; total, the empty batch `true`, a batch of one `verifyEd25519` itself.

const Point = ed25519.Point;
const B = Point.BASE;
const L = Point.Fn.ORDER;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const modL = (x: bigint): bigint => ((x % L) + L) % L;

/** Little-endian bytes to a bigint. */
const leToBigInt = (b: Uint8Array): bigint => {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
  return v;
};

/** A bigint below 2^(8·len) to fixed-length little-endian bytes. */
const bigIntToLe = (value: bigint, len: number): Uint8Array => {
  const out = new Uint8Array(len);
  let v = value;
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

/** `LE32(n)`. */
const le32 = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};

/** `LE64(n)`, exact for `n` up to `Number.MAX_SAFE_INTEGER`. */
const le64 = (n: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
};

/** SHA-512 through Node's OpenSSL, apart from the implementation's `@noble/hashes`. */
const sha512 = (...parts: Uint8Array[]): Uint8Array => {
  const hash = createHash('sha512');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};

/** A nonzero scalar below `L`, fixed by a label. */
const scalarOf = (label: string): bigint => modL(leToBigInt(sha512(utf8(label))));

/**
 * The entry `(R ‖ S, message, A)` with `S = r + k·a`, `k = SHA-512(R ‖ A ‖ message) mod L` — an
 * Ed25519 signature made from its scalars. `A` is `a·B` plus whatever torsion the caller adds, `R`
 * likewise `r·B`.
 */
function signed(a: bigint, A: EdwardsPoint, r: bigint, R: EdwardsPoint, message: Uint8Array): Ed25519BatchEntry {
  const publicKey = A.toBytes();
  const rBytes = R.toBytes();
  const k = modL(leToBigInt(sha512(rBytes, publicKey, message)));
  const signature = new Uint8Array(64);
  signature.set(rBytes, 0);
  signature.set(bigIntToLe(modL(r + k * a), 32), 32);
  return { signature, message, publicKey };
}

/** An entry with one field replaced. */
const withField = (entry: Ed25519BatchEntry, field: keyof Ed25519BatchEntry, value: unknown): Ed25519BatchEntry =>
  ({ ...entry, [field]: value }) as Ed25519BatchEntry;

/** The entry with bit 0 of its message's first byte flipped (a 1-byte message where it had none). */
const badMessage = (entry: Ed25519BatchEntry): Ed25519BatchEntry => {
  const message = entry.message.length > 0 ? new Uint8Array(entry.message) : new Uint8Array(1);
  message[0] = message[0]! ^ 1;
  return withField(entry, 'message', message);
};

// ---------------------------------------------------------------------------
// The honest corpus: key (a₀ + i)·B, nonce (r₀ + i)·B, a 32-byte message — a distinct key per entry,
// so a batch of n makes 2n + 1 points.
// ---------------------------------------------------------------------------

const HONEST_A0 = scalarOf('ed25519-batch honest key');
const HONEST_R0 = scalarOf('ed25519-batch honest nonce');
const honestCorpus: Ed25519BatchEntry[] = [];
let honestA = B.multiply(HONEST_A0);
let honestR = B.multiply(HONEST_R0);

/** The first `n` entries of the honest corpus. */
function honest(n: number): Ed25519BatchEntry[] {
  while (honestCorpus.length < n) {
    const i = BigInt(honestCorpus.length);
    const message = sha512(utf8(`ed25519-batch honest message ${i}`)).slice(0, 32);
    honestCorpus.push(signed(modL(HONEST_A0 + i), honestA, modL(HONEST_R0 + i), honestR, message));
    honestA = honestA.add(B);
    honestR = honestR.add(B);
  }
  return honestCorpus.slice(0, n);
}

// ---------------------------------------------------------------------------
// The vendored Wycheproof and speccheck vectors, and the four RFC 8032 vectors.
// ---------------------------------------------------------------------------

interface Vector {
  readonly name: string;
  readonly entry: Ed25519BatchEntry;
}

const readVectors = (file: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./vectors/${file}`, import.meta.url)), 'utf8'));

interface WycheproofFile {
  testGroups: Array<{
    publicKey: { pk: string };
    tests: Array<{ tcId: number; msg: string; sig: string; result: string }>;
  }>;
}
interface SpeccheckCase {
  message: string;
  pub_key: string;
  signature: string;
}

const WYCHEPROOF: Array<Vector & { readonly result: string }> = (
  readVectors('ed25519_test.json') as WycheproofFile
).testGroups.flatMap((group) =>
  group.tests.map((t) => ({
    name: `Wycheproof #${t.tcId}`,
    result: t.result,
    entry: { signature: unhex(t.sig), message: unhex(t.msg), publicKey: unhex(group.publicKey.pk) },
  })),
);

const SPECCHECK: Vector[] = (readVectors('cases.json') as SpeccheckCase[]).map((c, i) => ({
  name: `speccheck case ${i}`,
  entry: { signature: unhex(c.signature), message: unhex(c.message), publicKey: unhex(c.pub_key) },
}));

const RFC8032: Vector[] = RFC8032_VECTORS.map((v) => ({
  name: `RFC 8032 ${v.name}`,
  entry: { signature: v.signature, message: v.message, publicKey: v.publicKey },
}));

const single = (e: Ed25519BatchEntry): boolean => verifyEd25519(e.signature, e.message, e.publicKey);

/** The entry alone, and among four honest signatures first, in the middle and last. */
function batchesAround(entry: Ed25519BatchEntry): Ed25519BatchEntry[][] {
  const [h0, h1, h2, h3] = honest(4) as [Ed25519BatchEntry, Ed25519BatchEntry, Ed25519BatchEntry, Ed25519BatchEntry];
  return [
    [entry],
    [entry, h0, h1, h2, h3],
    [h0, h1, entry, h2, h3],
    [h0, h1, h2, h3, entry],
  ];
}

describe('verifyEd25519Batch', () => {
  describe('every vector, alone and among honest signatures, answers exactly verifyEd25519', () => {
    it('reads 4 RFC 8032 vectors, 151 Wycheproof and 12 speccheck cases', () => {
      expect(RFC8032.length).toBe(4);
      expect(WYCHEPROOF.length).toBe(151);
      expect(SPECCHECK.length).toBe(12);
    });

    it('the single check accepts every RFC 8032 vector, agrees with every Wycheproof label and reads speccheck as --VVVV------', () => {
      expect(RFC8032.every(({ entry }) => single(entry))).toBe(true);
      for (const { name, entry, result } of WYCHEPROOF) {
        expect(single(entry), name).toBe(result === 'valid');
      }
      expect(SPECCHECK.map(({ entry }) => (single(entry) ? 'V' : '-')).join('')).toBe('--VVVV------');
    });

    it.each([...RFC8032, ...WYCHEPROOF, ...SPECCHECK])('$name', ({ entry }) => {
      const expected = single(entry);
      for (const batch of batchesAround(entry)) {
        expect(verifyEd25519Batch(batch)).toBe(expected);
      }
    });
  });

  describe('the crafted rows — torsion in R or A — answer as the single check does', () => {
    // The cofactored equation clears an order-8 component, so each row passes the single check;
    // the batch clears it the same way (VALIDATION_INTERFACE → verifyEd25519Batch).
    const T8 = Point.fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a');
    const T2 = Point.fromHex('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f');
    const message = utf8('notis mixed-order probe');

    it('T8 has order 8 and T2 order 2', () => {
      expect(T8.isSmallOrder()).toBe(true);
      expect(T8.double().double().is0()).toBe(false);
      expect(T2.is0()).toBe(false);
      expect(T2.double().is0()).toBe(true);
    });

    /** `A = a·B + T2` over nonces `r·B` until `k`'s parity is `parity`. */
    const mixedOrderA = (parity: bigint): Ed25519BatchEntry => {
      const a = scalarOf('mixed-order A key');
      const A = B.multiply(a).add(T2);
      expect(A.isSmallOrder()).toBe(false);
      expect(A.isTorsionFree()).toBe(false);
      for (let j = 0; j < 64; j++) {
        const r = scalarOf(`mixed-order A nonce ${j}`);
        const entry = signed(a, A, r, B.multiply(r), message);
        if (leToBigInt(sha512(entry.signature.subarray(0, 32), entry.publicKey, message)) % L % 2n === parity) return entry;
      }
      throw new Error('no nonce gave the parity');
    };

    const rows: Array<[string, () => Ed25519BatchEntry]> = [
      [
        'mixed-order R: R = r·B + T8, S = r + k·a',
        () => {
          const a = scalarOf('mixed-order R key');
          const r = scalarOf('mixed-order R nonce');
          const R = B.multiply(r).add(T8);
          expect(R.isSmallOrder()).toBe(false);
          expect(R.isTorsionFree()).toBe(false);
          return signed(a, B.multiply(a), r, R, message);
        },
      ],
      ['mixed-order A: A = a·B + T2, k even', () => mixedOrderA(0n)],
      ['mixed-order A: A = a·B + T2, k odd', () => mixedOrderA(1n)],
      [
        'small-order R: R = T8, S = k·a',
        () => {
          const a = scalarOf('small-order R key');
          return signed(a, B.multiply(a), 0n, T8, message);
        },
      ],
    ];

    it.each(rows)('%s', (_label, build) => {
      const entry = build();
      expect(single(entry)).toBe(true);
      for (const batch of batchesAround(entry)) {
        expect(verifyEd25519Batch(batch)).toBe(true);
      }
    });

    it('one mixed-order key over two signatures — k even and k odd — enters the sum once', () => {
      // The key's scalar is Σ zᵢ·kᵢ mod L; the reduction moves its T2 component, which [8] clears.
      const even = mixedOrderA(0n);
      const odd = mixedOrderA(1n);
      expect(hex(even.publicKey)).toBe(hex(odd.publicKey));
      expect(verifyEd25519Batch([even, odd])).toBe(true);
      expect(verifyEd25519Batch([even, ...honest(3), odd])).toBe(true);
      expect(verifyEd25519Batch([even, badMessage(odd)])).toBe(false);
    });
  });

  describe('honest batches pass', () => {
    it('the honest corpus is honest: OpenSSL and verifyEd25519 accept its entries one at a time', () => {
      const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
      for (const entry of honest(64)) {
        const key = createPublicKey({
          key: Buffer.concat([SPKI_ED25519_PREFIX, entry.publicKey]),
          format: 'der',
          type: 'spki',
        });
        expect(cryptoVerify(null, entry.message, key, entry.signature)).toBe(true);
        expect(single(entry)).toBe(true);
      }
    });

    it.each([0, 1, 2, 64])('%i entries', (n) => {
      expect(verifyEd25519Batch(honest(n))).toBe(true);
    });

    // A threshold is a point count where the bucket window widens; distinct keys make a batch of
    // n entries 2n + 1 points, so n = t/2 − 1 and n = t/2 sit on either side of threshold t.
    it.each([64, 512, 4096, 20000])(
      'either side of the %i-point window threshold, and one bad entry on the far side refuses',
      (threshold) => {
        const below = threshold / 2 - 1;
        const above = threshold / 2;
        expect(windowBitsFor(2 * below + 1)).toBeLessThan(windowBitsFor(2 * above + 1));
        expect(verifyEd25519Batch(honest(below))).toBe(true);
        const batch = honest(above);
        expect(verifyEd25519Batch(batch)).toBe(true);
        batch[above - 1] = badMessage(batch[above - 1]!);
        expect(verifyEd25519Batch(batch)).toBe(false);
      },
      120_000,
    );
  });

  describe('one bad entry refuses the batch', () => {
    const corruptions: Array<[string, (entry: Ed25519BatchEntry, other: Ed25519BatchEntry) => Ed25519BatchEntry]> = [
      ['its message changed', (e) => badMessage(e)],
      [
        'S + 1',
        (e) => {
          const signature = new Uint8Array(e.signature);
          signature.set(bigIntToLe(modL(leToBigInt(e.signature.subarray(32, 64)) + 1n), 32), 32);
          return withField(e, 'signature', signature);
        },
      ],
      [
        'another honest signature\'s R',
        (e, other) => {
          const signature = new Uint8Array(e.signature);
          signature.set(other.signature.subarray(0, 32), 0);
          return withField(e, 'signature', signature);
        },
      ],
      ['another honest key', (e, other) => withField(e, 'publicKey', other.publicKey)],
    ];
    const positions: Array<[string, number]> = [
      ['first', 0],
      ['in the middle', 31],
      ['last', 63],
    ];

    type Corrupt = (typeof corruptions)[number][1];
    const cases = corruptions.flatMap(([what, corrupt]) =>
      positions.map(([where, i]): [string, string, number, Corrupt] => [what, where, i, corrupt]),
    );

    it.each(cases)(
      '%s, %s',
      (_what, _where, i, corrupt) => {
        const batch = honest(64);
        const bad = corrupt(batch[i]!, honest(65)[64]!);
        expect(single(bad)).toBe(false);
        batch[i] = bad;
        expect(verifyEd25519Batch(batch)).toBe(false);
      },
    );

    it('two entries whose errors cancel under equal coefficients', () => {
      // S₀ + δ and S₁ − δ: the unweighted sum of the two errors is zero, the weighted one is not.
      const [e0, e1, ...rest] = honest(8) as [Ed25519BatchEntry, Ed25519BatchEntry, ...Ed25519BatchEntry[]];
      const shifted = (e: Ed25519BatchEntry, delta: bigint): Ed25519BatchEntry => {
        const signature = new Uint8Array(e.signature);
        signature.set(bigIntToLe(modL(leToBigInt(e.signature.subarray(32, 64)) + delta), 32), 32);
        return withField(e, 'signature', signature);
      };
      const delta = scalarOf('cancelling delta');
      const b0 = shifted(e0, delta);
      const b1 = shifted(e1, -delta);
      expect(single(b0)).toBe(false);
      expect(single(b1)).toBe(false);
      expect(verifyEd25519Batch([b0, b1])).toBe(false);
      expect(verifyEd25519Batch([b0, ...rest, b1])).toBe(false);
    });
  });

  describe('shared keys and repeated entries', () => {
    // A key several entries share is decoded once and enters the sum once, its coefficients added
    // (VALIDATION_INTERFACE → verifyEd25519Batch).
    const a = scalarOf('one key');
    const A = B.multiply(a);
    const byOneKey = (count: number): Ed25519BatchEntry[] =>
      Array.from({ length: count }, (_, j) => {
        const r = scalarOf(`one key nonce ${j}`);
        return signed(a, A, r, B.multiply(r), utf8(`one key message ${j}`));
      });

    it('one key over many messages passes, and one bad message among them refuses', () => {
      const batch = byOneKey(40);
      expect(verifyEd25519Batch(batch)).toBe(true);
      batch[17] = badMessage(batch[17]!);
      expect(verifyEd25519Batch(batch)).toBe(false);
    });

    it('shared keys interleaved with distinct ones pass, and one bad entry refuses', () => {
      const shared = byOneKey(6);
      const distinct = honest(6);
      const batch = shared.flatMap((e, j) => [e, distinct[j]!]);
      expect(verifyEd25519Batch(batch)).toBe(true);
      batch[4] = badMessage(batch[4]!);
      expect(verifyEd25519Batch(batch)).toBe(false);
    });

    it('a repeated entry passes; a repeated bad entry refuses', () => {
      const [e0, e1] = honest(2) as [Ed25519BatchEntry, Ed25519BatchEntry];
      expect(verifyEd25519Batch([e0, e0])).toBe(true);
      expect(verifyEd25519Batch([e0, e1, e0, e1, e0])).toBe(true);
      const bad = badMessage(e1);
      expect(verifyEd25519Batch([bad, bad])).toBe(false);
      expect(verifyEd25519Batch([e0, bad, e0, bad])).toBe(false);
    });
  });

  describe('totality — a malformed batch answers false, never a throw', () => {
    // VALIDATION_INTERFACE → verifyEd25519Batch → "It is total".
    const answers = (entries: unknown): boolean => {
      let result: boolean | undefined;
      expect(() => {
        result = verifyEd25519Batch(entries as ReadonlyArray<Ed25519BatchEntry>);
      }).not.toThrow();
      return result!;
    };

    it('the empty batch is true', () => {
      expect(answers([])).toBe(true);
    });

    it('a batch that is not an array is false', () => {
      for (const notArray of [null, undefined, 42, 'entries', {}, { length: 2 }, new Uint8Array(2)]) {
        expect(answers(notArray)).toBe(false);
      }
    });

    it('an entry that is not an object, or a hole, is false alone and among honest entries', () => {
      const [h0, h1] = honest(2) as [Ed25519BatchEntry, Ed25519BatchEntry];
      for (const notEntry of [null, undefined, 42, 'entry', {}]) {
        expect(answers([notEntry])).toBe(false);
        expect(answers([notEntry, h0, h1])).toBe(false);
        expect(answers([h0, notEntry, h1])).toBe(false);
        expect(answers([h0, h1, notEntry])).toBe(false);
      }
      expect(answers([h0, , h1])).toBe(false);
    });

    const [valid] = honest(1) as [Ed25519BatchEntry];
    const malformed: Array<[string, Ed25519BatchEntry]> = [
      ['a 63-byte signature', withField(valid, 'signature', valid.signature.slice(0, 63))],
      ['a 65-byte signature', withField(valid, 'signature', Uint8Array.from([...valid.signature, 0]))],
      ['a 31-byte key', withField(valid, 'publicKey', valid.publicKey.slice(0, 31))],
      ['a 33-byte key', withField(valid, 'publicKey', Uint8Array.from([...valid.publicKey, 0]))],
      ...(['signature', 'message', 'publicKey'] as const).flatMap((field) =>
        (
          [
            ['a string', 'abc'],
            ['null', null],
            ['an array of numbers', [...valid[field]]],
            ['a Uint16Array of the same bytes', new Uint16Array(valid[field].slice().buffer)],
            ['a DataView of the same bytes', new DataView(valid[field].slice().buffer)],
          ] as Array<[string, unknown]>
        ).map(([what, value]): [string, Ed25519BatchEntry] => [`${what} as the ${field}`, withField(valid, field, value)]),
      ),
    ];

    it.each(malformed)('%s: false alone and first, in the middle or last among honest entries', (_label, entry) => {
      const [h0, h1] = honest(3).slice(1) as [Ed25519BatchEntry, Ed25519BatchEntry];
      expect(single(entry)).toBe(false);
      expect(answers([entry])).toBe(false);
      expect(answers([entry, h0, h1])).toBe(false);
      expect(answers([h0, entry, h1])).toBe(false);
      expect(answers([h0, h1, entry])).toBe(false);
    });

    it('each field as a Buffer answers as verifyEd25519 does — true', () => {
      const [h0, h1] = honest(3).slice(1) as [Ed25519BatchEntry, Ed25519BatchEntry];
      for (const field of ['signature', 'message', 'publicKey'] as const) {
        const entry = withField(valid, field, Buffer.from(valid[field]));
        expect(single(entry)).toBe(true);
        expect(answers([entry])).toBe(true);
        expect(answers([h0, entry, h1])).toBe(true);
      }
    });

    it('each field as another realm\'s Uint8Array answers as verifyEd25519 does — false', () => {
      const [h0, h1] = honest(3).slice(1) as [Ed25519BatchEntry, Ed25519BatchEntry];
      for (const field of ['signature', 'message', 'publicKey'] as const) {
        const foreign = runInNewContext(`new Uint8Array(${valid[field].length})`) as Uint8Array;
        foreign.set(valid[field]);
        expect(foreign instanceof Uint8Array).toBe(false);
        const entry = withField(valid, field, foreign);
        expect(single(entry)).toBe(false);
        expect(answers([entry])).toBe(false);
        expect(answers([h0, entry, h1])).toBe(false);
      }
    });

    describe('a well-shaped entry the strict checks refuse, among honest entries', () => {
      const P_LE = unhex('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'); // y = p
      const IDENTITY_SIGNED = unhex('0100000000000000000000000000000000000000000000000000000000000080'); // x = 0, sign bit set
      /** The first y ≥ 2 whose encoding is below p but on no point of the curve. */
      const offCurve = ((): Uint8Array => {
        for (let y = 2n; ; y++) {
          const bytes = bigIntToLe(y, 32);
          try {
            Point.fromBytes(bytes, false);
          } catch {
            return bytes;
          }
        }
      })();
      const withR = (rBytes: Uint8Array): Ed25519BatchEntry => {
        const signature = new Uint8Array(valid.signature);
        signature.set(rBytes, 0);
        return withField(valid, 'signature', signature);
      };
      const withS = (s: bigint): Ed25519BatchEntry => {
        const signature = new Uint8Array(valid.signature);
        signature.set(bigIntToLe(s, 32), 32);
        return withField(valid, 'signature', signature);
      };

      const refused: Array<[string, Ed25519BatchEntry]> = [
        ['a key with y = p', withField(valid, 'publicKey', P_LE)],
        ['a key with y < p on no point', withField(valid, 'publicKey', offCurve)],
        ['a key with x = 0 and the sign bit set', withField(valid, 'publicKey', IDENTITY_SIGNED)],
        ['a small-order key (the identity)', withField(valid, 'publicKey', bigIntToLe(1n, 32))],
        ['R with y = p', withR(P_LE)],
        ['R with y < p on no point', withR(offCurve)],
        ['R with x = 0 and the sign bit set', withR(IDENTITY_SIGNED)],
        ['S = L', withS(L)],
        ['S + L in place of S', withS(leToBigInt(valid.signature.subarray(32, 64)) + L)],
        ['S = 2²⁵⁶ − 1', withS((1n << 256n) - 1n)],
      ];

      it.each(refused)('%s: false, as the single check', (_label, entry) => {
        const [h0, h1] = honest(3).slice(1) as [Ed25519BatchEntry, Ed25519BatchEntry];
        expect(single(entry)).toBe(false);
        expect(answers([entry])).toBe(false);
        expect(answers([entry, h0, h1])).toBe(false);
        expect(answers([h0, entry, h1])).toBe(false);
        expect(answers([h0, h1, entry])).toBe(false);
      });
    });
  });

  describe('the coefficients, derived from the batch', () => {
    // VALIDATION_INTERFACE → verifyEd25519Batch → "The coefficients are derived from the batch, never
    // drawn": T = SHA-512("dagsocial/ed25519-batch/1" ‖ LE32(n) ‖ for each entry: signature(64) ‖
    // publicKey(32) ‖ LE64(|message|) ‖ message), zᵢ = LE(SHA-512(T ‖ LE32(i))[0..16]), a zero taken
    // as 1. The literals are that layout over the four RFC 8032 vectors, hashed apart from this repo's
    // code (Python's hashlib); the test recomputes each with Node's createHash as well.
    const FIXED = RFC8032.map(({ entry }) => entry);
    const PINNED_T =
      '498a62fd7efd9c29740064165ea8884520897dc1438602da0ef6aab22774aba191af7fa7159eebcc4d11e1ce2813427d2743bd85c0247e922e36990654b1da76';
    const PINNED_Z = [
      0x620155d87ae8df414ea2ecee430f12dcn,
      0x127689d789613eef0be4403bc19b25fn,
      0x1c384e8a4050af78435e1fbd084e0685n,
      0x8785d2ffc562ee01b0014204e006769bn,
    ];

    const transcriptHere = (entries: Ed25519BatchEntry[]): Uint8Array =>
      sha512(
        utf8('dagsocial/ed25519-batch/1'),
        le32(entries.length),
        ...entries.flatMap((e) => [e.signature, e.publicKey, le64(e.message.length), e.message]),
      );
    const coefficientHere = (transcript: Uint8Array, i: number): bigint => {
      const z = leToBigInt(sha512(transcript, le32(i)).subarray(0, 16));
      return z === 0n ? 1n : z;
    };

    it('the transcript of a fixed batch is pinned', () => {
      expect(hex(transcriptHere(FIXED))).toBe(PINNED_T);
      expect(hex(transcriptOf(FIXED))).toBe(PINNED_T);
    });

    it('its coefficients are pinned', () => {
      const t = unhex(PINNED_T);
      expect(PINNED_Z.map((_, i) => coefficientHere(t, i))).toEqual(PINNED_Z);
      expect(coefficientsOf(t, 4)).toEqual(PINNED_Z);
    });

    it('the transcript binds the entries, their order and their count', () => {
      const batch = honest(5);
      const t = hex(transcriptOf(batch));
      expect(t).toBe(hex(transcriptHere(batch)));
      expect(hex(transcriptOf([...batch].reverse()))).not.toBe(t);
      expect(hex(transcriptOf(batch.slice(0, 4)))).not.toBe(t);
      expect(hex(transcriptOf([badMessage(batch[0]!), ...batch.slice(1)]))).not.toBe(t);
    });

    it('a coefficient is its digest\'s first 16 bytes little-endian, a zero taken as 1', () => {
      const digest = new Uint8Array(64);
      expect(coefficientFrom(digest)).toBe(1n);
      digest.fill(0xff, 16);
      expect(coefficientFrom(digest)).toBe(1n);
      digest[0] = 2;
      expect(coefficientFrom(digest)).toBe(2n);
      digest[15] = 0x80;
      expect(coefficientFrom(digest)).toBe((1n << 127n) + 2n);
      expect(coefficientFrom(new Uint8Array(64).fill(0xff))).toBe((1n << 128n) - 1n);
    });

    it('a batch answers the same across repeated calls, and leaves its entries unchanged', () => {
      const passing = honest(12);
      const failing = honest(12);
      failing[5] = badMessage(failing[5]!);
      const snapshot = [...passing, ...failing].map((e) => hex(e.signature) + hex(e.message) + hex(e.publicKey));
      for (let round = 0; round < 3; round++) {
        expect(verifyEd25519Batch(passing)).toBe(true);
        expect(verifyEd25519Batch(failing)).toBe(false);
      }
      expect([...passing, ...failing].map((e) => hex(e.signature) + hex(e.message) + hex(e.publicKey))).toEqual(snapshot);
    });
  });
});
