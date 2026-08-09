/**
 * TS ↔ JS mirror: the demo UI must encode posts, boxes and transactions
 * byte-identically to `@dagsocial/types` (audit M-1, Spec G, positional format).
 *
 * The demo UI (`public/index.html`) mines PoW, signs, and computes post, box and
 * transaction ids in the browser; the node verifies all three. If the two
 * encodings drift, every post and every transaction minted from the UI is
 * rejected — and no unit test in either package would notice, because neither
 * exercises the other's code.
 *
 * This test closes that gap without a browser: it reads `index.html`, extracts
 * the actual crypto declarations from it, evaluates them, and asserts they
 * reproduce the golden vectors frozen in the types tests.
 *
 * **Why the UI is not simply importing the library.** It would remove this drift
 * class outright, but it means giving `index.html` a build step, and the demo UI
 * is scaffolding until `@dagsocial/web` lands (user decision, 2026-08-09). So the
 * mirror stays hand-written and this test stays the thing that polices it; both
 * die with the UI.
 *
 * The UI's `blake2b` comes from the `blakejs` CDN module, which is not
 * installed here, so it is injected as a Node `blake2b512` shim. Both are plain
 * BLAKE2b-512 — the equivalence the project already relies on (see CLAUDE.md,
 * "Platform constraint"). What this test pins is the *encoding*, which is where
 * the two implementations can actually diverge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  computePostId, signingHash, postPowPreimage, computeBoxId, computeTxId,
  computeCandidateBoxId, canonicalBoxBytes, MAX_PARENT_REFS,
} from '@dagsocial/types';
import type {
  CandidateOf,
  Post, KarmaBox, CreditBox, InviteBox, BondBox, PostLockBox, VouchBox,
  AnyBox, UtxoTransaction,
} from '@dagsocial/types';

const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

// ---------------------------------------------------------------------------
// Golden vector — must stay identical to packages/types/test/post.test.ts
// ---------------------------------------------------------------------------

const GOLDEN_AUTHOR = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_AUTHOR[i] = i;
const GOLDEN_CHALLENGE = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_CHALLENGE[i] = 0x20 + i;

/** A well-formed `b32` parent ref: 64 lowercase hex characters. */
const GOLDEN_REF = '11'.repeat(32);

const GOLDEN_POST: Post = {
  content: 'dagsocial golden vector ✓',
  author: GOLDEN_AUTHOR,
  parentRefs: [GOLDEN_REF],
  challenge: GOLDEN_CHALLENGE,
  powNonce: 4294967296,     // 2^32 — five VLQ bytes, so the wide path is covered
  protocolVersion: 1,
  timestamp: 1767225600000, // > 2^32 — six VLQ bytes
  signature: new Uint8Array(64).fill(0xcd),
};

const GOLDEN_SIGNING_HASH =
  '3143d7a351cf2bb4cdbca49ba7aa994ce2e4fd1638a9322058d03fe87debc6b0';
const GOLDEN_POST_ID =
  'fefac701207339ba5953fdfe98ed6212f7ead3025dc6e718878dc465ca06e8b0';

// ---------------------------------------------------------------------------
// Golden box vectors — must stay identical to packages/types/test/utxo.test.ts
// (positional: enum8(boxType) ‖ vlqU(value) ‖ per-type, no `guard` — C10)
// ---------------------------------------------------------------------------

const GOLDEN_KARMA_CANDIDATE: CandidateOf<KarmaBox> = {
  boxType: 'karma',
  value: 100n,
  owner: GOLDEN_AUTHOR,
  guard: 'owner_signature',
  proofSource: 'genesis',
};

const GOLDEN_CREDIT_CANDIDATE: CandidateOf<CreditBox> = {
  boxType: 'credit',
  value: 123456789n * 10n ** 8n,  // 12_345_678_900_000_000 > 2^53 — the range P0 exists for
  owner: GOLDEN_AUTHOR,
  guard: 'owner_signature',
  proofSource: 70000,             // > 65536 — a three-byte ZigZag VLQ
};

const GOLDEN_UTXO_TX: UtxoTransaction = {
  inputs: ['1111111111111111111111111111111111111111111111111111111111111111'],
  outputs: [GOLDEN_KARMA_CANDIDATE, GOLDEN_CREDIT_CANDIDATE],
  signatures: {},
  protocolVersion: 1,
};

const GOLDEN_KARMA_BOX_ID =
  '4ac16757cfa8adb833a281bd48b917478457a93e21cc7b90cc7bb93cc03f423c';
const GOLDEN_CREDIT_BOX_ID =
  '38d81346e5a47c6043f51e1e15aee5c6048aec92b5eb07c14003ccbcd4bb2bc5';
const GOLDEN_UTXO_TX_ID =
  '09b0c0e3fb832cd886114f0d099ec751537cef8377d7bc5a935f1ddf9c8eef62';

/**
 * The exact canonical bytes for the two golden candidates, frozen. Stronger
 * than the ids: a hash says "something moved", these say *which byte*. Read
 * them against TYPES_INTERFACE → Layout — Boxes, field by field.
 */
const GOLDEN_KARMA_BOX_BYTES =
  '00' +                                                               // enum8 karma
  '64' +                                                               // vlqU value 100
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 owner
  '07' + '67656e65736973' +                                            // lpUtf8 'genesis'
  '00';                                                                // opt decayBurn absent

const GOLDEN_CREDIT_BOX_BYTES =
  '01' +                                                               // enum8 credit
  '80eae1eac58af715' +                                                 // vlqU value
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 owner
  'e0c508' +                                                           // vlqS 70000
  '00';                                                                // opt lockedUntilBlock absent

/** The candidates as block application materializes them out of GOLDEN_UTXO_TX. */
const GOLDEN_KARMA_BOX: KarmaBox =
  { ...GOLDEN_KARMA_CANDIDATE, txId: GOLDEN_UTXO_TX_ID, index: 0 };
const GOLDEN_CREDIT_BOX: CreditBox =
  { ...GOLDEN_CREDIT_CANDIDATE, txId: GOLDEN_UTXO_TX_ID, index: 1 };

// ---------------------------------------------------------------------------
// Spec G provenance vectors.
//
// The provenance is the real one for these boxes: GOLDEN_UTXO_TX creates the
// karma box at index 0 and the credit box at index 1. Values measured from
// `computeCandidateBoxId` in @dagsocial/types, so both implementations are
// pinned to a constant rather than only to each other.
//
// `GOLDEN_KARMA_CANDIDATE_ID` equals `GOLDEN_KARMA_BOX_ID` above, and that is
// phase G3b's whole point rather than a copy-paste slip: `computeBoxId` IS
// `computeCandidateBoxId` applied to the box's own provenance, so the "legacy"
// and "candidate" ids collapsed into one derivation on both sides.
// ---------------------------------------------------------------------------

const GOLDEN_KARMA_CANDIDATE_ID =            // (GOLDEN_UTXO_TX_ID, index 0)
  '4ac16757cfa8adb833a281bd48b917478457a93e21cc7b90cc7bb93cc03f423c';
const GOLDEN_CREDIT_CANDIDATE_ID =           // (GOLDEN_UTXO_TX_ID, index 1)
  '38d81346e5a47c6043f51e1e15aee5c6048aec92b5eb07c14003ccbcd4bb2bc5';
const GOLDEN_KARMA_CANDIDATE_ID_WIDE_INDEX = // index 0x12345678 — five VLQ bytes
  'ca5af4ec56635f8b1731eec592e59bda4a8f0332ee7f75a8a13e44769b9a1fd0';
const GOLDEN_KARMA_CANDIDATE_ID_SENTINEL =   // any index outside the vlqU domain
  '555fa23925e32ddc4adb61422588088a410ea2196d05349d82b3034e197ad7f2';

// ---------------------------------------------------------------------------
// One fixture per box type (Spec G phase E3)
//
// Both mirror blocks encoded karma and credit only, which is how a missing
// binary-field conversion survived on `VouchBox`: with no vouch box ever encoded
// through both implementations, nothing could observe that the UI wrote
// `voucherId` in the wrong form. Same shape as phase C §4.2 — B3 round-tripped
// only a karma box, so an in-range tag at 0x03 could not collide with karma.
//
// Every type is now encoded through both implementations in both forms, so the
// next omission fails here instead of needing review to catch. Distinct fill
// bytes per field so a transposition is visible too.
// ---------------------------------------------------------------------------

/**
 * Provenance for the four per-type coverage fixtures below.
 *
 * They are NOT outputs of `GOLDEN_UTXO_TX` — that transaction creates the karma
 * box at index 0 and the credit box at index 1 and nothing else — so they carry
 * their own synthetic creating transaction rather than claiming an index of one
 * that has no output there.
 */
const COVERAGE_TX_ID = 'de'.repeat(32);

const BYTES_SECRET = new Uint8Array(32).fill(0xa1);
const BYTES_INVITEE = new Uint8Array(32).fill(0xb2);
const BYTES_TARGET = new Uint8Array(32).fill(0xc3);

const GOLDEN_INVITE_BOX: InviteBox = {
  boxType: 'invite', value: 10n,
  secretHash: BYTES_SECRET, inviterId: GOLDEN_AUTHOR, guard: 'hash_preimage_with_bond',
  txId: COVERAGE_TX_ID, index: 0,
};

const GOLDEN_BOND_BOX: BondBox = {
  boxType: 'bond', value: 5n,
  inviterId: GOLDEN_AUTHOR,
  inviteOutputIndex: 1,
  inviteePublicKey: BYTES_INVITEE,
  probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual',
  txId: COVERAGE_TX_ID, index: 1,
};

const GOLDEN_POST_LOCK_BOX: PostLockBox = {
  boxType: 'post_lock', value: 8n,
  originalValue: 10n, owner: GOLDEN_AUTHOR, targetPostId: GOLDEN_POST_ID,
  guard: 'block_apply',
  txId: COVERAGE_TX_ID, index: 2,
};

const GOLDEN_VOUCH_BOX: VouchBox = {
  boxType: 'vouch', value: 1n,
  voucherId: GOLDEN_AUTHOR, targetId: BYTES_TARGET, guard: 'owner_signature',
  txId: COVERAGE_TX_ID, index: 3,
};

/**
 * The bond as invite creation emits it: `inviteePublicKey` **empty**, meaning
 * unclaimed. It is the only 0-or-32 field in any box, `opt(b32)` is the only
 * option-shaped field in the box arms, and until now no fixture anywhere
 * exercised the absent branch through both implementations — which is exactly
 * how a `b32` in that slot survived review and killed the whole invite path in
 * production. One fixture per branch, so the next one cannot.
 */
const GOLDEN_BOND_BOX_UNCLAIMED: BondBox = {
  ...GOLDEN_BOND_BOX,
  inviteePublicKey: new Uint8Array(0),
  index: 4,
};

const ALL_BOX_TYPES: ReadonlyArray<{ name: string; box: AnyBox }> = [
  { name: 'karma', box: GOLDEN_KARMA_BOX },
  { name: 'credit', box: GOLDEN_CREDIT_BOX },
  { name: 'invite', box: GOLDEN_INVITE_BOX },
  { name: 'bond', box: GOLDEN_BOND_BOX },
  { name: 'bond (unclaimed)', box: GOLDEN_BOND_BOX_UNCLAIMED },
  { name: 'post_lock', box: GOLDEN_POST_LOCK_BOX },
  { name: 'vouch', box: GOLDEN_VOUCH_BOX },
];

/**
 * The tx-builder form of a box: every `Uint8Array` field as a hex string, which
 * is how the UI's builders carry keys (`pubKeyHex`, `secretHashHex`).
 *
 * Derived mechanically rather than hand-written, so a `Uint8Array` field added
 * to any box type is covered here without anyone remembering to update a
 * fixture — which is the failure this whole block exists to prevent.
 */
function toUiForm(box: AnyBox): Record<string, unknown> {
  return Object.fromEntries(Object.entries(box).map(
    ([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v],
  ));
}

// ---------------------------------------------------------------------------
// Extract the UI's crypto declarations from index.html
// ---------------------------------------------------------------------------

/**
 * Return the source of a top-level declaration, brace-matched from its header.
 *
 * Skips braces inside string literals and comments so a future comment or
 * string containing `{`/`}` cannot truncate the slice.
 */
function extractDeclaration(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`index.html no longer declares: ${header}`);

  const open = src.indexOf('{', start);
  if (open === -1) throw new Error(`no body found for: ${header}`);

  let depth = 0;
  let quote: string | null = null;
  let comment: 'line' | 'block' | null = null;

  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (comment === 'line') {
      if (ch === '\n') comment = null;
      continue;
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') { comment = null; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated body for: ${header}`);
}

/** Return a single-line `const NAME = …;` declaration. */
function extractConst(src: string, name: string): string {
  const header = `const ${name} =`;
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`index.html no longer declares: ${header}`);
  const end = src.indexOf('\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

interface UiCrypto {
  postFieldBytes: (
    content: string, author: Uint8Array, parentRefs: string[],
    challenge: Uint8Array, protocolVersion: number, timestamp: number,
  ) => Uint8Array;
  buildPowInput: UiCrypto['postFieldBytes'];
  computePostId: (post: Record<string, unknown>) => string;
  vlqU: (n: number) => Uint8Array;
  vlqS: (n: number) => Uint8Array;
  vlqU64: (v: bigint) => Uint8Array;
  lp: (b: Uint8Array) => Uint8Array;
  lpUtf8: (s: string) => Uint8Array;
  arr: <T>(items: T[], f: (x: T) => Uint8Array) => Uint8Array;
  opt: <T>(v: T | null | undefined, f: (x: T) => Uint8Array) => Uint8Array;
  boolByte: (v: boolean) => Uint8Array;
  enum8Tag: (table: Record<string, number>, v: string) => Uint8Array;
  b32Bytes: (v: Uint8Array, n: number) => Uint8Array;
  b32Hex: (v: string, n: number) => Uint8Array;
  cborEncodeInt: (n: number) => Uint8Array;
  cborEncodeBigInt: (v: bigint) => Uint8Array;
  cborEncodeString: (str: string) => Uint8Array;
  cborEncodeBytes: (buf: Uint8Array) => Uint8Array;
  canonicalBoxBytes: (box: Record<string, unknown>) => Uint8Array;
  computeBoxId: (box: Record<string, unknown>) => string;
  computeTxId: (tx: Record<string, unknown>) => string;
  computeCandidateBoxId: (
    candidate: Record<string, unknown>, txId: string, index: number,
  ) => string;
}

/**
 * `blakejs`-compatible shim over Node's blake2b512. Asserts the UI still calls
 * it the documented way — an unkeyed 64-byte digest.
 */
function blake2bShim(data: Uint8Array, key: null, outlen: number): Uint8Array {
  if (key !== null) throw new Error('UI passed a key to blake2b; mirror assumes unkeyed');
  if (outlen !== 64) throw new Error(`UI requested a ${outlen}-byte digest; mirror assumes 64`);
  return new Uint8Array(createHash('blake2b512').update(data).digest());
}

function loadUiCrypto(): UiCrypto {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const source = [
    'const encoder = new TextEncoder();',
    extractConst(html, 'POST_ID_DOMAIN'),
    extractConst(html, 'BOX_ID_DOMAIN'),
    extractConst(html, 'TX_ID_DOMAIN'),
    extractConst(html, 'VLQ_SENTINEL'),
    extractConst(html, 'BOX_TYPE_TAGS'),
    extractDeclaration(html, 'function buf2hex('),
    extractDeclaration(html, 'function hex2buf('),
    extractDeclaration(html, 'function concatUint8Arrays('),
    // The positional codec layer — the mirror of @dagsocial/types src/codec.ts.
    extractDeclaration(html, 'function isEncodableVlqU('),
    extractDeclaration(html, 'function isEncodableVlqS('),
    extractDeclaration(html, 'function vlqBigInt('),
    extractDeclaration(html, 'function vlqU('),
    extractDeclaration(html, 'function vlqS('),
    extractDeclaration(html, 'function vlqU64('),
    extractDeclaration(html, 'function b32Bytes('),
    extractDeclaration(html, 'function b32Hex('),
    extractDeclaration(html, 'function b32Either('),
    extractDeclaration(html, 'function optB32Either('),
    extractDeclaration(html, 'function lp('),
    extractDeclaration(html, 'function lpUtf8('),
    extractDeclaration(html, 'function arr('),
    extractDeclaration(html, 'function opt('),
    extractDeclaration(html, 'function boolByte('),
    extractDeclaration(html, 'function enum8Tag('),
    // The three id preimages built on it.
    extractDeclaration(html, 'function postFieldBytes('),
    extractDeclaration(html, 'function buildPowInput('),
    extractDeclaration(html, 'function computePostId('),
    extractDeclaration(html, 'function canonicalBoxBytes('),
    extractDeclaration(html, 'function boxTypeFields('),
    extractDeclaration(html, 'function computeBoxId('),
    extractDeclaration(html, 'function computeCandidateBoxId('),
    extractDeclaration(html, 'function computeTxId('),
    // The retired CBOR encoder. Extracted so the primitives it still exposes
    // stay pinned while it lives; see the block comment on its own describe().
    extractDeclaration(html, 'function cborHead('),
    extractDeclaration(html, 'function cborEncodeString('),
    extractDeclaration(html, 'function cborEncodeBytes('),
    extractDeclaration(html, 'function cborEncodeInt('),
    extractDeclaration(html, 'function cborEncodeBigInt('),
    'return { postFieldBytes, buildPowInput, computePostId,\n' +
    '         vlqU, vlqS, vlqU64, lp, lpUtf8, arr, opt, boolByte, enum8Tag,\n' +
    '         b32Bytes, b32Hex,\n' +
    '         cborEncodeInt, cborEncodeBigInt, cborEncodeString, cborEncodeBytes,\n' +
    '         canonicalBoxBytes, computeBoxId, computeTxId, computeCandidateBoxId };',
  ].join('\n\n');

  return new Function('blake2b', source)(blake2bShim) as UiCrypto;
}

const ui = loadUiCrypto();

/** What the UI's signPost() hashes: blake2b(buildSignHashInput(...)).slice(0,32). */
function uiSigningHash(post: Post): string {
  const input = ui.buildPowInput(
    post.content, post.author, post.parentRefs,
    post.challenge, post.protocolVersion, post.timestamp,
  );
  return Buffer.from(blake2bShim(input, null, 64).slice(0, 32)).toString('hex');
}

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------

describe('demo UI ↔ @dagsocial/types encoding mirror (M-1)', () => {
  it('the UI reproduces the frozen golden signingHash', () => {
    expect(uiSigningHash(GOLDEN_POST)).toBe(GOLDEN_SIGNING_HASH);
  });

  it('the UI reproduces the frozen golden postId', () => {
    expect(ui.computePostId(GOLDEN_POST as unknown as Record<string, unknown>))
      .toBe(GOLDEN_POST_ID);
  });

  it('types reproduces the same frozen golden vector', () => {
    // Pins both live implementations to the constants, not just to each other.
    expect(signingHash(GOLDEN_POST).toString('hex')).toBe(GOLDEN_SIGNING_HASH);
    expect(computePostId(GOLDEN_POST)).toBe(GOLDEN_POST_ID);
  });

  it('the UI PoW preimage is byte-identical to postPowPreimage', () => {
    const uiBytes = ui.buildPowInput(
      GOLDEN_POST.content, GOLDEN_POST.author, GOLDEN_POST.parentRefs,
      GOLDEN_POST.challenge, GOLDEN_POST.protocolVersion, GOLDEN_POST.timestamp,
    );
    expect(hexOf(uiBytes)).toBe(hexOf(postPowPreimage(GOLDEN_POST)));
  });

  it('the UI accepts a hex-string author and challenge identically', () => {
    // The posting flow passes hex strings straight from the API response.
    const hexPost = {
      ...GOLDEN_POST,
      author: Buffer.from(GOLDEN_POST.author).toString('hex'),
      challenge: Buffer.from(GOLDEN_POST.challenge).toString('hex'),
    };
    expect(ui.computePostId(hexPost as unknown as Record<string, unknown>))
      .toBe(GOLDEN_POST_ID);
  });

  it('both implementations agree across a spread of posts', () => {
    // Every variant is in-domain on both sides: a `parentRefs` entry is `b32`
    // now, so the old `['ab', 'cd']` / `['']` cases have no encoding at all —
    // they moved to the domain test below rather than being dropped.
    const variants: Post[] = [
      { ...GOLDEN_POST, content: 'a', parentRefs: [] },
      { ...GOLDEN_POST, content: '', parentRefs: [] },
      { ...GOLDEN_POST, content: '🙂 multi-byte ✓ ünïcode', parentRefs: ['ab'.repeat(32)] },
      { ...GOLDEN_POST, powNonce: 0, timestamp: 0 },
      { ...GOLDEN_POST, powNonce: Number.MAX_SAFE_INTEGER, timestamp: Number.MAX_SAFE_INTEGER },
      // At the cap. The encoder itself has no opinion on the count — the cap is
      // validation's — so this pins the count prefix, not the rule.
      {
        ...GOLDEN_POST,
        parentRefs: Array.from({ length: MAX_PARENT_REFS }, (_, i) => String(i).repeat(64)),
      },
    ];
    for (const v of variants) {
      expect(ui.computePostId(v as unknown as Record<string, unknown>)).toBe(computePostId(v));
      expect(uiSigningHash(v)).toBe(signingHash(v).toString('hex'));
    }
  });

  it('a parentRef outside the b32 domain has no encoding on EITHER side', () => {
    // The mirror has to agree on which inputs are unencodable, not only on the
    // bytes for the ones that are. A UI that padded `'ab'` to 32 bytes where the
    // node throws would mint posts the node cannot verify — and the padding
    // would map a malformed ref onto a well-formed ref's encoding, which is the
    // reason a fixed-width field carries no sentinel (spec §2.5).
    // `GOLDEN_REF` is all digits, so uppercasing it is a no-op — the case leg
    // needs a ref that actually contains letters to be non-vacuous.
    const MIXED_CASE_REF = 'ab'.repeat(32).toUpperCase();
    for (const bad of ['', 'ab', 'abcd', 'z'.repeat(64), MIXED_CASE_REF]) {
      const post = { ...GOLDEN_POST, parentRefs: [bad] };
      expect(() => computePostId(post), `types accepted ${bad}`).toThrow();
      expect(
        () => ui.computePostId(post as unknown as Record<string, unknown>),
        `ui accepted ${bad}`,
      ).toThrow();
    }
  });

  it('the M-1 collision pair is distinct in the UI too', () => {
    const a = { ...GOLDEN_POST, powNonce: 5, timestamp: 23 };
    const b = { ...GOLDEN_POST, powNonce: 52, timestamp: 3 };
    const idA = ui.computePostId(a as unknown as Record<string, unknown>);
    const idB = ui.computePostId(b as unknown as Record<string, unknown>);
    expect(idA).not.toBe(idB);
    expect(idA).toBe(computePostId(a));
    expect(idB).toBe(computePostId(b));
  });

  it('the UI positional writers match the frozen byte forms', () => {
    // Hand-derived from TYPES_INTERFACE → Primitives rather than measured off
    // the UI, so this catches an encoder that is merely self-consistent.
    expect(hexOf(ui.vlqU(0))).toBe('00');
    expect(hexOf(ui.vlqU(1))).toBe('01');
    expect(hexOf(ui.vlqU(127))).toBe('7f');
    expect(hexOf(ui.vlqU(128))).toBe('8001');
    expect(hexOf(ui.vlqU(300))).toBe('ac02');
    // Past 2^32, where a bitwise implementation silently truncates.
    expect(hexOf(ui.vlqU(2 ** 32))).toBe('8080808010');
    expect(hexOf(ui.vlqU(1767225600000))).toBe('80d0eab6b733');
    // ZigZag: the sign rides in bit 0.
    expect(hexOf(ui.vlqS(0))).toBe('00');
    expect(hexOf(ui.vlqS(-1))).toBe('01');
    expect(hexOf(ui.vlqS(1))).toBe('02');
    expect(hexOf(ui.vlqS(70000))).toBe('e0c508');
    // The bigint path spans the whole u64, where the number path stops at 2^53.
    expect(hexOf(ui.vlqU64(0n))).toBe('00');
    expect(hexOf(ui.vlqU64(2n ** 64n - 1n))).toBe('ffffffffffffffffff01');
    // Length prefixes, options and tags.
    expect(hexOf(ui.lp(new Uint8Array([0xaa, 0xbb])))).toBe('02aabb');
    expect(hexOf(ui.lpUtf8('✓'))).toBe('03e29c93');
    expect(hexOf(ui.arr([1, 2], (n: number) => ui.vlqU(n)))).toBe('020102');
    expect(hexOf(ui.opt(undefined, () => new Uint8Array([9])))).toBe('00');
    expect(hexOf(ui.opt(null, () => new Uint8Array([9])))).toBe('00');
    expect(hexOf(ui.opt(7, () => new Uint8Array([9])))).toBe('0109');
    expect(hexOf(ui.boolByte(false))).toBe('00');
    expect(hexOf(ui.boolByte(true))).toBe('01');
    expect(hexOf(ui.enum8Tag({ a: 0, b: 4 }, 'b'))).toBe('04');
  });

  it('the totality split is mirrored: sentinel where types sentinels, throw where it throws', () => {
    // A mirror that threw where the node sentinels (or the reverse) would
    // diverge on exactly the malformed input a light client is handed — audits
    // M-5/M-6. Total writers absorb it into the unreachable all-ones u64.
    const SENTINEL = 'ffffffffffffffffff01';
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(hexOf(ui.vlqU(bad)), `vlqU(${bad})`).toBe(SENTINEL);
    }
    // `vlqS`'s domain is wider on the negative side and narrower at the top:
    // ZigZag doubles the magnitude before the VLQ sees it, so −1 is faithful
    // while ±2^52 is not. Sharing `vlqU`'s list would assert the wrong domain.
    for (const bad of [NaN, Infinity, -Infinity, 1.5, 2 ** 52, -(2 ** 52) - 1]) {
      expect(hexOf(ui.vlqS(bad)), `vlqS(${bad})`).toBe(SENTINEL);
    }
    expect(hexOf(ui.lp(undefined as unknown as Uint8Array))).toBe(SENTINEL);
    expect(hexOf(ui.lpUtf8(undefined as unknown as string))).toBe(SENTINEL);
    expect(hexOf(ui.arr(undefined as unknown as number[], () => new Uint8Array()))).toBe(SENTINEL);
    expect(hexOf(ui.boolByte(undefined as unknown as boolean))).toBe('ff');
    expect(hexOf(ui.enum8Tag({ a: 0 }, 'nope'))).toBe('ff');
    // No unreachable sentinel exists for these, so they throw on both sides.
    expect(() => ui.vlqU64(1 as unknown as bigint)).toThrow();
    expect(() => ui.b32Bytes(new Uint8Array(31), 32)).toThrow();
    expect(() => ui.b32Bytes('ab'.repeat(32) as unknown as Uint8Array, 32)).toThrow();
    expect(() => ui.b32Hex('ab'.repeat(31), 32)).toThrow();
    expect(() => ui.b32Hex('AB'.repeat(32), 32)).toThrow();
  });
});

// ---------------------------------------------------------------------------

/**
 * Box and transaction encoding mirror. The UI's hand-written positional writers
 * must produce the same bytes as `@dagsocial/types` for every box type and every
 * transaction shape — otherwise every client-built box id (and every signed
 * txId) diverges from the node and the UI's transactions are simply rejected.
 */
describe('demo UI ↔ @dagsocial/types box encoding mirror (positional)', () => {
  it('the UI reproduces the frozen golden karma boxId', () => {
    expect(ui.computeBoxId(GOLDEN_KARMA_BOX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_KARMA_BOX_ID);
  });

  it('the UI reproduces the frozen golden credit boxId (value > 2^53)', () => {
    expect(ui.computeBoxId(GOLDEN_CREDIT_BOX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('types reproduces the same frozen golden box vectors', () => {
    // Pins both live implementations to the constants, not just to each other.
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('golden vector: the canonical box bytes are frozen on both sides', () => {
    // Field-by-field, which an id comparison cannot be: this says *which byte*.
    expect(hexOf(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE))).toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(hexOf(canonicalBoxBytes(GOLDEN_CREDIT_CANDIDATE))).toBe(GOLDEN_CREDIT_BOX_BYTES);
    expect(hexOf(ui.canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE as unknown as Record<string, unknown>)))
      .toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(hexOf(ui.canonicalBoxBytes(GOLDEN_CREDIT_CANDIDATE as unknown as Record<string, unknown>)))
      .toBe(GOLDEN_CREDIT_BOX_BYTES);
  });

  it('the UI accepts hex-string binary fields identically (the tx-builder form)', () => {
    // The UI's tx builders pass `owner` as a hex string straight from state.
    const hexBox = { ...GOLDEN_KARMA_BOX, owner: Buffer.from(GOLDEN_AUTHOR).toString('hex') };
    expect(ui.computeBoxId(hexBox as unknown as Record<string, unknown>))
      .toBe(GOLDEN_KARMA_BOX_ID);
  });

  it.each(ALL_BOX_TYPES)(
    '$name: the tx-builder hex form encodes identically to the byte form (E3)',
    ({ box }) => {
      // The form that catches a byte field the UI converts differently: it would
      // write 64 bytes of ASCII where the node writes 32 raw, and every id
      // derived from that box diverges — while both sides' own tests still pass.
      expect(hexOf(ui.canonicalBoxBytes(toUiForm(box)))).toBe(hexOf(canonicalBoxBytes(box)));
      expect(ui.computeBoxId(toUiForm(box))).toBe(computeBoxId(box));
      // And the byte form, which is what a server-returned box carries.
      expect(hexOf(ui.canonicalBoxBytes(box as unknown as Record<string, unknown>)))
        .toBe(hexOf(canonicalBoxBytes(box)));
    },
  );

  it('guard has left the consensus bytes on both sides (C10)', () => {
    // `guard` is a pure function of `boxType` — one string per type, with no box
    // choosing between two — so it carried zero information while costing bytes
    // in every box id. Both halves are pinned: the string is absent from the
    // bytes, *and* changing it moves no id.
    const bytes = hexOf(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE));
    expect(bytes).not.toContain(Buffer.from('owner_signature').toString('hex'));
    const reguarded = { ...GOLDEN_KARMA_BOX, guard: 'block_apply' as never };
    expect(ui.computeBoxId(reguarded as unknown as Record<string, unknown>))
      .toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(reguarded)).toBe(GOLDEN_KARMA_BOX_ID);
  });

  it('a stray key is unrepresentable — the encoder reads only what it declares', () => {
    // Under the CBOR form this needed an explicit strip of `id`/`txId`/`index`,
    // and any *other* decoration a display path added still entered the hash.
    // Positional has no branch that could write one.
    const decorated = {
      ...GOLDEN_KARMA_BOX, id: GOLDEN_KARMA_BOX_ID, createdAtBlock: 99, junk: 'x',
    };
    expect(hexOf(ui.canonicalBoxBytes(decorated as unknown as Record<string, unknown>)))
      .toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(hexOf(canonicalBoxBytes(decorated as never))).toBe(GOLDEN_KARMA_BOX_BYTES);
  });

  it('the lpUtf8 length ladder agrees across implementations at every VLQ width', () => {
    // `proofSource` is the only variable-length field left in a box, so it is
    // the only place a length prefix can change width. The old cbor-x ladder
    // (0x18/0x19/0x1a rungs) is gone; VLQ steps at 2^7 and 2^14 instead.
    const prefixAt = (b: Uint8Array): string => hexOf(b.subarray(34, 37));
    for (const [len, prefix] of [
      [127, '7f7878'], [128, '800178'], [16383, 'ff7f78'], [16384, '808001'],
    ] as Array<[number, string]>) {
      const box: CandidateOf<KarmaBox> = {
        ...GOLDEN_KARMA_CANDIDATE, proofSource: 'x'.repeat(len),
      };
      const fromUi = ui.canonicalBoxBytes(box as unknown as Record<string, unknown>);
      const fromTypes = canonicalBoxBytes(box);
      expect(hexOf(fromUi), `len=${len}`).toBe(hexOf(fromTypes));
      expect(prefixAt(fromTypes), `len=${len}`).toBe(prefix);
    }
  });

  it('an out-of-domain box field has no encoding on EITHER side', () => {
    const short = { ...GOLDEN_KARMA_BOX, owner: new Uint8Array(31) };
    expect(() => canonicalBoxBytes(short as never)).toThrow();
    expect(() => ui.canonicalBoxBytes(short as unknown as Record<string, unknown>)).toThrow();
    for (const value of [-1n, 2n ** 64n]) {
      const bad = { ...GOLDEN_KARMA_BOX, value };
      expect(() => canonicalBoxBytes(bad as never), `value=${value}`).toThrow();
      expect(
        () => ui.canonicalBoxBytes(bad as unknown as Record<string, unknown>),
        `value=${value}`,
      ).toThrow();
    }
  });

  it('an unclaimed bond takes the absent branch, and is distinguishable from every committed one', () => {
    // Both directions of the `opt(b32)` injectivity argument, on both sides.
    const unclaimed = hexOf(canonicalBoxBytes(GOLDEN_BOND_BOX_UNCLAIMED));
    const committed = hexOf(canonicalBoxBytes(GOLDEN_BOND_BOX));
    expect(hexOf(ui.canonicalBoxBytes(GOLDEN_BOND_BOX_UNCLAIMED as unknown as Record<string, unknown>)))
      .toBe(unclaimed);
    // Unclaimed ends `00 00 00` — absent tag, then the two zero probation
    // fields — and carries no key bytes at all. The tag byte is present either
    // way, so committed is exactly 32 bytes longer, not 33.
    expect(unclaimed.length + 32 * 2).toBe(committed.length);
    expect(unclaimed).not.toBe(committed);
    // The tx-builder form spells the same absence as an empty hex string, and
    // must reach the same bytes — otherwise a client-built invite derives a bond
    // id the node never agrees with.
    expect(hexOf(ui.canonicalBoxBytes({ ...toUiForm(GOLDEN_BOND_BOX), inviteePublicKey: '' })))
      .toBe(unclaimed);
    // A *missing* field is out of domain, not unclaimed: letting it take the
    // absent branch would give a malformed box a well-formed box's id.
    const missing = { ...GOLDEN_BOND_BOX } as Partial<BondBox>;
    delete missing.inviteePublicKey;
    expect(() => canonicalBoxBytes(missing as never)).toThrow();
    expect(() => ui.canonicalBoxBytes(missing as unknown as Record<string, unknown>)).toThrow();
  });

  it('an unknown boxType takes the reserved 0xff tag rather than throwing', () => {
    // Total, and the reserved tag is what keeps a malformed box from colliding
    // with a well-formed one: no valid boxType is 0xff.
    const bogus = { ...GOLDEN_KARMA_BOX, boxType: 'like' };
    expect(hexOf(ui.canonicalBoxBytes(bogus as unknown as Record<string, unknown>))).toBe('ff64');
    expect(hexOf(canonicalBoxBytes(bogus as never))).toBe('ff64');
  });

  it('the UI reproduces the frozen golden txId (what signTxId signs)', () => {
    expect(ui.computeTxId(GOLDEN_UTXO_TX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_UTXO_TX_ID);
    expect(computeTxId(GOLDEN_UTXO_TX)).toBe(GOLDEN_UTXO_TX_ID);
  });

  it('the txId counts its entries — two output lists cannot concatenate alike (C1)', () => {
    // Pre-migration the inputs and outputs were concatenated with no count and
    // no length prefix, and box bytes are variable-length. `arr()` closes it.
    const one = { ...GOLDEN_UTXO_TX, outputs: [GOLDEN_KARMA_CANDIDATE] };
    const two = { ...GOLDEN_UTXO_TX, outputs: [GOLDEN_KARMA_CANDIDATE, GOLDEN_KARMA_CANDIDATE] };
    expect(ui.computeTxId(one as unknown as Record<string, unknown>))
      .not.toBe(ui.computeTxId(two as unknown as Record<string, unknown>));
    expect(ui.computeTxId(one as unknown as Record<string, unknown>)).toBe(computeTxId(one));
    expect(ui.computeTxId(two as unknown as Record<string, unknown>)).toBe(computeTxId(two));
  });

  it('the preimages map agrees, and absence differs from empty (no malleability)', () => {
    const withPreimages: UtxoTransaction = {
      ...GOLDEN_UTXO_TX,
      preimages: {
        [GOLDEN_KARMA_BOX_ID]: new Uint8Array([1, 2, 3]),
        [GOLDEN_CREDIT_BOX_ID]: new Uint8Array([4, 5]),
      },
    };
    const empty: UtxoTransaction = { ...GOLDEN_UTXO_TX, preimages: {} };
    expect(ui.computeTxId(withPreimages as unknown as Record<string, unknown>))
      .toBe(computeTxId(withPreimages));
    expect(ui.computeTxId(empty as unknown as Record<string, unknown>)).toBe(computeTxId(empty));
    // `opt()` tags presence, so `{}` is `01 00` and absence is `00`. Under the
    // pre-migration form both appended nothing and the two hashed alike.
    expect(computeTxId(empty)).not.toBe(GOLDEN_UTXO_TX_ID);
  });
});

// ---------------------------------------------------------------------------

/**
 * ⚠ **The UI's hand-written CBOR encoder is DEAD** as of this phase — zero
 * callers in `index.html`, because `canonicalBoxBytes` is positional now. Its
 * deletion is booked to the migration's Phase 7, whose entire remaining content
 * this is.
 *
 * These four cases stay only so the encoder is not silently untested while it
 * lives, and they are deliberately narrowed to the encoder's own primitives: the
 * box-shaped assertions that used to sit here ("bigint value serializes as 0x1b
 * uint64", "an over-cap field still encodes byte-identically to cbor-x") made a
 * claim about *box identity* that is no longer true of this code, and moved to
 * the positional block above. They go together with the encoder in Phase 7.
 */
describe('demo UI CBOR encoder — retired, pinned until Phase 7 deletes it', () => {
  it('cborEncodeInt matches cbor-x across the full number range (L-5)', () => {
    // Byte forms measured against cbor-x 1.6.4. Note the float64 (0xfb) forms
    // past ±2^32: cbor-x never emits 0x1b uint64 for a JS number — that form is
    // exclusively the bigint path.
    const cases: Array<[number, string]> = [
      [0, '00'], [23, '17'], [24, '1818'], [255, '18ff'],
      [256, '190100'], [65535, '19ffff'],
      [65536, '1a00010000'], [70000, '1a00011170'], [4294967295, '1affffffff'],
      [4294967296, 'fb41f0000000000000'],
      [Number.MAX_SAFE_INTEGER, 'fb433fffffffffffff'],
      [-1, '20'], [-24, '37'], [-25, '3818'], [-70000, '3a0001116f'],
      [-4294967296, '3affffffff'],
      [-4294967297, 'fbc1f0000000100000'],
      [-Number.MAX_SAFE_INTEGER, 'fbc33fffffffffffff'],
    ];
    for (const [n, hex] of cases) expect(hexOf(ui.cborEncodeInt(n)), `n=${n}`).toBe(hex);
    expect(() => ui.cborEncodeInt(1.5)).toThrow();
    expect(() => ui.cborEncodeInt(NaN)).toThrow();
  });

  const headOf = (b: Uint8Array, n: number): string => Buffer.from(b.subarray(0, n)).toString('hex');

  it('cborEncodeBytes follows the cbor-x length ladder past the old 255 cap (L-5)', () => {
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(0)), 1)).toBe('40');
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(23)), 1)).toBe('57');
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(24)), 2)).toBe('5818');
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(255)), 2)).toBe('58ff');    // the old cap
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(256)), 3)).toBe('590100');  // used to throw
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(65535)), 3)).toBe('59ffff');
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(65536)), 5)).toBe('5a00010000');
    // Definite length, never chunked: header + payload and nothing else.
    expect(ui.cborEncodeBytes(new Uint8Array(65536)).length).toBe(5 + 65536);
  });

  it('cborEncodeString follows the same ladder, counting UTF-8 bytes', () => {
    expect(headOf(ui.cborEncodeString(''), 1)).toBe('60');
    expect(headOf(ui.cborEncodeString('a'.repeat(23)), 1)).toBe('77');
    expect(headOf(ui.cborEncodeString('a'.repeat(24)), 2)).toBe('7818');
    expect(headOf(ui.cborEncodeString('a'.repeat(255)), 2)).toBe('78ff');    // the old cap
    expect(headOf(ui.cborEncodeString('a'.repeat(256)), 3)).toBe('790100');  // used to throw
    expect(headOf(ui.cborEncodeString('a'.repeat(65535)), 3)).toBe('79ffff');
    expect(headOf(ui.cborEncodeString('a'.repeat(65536)), 5)).toBe('7a00010000');
    // 200 × U+2713 is 200 characters but 600 bytes — the prefix counts bytes.
    expect(headOf(ui.cborEncodeString('✓'.repeat(200)), 3)).toBe('790258');
    expect(ui.cborEncodeString('✓'.repeat(200)).length).toBe(3 + 600);
  });

  it('cborEncodeBigInt always emits the 8-byte uint64 form, and only that', () => {
    expect(hexOf(ui.cborEncodeBigInt(0n))).toBe('1b0000000000000000');
    expect(hexOf(ui.cborEncodeBigInt(2n))).toBe('1b0000000000000002');
    expect(hexOf(ui.cborEncodeBigInt(100n))).toBe('1b0000000000000064');
    expect(hexOf(ui.cborEncodeBigInt(2n ** 64n - 1n))).toBe('1bffffffffffffffff');
    expect(() => ui.cborEncodeBigInt(2n ** 64n)).toThrow();
    expect(() => ui.cborEncodeBigInt(-1n)).toThrow();
  });
});

// ---------------------------------------------------------------------------

/**
 * Box-identity mirror (Spec G phase E). The derivation binds content *and* the
 * position that content was created at:
 *
 *   blake2b512( BOX_ID_DOMAIN ‖ canonicalBoxBytes ‖ b32(txId) ‖ vlqU(index) )
 *
 * Provenance is no longer *stripped* before hashing — it is structurally absent
 * from `canonicalBoxBytes` and appended afterwards, which is what keeps the
 * derivation non-circular without anyone having to remember a strip rule.
 */
describe('demo UI ↔ @dagsocial/types box identity mirror (Spec G phase E)', () => {
  const asUi = (box: object): Record<string, unknown> => box as unknown as Record<string, unknown>;

  it('the legacy boxId is unmoved by provenance on both sides', () => {
    expect(ui.computeBoxId(asUi(GOLDEN_KARMA_BOX))).toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(GOLDEN_KARMA_BOX_ID);
    expect(ui.computeBoxId(asUi(GOLDEN_CREDIT_BOX))).toBe(GOLDEN_CREDIT_BOX_ID);
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('the txId is unmoved by output provenance too — one encoder, two callers', () => {
    // types routes `computeTxId`'s outputs through `canonicalBoxBytes` for
    // exactly this reason; the UI does too, so a materialized output and the
    // candidate it came from hash the same.
    const tx: UtxoTransaction = {
      ...GOLDEN_UTXO_TX,
      outputs: [GOLDEN_KARMA_BOX, GOLDEN_CREDIT_BOX],
    };
    expect(ui.computeTxId(asUi(tx))).toBe(GOLDEN_UTXO_TX_ID);
    expect(computeTxId(tx)).toBe(GOLDEN_UTXO_TX_ID);
  });

  it('the UI computeCandidateBoxId matches types on the golden vectors', () => {
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_CREDIT_BOX), GOLDEN_UTXO_TX_ID, 1))
      .toBe(GOLDEN_CREDIT_CANDIDATE_ID);
    expect(computeCandidateBoxId(GOLDEN_CREDIT_BOX, GOLDEN_UTXO_TX_ID, 1))
      .toBe(GOLDEN_CREDIT_CANDIDATE_ID);
  });

  it('a stored box re-derives its own id — the derivation is total over both forms', () => {
    // What a light client does: take a box off the wire, re-derive from its own
    // provenance.
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
  });

  it('the derivation is not the legacy one — the tag and provenance both bind', () => {
    // Inverted by phase G3b: there is no legacy derivation left to differ from.
    // `computeBoxId` IS `computeCandidateBoxId` applied to the box's own
    // provenance — on BOTH sides — so these must now be equal, and the mirror is
    // what proves the client collapsed them the same way the node did.
    expect(GOLDEN_KARMA_CANDIDATE_ID).toBe(GOLDEN_KARMA_BOX_ID);
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_CANDIDATE), GOLDEN_UTXO_TX_ID, 0))
      .toBe(ui.computeBoxId(asUi(GOLDEN_KARMA_BOX)));
  });

  it('both txId and index enter the derivation', () => {
    const otherTx = '9'.repeat(64);
    const ids = [
      ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0),
      ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 1),
      ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), otherTx, 0),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe(computeCandidateBoxId(GOLDEN_KARMA_BOX, otherTx, 0));
  });

  it('a wide index agrees byte for byte across implementations', () => {
    // 0x12345678 needs five VLQ bytes, so a mirror that stopped at one
    // continuation byte fails here even though it agrees on index 0 — the index
    // every mint and most single-output transactions use.
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0x12345678))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID_WIDE_INDEX);
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 0x12345678))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID_WIDE_INDEX);
  });

  it('a malformed index derives the sentinel id rather than throwing (M-5)', () => {
    // `index` is `vlqU`, which is total: the encodable domain is the
    // non-negative safe integers, so the all-ones u64 stays unreachable from a
    // valid index and a malformed one cannot impersonate a valid one.
    //
    // Note 0xffffffff and 2^32 are NOT in this list any more, and that is the
    // change rather than an omission: under the old `u32BE` the sentinel WAS
    // 0xffffffff, so those two collided with malformed input. `vlqU` encodes
    // both faithfully.
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, bad), `index=${bad}`)
        .toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
      expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, bad), `index=${bad}`)
        .toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
    }
    // …and 2^32 is now a real index, distinct from the sentinel.
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 2 ** 32))
      .not.toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 2 ** 32))
      .toBe(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 2 ** 32));
  });

  it('txId enters as 32 RAW bytes — an out-of-domain txId has no encoding at all', () => {
    // Was "txId enters as the UTF-8 bytes of its hex text, not as decoded
    // bytes", and the case-sensitivity it proved is the reason the name had to
    // change rather than the constant: `AB…` and `ab…` used to derive two
    // distinct ids for one transaction, and the old form kept that collision
    // *visible* instead of removing it. Under `b32` the uppercase spelling has
    // no encoding, so the ambiguity is unconstructible rather than distinguished.
    //
    // The cost is stated where it is paid: derivation is no longer total on an
    // attacker-supplied txId, so every call site must establish the domain. Every
    // txId reaching here is a blake2b digest rendered lowercase, by construction.
    for (const weird of [GOLDEN_UTXO_TX_ID.toUpperCase(), '', 'abc', 'zz', 'ab'.repeat(31)]) {
      expect(() => computeCandidateBoxId(GOLDEN_KARMA_BOX, weird, 0), `types txId=${weird}`)
        .toThrow();
      expect(() => ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), weird, 0), `ui txId=${weird}`)
        .toThrow();
    }
  });

  it('the UI accepts hex-string binary fields identically here too', () => {
    // The tx-builder form: `owner` arrives as hex from state, not as bytes.
    const hexBox = { ...GOLDEN_KARMA_BOX, owner: Buffer.from(GOLDEN_AUTHOR).toString('hex') };
    expect(ui.computeCandidateBoxId(asUi(hexBox), GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
  });

  it.each(ALL_BOX_TYPES)(
    '$name: the provenance derivation agrees in both forms (E3)',
    ({ box }) => {
      const expected = computeCandidateBoxId(box, GOLDEN_UTXO_TX_ID, 3);
      expect(ui.computeCandidateBoxId(toUiForm(box), GOLDEN_UTXO_TX_ID, 3)).toBe(expected);
      expect(ui.computeCandidateBoxId(asUi(box), GOLDEN_UTXO_TX_ID, 3)).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------

/**
 * likeTarget tail mirror (P2-D). The like transaction's target sits inside the
 * `computeTxId` preimage as `opt(b32)`, so the signature covers the target and a
 * relay cannot re-point a like. The UI signs what it builds, so a mirror that
 * dropped the tail (or gated it on truthiness) would sign ids the node never
 * computes, and every like from the demo UI would be rejected.
 */
describe('demo UI ↔ @dagsocial/types likeTarget tail mirror (P2-D)', () => {
  const asUi = (tx: object): Record<string, unknown> => tx as unknown as Record<string, unknown>;

  // Measured from @dagsocial/types computeTxId — both implementations pin to
  // constants, not just to each other.
  const GOLDEN_LIKE_TX_ID =
    '724fcce0c711683d05f6f099584d30704f99ca2f41251d9a69757119f2ae84ee';

  const GOLDEN_LIKE_TX: UtxoTransaction = {
    ...GOLDEN_UTXO_TX,
    likeTarget: GOLDEN_POST_ID,
  };

  it('the UI reproduces the frozen likeTarget-bearing txId', () => {
    expect(ui.computeTxId(asUi(GOLDEN_LIKE_TX))).toBe(GOLDEN_LIKE_TX_ID);
    expect(computeTxId(GOLDEN_LIKE_TX)).toBe(GOLDEN_LIKE_TX_ID);
  });

  it('absence appends nothing but the tag — the un-targeted tx keeps its id', () => {
    expect(ui.computeTxId(asUi(GOLDEN_UTXO_TX))).toBe(GOLDEN_UTXO_TX_ID);
    expect(GOLDEN_LIKE_TX_ID).not.toBe(GOLDEN_UTXO_TX_ID);
  });

  it('an empty-string target has no encoding — the truthiness trap is gone', () => {
    // Was "presence is not truthiness — an empty-string target still appends the
    // marker". Under the ASCII `like:` marker an empty target was *encodable*,
    // so the pin had to be that presence is `!== undefined` rather than truthy.
    // `opt(b32)` still distinguishes presence from absence by a tag byte, but
    // `''` is out of the `b32` domain, so the case the old pin guarded is
    // unconstructible rather than merely handled.
    const emptyTarget: UtxoTransaction = { ...GOLDEN_UTXO_TX, likeTarget: '' };
    expect(() => computeTxId(emptyTarget)).toThrow();
    expect(() => ui.computeTxId(asUi(emptyTarget))).toThrow();
  });

  it('the target binds — re-pointing the like moves the id identically on both sides', () => {
    const repointed: UtxoTransaction = {
      ...GOLDEN_UTXO_TX,
      likeTarget: '2222222222222222222222222222222222222222222222222222222222222222',
    };
    const uiId = ui.computeTxId(asUi(repointed));
    expect(uiId).not.toBe(GOLDEN_LIKE_TX_ID);
    expect(uiId).toBe(computeTxId(repointed));
  });
});
