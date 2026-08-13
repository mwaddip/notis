/**
 * TS ↔ JS mirror: the demo UI must encode posts, boxes and transactions
 * byte-identically to `@dagsocial/types` — TYPES_INTERFACE → Canonical field
 * encoding, Layout — Post, Layout — Boxes, Layout — UtxoTransaction.
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
  computeCandidateBoxId, canonicalBoxBytes, MAX_PARENT_REFS, powNonceBytes,
} from '@dagsocial/types';
import { verifyPoW } from '../../src/services/pow.js';
import { extractDeclaration as extractDeclarationFrom } from './extract-declaration.js';
import type {
  CandidateOf,
  Post, KarmaBox, CreditBox, InviteBox, GenesisProofBox, BondBox, PostLockBox, VouchBox,
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
  value: 123456789n * 10n ** 8n,  // 12_345_678_900_000_000 > 2^53 — why box values are bigint
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
// Provenance vectors (NODE_INTERFACE → Box Identity and Mint Provenance).
//
// The provenance is the real one for these boxes: GOLDEN_UTXO_TX creates the
// karma box at index 0 and the credit box at index 1. Values measured from
// `computeCandidateBoxId` in @dagsocial/types, so both implementations are
// pinned to a constant rather than only to each other.
//
// `GOLDEN_KARMA_CANDIDATE_ID` equals `GOLDEN_KARMA_BOX_ID` above, and that is
// the derivation rather than a copy-paste slip: `computeBoxId` IS
// `computeCandidateBoxId` applied to the box's own provenance, one derivation
// on both sides.
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
// One fixture per box type
//
// A box type encoded through only ONE implementation is a type whose binary
// fields nobody compares: a UI that wrote `VouchBox.voucherId` in the wrong form
// would be observed by nothing. Every type in `ALL_BOX_TYPES` is encoded through
// both implementations in both forms, so an omission fails here instead of
// needing review to catch. Distinct fill bytes per field so a transposition is
// visible too.
//
// ⚠ **`genesis_proof` is covered separately, in the byte form only.**
// `toUiForm` renders every `Uint8Array` as hex because that is how the UI's tx
// builders carry keys — and no builder carries a `payload`, because the box is
// written by genesis seeding and a transaction may never create one. `lp` is
// byte-only on both sides, so a hex-form assertion would be asserting agreement
// on a shape neither implementation has a producer for.
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
 * unclaimed. It is the only 0-or-32 field in any box and `opt(b32)` is the only
 * option-shaped field in the box arms (TYPES_INTERFACE → Layout — Boxes), so
 * without a fixture on the absent branch a plain `b32` in that slot encodes
 * every unclaimed bond wrongly and nothing observes it. One fixture per branch.
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
 *
 * Shared with `miner-mirror.test.ts`, the other consumer that cannot import
 * `@dagsocial/validation` and is held by a mirror instead.
 */
const extractDeclaration = (src: string, header: string): string =>
  extractDeclarationFrom(src, header, 'index.html');

/** Return a single-line `const NAME = …;` declaration. */
function extractConst(src: string, name: string): string {
  const header = `const ${name} =`;
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`index.html no longer declares: ${header}`);
  const end = src.indexOf('\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

/**
 * The byte primitives: every declaration whose job is to emit wire bytes. The
 * completeness audit at the bottom of this file derives its vocabulary from this
 * array, so a primitive added here extends the audit with it.
 */
const BYTE_PRIMITIVES = [
  'vlqU', 'vlqS', 'vlqU64', 'vlqBigInt', 'lp', 'lpUtf8', 'arr', 'opt',
  'boolByte', 'enum8Tag', 'b32Bytes', 'b32Hex', 'b32Either', 'optB32Either',
] as const;

/** The rest of what the mirror evaluates: helpers, the id preimages, the PoW pair. */
const MIRRORED_OTHER = [
  'buf2hex', 'hex2buf', 'concatUint8Arrays',
  'isEncodableVlqU', 'isEncodableVlqS',
  'postFieldBytes', 'buildPowInput',
  'powNonceTail', 'postPowHash', 'powTarget', 'meetsPowTarget',
  'computePostId', 'canonicalBoxBytes', 'boxTypeFields',
  'computeBoxId', 'computeCandidateBoxId', 'computeTxId',
] as const;

/** Every function declaration the mirror lifts out of `index.html`. */
const MIRRORED_FUNCTIONS: readonly string[] = [...BYTE_PRIMITIVES, ...MIRRORED_OTHER];

/** Consts the mirror lifts. A top-level one may itself construct bytes. */
const MIRRORED_CONSTS = [
  'POST_ID_DOMAIN', 'BOX_ID_DOMAIN', 'TX_ID_DOMAIN', 'VLQ_SENTINEL', 'BOX_TYPE_TAGS',
] as const;

/** What `loadUiCrypto` hands back; must stay in step with `UiCrypto`. */
const RETURNED = [
  'postFieldBytes', 'buildPowInput', 'computePostId',
  'powNonceTail', 'postPowHash', 'powTarget', 'meetsPowTarget',
  'vlqU', 'vlqS', 'vlqU64', 'lp', 'lpUtf8', 'arr', 'opt', 'boolByte', 'enum8Tag',
  'b32Bytes', 'b32Hex',
  'canonicalBoxBytes', 'computeBoxId', 'computeTxId', 'computeCandidateBoxId',
] as const;

interface UiCrypto {
  postFieldBytes: (
    content: string, author: Uint8Array, parentRefs: string[],
    challenge: Uint8Array, protocolVersion: number, timestamp: number,
  ) => Uint8Array;
  buildPowInput: UiCrypto['postFieldBytes'];
  computePostId: (post: Record<string, unknown>) => string;
  powNonceTail: (nonce: number) => Uint8Array;
  postPowHash: (powInput: Uint8Array, nonce: number) => Uint8Array;
  powTarget: (targetBits: number) => Uint8Array | null;
  meetsPowTarget: (hash: Uint8Array, target: Uint8Array) => boolean;
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
    ...MIRRORED_CONSTS.map((name) => extractConst(html, name)),
    ...MIRRORED_FUNCTIONS.map((name) => extractDeclaration(html, `function ${name}(`)),
    `return { ${RETURNED.join(', ')} };`,
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
    // Every variant is in-domain on both sides. A `parentRefs` entry is `b32`,
    // so a short or empty ref has no encoding at all and belongs in the domain
    // test below, where the throw is the assertion.
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
    // reason a fixed-width field throws instead of carrying a sentinel
    // (TYPES_INTERFACE → Totality).
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
    // diverge on exactly the malformed input a light client is handed
    // (TYPES_INTERFACE → Totality). Total writers absorb it into the
    // unreachable all-ones u64.
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
    // The positional encoder writes the fields its arm names and has no branch
    // that could write another, so a decoration a display path attaches cannot
    // enter the hash — no strip step stands between the box and its bytes.
    const decorated = {
      ...GOLDEN_KARMA_BOX, id: GOLDEN_KARMA_BOX_ID, createdAtBlock: 99, junk: 'x',
    };
    expect(hexOf(ui.canonicalBoxBytes(decorated as unknown as Record<string, unknown>)))
      .toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(hexOf(canonicalBoxBytes(decorated as never))).toBe(GOLDEN_KARMA_BOX_BYTES);
  });

  it('the lpUtf8 length ladder agrees across implementations at every VLQ width', () => {
    // `proofSource` is the only variable-length field in a box, so it is the
    // only place a length prefix can change width. `lpUtf8` is VLQ-prefixed, so
    // the rungs sit at 2^7 and 2^14 (TYPES_INTERFACE → Primitives).
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

  it('genesis_proof: the byte form encodes identically on both implementations', () => {
    // The page never builds one, and that is exactly why this is here: without
    // the tag and the arm, `enum8Tag` falls back to `0xff` and `boxTypeFields`
    // writes no tail, so the UI derives a **wrong id that looks well-formed**
    // rather than throwing. Two arms, because the length prefix is the whole of
    // `lp`'s injectivity and the empty payload is the smallest legal box.
    for (const payload of [new Uint8Array([0xde, 0xad, 0xbe, 0xef]), new Uint8Array(0)]) {
      const box: GenesisProofBox = {
        boxType: 'genesis_proof', value: 0n, payload, guard: 'unspendable',
        txId: COVERAGE_TX_ID, index: 5,
      };
      const label = `payload=${payload.length}`;
      expect(hexOf(ui.canonicalBoxBytes(box as unknown as Record<string, unknown>)), label)
        .toBe(hexOf(canonicalBoxBytes(box)));
      expect(ui.computeBoxId(box as unknown as Record<string, unknown>), label)
        .toBe(computeBoxId(box));
    }
  });

  it('genesis_proof takes tag 3, on both implementations', () => {
    // The tag is the first byte of the id preimage, so a table that disagrees
    // with @dagsocial/types moves every id derived here.
    const box: GenesisProofBox = {
      boxType: 'genesis_proof', value: 0n, payload: new Uint8Array([0x01]),
      guard: 'unspendable', txId: COVERAGE_TX_ID, index: 5,
    };
    expect(hexOf(canonicalBoxBytes(box)).slice(0, 2)).toBe('03');
    expect(hexOf(ui.canonicalBoxBytes(box as unknown as Record<string, unknown>)).slice(0, 2))
      .toBe('03');
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
    // Box bytes are variable-length, so a concatenation with no count and no
    // length prefix lets two different output lists produce one byte string.
    // `arr()` writes the count, which is what makes the preimage injective
    // (TYPES_INTERFACE → Layout — UtxoTransaction).
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
    // `opt()` tags presence, so `{}` is `01 00` and absence is `00` — an empty
    // map and a missing one are distinguishable rather than both appending
    // nothing, which is what closes the malleability.
    expect(computeTxId(empty)).not.toBe(GOLDEN_UTXO_TX_ID);
  });
});

// ---------------------------------------------------------------------------

/**
 * Box-identity mirror. The derivation binds content *and* the position that
 * content was created at (NODE_INTERFACE → Box Identity and Mint Provenance):
 *
 *   blake2b512( BOX_ID_DOMAIN ‖ canonicalBoxBytes ‖ b32(txId) ‖ vlqU(index) )
 *
 * Provenance is structurally absent from `canonicalBoxBytes` and appended
 * afterwards rather than stripped before hashing, which is what keeps the
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
    // There is no second derivation to differ from: `computeBoxId` IS
    // `computeCandidateBoxId` applied to the box's own provenance — on BOTH
    // sides — so these must be EQUAL, and the mirror is what proves the client
    // collapsed them the same way the node did.
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
    // 0xffffffff and 2^32 are deliberately absent from this list. Both are
    // inside `vlqU`'s domain and encode faithfully, so they are valid indices
    // rather than sentinel cases — the assertion below pins that.
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, bad), `index=${bad}`)
        .toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
      expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, bad), `index=${bad}`)
        .toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
    }
    // …and 2^32 is a real index, distinct from the sentinel.
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 2 ** 32))
      .not.toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 2 ** 32))
      .toBe(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 2 ** 32));
  });

  it('txId enters as 32 RAW bytes — an out-of-domain txId has no encoding at all', () => {
    // `b32` decodes the hex text to 32 raw bytes, and its domain is 64
    // LOWERCASE hex characters. `AB…` and `ab…` name one transaction, so an
    // encoding that admitted both would give that transaction two ids; here the
    // uppercase spelling has no encoding at all, and the ambiguity is
    // unconstructible rather than merely distinguished.
    //
    // The cost is stated where it is paid: derivation is NOT total on an
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
 * likeTarget tail mirror. The like transaction's target sits inside the
 * `computeTxId` preimage as `opt(likeTarget, b32)` (TYPES_INTERFACE → Layout —
 * UtxoTransaction), so the signature covers the target and a
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
    // `opt` distinguishes presence from absence by a tag byte, so presence is
    // `!== undefined` and never truthiness — but `''` does not reach that
    // question at all, because it is out of the `b32` domain and has no
    // encoding. A truthiness trap is unconstructible here rather than handled.
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

// ---------------------------------------------------------------------------
// The post-PoW nonce tail, and the predicate the UI decides with it
// ---------------------------------------------------------------------------

describe('demo UI ↔ @dagsocial/types post-PoW nonce tail', () => {
  // TYPES_INTERFACE → Serialization → "Layout — Post" makes `powNonceBytes` the
  // tail's only writer, so the UI's copy is a mirror and not a second dialect.
  // These are the values `packages/types/test/golden/post.json` freezes for it —
  // including the out-of-domain sentinel, because the tail is total on both sides
  // and four out-of-domain nonces sharing one tail is a property, not an accident.
  const FROZEN_NONCES = [0, 127, 128, 1000000, Number.MAX_SAFE_INTEGER, -1];

  it.each(FROZEN_NONCES)('powNonceTail(%d) is byte-identical to powNonceBytes', (n) => {
    expect(hexOf(ui.powNonceTail(n))).toBe(hexOf(powNonceBytes(n)));
  });

  it('computePostId reaches the same tail writer, not a second copy of it', () => {
    // The id's nonce row must move with `powNonceTail`. Two UI call sites read
    // the same writer, so neither can drift from the other or from validation.
    const tail = ui.powNonceTail(GOLDEN_POST.powNonce);
    expect(hexOf(tail)).toBe(hexOf(powNonceBytes(GOLDEN_POST.powNonce)));
    expect(ui.computePostId(GOLDEN_POST as unknown as Record<string, unknown>))
      .toBe(computePostId(GOLDEN_POST));
  });
});

describe('demo UI PoW predicate ↔ @dagsocial/validation verifyPoW', () => {
  const INPUTS = {
    'three-bytes': new Uint8Array([0x01, 0x02, 0x03]),
    'empty': new Uint8Array([]),
    '32-zero-bytes': new Uint8Array(32),
  } satisfies Record<string, Uint8Array>;

  // Every row carries the zero-bit count its digest actually opens with, so
  // `targetBits` is CHOSEN, never searched. A test that mines a nonce through the
  // predicate it is testing cannot fail — it asks the predicate for an input the
  // predicate accepts.
  //
  // The hash column is regenerated rather than hand-derived: the LAYOUT is pinned
  // upstream by types' golden vectors, written from the layout table. What these rows
  // pin is that two independent implementations of the same predicate agree —
  // `validation/src/verify.ts` and the demo UI compute the same concat, the same
  // blake2b512, the same [0..32] and the same leading-zero test, sharing no code.
  const ROWS = [
    { input: 'three-bytes', nonce: 0, zeroBits: 0, hash: 'ca8a13775dfec26a67ac1f7f19a2f01417bf74ea9d32c5a0c97ba6e672b397a1' },
    { input: 'three-bytes', nonce: 1, zeroBits: 2, hash: '2b64d5317f8a756bdf36152e0cf8d11bf3d64d0f0757acddbda7b91637255119' },
    { input: 'three-bytes', nonce: 127, zeroBits: 2, hash: '365c35d560d5098d733cd8616880664fd220bdffa5181d3f1e0f235c2c7bb245' },
    { input: 'three-bytes', nonce: 128, zeroBits: 0, hash: '8aa077826cc617670c94e07ea476567f5dbd3b4837ff3f04442a877e081b54a3' },
    { input: 'three-bytes', nonce: 1000000, zeroBits: 5, hash: '0431e9d873053b76056b851cc66b4cfddbf0d19fd4db8c149dec44aeffa44a06' },
    { input: 'three-bytes', nonce: 212554, zeroBits: 17, hash: '00004189c1bb78326f134603e69f033328f154395b18881789bd8f970f268b9c' },
    { input: 'empty', nonce: 0, zeroBits: 2, hash: '2fa3f686df876995167e7c2e5d74c4c7b6e48f8068fe0e44208344d480f7904c' },
    { input: 'empty', nonce: 1000000, zeroBits: 1, hash: '4612328d490fb0ca9ab63e82fb3400f7bca2da13928cddd5913e0b9c9d65ae93' },
    { input: '32-zero-bytes', nonce: 0, zeroBits: 0, hash: 'e5950b21be53a5b576e5f131289b05ebb19bd8fdb20eb7168466b26651d62fa8' },
    { input: '32-zero-bytes', nonce: 1000000, zeroBits: 5, hash: '06e52d645229208556c3d379c1a00e40b54c8126338d360c0d6d1db61d5b8738' },
  ] as const;

  it.each(ROWS)('$input @ nonce $nonce: the UI digest is verifyPoW\'s', (row) => {
    const input = INPUTS[row.input];
    const hash = ui.postPowHash(input, row.nonce);
    expect(hexOf(hash)).toBe(row.hash);
    // `zeroBits` is the exact count, so the digest meets that target and no
    // tighter one — which pins the count without the predicate returning one.
    expect(ui.meetsPowTarget(hash, ui.powTarget(row.zeroBits)!)).toBe(true);
    expect(ui.meetsPowTarget(hash, ui.powTarget(row.zeroBits + 1)!)).toBe(false);
  });

  it.each(ROWS)('$input @ nonce $nonce: both predicates hold at $zeroBits and fail one bit tighter', (row) => {
    const input = INPUTS[row.input];
    const uiHolds = (bits: number): boolean =>
      ui.meetsPowTarget(ui.postPowHash(input, row.nonce), ui.powTarget(bits)!);

    // A `bits` that holds and a `bits` that fails FOR THE SAME NONCE, so neither a
    // constant-true nor a constant-false predicate survives either side.
    expect(uiHolds(row.zeroBits)).toBe(true);
    expect(verifyPoW(input, row.nonce, row.zeroBits)).toBe(true);
    expect(uiHolds(row.zeroBits + 1)).toBe(false);
    expect(verifyPoW(input, row.nonce, row.zeroBits + 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Completeness audit — a mirror's coverage is a claim about a LIST
// ---------------------------------------------------------------------------

/**
 * Byte construction in `index.html` must sit inside something the mirror evaluates.
 *
 * Adding a name to `MIRRORED_OTHER` fixes one omission. This re-derives the list
 * instead, because the defect's shape is *a list nobody re-derives*: a
 * consensus-critical function the list does not name is unpinned, and its
 * absence signals nothing — the whole suite stays green (WEB_INTERFACE, the
 * mirror-coverage warning).
 *
 * ⚠ **This narrows the class; it does not close it.** The audit keys on a
 * VOCABULARY drawn from `BYTE_PRIMITIVES`. Byte assembly written without any of
 * those names — a bare `new Uint8Array([…])`, a hand-rolled push loop, a DataView
 * write — is invisible to it. Nor can it see a function that calls a *mirrored*
 * builder with the wrong arguments: it sees construction, not correctness. A reader
 * who takes the vocabulary for the whole class repeats the mistake one level down.
 */
const AUDIT_VOCABULARY: readonly string[] = [
  ...BYTE_PRIMITIVES,
  'blake2b', 'concatUint8Arrays', 'encoder.encode',
];

/**
 * Scopes that construct bytes and are deliberately not mirrored — one line of reason
 * each, and none of them the post-PoW tail. An entry is an admission, not a
 * clearance: `signPost`'s own reason names a digest line this suite does not pin,
 * so read each reason for what it concedes rather than treating the list as a
 * second column of coverage.
 */
const AUDIT_ALLOW: Record<string, string> = {
  signPost:
    'its PREIMAGE is mirrored (buildSignHashInput -> buildPowInput); its digest line is NOT — uiSigningHash re-implements blake2b(input, null, 64).slice(0, 32) test-side rather than evaluating signPost, so changing this call to slice(0, 16) would fail nothing. An unpinned two-line copy, carried deliberately.',
  attachFeedHandlers:
    'hashes a server-issued challenge before Ed25519 signing — it takes no layout decision',
  'createInviteBtn#click':
    'hashes 32 random bytes into an invite secretHash — it takes no layout decision',
};

interface Scope { name: string; start: number; end: number; }
interface Finding { scope: string; token: string; line: number; }

/** Blank comments and string/template bodies, preserving every offset. */
function maskSource(s: string): string {
  const out = s.split('');
  let i = 0;
  let state: 'line' | 'block' | 'str' | null = null;
  let quote: string | null = null;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (state === 'line') { if (ch === '\n') state = null; else out[i] = ' '; i++; continue; }
    if (state === 'block') {
      if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = null; continue; }
      if (ch !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (state === 'str') {
      if (ch === '\\') { out[i] = ' '; if (s[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
      if (ch === quote) { state = null; quote = null; i++; continue; }
      if (ch !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (ch === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'line'; continue; }
    if (ch === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'block'; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { out[i] = ' '; quote = ch; state = 'str'; i++; continue; }
    i++;
  }
  return out.join('');
}

/** End offset (exclusive) of the block opened by the first `{` at or after `from`. */
function blockEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = masked.indexOf('{', from); i < masked.length && i !== -1; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error(`unterminated block at offset ${from}`);
}

/**
 * Every scope a byte site can be attributed to, innermost-first at use.
 *
 * Three shapes, because two of them are the blind spots of the first: a declared
 * function, a function or arrow bound to a name, and an inline DOM handler — which
 * has no name of its own, so it takes the element id and event as its address.
 */
function namedScopes(src: string, masked: string): Scope[] {
  const scopes: Scope[] = [];
  for (const m of masked.matchAll(/\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g)) {
    scopes.push({ name: m[1]!, start: m.index, end: blockEnd(masked, m.index) });
  }
  const bound = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/g;
  for (const m of masked.matchAll(bound)) {
    scopes.push({ name: m[1]!, start: m.index, end: blockEnd(masked, m.index) });
  }
  // Matched on the raw source: a handler's address is its element id and event, and
  // both are string literals, which `maskSource` blanks. Offsets are preserved, so
  // requiring the call itself to survive masking is what keeps a commented-out
  // registration from registering a scope.
  const handler = /getElementById\(\s*'([A-Za-z0-9_]+)'\s*\)\s*\.addEventListener\(\s*'([a-z]+)'\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  for (const m of src.matchAll(handler)) {
    if (!masked.startsWith('getElementById', m.index)) continue;
    scopes.push({ name: `${m[1]!}#${m[2]!}`, start: m.index, end: blockEnd(masked, m.index) });
  }
  return scopes;
}

/** The single-statement scope of a top-level `const NAME = …` initialiser. */
function constInitScopes(masked: string): Scope[] {
  const scopes: Scope[] = [];
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g)) {
    const nl = masked.indexOf('\n', m.index);
    scopes.push({ name: m[1]!, start: m.index, end: nl === -1 ? masked.length : nl });
  }
  return scopes;
}

function auditByteConstruction(): { findings: Finding[]; unattributed: Finding[] } {
  const src = readFileSync(INDEX_HTML, 'utf8');
  const masked = maskSource(src);
  const scopes = namedScopes(src, masked);
  const consts = constInitScopes(masked);
  const lineOf = (off: number): number => masked.slice(0, off).split('\n').length;

  const findings: Finding[] = [];
  const unattributed: Finding[] = [];
  for (const token of AUDIT_VOCABULARY) {
    const re = new RegExp(`(?<![A-Za-z0-9_$.])${token.replace('.', '\\.')}\\s*\\(`, 'g');
    for (const m of masked.matchAll(re)) {
      const off = m.index;
      const inner = scopes
        .filter((s) => off > s.start && off < s.end)
        .sort((a, b) => (b.end - b.start) - (a.end - a.start))
        .pop();
      if (inner) {
        // A declaration's own header is not a call site of itself.
        if (inner.name === token && off === inner.start + 'function '.length) continue;
        findings.push({ scope: inner.name, token, line: lineOf(off) });
        continue;
      }
      const asConst = consts.find((c) => off > c.start && off < c.end);
      if (asConst) { findings.push({ scope: asConst.name, token, line: lineOf(off) }); continue; }
      unattributed.push({ scope: '<no named scope>', token, line: lineOf(off) });
    }
  }
  return { findings, unattributed };
}

describe('demo UI byte-construction completeness audit', () => {
  const { findings, unattributed } = auditByteConstruction();
  const covered = (scope: string): boolean =>
    MIRRORED_FUNCTIONS.includes(scope)
    || (MIRRORED_CONSTS as readonly string[]).includes(scope)
    || scope in AUDIT_ALLOW;

  it('finds byte construction at all — a vocabulary that matches nothing proves nothing', () => {
    expect(findings.length).toBeGreaterThan(20);
    expect(new Set(findings.map((f) => f.scope)).size).toBeGreaterThan(10);
  });

  it('every byte-constructing scope is mirrored or allow-listed', () => {
    const unexplained = findings
      .filter((f) => !covered(f.scope))
      .map((f) => `${f.scope} — ${f.token}( at index.html:${f.line}`);
    expect([...new Set(unexplained)]).toEqual([]);
  });

  it('no byte construction sits outside every named scope', () => {
    // An anonymous site has no stable address, so it cannot be allow-listed either.
    // The fix for one is to give it a name.
    expect(unattributed.map((f) => `${f.token}( at index.html:${f.line}`)).toEqual([]);
  });

  it('solvePoW constructs no bytes', () => {
    // Named on purpose. It is the site this audit exists to cover, so exempting it
    // would have been the audit's first act — the extraction is what keeps the
    // allow-list honest rather than self-serving.
    expect(Object.keys(AUDIT_ALLOW)).not.toContain('solvePoW');
    expect(findings.filter((f) => f.scope === 'solvePoW')).toEqual([]);
  });

  it('the allow-list carries a reason per entry and no dead entries', () => {
    for (const [scope, reason] of Object.entries(AUDIT_ALLOW)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(findings.some((f) => f.scope === scope)).toBe(true);
    }
  });

  it('the mirror still names the tail writer, the hash and the predicate', () => {
    for (const name of ['powNonceTail', 'postPowHash', 'powTarget', 'meetsPowTarget']) {
      expect(MIRRORED_FUNCTIONS).toContain(name);
      expect(RETURNED as readonly string[]).toContain(name);
    }
    expect(typeof ui.powNonceTail).toBe('function');
    expect(typeof ui.postPowHash).toBe('function');
    expect(typeof ui.powTarget).toBe('function');
    expect(typeof ui.meetsPowTarget).toBe('function');
  });
});
