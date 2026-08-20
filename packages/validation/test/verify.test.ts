import { describe, it, expect } from 'vitest';
import { createHash, sign, createPrivateKey, verify as cryptoVerify } from 'crypto';
import { readFileSync } from 'fs';
import {
  verifyValidatorSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyContentCharacters,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyBlockChainLink,
  verifyOrderingBlockPoW,
  blockHash,
  computePowHash,
  isValidVouchTarget,
  verifyPostFieldDomains,
  verifyHeaderFieldDomains,
  ed25519PublicKeyToKeyObject,
} from '../src/verify.js';
import { isDisallowedContentCodepoint, PINNED_UNICODE_VERSION } from '../src/content-charset.js';
import { generateKeyPair, computePostId, computeTxId, postFieldBytes, EMPTY_STATE_ROOT, MAX_CONTENT_BYTES, MAX_PARENT_REFS, MAX_TX_BYTES, MAX_BLOCK_BODY_BYTES, ORDERING_BLOCK_POW_TARGET_FLOOR, PROTOCOL_VERSION, encodeHeader, encodeTx, encodeUtxoTxTree, utxoTxTreeByteLength, ByteWriter, writeHexNOrThrow, writeBytesNOrThrow, writeVlqU, writeLp } from '@dagsocial/types';
import type { Post, PruneEntry, BlockHeader, OrderingBlock, UtxoTransaction, AnyBoxCandidate } from '@dagsocial/types';

/**
 * `blockHash` for a fixture the test has just built and asserts is in-domain.
 *
 * The guarded function answers `null` on exactly the headers
 * `verifyHeaderFieldDomains` rejects, so a `null` here means the *fixture* drifted
 * out of the domain — not that the code under test is wrong. It says so at the
 * fixture rather than surfacing as `Buffer.from(null)` three frames later —
 * the same argument that puts the guard inside the encoder-backed functions.
 *
 * Deliberately not used for the poison fixtures: those are outside the domain on
 * purpose, and hash through the transcribed unguarded encoder instead.
 */
function mustHash(header: BlockHeader): string {
  const hash = blockHash(header);
  if (hash === null) {
    throw new Error(
      `fixture header is outside the encodable domain (blockHash returned null): ` +
        `${verifyHeaderFieldDomains(header).error ?? 'no reason reported'}`,
    );
  }
  return hash;
}

// ---------------------------------------------------------------------------
// verifyValidatorSignature
// ---------------------------------------------------------------------------

describe('verifyValidatorSignature', () => {
  type KeyPair = ReturnType<typeof generateKeyPair>;

  const privKeyOf = (kp: KeyPair) =>
    createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' });

  const makeHeader = (over: Partial<BlockHeader> = {}): BlockHeader => ({
    protocolVersion: 1,
    height: 7,
    prevBlockHash: 'ab'.repeat(32),
    utxoTxRoot: '22'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32),
    powNonce: 12345,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_700_000_000_000,
    ...over,
  });

  /** Sign exactly what the block creator signs: the 32 raw bytes of blockHash(header). */
  const signHeader = (header: BlockHeader, kp: KeyPair): Uint8Array =>
    new Uint8Array(sign(null, Buffer.from(mustHash(header), 'hex'), privKeyOf(kp)));

  it('accepts a correctly signed header', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    expect(verifyValidatorSignature(header, signHeader(header, kp))).toBe(true);
  });

  it('rejects a signature made by a key other than validatorId (forged authorship)', () => {
    const kpA = generateKeyPair();
    const kpB = generateKeyPair();
    // The header claims B produced the block; A actually signed it.
    const header = makeHeader({ validatorId: kpB.publicKey });
    expect(verifyValidatorSignature(header, signHeader(header, kpA))).toBe(false);
  });

  it('rejects a tampered header — the recomputed blockHash no longer matches', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    const sig = signHeader(header, kp);
    expect(verifyValidatorSignature({ ...header, height: 8 }, sig)).toBe(false);
    expect(verifyValidatorSignature({ ...header, utxoTxRoot: '33'.repeat(32) }, sig)).toBe(false);
    expect(verifyValidatorSignature({ ...header, powNonce: 12346 }, sig)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    const sig = signHeader(header, kp);
    sig[0] = (sig[0]! + 1) % 256;
    expect(verifyValidatorSignature(header, sig)).toBe(false);
  });

  it('rejects an all-zero placeholder signature', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    expect(verifyValidatorSignature(header, new Uint8Array(64))).toBe(false);
  });

  // --- no-panic (M-5): every malformed shape returns false, never throws ---

  it('returns false without throwing on a missing or mis-typed signature', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    for (const bad of [undefined, null, 'abc', 42, {}, [], new Uint32Array(16)]) {
      expect(() => verifyValidatorSignature(header, bad as any)).not.toThrow();
      expect(verifyValidatorSignature(header, bad as any)).toBe(false);
    }
  });

  it('returns false without throwing on a wrong-length signature', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    for (const len of [0, 32, 63, 65, 128]) {
      expect(() => verifyValidatorSignature(header, new Uint8Array(len))).not.toThrow();
      expect(verifyValidatorSignature(header, new Uint8Array(len))).toBe(false);
    }
  });

  it('returns false without throwing when validatorId is not 32 bytes (createPublicKey)', () => {
    const kp = generateKeyPair();
    const sig = signHeader(makeHeader({ validatorId: kp.publicKey }), kp);
    for (const len of [0, 31, 33, 64]) {
      const header = makeHeader({ validatorId: new Uint8Array(len) });
      expect(() => verifyValidatorSignature(header, sig)).not.toThrow();
      expect(verifyValidatorSignature(header, sig)).toBe(false);
    }
    // 32 bytes that are not a valid curve point must still reject cleanly.
    const offCurve = makeHeader({ validatorId: new Uint8Array(32).fill(0xff) });
    expect(() => verifyValidatorSignature(offCurve, sig)).not.toThrow();
    expect(verifyValidatorSignature(offCurve, sig)).toBe(false);
  });

  it('returns false without throwing on a header that encodeHeader would reject', () => {
    const kp = generateKeyPair();
    const sig = signHeader(makeHeader({ validatorId: kp.publicKey }), kp);
    const bad: unknown[] = [
      null,
      undefined,
      'not-a-header',
      42,
      makeHeader({ prevBlockHash: Symbol('s') as any }),
      makeHeader({ validatorId: undefined as any }),
      makeHeader({ validatorId: 'hex-string' as any }),
      makeHeader({ height: undefined as any }),
      makeHeader({ stateRoot: Symbol('r') as any }),
      makeHeader({ createdAt: (() => 1) as any }),
    ];
    for (const h of bad) {
      expect(() => verifyValidatorSignature(h as any, sig)).not.toThrow();
      expect(verifyValidatorSignature(h as any, sig)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyProtocolVersion
// ---------------------------------------------------------------------------

describe('verifyProtocolVersion', () => {
  it('accepts version 1', () => {
    expect(verifyProtocolVersion(1)).toBe(true);
  });

  it('rejects version 0', () => {
    expect(verifyProtocolVersion(0)).toBe(false);
  });

  it('rejects version 2', () => {
    expect(verifyProtocolVersion(2)).toBe(false);
  });

  it('rejects version 999', () => {
    expect(verifyProtocolVersion(999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyContentLimits
// ---------------------------------------------------------------------------

describe('verifyContentLimits', () => {
  it('accepts content within limits', () => {
    expect(verifyContentLimits('hello')).toEqual({ valid: true });
  });

  it('rejects empty content', () => {
    expect(verifyContentLimits('')).toEqual({ valid: false, error: 'Content is empty' });
  });

  it('rejects content exceeding 300 bytes', () => {
    const long = 'x'.repeat(301);
    expect(verifyContentLimits(long)).toEqual({ valid: false, error: 'Content exceeds max length' });
  });

  it('accepts exactly 300 bytes', () => {
    const exact = 'x'.repeat(300);
    expect(verifyContentLimits(exact)).toEqual({ valid: true });
  });

  it('accepts 1-byte content', () => {
    expect(verifyContentLimits('x')).toEqual({ valid: true });
  });

  it('counts UTF-8 bytes not characters', () => {
    // '€' is 3 bytes in UTF-8
    const euros = '€'.repeat(100); // 300 bytes
    expect(verifyContentLimits(euros)).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// verifyContentCharacters
// ---------------------------------------------------------------------------

describe('verifyContentCharacters', () => {
  it('accepts plain ASCII text', () => {
    expect(verifyContentCharacters('hello world')).toEqual({ valid: true });
  });

  it('accepts text with newlines', () => {
    expect(verifyContentCharacters('line1\nline2\nline3')).toEqual({ valid: true });
  });

  it('accepts Unicode letters and marks', () => {
    expect(verifyContentCharacters('Café résumé naïve')).toEqual({ valid: true });
  });

  it('accepts CJK characters', () => {
    expect(verifyContentCharacters('你好世界')).toEqual({ valid: true });
  });

  it('accepts emoji', () => {
    expect(verifyContentCharacters('hello 👋 world 🌍')).toEqual({ valid: true });
  });

  it('accepts punctuation and symbols', () => {
    expect(verifyContentCharacters('Hello! How are you? #excited')).toEqual({ valid: true });
  });

  it('accepts numbers', () => {
    expect(verifyContentCharacters('12345')).toEqual({ valid: true });
  });

  it('accepts empty string', () => {
    // Character check passes; content length is enforced separately by verifyContentLimits
    expect(verifyContentCharacters('')).toEqual({ valid: true });
  });

  it('rejects null byte', () => {
    expect(verifyContentCharacters('hello\u0000world').valid).toBe(false);
  });

  it('rejects backspace', () => {
    expect(verifyContentCharacters('hello\bworld').valid).toBe(false);
  });

  it('rejects tab', () => {
    expect(verifyContentCharacters('hello\tworld').valid).toBe(false);
  });

  it('rejects carriage return', () => {
    expect(verifyContentCharacters('hello\rworld').valid).toBe(false);
  });

  it('rejects escape sequence', () => {
    expect(verifyContentCharacters('helloworld').valid).toBe(false);
  });

  it('rejects zero-width space (U+200B)', () => {
    expect(verifyContentCharacters('hello​world').valid).toBe(false);
  });

  it('rejects zero-width non-joiner (U+200C)', () => {
    expect(verifyContentCharacters('hello‌world').valid).toBe(false);
  });

  it('rejects zero-width joiner (U+200D)', () => {
    expect(verifyContentCharacters('hello‍world').valid).toBe(false);
  });

  it('rejects BOM (U+FEFF)', () => {
    expect(verifyContentCharacters('﻿hello').valid).toBe(false);
  });

  it('rejects bidi override LTR (U+202D)', () => {
    expect(verifyContentCharacters('hello‭world').valid).toBe(false);
  });

  it('rejects bidi override RTL (U+202E)', () => {
    expect(verifyContentCharacters('hello‮world').valid).toBe(false);
  });

  it('rejects bidi isolate chars (U+2066-U+2069)', () => {
    expect(verifyContentCharacters('hello⁦world').valid).toBe(false);
    expect(verifyContentCharacters('hello⁧world').valid).toBe(false);
    expect(verifyContentCharacters('hello⁨world').valid).toBe(false);
    expect(verifyContentCharacters('hello⁩world').valid).toBe(false);
  });

  it('rejects soft hyphen (U+00AD)', () => {
    // U+00AD is Cf (format), not Pd (punctuation dash)
    expect(verifyContentCharacters('hello­world').valid).toBe(false);
  });

  it('rejects private use area (U+E000)', () => {
    expect(verifyContentCharacters('helloworld').valid).toBe(false);
  });

  it('rejects string that is entirely disallowed chars', () => {
    expect(verifyContentCharacters('​‌‍').valid).toBe(false);
  });

  it('provides a useful error message', () => {
    const result = verifyContentCharacters('bad​char');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('disallowed characters');
  });
});

// ---------------------------------------------------------------------------
// verifyParentRefsCount
// ---------------------------------------------------------------------------

describe('verifyParentRefsCount', () => {
  it('accepts 0 parent refs', () => {
    expect(verifyParentRefsCount([])).toEqual({ valid: true });
  });

  // Both bounds are written against the constant, the shape the ordering-block
  // path already uses (`refs(n)`, below). Spelled as literals they fail
  // asymmetrically the moment `MAX_PARENT_REFS` moves: a hardcoded bound breaks
  // loudly, while a hardcoded bound-plus-one keeps passing and quietly stops
  // testing the off-by-one it exists for — it lands many *over* the bound rather
  // than one over. A test that still passes for a weaker reason than its name
  // claims shows up in no failure list, which is why the bound is never spelled
  // as a number.
  //
  // Placeholder refs, not hex ids, on purpose: `verifyParentRefsCount` checks
  // array-ness and length and nothing else, and the fixtures say so.
  it('accepts exactly MAX_PARENT_REFS parent refs', () => {
    const refs = Array.from({ length: MAX_PARENT_REFS }, (_, i) => `ref${i}`);
    expect(refs).toHaveLength(MAX_PARENT_REFS);
    expect(verifyParentRefsCount(refs)).toEqual({ valid: true });
  });

  it('rejects one more than MAX_PARENT_REFS', () => {
    const refs = Array.from({ length: MAX_PARENT_REFS + 1 }, (_, i) => `ref${i}`);
    expect(verifyParentRefsCount(refs)).toEqual({
      valid: false,
      error: `Too many parent refs (max ${MAX_PARENT_REFS})`,
    });
  });
});

// ---------------------------------------------------------------------------
// verifyTxStructure
// ---------------------------------------------------------------------------

describe('verifyTxStructure', () => {
  // ⛔ Box ids are `b32` — 64 lowercase hex, always — so a stand-in like
  // `'input1'` is not merely unrealistic: `writeHexNOrThrow` refuses it and the
  // weight bound's `encodeTx` turns every fixture carrying one into
  // `Transaction is not encodable`. Each rejection below therefore names its own
  // error, so a fixture that drifts out of the codec's domain fails loudly
  // instead of being credited to the rule it was written for.
  const ID_A = 'aa'.repeat(32);
  const ID_B = 'bb'.repeat(32);
  const karmaOut = { boxType: 'karma', value: 5n, createdAtBlock: 0, owner: new Uint8Array(32) } as const;

  it('accepts a valid transaction', () => {
    const tx: UtxoTransaction = {
      inputs: [ID_A],
      outputs: [{ ...karmaOut }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx)).toEqual({ valid: true });
  });

  it('rejects transaction with no inputs', () => {
    const tx: UtxoTransaction = {
      inputs: [],
      outputs: [{ ...karmaOut }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx)).toEqual({
      valid: false,
      error: 'Transaction must have at least one input',
    });
  });

  it('rejects transaction with no outputs', () => {
    const tx: UtxoTransaction = {
      inputs: [ID_A],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx)).toEqual({
      valid: false,
      error: 'Transaction must have at least one output',
    });
  });

  it('rejects transaction with duplicate inputs', () => {
    const tx: UtxoTransaction = {
      inputs: [ID_A, ID_A],
      outputs: [{ ...karmaOut }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx)).toEqual({
      valid: false,
      error: 'Duplicate input in transaction',
    });
    // Two distinct ids are the control: the rule is duplication, not arity.
    expect(verifyTxStructure({ ...tx, inputs: [ID_A, ID_B] })).toEqual({ valid: true });
  });

  it('rejects transaction missing protocolVersion', () => {
    const tx = {
      inputs: [ID_A],
      outputs: [{ ...karmaOut }],
      signatures: {},
    } as unknown as UtxoTransaction;
    expect(verifyTxStructure(tx)).toEqual({
      valid: false,
      error: 'Transaction missing protocolVersion',
    });
  });
});

// ---------------------------------------------------------------------------
// verifyTxStructure — a genesis_proof box may never be a transaction output
// ---------------------------------------------------------------------------
//
// The rule's other half — never an *input* — is node's, because `tx.inputs` are
// box id strings and typing one needs the UTXO set
// (VALIDATION_INTERFACE → verifyTxStructure).

describe('verifyTxStructure — genesis_proof outputs', () => {
  const REASON = 'Transaction may not output a genesis_proof box';

  const proofOut = (payload: Uint8Array): AnyBoxCandidate => ({
    boxType: 'genesis_proof',
    value: 0n,
    createdAtBlock: 0,
    payload,
  });

  const txWith = (outputs: AnyBoxCandidate[]): UtxoTransaction => ({
    inputs: ['aa'.repeat(32)],
    outputs,
    signatures: {},
    protocolVersion: 1,
  });

  const karmaOut: AnyBoxCandidate = {
    boxType: 'karma', value: 5n, createdAtBlock: 0, owner: new Uint8Array(32),
  };

  /**
   * One candidate per box type the rule must not touch. Named for what the list
   * is rather than how long it is, so a new box type does not make the name
   * false.
   */
  const NON_PROOF_OUTPUTS: [string, AnyBoxCandidate][] = [
    ['karma', karmaOut],
    ['credit', { boxType: 'credit', value: 5n, createdAtBlock: 0, owner: new Uint8Array(32) }],
    ['bond', { boxType: 'bond', value: 5n, createdAtBlock: 0, inviterId: new Uint8Array(32), inviteePublicKey: new Uint8Array(32) }],
    ['post_lock', { boxType: 'post_lock', value: 5n, createdAtBlock: 0, originalValue: 5n, owner: new Uint8Array(32) }],
    ['vouch', { boxType: 'vouch', value: 1n, createdAtBlock: 0, voucherId: new Uint8Array(32), targetId: new Uint8Array(32) }],
    ['like_accrual', { boxType: 'like_accrual', value: 1n, createdAtBlock: 0, author: new Uint8Array(32) }],
    ['vouch_escrow', { boxType: 'vouch_escrow', value: 1n, createdAtBlock: 0, owner: new Uint8Array(32), releaseAtBlock: 42 }],
  ];

  it('rejects a transaction that outputs a genesis_proof box', () => {
    expect(verifyTxStructure(txWith([proofOut(new Uint8Array([1]))]))).toEqual({
      valid: false,
      error: REASON,
    });
  });

  it('rejects it in any output position, not only the first', () => {
    expect(verifyTxStructure(txWith([karmaOut, proofOut(new Uint8Array([1])), karmaOut]))).toEqual({
      valid: false,
      error: REASON,
    });
  });

  // The box type is the whole rule, so the verdict and the reason are constant
  // in payload size — this package states no payload bound and none can be
  // credited for a rejection here (VALIDATION_INTERFACE → verifyTxStructure).
  // The assertion is on the *reason*: a rejection test that asserts only
  // `valid: false` cannot tell which rule rejected.
  it.each([0, 1, 512, 513, 65536])('rejects a %i-byte payload for the same reason', (n) => {
    expect(verifyTxStructure(txWith([proofOut(new Uint8Array(n))]))).toEqual({
      valid: false,
      error: REASON,
    });
  });

  // The tag alone decides, so a proof box carrying no payload at all is refused
  // without the scan reading a field that is not there.
  it('rejects a genesis_proof output with no other field set', () => {
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'genesis_proof' }],
      signatures: {},
      protocolVersion: 1,
    } as unknown as UtxoTransaction;
    expect(verifyTxStructure(tx)).toEqual({ valid: false, error: REASON });
  });

  it.each(NON_PROOF_OUTPUTS)('leaves a %s output alone', (_label, out) => {
    expect(verifyTxStructure(txWith([out]))).toEqual({ valid: true });
  });

  // Totality (M-5). The scan reads `boxType` off a peer-supplied object, so a
  // non-object output yields a verdict rather than a TypeError.
  //
  // ⛔ The verdict is a REJECTION, and it is the encoder's, not this scan's.
  // "An output is an object" is still not a rule this package states — but a
  // non-object has no box arm, so `canonicalBoxBytes` reaches a throwing writer
  // and the weight bound's `encodeTx` catch turns that into the stated
  // rejection (VALIDATION_INTERFACE → verifyTxStructure). What the scan
  // guarantees is the *shape* of the answer: a verdict, never a TypeError.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'genesis_proof'],
    ['an array', []],
  ])('answers a verdict, never a throw, on %s in outputs', (_label, out) => {
    const tx = {
      inputs: ['aa'.repeat(32)],
      outputs: [out],
      signatures: {},
      protocolVersion: 1,
    } as unknown as UtxoTransaction;
    expect(() => verifyTxStructure(tx)).not.toThrow();
    expect(verifyTxStructure(tx)).toEqual({
      valid: false,
      error: 'Transaction is not encodable',
    });
  });

  it('and the genesis_proof scan is not what refuses them', () => {
    // The control: a well-formed karma output in the same position is accepted,
    // so the rejections above are about the outputs being unencodable and not
    // about the scan having grown a rule.
    expect(verifyTxStructure(txWith([karmaOut]))).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// verifyOrderingBlockStructure
// ---------------------------------------------------------------------------

/**
 * The settlement transaction as *this* layer sees it — an id and opaque bytes.
 *
 * Position is the whole of its identity (NODE_INTERFACE → It is the LAST entry
 * in `utxoTxIds`), so nothing here decodes it and no fixture needs it to be
 * well-formed inside. Every valid-block fixture below carries one because a body
 * without one is refused, and a fixture that did not would be measuring the
 * settlement rule instead of whatever it names.
 */
const SETTLEMENT_ID = 'ee'.repeat(32);
const SETTLEMENT_BYTES = new Uint8Array([1]);

describe('verifyOrderingBlockStructure', () => {
  const makeValidBlock = (): OrderingBlock => ({
    header: {
      protocolVersion: 1,
      height: 1,
      prevBlockHash: '0'.repeat(64),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32).fill(1),
      powNonce: 0,
      powTargetBits: 3072,
      createdAt: Date.now(),
    },
    utxoTxTree: {
      utxoTxIds: [SETTLEMENT_ID],
      utxoTxs: [SETTLEMENT_BYTES],
      pruneEntries: [],
    },
    validatorSignature: new Uint8Array(64),
  });

  it('accepts a valid ordering block', () => {
    expect(verifyOrderingBlockStructure(makeValidBlock())).toEqual({ valid: true });
  });

  it('rejects block missing prevBlockHash', () => {
    const block = {
      ...makeValidBlock(),
      header: { ...makeValidBlock().header, prevBlockHash: '' },
    };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block with invalid validatorSignature length', () => {
    const block = { ...makeValidBlock(), validatorSignature: new Uint8Array(32) };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block with height 0', () => {
    const block = {
      ...makeValidBlock(),
      header: { ...makeValidBlock().header, height: 0 },
    };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block missing protocolVersion', () => {
    const block = {
      ...makeValidBlock(),
      header: { ...makeValidBlock().header, protocolVersion: undefined },
    } as unknown as OrderingBlock;
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block with empty hash', () => {
    // Block hash is computed from header, not stored. The structure validator
    // checks for missing header — an empty prevBlockHash triggers that path.
    const block = {
      ...makeValidBlock(),
      header: { ...makeValidBlock().header, prevBlockHash: '', height: 0 },
    };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  // ⛔ There is one committed body, so the only presence case left is the tree
  // itself. `pruneEntries` moved inside it, and its `?.` is what makes a block
  // carrying no `utxoTxTree` a verdict rather than a TypeError — the failure
  // direction `VALIDATION_INTERFACE`'s no-panic rule forbids.
  //
  // Post field domain pins are in `verifyTxStructure` (below): a post's fields
  // are pinned on the transaction that carries them, the same object that
  // hashes them.

  it('rejects a block with no utxoTxTree at all — a rejection, not a TypeError', () => {
    const block = { ...makeValidBlock(), utxoTxTree: undefined } as unknown as OrderingBlock;
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Ordering block missing utxoTxTree.pruneEntries');
  });

  it('rejects a block whose utxoTxTree has no pruneEntries array', () => {
    const block = makeValidBlock();
    (block.utxoTxTree as { pruneEntries?: unknown }).pruneEntries = undefined;
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Ordering block missing utxoTxTree.pruneEntries');
  });

  it('rejects block with utxoTxs misaligned with utxoTxIds', () => {
    const block = makeValidBlock();
    block.utxoTxTree.utxoTxIds = ['bb'.repeat(32)];
    block.utxoTxTree.utxoTxs = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]; // 1 id, 2 txs
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block missing utxoTxTree.utxoTxIds', () => {
    const block = {
      ...makeValidBlock(),
      utxoTxTree: {
        utxoTxs: [],
        likeBoxIds: [],
        pruneEntries: [],
      },
    } as unknown as OrderingBlock;
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The settlement transaction — position is the whole of the rule here
  //
  // Every block carries one and it is the LAST entry in `utxoTxIds`
  // (NODE_INTERFACE → It is the LAST entry in `utxoTxIds`). Identity being
  // positional is what lets this package say anything at all: recognising a
  // settlement by what it spends needs the karma pool's id, and that needs the
  // UTXO set. So the one refusable state is an empty body, and these cases pin
  // that it is refused for *that* reason and not by the alignment check or the
  // body bound standing in for it.
  // -------------------------------------------------------------------------

  /** The valid block with its body emptied, and `utxoTxs` emptied with it. */
  const emptyBodied = (): OrderingBlock => {
    const block = makeValidBlock();
    block.utxoTxTree.utxoTxIds = [];
    block.utxoTxTree.utxoTxs = [];
    return block;
  };

  it('rejects a body carrying no transactions — every block carries a settlement', () => {
    expect(verifyOrderingBlockStructure(emptyBodied())).toEqual({
      valid: false,
      error: 'Ordering block body carries no settlement transaction',
    });
  });

  it('one transaction is the difference between the two verdicts', () => {
    // The two fixtures differ in exactly one entry, so nothing else in the
    // function can be credited with either verdict — the shape the weight-bound
    // pair below uses, applied to a count.
    expect(verifyOrderingBlockStructure(emptyBodied()).valid).toBe(false);
    expect(verifyOrderingBlockStructure(makeValidBlock())).toEqual({ valid: true });
  });

  it('the alignment check is not what refuses an empty body', () => {
    // `utxoTxs` is emptied alongside `utxoTxIds`, so the two arrays agree at
    // length 0 and the alignment rule passes. A block that fails only because
    // its arrays disagree names the alignment instead, which is what separates
    // the two rules.
    const empty = emptyBodied();
    expect(empty.utxoTxTree.utxoTxs).toHaveLength(empty.utxoTxTree.utxoTxIds.length);
    expect(verifyOrderingBlockStructure(empty).error).toBe(
      'Ordering block body carries no settlement transaction',
    );

    const misaligned = makeValidBlock();
    misaligned.utxoTxTree.utxoTxs = [];
    expect(verifyOrderingBlockStructure(misaligned).error).toBe(
      'Ordering block utxoTxs must align with utxoTxIds',
    );
  });

  it('refuses the empty body before reading a prune entry or weighing anything', () => {
    // ⛔ The way to measure which rule fires is to give one block *two* defects
    // and check which one it names. This block has an empty body and a prune
    // entry whose `subtreeMerkleRoot` is a 32-char string; both are refusable,
    // and the prune loop runs first, so that is the name that comes back.
    const block = emptyBodied();
    block.utxoTxTree.pruneEntries = [
      { ...makeValidPruneEntry(), subtreeMerkleRoot: 'a'.repeat(32) } as unknown as PruneEntry,
    ];
    // Prune entries are typed ahead of the count, so that defect is named first
    // — which is what makes the ordering observable rather than assumed.
    expect(verifyOrderingBlockStructure(block).error).toContain('invalid subtreeMerkleRoot');

    // With the prune entry sound, the count is what is left.
    block.utxoTxTree.pruneEntries = [makeValidPruneEntry()];
    expect(verifyOrderingBlockStructure(block).error).toBe(
      'Ordering block body carries no settlement transaction',
    );
  });

  it('states nothing about what the settlement contains', () => {
    // The bytes are never decoded here, so a body whose one transaction is a
    // single junk byte is accepted — what the settlement holds is consensus and
    // belongs to node (NODE_INTERFACE → the settlement transaction). A check
    // that rejected this would be reading a box, which is the thing positional
    // identity exists to avoid.
    const block = makeValidBlock();
    block.utxoTxTree.utxoTxs = [new Uint8Array([0xff])];
    expect(verifyOrderingBlockStructure(block)).toEqual({ valid: true });
  });

  const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

  it('rejects a utxoTxs element that is not a byte view', () => {
    const block = makeValidBlock();
    block.utxoTxTree.utxoTxIds = ['bb'.repeat(32)];
    // The measured payload: a string where `Uint8Array` is declared. Array-ness
    // and length alignment both hold, which is why it passed.
    block.utxoTxTree.utxoTxs = ['not-bytes' as unknown as Uint8Array];
    expect(verifyOrderingBlockStructure(block)).toEqual({
      valid: false,
      error: 'Ordering block utxoTx must be a byte view',
    });
  });

  it('rejects every non-byte-view utxoTxs element, including the length-bearing ones', () => {
    // The prune-entry rule, one struct over: a `.length` read is not a type
    // check. An `Array` of byte values, a `{length}` object and a non-`Uint8Array`
    // typed view all satisfy one and none of them encode.
    for (const bad of ['not-bytes', [1, 2, 3], { length: 3 }, new Uint32Array(3), null, 42]) {
      const block = makeValidBlock();
      block.utxoTxTree.utxoTxIds = ['bb'.repeat(32)];
      block.utxoTxTree.utxoTxs = [bad as unknown as Uint8Array];
      expect(verifyOrderingBlockStructure(block)).toEqual({
        valid: false,
        error: 'Ordering block utxoTx must be a byte view',
      });
    }
  });

  it('utxoTxs: a non-byte-view element sentinels the length prefix readLp refuses', () => {
    const encodeLp = (v: unknown): string => {
      const w = new ByteWriter();
      writeLp(w, v as Uint8Array);
      return hexOf(w.toBytes());
    };
    // Every non-byte-view collides on the sentinel length prefix, payload absent.
    expect(new Set(['not-bytes', [1, 2, 3], { length: 3 }, null].map(encodeLp)).size).toBe(1);
    // An honest three-byte payload does not: `vlqU(3)` then the bytes.
    expect(encodeLp(new Uint8Array([1, 2, 3]))).toBe('03010203');
  });

  it('accepts an empty utxoTxs, and byte-view elements', () => {
    // Empty is the overwhelmingly common case and must not be caught by a pin
    // written for the elements.
    expect(verifyOrderingBlockStructure(makeValidBlock())).toEqual({ valid: true });

    const block = makeValidBlock();
    block.utxoTxTree.utxoTxIds = ['bb'.repeat(32), 'cc'.repeat(32)];
    // `Buffer` extends `Uint8Array`, and node's `encodeTx` output must pass.
    block.utxoTxTree.utxoTxs = [new Uint8Array(0), Buffer.from([1, 2, 3])];
    expect(verifyOrderingBlockStructure(block)).toEqual({ valid: true });
  });

  // -------------------------------------------------------------------------
  // pruneEntries
  //
  // These fields are the ones block application feeds to `Buffer.from(...)`
  // and `createHash().update(...)`, so a wrong *type* here is not a cosmetic
  // defect: it throws inside the apply funnel. Nothing else validates them.
  // -------------------------------------------------------------------------

  /** A prune entry that is well-formed in every field the structure check reads. */
  const makeValidPruneEntry = (): PruneEntry => ({
    rootPostHash: 'aa'.repeat(32),
    subtreePostIds: ['aa'.repeat(32), 'bb'.repeat(32)],
    subtreeMerkleRoot: new Uint8Array(32).fill(7),
    authorId: new Uint8Array(32).fill(3),
    authorSignature: new Uint8Array(64).fill(9),
  });

  /** The valid block, carrying one prune entry with `over` applied to it. */
  const blockWithPrune = (over: Record<string, unknown> = {}): OrderingBlock => {
    const block = makeValidBlock();
    block.utxoTxTree.pruneEntries = [
      { ...makeValidPruneEntry(), ...over } as unknown as PruneEntry,
    ];
    return block;
  };

  it('accepts a well-formed prune entry (control for every rejection below)', () => {
    expect(verifyOrderingBlockStructure(blockWithPrune())).toEqual({ valid: true });
  });


  it('rejects a block with no pruneEntries field at all', () => {
    const block = makeValidBlock();
    delete (block.utxoTxTree as unknown as Record<string, unknown>).pruneEntries;
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('pruneEntries');
  });

  it('rejects a non-array pruneEntries', () => {
    const block = makeValidBlock();
    (block.utxoTxTree as unknown as Record<string, unknown>).pruneEntries = 'nope';
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects a prune entry that is not an object', () => {
    const block = makeValidBlock();
    (block.utxoTxTree as unknown as Record<string, unknown>).pruneEntries = [42];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('pruneEntry is not an object');
  });

  // Each case below deviates from `makeValidPruneEntry()` in exactly one field,
  // and the control above proves the rest of the entry passes — so what each
  // one measures is that field and nothing else. The distinct-error assertion
  // at the end proves no two of them are being rejected for the same reason.
  const REJECTED_SHAPES: Array<{ name: string; over: Record<string, unknown>; error: string }> = [
    { name: 'rootPostHash too short', over: { rootPostHash: 'aa' }, error: 'invalid rootPostHash' },
    { name: 'rootPostHash not a string', over: { rootPostHash: 42 }, error: 'invalid rootPostHash' },
    { name: 'rootPostHash bytes, not hex', over: { rootPostHash: new Uint8Array(32) }, error: 'invalid rootPostHash' },
    { name: 'subtreePostIds not an array', over: { subtreePostIds: 'aa'.repeat(32) }, error: 'invalid subtreePostIds' },
    { name: 'subtreePostIds holds a non-string', over: { subtreePostIds: [42] }, error: 'subtreePostId must be 64 lowercase hex' },
    { name: 'subtreePostIds holds a short string', over: { subtreePostIds: ['aa'] }, error: 'subtreePostId must be 64 lowercase hex' },
    // The alphabet, not just the width: 64 characters that are not hex, which a
    // length-only check waves through while the message still says "hex".
    { name: 'subtreePostIds holds a 64-char non-hex string', over: { subtreePostIds: ['zz'.repeat(32)] }, error: 'subtreePostId must be 64 lowercase hex' },
    { name: 'subtreePostIds holds an uppercase-hex id', over: { subtreePostIds: ['AA'.repeat(32)] }, error: 'subtreePostId must be 64 lowercase hex' },
    { name: 'rootPostHash is 64 chars of non-hex', over: { rootPostHash: 'zz'.repeat(32) }, error: 'invalid rootPostHash' },
    { name: 'rootPostHash is uppercase hex', over: { rootPostHash: 'AA'.repeat(32) }, error: 'invalid rootPostHash' },
    // The kill shot: an integer where 32 bytes belong. `Buffer.from(42)`
    // throws, and block apply reaches it with nothing in between.
    { name: 'subtreeMerkleRoot is a number', over: { subtreeMerkleRoot: 42 }, error: 'invalid subtreeMerkleRoot' },
    // Length-bearing impostors — what a `.length`-only check would wave through.
    { name: 'subtreeMerkleRoot is a 32-char string', over: { subtreeMerkleRoot: 'a'.repeat(32) }, error: 'invalid subtreeMerkleRoot' },
    { name: 'subtreeMerkleRoot is {length: 32}', over: { subtreeMerkleRoot: { length: 32 } }, error: 'invalid subtreeMerkleRoot' },
    { name: 'subtreeMerkleRoot is a 32-element array', over: { subtreeMerkleRoot: new Array(32).fill(0) }, error: 'invalid subtreeMerkleRoot' },
    // Right type, wrong width — an 8-byte key or root is not a key or root.
    { name: 'subtreeMerkleRoot is 31 bytes', over: { subtreeMerkleRoot: new Uint8Array(31) }, error: 'invalid subtreeMerkleRoot' },
    { name: 'subtreeMerkleRoot is a Uint32Array', over: { subtreeMerkleRoot: new Uint32Array(8) }, error: 'invalid subtreeMerkleRoot' },
    { name: 'subtreeMerkleRoot missing', over: { subtreeMerkleRoot: undefined }, error: 'invalid subtreeMerkleRoot' },
    { name: 'authorId is a 32-char string', over: { authorId: 'a'.repeat(32) }, error: 'invalid authorId' },
    { name: 'authorId is {length: 32}', over: { authorId: { length: 32 } }, error: 'invalid authorId' },
    { name: 'authorId is 33 bytes', over: { authorId: new Uint8Array(33) }, error: 'invalid authorId' },
    { name: 'authorId missing', over: { authorId: undefined }, error: 'invalid authorId' },
    { name: 'authorSignature is a 64-char string', over: { authorSignature: 'a'.repeat(64) }, error: 'invalid authorSignature' },
    { name: 'authorSignature is {length: 64}', over: { authorSignature: { length: 64 } }, error: 'invalid authorSignature' },
    { name: 'authorSignature is 32 bytes', over: { authorSignature: new Uint8Array(32) }, error: 'invalid authorSignature' },
    { name: 'authorSignature missing', over: { authorSignature: undefined }, error: 'invalid authorSignature' },
  ];

  for (const shape of REJECTED_SHAPES) {
    it(`rejects a prune entry whose ${shape.name}`, () => {
      const result = verifyOrderingBlockStructure(blockWithPrune(shape.over));
      expect(result.valid).toBe(false);
      expect(result.error).toContain(shape.error);
    });
  }

  it('names the offending field distinctly for each prune-entry rejection', () => {
    // One error string per field, so an operator reading a rejection log can
    // tell which field the producer got wrong.
    const errors = new Set(REJECTED_SHAPES.map((s) => s.error));
    expect(errors.size).toBe(6);
    for (const shape of REJECTED_SHAPES) {
      expect(verifyOrderingBlockStructure(blockWithPrune(shape.over)).error).toContain(shape.error);
    }
  });

  it('never throws on a hostile prune entry', () => {
    for (const shape of REJECTED_SHAPES) {
      expect(() => verifyOrderingBlockStructure(blockWithPrune(shape.over))).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The hex-alphabet pin has teeth
//
// Every block below is mined and signed for real, and differs from a control
// block that this function accepts in exactly one field. So for each case the
// claim "the alphabet check is the only thing rejecting it" is measured, not
// asserted: each surviving check is exercised individually on the *poisoned*
// block and shown to pass, and the control proves the rest of the structure
// check passes on an otherwise identical object.
//
// The path this closes is the store, not the preimage. Prune entries carry
// hex-32 fields (`rootPostHash`, `subtreePostIds`) that reach `block_topology`
// and `rowToPost` → `computePostId`. A 64-character non-hex string passes a
// bare length check, reaches a hex-decode boundary, and either throws or
// silently produces wrong bytes — the hex-alphabet pin here is the gate.
// ---------------------------------------------------------------------------

describe('ordering-block hex domains — the pin has teeth', () => {
  type KeyPair = ReturnType<typeof generateKeyPair>;

  const privKeyOf = (kp: KeyPair) =>
    createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' });

  const signHeader = (header: BlockHeader, kp: KeyPair): Uint8Array =>
    new Uint8Array(sign(null, Buffer.from(mustHash(header), 'hex'), privKeyOf(kp)));

  /** Mine the header for real against its own `powTargetBits`. */
  const solve = (header: BlockHeader): BlockHeader => {
    for (let n = 0; n < 1_000_000; n++) {
      const candidate = { ...header, powNonce: n };
      if (verifyOrderingBlockPoW(candidate)) return candidate;
    }
    throw new Error('unsolvable fixture');
  };

  /**
   * A length check with no alphabet — what these fields are held to if the hex
   * pin is removed. Transcribed here so that "the alphabet is the only thing
   * rejecting this" is a measurement rather than a memory: every poison below is
   * asserted to satisfy it.
   */
  const preChangeRule = (v: unknown): boolean => typeof v === 'string' && v.length === 64;

  /**
   * A bare type check on the string header fields — the whole of what they are
   * held to if `HEADER_DOMAIN` is removed, leaving `verifyOrderingBlockPoW` and
   * `verifyValidatorSignature` with no other header gate. Transcribed here so
   * that "the poison mines and signs under the weaker rule" is a measurement
   * rather than a memory.
   */
  const preChangeEncoderRule = (v: unknown): boolean => typeof v === 'string';

  /** 64 characters, a string, and not hex. */
  const NON_HEX_64 = 'zz'.repeat(32);
  /** 64 characters of hex in the wrong case — decodes to the same 32 bytes. */
  const UPPER_HEX_64 = 'AB'.repeat(32);
  const GOOD = 'ab'.repeat(32);

  const kp = generateKeyPair();

  /**
   * A block whose one body carries `pruneEntries` / `utxoTxIds`, with a
   * genuinely mined and signed header.
   *
   * `utxoTxRoot` is a producer-chosen 64-hex string here, not recomputed:
   * `verifyOrderingBlockStructure` does not recompute it (that is apply-time, in
   * `@dagsocial/node`), and the header commits only to the root string it
   * declares. So nothing about a poisoned entry is visible to PoW or to the
   * signature.
   */
  const makeBlock = (
    body: Partial<OrderingBlock['utxoTxTree']> = {},
    headerOver: Partial<BlockHeader> = {},
    /**
     * Header fields substituted **after** mining and signing, for values that
     * cannot be mined at all: `HEADER_DOMAIN` gates `verifyOrderingBlockPoW`
     * and `blockHash`, so a header holding a non-`Uint8Array` `validatorId` or a
     * non-string `stateRoot` has no PoW solution to find. That is not a gap in
     * the fixture — it is the finding, and the tests using this argument assert
     * it explicitly rather than pretending the poison rode through PoW.
     */
    postSolve: Partial<BlockHeader> = {},
  ): OrderingBlock => {
    // The settlement is the default body, not an empty one: a fixture with no
    // transactions is refused by the count rule and would measure that instead
    // of the poison it names (VALIDATION_INTERFACE → `utxoTxIds.length >= 1`).
    const { utxoTxIds = [SETTLEMENT_ID], ...tree } = body;
    const solved = solve({
      protocolVersion: 1,
      height: 42,
      prevBlockHash: '11'.repeat(32),
      utxoTxRoot: '33'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: kp.publicKey,
      powNonce: 0,
      powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
      createdAt: 1_700_000_000_000,
      ...headerOver,
    });
    // Signed over the mined header, then substituted — so the signature is real
    // and covers the pre-substitution header, exactly as an attacker splicing a
    // field into a signed block would leave it.
    const validatorSignature = signHeader(solved, kp);
    return {
      header: { ...solved, ...postSolve },
      utxoTxTree: {
        utxoTxIds,
        utxoTxs: utxoTxIds.map(() => new Uint8Array(1)),
        pruneEntries: tree.pruneEntries ?? [],
      },
      validatorSignature,
    };
  };

  const prune = (over: Partial<PruneEntry> = {}): PruneEntry => ({
    rootPostHash: GOOD,
    subtreePostIds: [GOOD],
    subtreeMerkleRoot: new Uint8Array(32).fill(7),
    authorId: new Uint8Array(32).fill(3),
    authorSignature: new Uint8Array(64).fill(9),
    ...over,
  });

  /**
   * The Stage-1 ordering-block pipeline as `net`'s `orderingBlock` topic
   * validator runs it, minus the structure step — so a `true` here means the
   * *only* remaining question is the structure check itself.
   */
  const everythingElsePasses = (block: OrderingBlock): boolean =>
    verifyProtocolVersion(block.header.protocolVersion) &&
    Number.isSafeInteger(block.header.height) &&
    verifyOrderingBlockPoW(block.header) &&
    verifyValidatorSignature(block.header, block.validatorSignature);

  const CASES: Array<{ name: string; poison: string; block: () => OrderingBlock; error: string }> = [
    {
      name: 'pruneEntry.rootPostHash',
      poison: NON_HEX_64,
      block: () => makeBlock({ pruneEntries: [prune({ rootPostHash: NON_HEX_64 })] }),
      error: 'invalid rootPostHash',
    },
    {
      name: 'pruneEntry.subtreePostIds',
      poison: NON_HEX_64,
      block: () => makeBlock({ pruneEntries: [prune({ subtreePostIds: [NON_HEX_64] })] }),
      error: 'subtreePostId must be 64 lowercase hex',
    },
    {
      name: 'utxoTxIds — the element check that did not exist',
      poison: NON_HEX_64,
      block: () => makeBlock({ utxoTxIds: [NON_HEX_64] }),
      error: 'utxoTxId must be 64 lowercase hex',
    },
    // Uppercase hex is the injectivity half: it decodes to the *same* 32 bytes
    // as its lowercase spelling, so accepting both gives one id two in-memory
    // representations — the malleability the fixed-width encoding exists to
    // close, arriving from the codec side.
    {
      name: 'pruneEntry.subtreePostIds in uppercase hex',
      poison: UPPER_HEX_64,
      block: () => makeBlock({ pruneEntries: [prune({ subtreePostIds: [UPPER_HEX_64] })] }),
      error: 'subtreePostId must be 64 lowercase hex',
    },
  ];

  /**
   * The header half of the demonstration — the same poisons, in header fields.
   *
   * These cannot be mined into a fixture: with `HEADER_DOMAIN` in front of the
   * encoders a poisoned header has no PoW solution and `solve()` throws
   * `unsolvable fixture`. The poison is therefore spliced in **after** mining
   * and signing, exactly as an attacker splicing a field into an already-signed
   * block would leave it.
   *
   * That is what these cases measure and `CASES` cannot: the domain pin reaches
   * `verifyOrderingBlockPoW` and `verifyValidatorSignature`, not only the
   * structure check.
   */
  const HEADER_CASES: Array<{ name: string; poison: string; over: Partial<BlockHeader>; error: string }> = [
    { name: 'header.prevBlockHash', poison: NON_HEX_64, over: { prevBlockHash: NON_HEX_64 }, error: 'invalid prevBlockHash' },
    { name: 'header.utxoTxRoot', poison: NON_HEX_64, over: { utxoTxRoot: NON_HEX_64 }, error: 'missing utxoTxRoot' },
    { name: 'header.prevBlockHash in uppercase hex', poison: UPPER_HEX_64, over: { prevBlockHash: UPPER_HEX_64 }, error: 'invalid prevBlockHash' },
  ];

  it('has a control block that this function accepts', () => {
    const control = makeBlock({
      pruneEntries: [prune()],
      utxoTxIds: [GOOD],
    });
    expect(verifyOrderingBlockStructure(control)).toEqual({ valid: true });
    expect(everythingElsePasses(control)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The settlement count, on a block that is real in every other respect
  //
  // Mined and signed like the poison fixtures above, and differing from the
  // control in exactly one thing: it carries no transactions. So the claim "the
  // count rule is what rejects it" is measured the same way the alphabet claims
  // are — every other Stage-1 check is exercised on this exact object and
  // passes.
  // -------------------------------------------------------------------------

  describe('a body with no settlement', () => {
    const empty = (): OrderingBlock => makeBlock({ pruneEntries: [prune()], utxoTxIds: [] });

    it('still clears version, height, PoW and the validator signature', () => {
      const block = empty();
      expect(verifyProtocolVersion(block.header.protocolVersion)).toBe(true);
      expect(Number.isSafeInteger(block.header.height)).toBe(true);
      expect(verifyOrderingBlockPoW(block.header)).toBe(true);
      expect(verifyValidatorSignature(block.header, block.validatorSignature)).toBe(true);
      expect(everythingElsePasses(block)).toBe(true);
    });

    it('and the count rule is what rejects it', () => {
      expect(verifyOrderingBlockStructure(empty())).toEqual({
        valid: false,
        error: 'Ordering block body carries no settlement transaction',
      });
    });

    it('one transaction, and the same block is accepted', () => {
      // The control differs from the fixture above in the body alone, so the
      // prune entry, the header and the signature are all held fixed across the
      // two verdicts.
      const control = makeBlock({ pruneEntries: [prune()], utxoTxIds: [GOOD] });
      expect(verifyOrderingBlockStructure(control)).toEqual({ valid: true });
    });
  });

  for (const c of CASES) {
    describe(c.name, () => {
      it('was accepted by the rule this phase replaced', () => {
        expect(preChangeRule(c.poison)).toBe(true);
      });

      it('still clears version, height, PoW and the validator signature', () => {
        const block = c.block();
        // Individually, so a failure names which one moved.
        expect(verifyProtocolVersion(block.header.protocolVersion)).toBe(true);
        expect(Number.isSafeInteger(block.header.height)).toBe(true);
        expect(verifyOrderingBlockPoW(block.header)).toBe(true);
        expect(verifyValidatorSignature(block.header, block.validatorSignature)).toBe(true);
        expect(everythingElsePasses(block)).toBe(true);
      });

      it('and the alphabet pin is what rejects it', () => {
        const result = verifyOrderingBlockStructure(c.block());
        expect(result.valid).toBe(false);
        expect(result.error).toContain(c.error);
      });
    });
  }

  for (const c of HEADER_CASES) {
    describe(c.name, () => {
      it('was accepted by the rule this phase replaced', () => {
        expect(preChangeRule(c.poison)).toBe(true);
        // And by the bare type check, which is what would let it mine.
        expect(preChangeEncoderRule(c.poison)).toBe(true);
      });

      it('the same block without the poison clears everything — so the poison is the only variable', () => {
        const clean = makeBlock();
        expect(verifyOrderingBlockStructure(clean)).toEqual({ valid: true });
        expect(everythingElsePasses(clean)).toBe(true);
      });

      it('1e: the structure gate still names the field, with the message it always used', () => {
        const result = verifyOrderingBlockStructure(makeBlock({}, {}, c.over));
        expect(result.valid).toBe(false);
        expect(result.error).toContain(c.error);
      });

      it('1f: the encoders now refuse it too, so it can no longer ride through PoW or the signature', () => {
        const block = makeBlock({}, {}, c.over);
        // Individually, so a failure names which one moved.
        expect(blockHash(block.header)).toBeNull();
        expect(computePowHash(block.header)).toBeNull();
        expect(verifyOrderingBlockPoW(block.header)).toBe(false);
        expect(verifyValidatorSignature(block.header, block.validatorSignature)).toBe(false);
        expect(verifyHeaderFieldDomains(block.header).valid).toBe(false);
      });

    });
  }

  // -------------------------------------------------------------------------
  // stateRoot — 66 characters, not 64
  // -------------------------------------------------------------------------

  describe('header.stateRoot', () => {
    it('accepts the 33-byte digest the producer actually emits', () => {
      expect(verifyOrderingBlockStructure(makeBlock({}, { stateRoot: EMPTY_STATE_ROOT }))).toEqual({
        valid: true,
      });
      expect(verifyOrderingBlockStructure(makeBlock({}, { stateRoot: 'ab'.repeat(33) }))).toEqual({
        valid: true,
      });
    });

    // Every value here is a *string*, so a bare type check admits it and the
    // header would mine and sign with the poison inside its own PoW preimage.
    // `HEADER_DOMAIN` is what closes that: `verifyOrderingBlockPoW` and
    // `verifyValidatorSignature` establish the full header domain, so none of
    // these mines and the fixture has to splice the poison in after signing.
    // The `preChangeEncoderRule` assertion is what keeps the counterfactual a
    // measurement; the label assertion is what pins the structure check's own
    // diagnosis, which delegating the domain must not move.
    const BAD_STATE_ROOTS: Array<[string, string]> = [
      ['64 hex characters — a 32-byte digest where 33 belong', '00'.repeat(32)],
      ['66 characters of non-hex', 'zz'.repeat(33)],
      ['66 characters of uppercase hex', 'AB'.repeat(33)],
      ['68 characters — a 34-byte digest', '00'.repeat(34)],
      ['the empty string', ''],
    ];

    for (const [name, bad] of BAD_STATE_ROOTS) {
      it(`rejects ${name}`, () => {
        expect(preChangeEncoderRule(bad)).toBe(true);
        const block = makeBlock({}, {}, { stateRoot: bad });
        expect(verifyOrderingBlockPoW(block.header)).toBe(false);
        expect(verifyValidatorSignature(block.header, block.validatorSignature)).toBe(false);
        expect(blockHash(block.header)).toBeNull();
        const result = verifyOrderingBlockStructure(block);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('invalid stateRoot');
      });
    }

    it('a non-string stateRoot was already unminable — the pin states the verdict, it does not change it', () => {
      // A non-string fails even a bare type check, so this header has no PoW
      // solution and `verifyOrderingBlockPoW` rejects it whether or not the
      // domain pin is in place. Pinned as a separate claim precisely because of
      // that: folding it in with the five above would credit the alphabet and
      // width rules with a rejection they are not responsible for.
      const block = makeBlock({}, {}, { stateRoot: 42 as unknown as string });
      expect(verifyOrderingBlockPoW(block.header)).toBe(false);
      const result = verifyOrderingBlockStructure(block);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid stateRoot');
    });
  });

  // -------------------------------------------------------------------------
  // The byte fields: `isBytes`, not `.length`
  // -------------------------------------------------------------------------

  describe('length-bearing impostors in the byte fields', () => {
    const IMPOSTORS = (n: number): unknown[] => [
      'a'.repeat(n),
      { length: n },
      new Array(n).fill(0),
      new Uint32Array(n / 4),
    ];

    const label = (v: unknown): string =>
      v instanceof Uint32Array ? 'a Uint32Array'
        : Array.isArray(v) ? 'an Array'
        : typeof v === 'string' ? 'a same-length string'
        : 'a {length: n} object';

    for (const bad of IMPOSTORS(32)) {
      it(`rejects a validatorId that is ${label(bad)}`, () => {
        // Substituted after mining: even a bare type check demands a byte view
        // for `validatorId`, so this header has no PoW solution either way.
        // Unlike the hex cases, the pin adds no rejection here — it moves the
        // verdict from "PoW failed" to "the structure gate names the field",
        // which is where the contract says structure validation answers.
        const block = makeBlock({}, {}, { validatorId: bad as Uint8Array });
        expect(verifyOrderingBlockPoW(block.header)).toBe(false);
        const result = verifyOrderingBlockStructure(block);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('invalid validatorId');
      });

    }

    for (const bad of IMPOSTORS(64)) {
      it(`rejects a validatorSignature that is ${label(bad)}`, () => {
        const block = { ...makeBlock(), validatorSignature: bad as Uint8Array };
        const result = verifyOrderingBlockStructure(block);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('invalid validatorSignature');
      });
    }
  });

  // -------------------------------------------------------------------------
  // MAX_PARENT_REFS — the constant, not a literal
  // -------------------------------------------------------------------------

  describe('the parentRefs bound comes from MAX_PARENT_REFS', () => {
    // ⛔ A post's refs ride inside the transaction that creates it, so
    // `verifyTxStructure` is where the bound is enforced — the same
    // `verifyParentRefsCount`, reading the same constant.

    /** N distinct well-formed refs, so the count rule is the only thing under test. */
    const refs = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));

    const postTx = (parentRefs: string[]): UtxoTransaction => ({
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: 1n, owner: new Uint8Array(32) } as never],
      signatures: {},
      protocolVersion: 1,
      post: {
        content: 'hello',
        author: new Uint8Array(32).fill(7),
        parentRefs,
        protocolVersion: 1,
        type: 'regular' as const,
      },
    });

    it('accepts exactly MAX_PARENT_REFS refs', () => {
      expect(verifyTxStructure(postTx(refs(MAX_PARENT_REFS)))).toEqual({ valid: true });
    });

    it('rejects one more than MAX_PARENT_REFS', () => {
      const result = verifyTxStructure(postTx(refs(MAX_PARENT_REFS + 1)));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Too many parent refs');
    });

    // The point of the two above: they are written against the constant, so if
    // `MAX_PARENT_REFS` moves the boundary moves with it and no edit is needed
    // here. A literal in the source would leave this path pinned to the
    // constant's old reading while the post path tracked the new one, and this
    // test would not notice.
    it('tracks the constant rather than a literal', () => {
      const atBound = refs(MAX_PARENT_REFS);
      expect(atBound).toHaveLength(MAX_PARENT_REFS);
      expect(verifyTxStructure(postTx(atBound)).valid).toBe(true);
      expect(verifyTxStructure(postTx(refs(MAX_PARENT_REFS + 1))).valid).toBe(false);
    });

    it('a transaction with NO post skips the whole clause', () => {
      // The biconditional's other half: the post checks must not fire on an
      // ordinary transaction, or every like and invite would pay for them.
      const { post: _post, ...noPost } = postTx([]);
      expect(verifyTxStructure(noPost as UtxoTransaction)).toEqual({ valid: true });
    });
  });

  // -------------------------------------------------------------------------
  // Totality is preserved — the pin adds rejections, never a throw
  // -------------------------------------------------------------------------

  describe('totality (M-5) across every newly pinned field', () => {
    // One mined header for the whole sweep — the poison is per-field, and PoW
    // is irrelevant to a structure verdict.
    const template = makeBlock();

    const put = (over: Partial<OrderingBlock>, headerOver: Partial<BlockHeader> = {}): OrderingBlock => ({
      ...template,
      header: { ...template.header, ...headerOver },
      // The settlement rides every fixture in the sweep: with an empty body the
      // count rule refuses each one outright and `conforms` would be false for
      // reasons that have nothing to do with the field being poisoned.
      utxoTxTree: { utxoTxIds: [SETTLEMENT_ID], utxoTxs: [SETTLEMENT_BYTES], pruneEntries: [] },
      ...over,
    });

    const isHex = (v: unknown, chars: number): boolean =>
      typeof v === 'string' && new RegExp(`^[0-9a-f]{${chars}}$`).test(v);
    const isBytesOf = (v: unknown, n: number): boolean => v instanceof Uint8Array && v.length === n;

    it('returns {valid:false} and never throws on the malformed corpus', () => {
      for (const bad of MALFORMED) {
        // `conforms` is not a hedge — it names the one honest exception. The
        // corpus holds `Buffer.alloc(64)`, which IS a well-formed
        // `validatorSignature` shape: structure validation checks the field's
        // domain, not whether the signature verifies. Asserting `false` there
        // would be asserting a bug.
        const shapes: Array<{ block: OrderingBlock; conforms: boolean }> = [
          { block: put({}, { stateRoot: bad as string }), conforms: isHex(bad, 66) },
          { block: put({}, { prevBlockHash: bad as string }), conforms: isHex(bad, 64) },
          { block: put({}, { utxoTxRoot: bad as string }), conforms: isHex(bad, 64) },
          { block: put({}, { validatorId: bad as Uint8Array }), conforms: isBytesOf(bad, 32) },
          { block: put({ validatorSignature: bad as Uint8Array }), conforms: isBytesOf(bad, 64) },
          {
            block: put({
              utxoTxTree: { utxoTxIds: [bad as string], utxoTxs: [new Uint8Array(1)], pruneEntries: [] },
            }),
            conforms: isHex(bad, 64),
          },
          {
            block: put({
              utxoTxTree: {
                utxoTxIds: [SETTLEMENT_ID],
                utxoTxs: [SETTLEMENT_BYTES],
                pruneEntries: [
                  { ...prune(), rootPostHash: bad, subtreePostIds: [bad] } as unknown as PruneEntry,
                ],
              },
            }),
            conforms: isHex(bad, 64),
          },
          // The body's own count, swept for the same property. `conforms` is
          // flat `false` and that is a measurement, not a shortcut: the corpus
          // holds five arrays — `[]`, `[null]`, `[undefined]`, `[Symbol]`,
          // `[123]` — and the empty one is refused by the count while the other
          // four are refused by the element pin, so no entry can conform.
          {
            block: put({
              utxoTxTree: {
                utxoTxIds: bad as unknown as string[],
                utxoTxs: bad as unknown as Uint8Array[],
                pruneEntries: [],
              },
            }),
            conforms: false,
          },
        ];

        for (const { block, conforms } of shapes) {
          expect(() => verifyOrderingBlockStructure(block)).not.toThrow();
          expect(verifyOrderingBlockStructure(block).valid).toBe(conforms);
        }
      }
    });

    it('the corpus does contain a value that conforms, so the sweep is not vacuous', () => {
      // Guards the assertion above from degenerating into "everything is
      // false": if no corpus value ever conforms, `conforms` is dead weight
      // and a future regression that accepted everything would still pass.
      expect(MALFORMED.some((bad) => isBytesOf(bad, 64))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// verifyBlockChainLink
// ---------------------------------------------------------------------------

describe('verifyBlockChainLink', () => {
  const makeBlock = (height: number, prevHash: string): OrderingBlock => ({
    header: {
      protocolVersion: 1,
      height,
      prevBlockHash: prevHash,
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32).fill(1),
      powNonce: 0,
      powTargetBits: 3072,
      createdAt: Date.now(),
    },
    utxoTxTree: {
      utxoTxIds: [SETTLEMENT_ID],
      utxoTxs: [SETTLEMENT_BYTES],
      pruneEntries: [],
    },
    validatorSignature: new Uint8Array(64),
  });

  // Both fixtures are inside the header domain, deliberately. A short stand-in
  // like `'0000'` is a `prevBlockHash` no producer could emit — a real one is
  // `blockHash`'s 64 lowercase hex, always — and `verifyBlockChainLink` rejects
  // the *previous* block outright for it, which would leave all three tests
  // below green-but-vacuous: "rejects mismatched prevBlockHash" would pass on a
  // malformed-`prev` rejection that never reached the comparison. So
  // `GENESIS_PREV` is well-formed and the mismatch case uses a well-formed
  // *wrong* hash.
  const GENESIS_PREV = '00'.repeat(32);
  const WRONG_HASH = 'ff'.repeat(32);

  it('accepts a valid chain link', () => {
    const prev = makeBlock(1, GENESIS_PREV);
    const prevHash = mustHash(prev.header);
    const next = makeBlock(2, prevHash);
    expect(verifyBlockChainLink(next, prev)).toBe(true);
  });

  it('rejects mismatched prevBlockHash', () => {
    const prev = makeBlock(1, GENESIS_PREV);
    const next = makeBlock(2, WRONG_HASH);
    // The rejection must be the comparison, not a domain rejection of `prev`:
    // both headers are inside the domain, and the hashes genuinely differ.
    expect(verifyHeaderFieldDomains(prev.header)).toEqual({ valid: true });
    expect(verifyHeaderFieldDomains(next.header)).toEqual({ valid: true });
    expect(mustHash(prev.header)).not.toBe(WRONG_HASH);
    expect(verifyBlockChainLink(next, prev)).toBe(false);
  });

  it('rejects non-sequential height', () => {
    const prev = makeBlock(1, GENESIS_PREV);
    const prevHash = mustHash(prev.header);
    const next = makeBlock(3, prevHash);
    // Same guard: the hash link is correct, so only the height can be rejecting.
    expect(next.header.prevBlockHash).toBe(mustHash(prev.header));
    expect(verifyBlockChainLink(next, prev)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidVouchTarget
// ---------------------------------------------------------------------------

describe('isValidVouchTarget', () => {
  it('accepts 32-byte Uint8Array', () => {
    expect(isValidVouchTarget(new Uint8Array(32).fill(0x42))).toBe(true);
  });

  it('rejects non-Uint8Array', () => {
    expect(isValidVouchTarget(Buffer.alloc(32) as any)).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(isValidVouchTarget(new Uint8Array(31))).toBe(false);
    expect(isValidVouchTarget(new Uint8Array(33))).toBe(false);
  });

  it('rejects all zeros', () => {
    expect(isValidVouchTarget(new Uint8Array(32))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M-4 — version-independent content character check
// ---------------------------------------------------------------------------

describe('verifyContentCharacters — version-independent table (M-4)', () => {
  /** Wrap a bare codepoint in ASCII so a failure is about that codepoint only. */
  const cp = (n: number) => `ok${String.fromCodePoint(n)}ok`;

  it('pins a documented Unicode version', () => {
    expect(PINNED_UNICODE_VERSION).toBe('16.0');
  });

  it('never consults runtime Unicode category data', () => {
    // This is the whole of M-4: a `\p{...}` escape anywhere on the path would
    // reintroduce the Node/V8-version dependence the table exists to remove.
    // Scanned at source level, not via `Function.prototype.toString`, so a
    // property escape hidden in a module-level regex const is caught too.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const propertyEscape = /\\[pP]\{/;

    for (const file of ['../src/verify.ts', '../src/content-charset.ts']) {
      const code = stripComments(readFileSync(new URL(file, import.meta.url), 'utf8'));
      expect(propertyEscape.test(code), `${file} uses a Unicode property escape`).toBe(false);
    }
  });

  describe('known-dangerous codepoints stay rejected', () => {
    const dangerous: [string, number][] = [
      ['NUL U+0000', 0x0000],
      ['TAB U+0009', 0x0009],
      ['CR U+000D', 0x000d],
      ['DEL U+007F', 0x007f],
      ['SOFT HYPHEN U+00AD', 0x00ad],
      ['ZWSP U+200B', 0x200b],
      ['ZWJ U+200D', 0x200d],
      ['RLO U+202E', 0x202e],
      ['LRI U+2066', 0x2066],
      ['BOM U+FEFF', 0xfeff],
      ['lone surrogate U+D800', 0xd800],
      ['private use U+E000', 0xe000],
      ['LANGUAGE TAG U+E0001', 0xe0001],
      ['tag char U+E0041', 0xe0041],
      ['plane-15 private use U+F0000', 0xf0000],
      ['plane-16 private use U+100000', 0x100000],
    ];
    for (const [name, code] of dangerous) {
      it(`rejects ${name}`, () => {
        expect(verifyContentCharacters(cp(code)).valid).toBe(false);
      });
    }
  });

  describe('known-safe content stays allowed', () => {
    it('accepts ASCII letters', () => {
      expect(verifyContentCharacters('hello world').valid).toBe(true);
    });

    it('accepts a line feed', () => {
      expect(verifyContentCharacters('line1\u{000A}line2').valid).toBe(true);
    });

    it('accepts multi-byte letters', () => {
      expect(verifyContentCharacters('café 你好 Ωμέγα').valid).toBe(true);
    });

    it('accepts a plain emoji', () => {
      expect(verifyContentCharacters('wave \u{1F44B}').valid).toBe(true);
    });

    it('rejects a ZWJ emoji sequence — U+200D is a format char, as before', () => {
      expect(verifyContentCharacters('\u{1F468}\u{200D}\u{1F469}').valid).toBe(false);
    });
  });

  describe('frontier codepoints — the version-independence property', () => {
    // These are the codepoints whose category differs between Unicode data
    // versions. Under the old `\P{C}` check each flipped verdict as the
    // runtime's Unicode version moved, because `\P{C}` rejects `Cn`
    // (unassigned). The table allows `Cn`, so the verdict is now the same on
    // every build. Asserting the table against runtime `\p{}` instead would be
    // exactly the version-fragile test this replaces.

    it('allows U+11BC0 — assigned in Unicode 16.0, unassigned before it', () => {
      expect(verifyContentCharacters(cp(0x11bc0)).valid).toBe(true);
    });

    it('allows U+10940 — still unassigned at the pinned Unicode 16.0', () => {
      expect(verifyContentCharacters(cp(0x10940)).valid).toBe(true);
    });

    it('allows U+2065 — unassigned, inside the Cf run U+2060–U+206F', () => {
      expect(verifyContentCharacters(cp(0x2065)).valid).toBe(true);
    });

    it('allows the U+FFFE noncharacter — Cn, not Cc/Cf/Cs/Co', () => {
      expect(verifyContentCharacters(cp(0xfffe)).valid).toBe(true);
    });
  });

  describe('table boundaries', () => {
    it('allows U+000A but rejects both its neighbours', () => {
      expect(verifyContentCharacters('a\u{000A}b').valid).toBe(true);
      expect(verifyContentCharacters('a\u{0009}b').valid).toBe(false);
      expect(verifyContentCharacters('a\u{000B}b').valid).toBe(false);
    });

    it('allows the codepoint immediately outside each rejected run', () => {
      expect(verifyContentCharacters(cp(0x00a0)).valid).toBe(true); // past U+007F–U+009F
      expect(verifyContentCharacters(cp(0x00ae)).valid).toBe(true); // past U+00AD
      expect(verifyContentCharacters(cp(0x200a)).valid).toBe(true); // before U+200B
      expect(verifyContentCharacters(cp(0x2010)).valid).toBe(true); // past U+200F
      expect(verifyContentCharacters(cp(0xf900)).valid).toBe(true); // past U+D800–U+F8FF
    });

    it('classifies range edges exactly', () => {
      expect(isDisallowedContentCodepoint(0x0009)).toBe(true);
      expect(isDisallowedContentCodepoint(0x000a)).toBe(false);
      expect(isDisallowedContentCodepoint(0x000b)).toBe(true);
      expect(isDisallowedContentCodepoint(0xd7ff)).toBe(false);
      expect(isDisallowedContentCodepoint(0xd800)).toBe(true);
      expect(isDisallowedContentCodepoint(0xf8ff)).toBe(true);
      expect(isDisallowedContentCodepoint(0xf900)).toBe(false);
      expect(isDisallowedContentCodepoint(0x10fffd)).toBe(true);
      expect(isDisallowedContentCodepoint(0x10fffe)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// M-6 — integer guards on nonces and targetBits
// ---------------------------------------------------------------------------

describe('integer guards on the header nonce and targetBits (M-6)', () => {
  // ⛔ The ordering-block header's `powNonce` is a `vlqU` field, written by
  // a total-by-sentinel writer and a search variable an attacker varies against
  // a target. The `isU64Safe` guard lives in `HEADER_DOMAIN`
  // (`verifyHeaderFieldDomains`).
  //
  // What closes it is the pin here PLUS `verifyOrderingBlockPoW` encoding the
  // nonce as a fixed 8-byte LE, which has no sentinel at all. `computePowHash`
  // runs the whole header domain first, so the two cannot be reached out of order.

  const kp = generateKeyPair();
  const baseHeader = (over: Partial<BlockHeader> = {}): BlockHeader => ({
    protocolVersion: 1,
    height: 1,
    prevBlockHash: '11'.repeat(32),
    utxoTxRoot: '33'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: kp.publicKey,
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_700_000_000_000,
    ...over,
  });

  const badNumbers: [string, number][] = [
    ['NaN', NaN],
    ['negative', -1],
    ['float', 1.5],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
    ['past u64', 2 ** 64],
  ];

  it('has an in-domain baseline to degrade from', () => {
    expect(verifyHeaderFieldDomains(baseHeader())).toEqual({ valid: true });
  });

  for (const [name, bad] of badNumbers) {
    it(`rejects a ${name} powNonce, without throwing`, () => {
      expect(() => verifyOrderingBlockPoW(baseHeader({ powNonce: bad }))).not.toThrow();
      expect(verifyOrderingBlockPoW(baseHeader({ powNonce: bad }))).toBe(false);
      expect(verifyHeaderFieldDomains(baseHeader({ powNonce: bad })).valid).toBe(false);
    });

    it(`rejects a ${name} powTargetBits, without throwing`, () => {
      expect(() => verifyOrderingBlockPoW(baseHeader({ powTargetBits: bad }))).not.toThrow();
      expect(verifyOrderingBlockPoW(baseHeader({ powTargetBits: bad }))).toBe(false);
      expect(verifyHeaderFieldDomains(baseHeader({ powTargetBits: bad })).valid).toBe(false);
    });
  }

  it('the sentinel is unreachable: two out-of-domain nonces do not share a verdict', () => {
    // ⛔ Assert the MECHANISM. Under `vlqU` alone, NaN and -1 both encode to the
    // all-ones sentinel — so without the domain pin a header holding either
    // would produce the same `blockHash`, and a solution for one would be a
    // solution for the other. `blockHash` returns null for both instead, which
    // is what makes the collision unreachable rather than merely unlikely.
    expect(blockHash(baseHeader({ powNonce: NaN }))).toBeNull();
    expect(blockHash(baseHeader({ powNonce: -1 }))).toBeNull();
    expect(blockHash(baseHeader())).not.toBeNull();
  });

  it('rejects a powTargetBits past the scaled domain', () => {
    // 65536 is 256 whole bits in units of 1/256 — the widest the digest can
    // express. Past it there is no target to expand, so refusing out of domain
    // IS the bound.
    expect(verifyHeaderFieldDomains(baseHeader({ powTargetBits: 65536 })).valid).toBe(true);
    expect(verifyHeaderFieldDomains(baseHeader({ powTargetBits: 65537 })).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M-5 — no exported verify function throws on malformed input
// ---------------------------------------------------------------------------

/** Values that arrive off the wire wrongly typed, out of range, or hostile. */
const circular: Record<string, unknown> = { name: 'circular' };
circular.self = circular;

const MALFORMED: unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  2 ** 64,
  -(2 ** 64),
  '',
  'x',
  'not-an-array',
  '0'.repeat(100),
  {},
  [],
  [null],
  [undefined],
  [Symbol('ref')],
  [123],
  Symbol('sym'),
  123n,
  new Uint8Array(0),
  new Uint8Array(31),
  new Uint8Array(33),
  new Uint32Array(8),
  Buffer.alloc(0),
  Buffer.alloc(64),
  () => 1,
  new Map(),
  new Set(),
  circular,
];

describe('no-panic on malformed input (M-5)', () => {
  const kp = generateKeyPair();

  const makeGoodPost = (): Post => ({
    content: 'hello',
    author: kp.publicKey,
    parentRefs: [],
    protocolVersion: 1,
    type: 'regular' as const,
  });

  const makeHeader = (over: Partial<BlockHeader> = {}): BlockHeader => ({
    protocolVersion: 1,
    height: 1,
    prevBlockHash: '0'.repeat(64),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(1),
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_700_000_000_000,
    ...over,
  });

  const goodPost = makeGoodPost();
  const goodInput = Buffer.from('pow input');
  const goodBlock: OrderingBlock = {
    header: makeHeader(),
    utxoTxTree: { utxoTxIds: [SETTLEMENT_ID], utxoTxs: [SETTLEMENT_BYTES], pruneEntries: [] },
    validatorSignature: new Uint8Array(64),
  };

  // --- the fuzz sweep: every argument position of every exported verify fn ---

  it('verifyValidatorSignature survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyValidatorSignature(bad as any, new Uint8Array(64))).not.toThrow();
      expect(() => verifyValidatorSignature(makeHeader(), bad as any)).not.toThrow();
      expect(() => verifyValidatorSignature(makeHeader({ validatorId: bad as any }), bad as any)).not.toThrow();
      expect(() => verifyValidatorSignature(makeHeader({ prevBlockHash: bad as any }), bad as any)).not.toThrow();
      expect(() => verifyValidatorSignature(makeHeader({ createdAt: bad as any }), bad as any)).not.toThrow();
    }
  });

  it('verifyContentLimits survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyContentLimits(bad as any)).not.toThrow();
    }
  });

  it('verifyContentCharacters survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyContentCharacters(bad as any)).not.toThrow();
    }
  });

  it('verifyParentRefsCount survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyParentRefsCount(bad as any)).not.toThrow();
    }
  });

  it('verifyProtocolVersion survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyProtocolVersion(bad as any)).not.toThrow();
    }
  });

  it('verifyTxStructure survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyTxStructure(bad as any)).not.toThrow();
      expect(() => verifyTxStructure({ inputs: bad, outputs: bad, protocolVersion: 1 } as any)).not.toThrow();
      // ⛔ The post payload, field by field. `post: null` is the sharpest
      // case: a property read before `isObject` would throw, which is why
      // `verifyPostFieldDomains` runs first inside the clause.
      // The output is a whole karma box so the sweep reaches the post clause on
      // its own terms: with an unencodable output every iteration would end at
      // the weight bound's `encodeTx` catch instead.
      const withPost = (post: unknown) =>
        ({ inputs: ['aa'.repeat(32)], outputs: [{ boxType: 'karma', value: 1n, owner: new Uint8Array(32) }], signatures: {}, protocolVersion: 1, post });
      expect(() => verifyTxStructure(withPost(bad) as any)).not.toThrow();
      expect(() => verifyTxStructure(withPost(null) as any)).not.toThrow();
      expect(() => verifyTxStructure(withPost({ ...goodPost, content: bad }) as any)).not.toThrow();
      expect(() => verifyTxStructure(withPost({ ...goodPost, author: bad }) as any)).not.toThrow();
      expect(() => verifyTxStructure(withPost({ ...goodPost, parentRefs: bad }) as any)).not.toThrow();
      expect(() => verifyTxStructure(withPost({ ...goodPost, protocolVersion: bad }) as any)).not.toThrow();
      expect(() => verifyTxStructure(withPost({ ...goodPost, type: bad }) as any)).not.toThrow();
    }
  });

  it('verifyOrderingBlockStructure survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyOrderingBlockStructure(bad as any)).not.toThrow();
      expect(() => verifyOrderingBlockStructure({ ...goodBlock, header: bad } as any)).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          utxoTxTree: { ...goodBlock.utxoTxTree, pruneEntries: bad },
        } as any),
      ).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          utxoTxTree: {
            ...goodBlock.utxoTxTree,
            pruneEntries: [
              {
                rootPostHash: bad,
                subtreePostIds: bad,
                subtreeMerkleRoot: bad,
                authorId: bad,
                authorSignature: bad,
              },
            ],
          },
        } as any),
      ).not.toThrow();
      // The transaction list itself, which the count rule reads: `.length` off
      // a non-array is `undefined`, and the `Array.isArray` gate above it is
      // what keeps the comparison from being a silent `undefined === 0`.
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          utxoTxTree: { utxoTxIds: bad, utxoTxs: bad, pruneEntries: [] },
        } as any),
      ).not.toThrow();
      // The id is aligned deliberately: with an empty `utxoTxIds` the count and
      // length checks reject first and the element pin is never reached, so the
      // sweep would pass over the check it is meant to cover.
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          utxoTxTree: { utxoTxIds: ['bb'.repeat(32)], utxoTxs: [bad], pruneEntries: [] },
        } as any),
      ).not.toThrow();
    }
  });

  it('verifyOrderingBlockPoW survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyOrderingBlockPoW(bad as any)).not.toThrow();
      expect(() => verifyOrderingBlockPoW(makeHeader({ powNonce: bad as any }))).not.toThrow();
      expect(() => verifyOrderingBlockPoW(makeHeader({ powTargetBits: bad as any }))).not.toThrow();
      expect(() => verifyOrderingBlockPoW(makeHeader({ validatorId: bad as any }))).not.toThrow();
      expect(() => verifyOrderingBlockPoW(makeHeader({ prevBlockHash: bad as any }))).not.toThrow();
    }
  });

  it('verifyBlockChainLink survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyBlockChainLink(bad as any, goodBlock)).not.toThrow();
      expect(() => verifyBlockChainLink(goodBlock, bad as any)).not.toThrow();
      expect(() =>
        verifyBlockChainLink(goodBlock, { ...goodBlock, header: makeHeader({ validatorId: bad as any }) }),
      ).not.toThrow();
    }
  });

  it('isValidVouchTarget survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => isValidVouchTarget(bad as any)).not.toThrow();
    }
  });

  // --- the specific throw sites named in the audit ---

  it('rejects a public key that is not 32 bytes (createPublicKey)', () => {
    // The SPKI-envelope mechanics survive in the transaction/validator signature
    // path unchanged; `verifyValidatorSignature` is where they are now reachable.
    const h = makeHeader();
    expect(verifyValidatorSignature({ ...h, validatorId: new Uint8Array(31) }, new Uint8Array(64))).toBe(false);
    expect(verifyValidatorSignature({ ...h, validatorId: new Uint8Array(33) }, new Uint8Array(64))).toBe(false);
    expect(verifyValidatorSignature({ ...h, validatorId: new Uint8Array(0) }, new Uint8Array(64))).toBe(false);
    expect(verifyValidatorSignature({ ...h, validatorId: 'not-a-key' as any }, new Uint8Array(64))).toBe(false);
    // 32 bytes that are not a valid curve point must still reject cleanly.
    expect(verifyValidatorSignature({ ...h, validatorId: new Uint8Array(32).fill(0xff) }, new Uint8Array(64))).toBe(false);
  });

  it('rejects a post whose shape would throw inside postFieldBytes', () => {
    // The encoder a malformed post reaches is `postFieldBytes` via
    // `computeTxId`; `verifyTxStructure` is the gate in front of it.
    //
    // ⛔ The output is a WHOLE karma box, and that is what makes the test
    // measure anything: a bare `{ boxType: 'karma' }` is unencodable, so the
    // weight bound's `encodeTx` catch would reject every case below and each
    // assertion would hold with the post clause deleted. The control at the end
    // is the other half — it fails if the clause stops running.
    const tx = (post: unknown) =>
      ({
        inputs: ['aa'.repeat(32)],
        outputs: [{ boxType: 'karma', value: 1n, owner: new Uint8Array(32) }],
        signatures: {},
        protocolVersion: 1,
        post,
      });
    expect(verifyTxStructure(tx({ ...goodPost, parentRefs: 'nope' }) as any).valid).toBe(false);
    expect(verifyTxStructure(tx({ ...goodPost, parentRefs: [Symbol('x')] }) as any).valid).toBe(false);
    expect(verifyTxStructure(tx({ ...goodPost, author: undefined }) as any).valid).toBe(false);
    expect(verifyTxStructure(tx({ ...goodPost, author: 42 }) as any).valid).toBe(false);
    expect(verifyTxStructure(tx({ ...goodPost, content: 42 }) as any).valid).toBe(false);
    expect(verifyTxStructure(tx(null) as any).valid).toBe(false);
    expect(verifyTxStructure(tx(goodPost) as any)).toEqual({ valid: true });
  });

  it('rejects non-string content instead of throwing in Buffer.byteLength', () => {
    expect(verifyContentLimits(42 as any).valid).toBe(false);
    expect(verifyContentLimits(null as any).valid).toBe(false);
    expect(verifyContentLimits(undefined as any).valid).toBe(false);
    expect(verifyContentLimits({} as any).valid).toBe(false);
    expect(verifyContentCharacters(42 as any).valid).toBe(false);
    expect(verifyContentCharacters(null as any).valid).toBe(false);
  });

  it('rejects non-array parent refs instead of throwing on .length', () => {
    expect(verifyParentRefsCount('nope' as any).valid).toBe(false);
    expect(verifyParentRefsCount(null as any).valid).toBe(false);
    expect(verifyParentRefsCount({ length: 99 } as any).valid).toBe(false);
  });

  it('rejects a malformed ordering block header instead of throwing in the encoder', () => {
    expect(verifyOrderingBlockPoW(null as any)).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ prevBlockHash: Symbol('s') as any }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ validatorId: undefined as any }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powNonce: NaN }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powNonce: -1 }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powNonce: 1.5 }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powTargetBits: NaN }))).toBe(false);
    // Wider than the digest — `powTarget` answers `null` rather than a target
    // no digest can be compared against.
    expect(verifyOrderingBlockPoW(makeHeader({ powTargetBits: 1_000_000 }))).toBe(false);
    expect(verifyBlockChainLink(null as any, goodBlock)).toBe(false);
    expect(verifyBlockChainLink(goodBlock, null as any)).toBe(false);
  });

  // --- the happy path is unchanged ---

  it('leaves the happy path intact', () => {
    // ⛔ A whole karma box, not a bare `{ boxType }`: outputs reach
    // `canonicalBoxBytes` inside the weight bound's `encodeTx`, so a box missing
    // `value` or `owner` is `Transaction is not encodable` and would make this
    // "happy path" assert the opposite of its name.
    expect(verifyTxStructure({ inputs: ['aa'.repeat(32)], outputs: [{ boxType: 'karma', value: 5n, createdAtBlock: 0, owner: new Uint8Array(32) }], signatures: {}, protocolVersion: 1, post: goodPost })).toEqual({ valid: true });
    expect(verifyContentLimits('hello')).toEqual({ valid: true });
    expect(verifyContentCharacters('hello')).toEqual({ valid: true });
    expect(verifyParentRefsCount([])).toEqual({ valid: true });
    expect(verifyOrderingBlockStructure(goodBlock)).toEqual({ valid: true });

    let mined: BlockHeader | undefined;
    for (let n = 0; n < 100000; n++) {
      const candidate = makeHeader({ powNonce: n });
      if (verifyOrderingBlockPoW(candidate)) {
        mined = candidate;
        break;
      }
    }
    expect(mined).toBeDefined();
    expect(verifyOrderingBlockPoW(mined!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Numeric guard on protocolVersion and type membership (M-6 follow-up)
// ---------------------------------------------------------------------------

describe('integer guard on protocolVersion and type membership (M-6)', () => {
  // ⛔ `verifyPostFieldDomains` enforces the numeric domain on
  // `protocolVersion` and the membership domain on `type`, reached through
  // `verifyTxStructure`'s post clause, protecting the same encoder:
  // `postFieldBytes` is inside the `computeTxId` preimage.

  /** A well-formed post payload — every field in domain. */
  const goodPost = (over: Partial<Post> = {}): Post => ({
    content: 'guard me',
    author: new Uint8Array(32).fill(7),
    parentRefs: [],
    protocolVersion: 1,
    type: 'regular' as const,
    ...over,
  });

  const postTx = (post: Post): UtxoTransaction => ({
    inputs: ['aa'.repeat(32)],
    outputs: [{ boxType: 'karma', value: 1n, owner: new Uint8Array(32) } as never],
    signatures: {},
    protocolVersion: 1,
    post,
  });

  const OUT_OF_DOMAIN: Array<[string, number]> = [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['negative', -1],
    ['fractional', 1.5],
    ['past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
  ];

  it.each(OUT_OF_DOMAIN)('rejects a %s protocolVersion without throwing', (_label, value) => {
    let result: { valid: boolean } | undefined;
    expect(() => {
      result = verifyTxStructure(postTx(goodPost({ protocolVersion: value })));
    }).not.toThrow();
    expect(result!.valid).toBe(false);
  });

  it('rejects an off-table type', () => {
    const result = verifyPostFieldDomains(goodPost({ type: 'poll' as any }));
    expect(result).toEqual({ valid: false, error: 'Post type must be a member of POST_TYPE' });
  });

  it('rejects a non-string type without throwing', () => {
    for (const bad of [42, null, undefined, true, Symbol('x')]) {
      expect(() => verifyPostFieldDomains(goodPost({ type: bad as any }))).not.toThrow();
      expect(verifyPostFieldDomains(goodPost({ type: bad as any })).valid).toBe(false);
    }
  });

  it('accepts a well-formed post (guard does not regress the happy path)', () => {
    expect(verifyTxStructure(postTx(goodPost())).valid).toBe(true);
    expect(verifyTxStructure(postTx(goodPost({ type: 'regular' as const }))).valid).toBe(true);
    expect(verifyTxStructure(postTx(goodPost({ type: 'profile' as const }))).valid).toBe(true);
    expect(verifyTxStructure(postTx(goodPost({ protocolVersion: 0 }))).valid).toBe(true);
  });
});

describe('fixed-width field domains (spec §2.5 / §6.1)', () => {
  const kp = generateKeyPair();
  const priv = createPrivateKey({
    key: Buffer.from(kp.secretKey),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKeyObj = ed25519PublicKeyToKeyObject(kp.publicKey);

  /**
   * A post signed over its own stated fields.
   *
   * ⚠ **A post has no signature of its own** — the creating transaction is
   * signed over its `TxId` and the signer is the author. The helper keeps its
   * name because what it builds is unchanged in the way that matters here: a
   * post every field of which is in domain, which is the fixture the poison
   * cases below are cut from.
   */
  const signedPost = (over: Partial<Post> = {}): Post => ({
    content: 'pin the domain',
    author: kp.publicKey,
    parentRefs: [],
    protocolVersion: 1,
    type: 'regular' as const,
    ...over,
  });

  /** The post's carrier — the transaction whose `TxId` preimage contains it. */
  const postTx = (post: Post): UtxoTransaction => ({
    inputs: ['aa'.repeat(32)],
    outputs: [{ boxType: 'karma', value: 1n, owner: new Uint8Array(32) } as never],
    signatures: {},
    protocolVersion: 1,
    post,
  });

  /**
   * The payload really is encodable — which is what "the builder is sound" means.
   * `postFieldBytes` throws on an out-of-domain `author` or ref, so a
   * successful encode is the same evidence a genuine signature used to be: the
   * twin a poisoned fixture is cut from is not itself broken.
   */
  const payloadIsEncodable = (post: Post): boolean => {
    try {
      postFieldBytes(post);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Build well-formed, sign, **then** poison — the only route to the domain
   * check now that an out-of-domain post cannot be encoded, and so cannot be
   * signed.
   *
   * Returns the honest twin alongside the poisoned post. The twin is not a
   * convenience: "every prior check passed" is only evidence when it is
   * asserted against an object that differs in exactly one field, and it is
   * what stops a case from passing because the base fixture was broken.
   *
   * The twin encodes; the poisoned post does not. These tests assert the
   * **domain** rule rejects before that encoder is reached.
   */
  const signedThenPoisoned = (
    over: Record<string, unknown>,
  ): { honest: Post; post: Post } => {
    const honest = signedPost();
    return { honest, post: { ...honest, ...over } as Post };
  };

  // -------------------------------------------------------------------------
  // The headline: a post that passes ALL of Stage 1 today
  // -------------------------------------------------------------------------

  it('TEETH: a post with a non-hex parentRef passes every other Stage-1 check and is now rejected', () => {
    // 64 characters, count within MAX_PARENT_REFS, a string — so it satisfies
    // `verifyParentRefsCount` and any bare `typeof ref === 'string'` guard.
    // Under `arr(refs, b32)` it has no encoding at all.
    const { honest, post } = signedThenPoisoned({ parentRefs: ['z'.repeat(64)] });

    // The builder is sound: the twin this post is cut from is in domain and
    // encodable, so nothing below is passing on a broken fixture.
    expect(payloadIsEncodable(honest)).toBe(true);
    expect(verifyPostFieldDomains(honest)).toEqual({ valid: true });

    // Everything Stage 1 checks besides the domain still says yes:
    expect(verifyContentLimits(post.content)).toEqual({ valid: true });
    expect(verifyContentCharacters(post.content)).toEqual({ valid: true });
    expect(verifyParentRefsCount(post.parentRefs)).toEqual({ valid: true });
    expect(verifyProtocolVersion(post.protocolVersion)).toBe(true);
    // …and the encoder refuses it outright, naming the ref it choked on. This
    // is the reason the pin must run first: there is no preimage to check
    // anything else against.
    expect(() => postFieldBytes(post)).toThrow(
      'writeHexNOrThrow: expected 64 lowercase hex chars, got 64 chars',
    );

    // The pin is the only thing that rejects it — at both entry points.
    expect(verifyPostFieldDomains(post)).toEqual({
      valid: false,
      error: 'Post parentRef must be 64 lowercase hex characters',
    });
    expect(verifyTxStructure(postTx(post))).toEqual({
      valid: false,
      error: 'Post parentRef must be 64 lowercase hex characters',
    });
    // …and the honest twin passes the same gate, so the verdict is about the ref.
    expect(verifyTxStructure(postTx(honest))).toEqual({ valid: true });
  });

  it('TEETH: `verifyTxStructure` gated nothing about a post before — now it gates gossip', () => {
    // ⛔ `verifyTxStructure` gates gossip on the `tx` topic; it runs before
    // anything hashes the payload. `computeTxId` reaches `postFieldBytes`,
    // which throws on a 31-byte author.
    const { honest, post } = signedThenPoisoned({ author: new Uint8Array(31).fill(4) });

    // Every check that does not look inside the post still passes: the
    // transaction has inputs, outputs, a protocolVersion, and a post that is
    // present and an object.
    expect(verifyTxStructure(postTx(honest))).toEqual({ valid: true });
    expect(verifyTxStructure(postTx(post))).toEqual({
      valid: false,
      error: 'Post author must be exactly 32 bytes',
    });
    // It reaches that verdict WITHOUT encoding the post — which it could not do.
    // This is the relay path, inside a topic validator whose catch arm bans the
    // *forwarding* peer, so a throw here is the wrong penalty class.
    expect(() => postFieldBytes(post)).toThrow('writeBytesNOrThrow: expected 32 bytes, got 31');
    expect(() => verifyTxStructure(postTx(post))).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // author width
  // -------------------------------------------------------------------------

  it.each([0, 1, 31, 33, 64])('rejects a %i-byte author', (n) => {
    const { honest, post } = signedThenPoisoned({ author: new Uint8Array(n).fill(4) });
    // The twin differs in the author width and nothing else, and it is signed,
    // genuine and accepted — so the verdict below is about the width.
    expect(payloadIsEncodable(honest)).toBe(true);
    expect(verifyPostFieldDomains(honest)).toEqual({ valid: true });
    // `author` is the second rule in the chain, so this label also reports that
    // `isObject` and the content-type rule passed.
    expect(verifyPostFieldDomains(post)).toEqual({
      valid: false,
      error: 'Post author must be exactly 32 bytes',
    });
    // …and the width in the writer's own message is this case's `n`, so the
    // rejection is tied to the value the test is named for rather than to some
    // other malformed field drifting into the fixture.
    expect(() => postFieldBytes(post)).toThrow(`writeBytesNOrThrow: expected 32 bytes, got ${n}`);
  });

  it.each([
    ['empty', '', '0 chars'],
    ['63 hex chars', 'a'.repeat(63), '63 chars'],
    ['65 hex chars', 'a'.repeat(65), '65 chars'],
    ['64 chars with one non-hex', 'a'.repeat(63) + 'g', '64 chars'],
    ['0x-prefixed', '0x' + 'a'.repeat(62), '64 chars'],
    ['64 chars of whitespace padding', ' '.repeat(2) + 'a'.repeat(62), '64 chars'],
  ])('rejects a parentRef that is %s', (_label, ref, seenByWriter) => {
    const { honest, post } = signedThenPoisoned({ parentRefs: [ref] });
    expect(verifyPostFieldDomains(honest)).toEqual({ valid: true });
    expect(verifyPostFieldDomains(post)).toEqual({
      valid: false,
      error: 'Post parentRef must be 64 lowercase hex characters',
    });
    expect(() => postFieldBytes(post)).toThrow(
      `writeHexNOrThrow: expected 64 lowercase hex chars, got ${seenByWriter}`,
    );
  });

  it('rejects a malformed ref in any position, not just the first', () => {
    const good = 'ab'.repeat(32);
    const { post } = signedThenPoisoned({ parentRefs: [good, good, 'z'.repeat(64)] });

    // The control: same three positions, all well-formed, accepted. So a check
    // that only inspected `parentRefs[0]` would pass the poisoned post too —
    // it is position 2 that has to be found.
    expect(verifyPostFieldDomains({ ...post, parentRefs: [good, good, good] })).toEqual({
      valid: true,
    });
    expect(verifyPostFieldDomains(post)).toEqual({
      valid: false,
      error: 'Post parentRef must be 64 lowercase hex characters',
    });
    expect(() => postFieldBytes(post)).toThrow(
      'writeHexNOrThrow: expected 64 lowercase hex chars, got 64 chars',
    );

    // Three refs is over MAX_PARENT_REFS and that is deliberate: the count rule
    // is `verifyParentRefsCount`'s and is *not* one of this function's, which
    // is what lets a domain test reach a third position at all. Pinned so the
    // separation is not "tidied away" by trimming the fixture to one ref.
    expect(verifyParentRefsCount(post.parentRefs).valid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Honest paths do not move — the prediction, pinned
  // -------------------------------------------------------------------------

  it('accepts a well-formed post: 32/32 bytes and real computePostId refs', () => {
    // Every honest parentRef is a `computePostId` output, i.e. the hex string
    // `.toString('hex')` produces — lowercase, 64 chars, by construction.
    // A parent's id comes from the transaction that created it, so the honest
    // ref is a `computePostId(txId, 0)` output — still lowercase 64-hex by
    // construction, which is the property this pins.
    const parentId = computePostId(computeTxId(postTx(signedPost({ content: 'parent' }))), 0);
    expect(parentId).toMatch(/^[0-9a-f]{64}$/);

    const child = signedPost({ content: 'child', parentRefs: [parentId] });
    expect(verifyPostFieldDomains(child)).toEqual({ valid: true });
    expect(verifyTxStructure(postTx(child))).toEqual({ valid: true });
  });

  it('accepts the full MAX_PARENT_REFS-wide honest case', () => {
    // Driven by the constant, not by a literal — the shape `refs(n)` on the
    // ordering-block path already uses. A literal falsifies the test name the
    // moment the constant moves, and it is the name that carries the property:
    // whatever the bound is, a post sitting exactly on it is accepted by all
    // three checks at once.
    //
    // Honest about what that proves at `MAX_PARENT_REFS = 1`: this is a one-ref
    // post, so it does not discriminate "many refs" from "one ref" and largely
    // overlaps the well-formed case above. What survives is the agreement of the
    // three checks at the bound, plus a tripwire that self-adjusts if the bound
    // moves up.
    const refs = Array.from({ length: MAX_PARENT_REFS }, (_, i) =>
      computePostId(computeTxId(postTx(signedPost({ content: `parent ${i}` }))), 0),
    );
    expect(refs).toHaveLength(MAX_PARENT_REFS);
    expect(new Set(refs).size).toBe(MAX_PARENT_REFS);
    const post = signedPost({ parentRefs: refs });
    expect(verifyParentRefsCount(post.parentRefs)).toEqual({ valid: true });
    expect(verifyPostFieldDomains(post)).toEqual({ valid: true });
    expect(verifyTxStructure(postTx(post))).toEqual({ valid: true });
  });

  // -------------------------------------------------------------------------
  // Still total on adversarial input (M-5)
  // -------------------------------------------------------------------------

  it('verifyPostFieldDomains survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyPostFieldDomains(bad as unknown as Post)).not.toThrow();
      expect(verifyPostFieldDomains(bad as unknown as Post).valid).toBe(false);
      const good = signedPost();
      expect(() => verifyPostFieldDomains({ ...good, author: bad } as unknown as Post)).not.toThrow();
      expect(() => verifyPostFieldDomains({ ...good, extraJunk: bad } as unknown as Post)).not.toThrow();
      expect(() => verifyPostFieldDomains({ ...good, parentRefs: bad } as unknown as Post)).not.toThrow();
      expect(() => verifyPostFieldDomains({ ...good, parentRefs: [bad] } as unknown as Post)).not.toThrow();
    }
  });

  it('verifyTxStructure stays total now that it reaches into the post', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyTxStructure(postTx(bad as unknown as Post))).not.toThrow();
      // ⚠ `undefined` is the ABSENCE case and must stay valid — presence is
      // `!== undefined`, matching the `computeTxId` tail rule, so a transaction
      // with no post is an ordinary transaction and not a malformed one. Every
      // other malformed value is a present post and is rejected.
      const expected = bad === undefined;
      expect(verifyTxStructure(postTx(bad as unknown as Post)).valid).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// The header encoders establish their own domain
//
// Two failure modes, and only one of them is a panic.
//
// The first is an ungated door into `encodeHeader`. `blockHash` and
// `computePowHash` are reachable with headers no structure check has seen:
// node's fork resolution holds bare peer `BlockHeader`s, and
// `verifyOrderingBlockStructure` cannot cover that path because it takes an
// `OrderingBlock`. The guard therefore lives in the two encoder-backed
// functions themselves (VALIDATION_INTERFACE → blockHash).
//
// The second does not throw, which is why a search for panics cannot see it.
// `createdAt`'s layout writer is `vlqU`, which is total *by sentinel* — so
// `NaN`, `-1`, `1.5` and `2^60` all encode to `VLQ_SENTINEL`, giving distinct
// headers one `blockHash`, one PoW preimage and one signature verdict.
// `encodeHeader` is positional (`encodeStruct(HEADER, …)`), so that collision is
// live and `HEADER_DOMAIN`'s `createdAt` rule is what closes it.
// ---------------------------------------------------------------------------

describe('the header domain pin has teeth (spec §6.2)', () => {
  type KeyPair = ReturnType<typeof generateKeyPair>;

  const privKeyOf = (kp: KeyPair) =>
    createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' });

  const kp = generateKeyPair();

  const header = (over: Partial<BlockHeader> = {}): BlockHeader => ({
    protocolVersion: 1,
    height: 42,
    prevBlockHash: '11'.repeat(32),
    utxoTxRoot: '33'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: kp.publicKey,
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_700_000_000_000,
    ...over,
  });

  // -------------------------------------------------------------------------
  // The weaker rules, transcribed
  //
  // Each is what these fields are held to without `HEADER_DOMAIN` in front of
  // them. Keeping them here is what makes "accepted under the weaker rule" a
  // measurement rather than a memory.
  //
  // Transcribed rather than borrowed, at every layer — a reference
  // implementation that calls the code under test is not independent of it, and
  // that includes reaching the live `encodeHeader` underneath. What these need
  // is `blockHash` / `computePowHash` minus the domain guard, which is what
  // lets a poison fixture be mined and signed here after the guarded pair
  // refuses it.
  // -------------------------------------------------------------------------

  /** A bare type check on `createdAt` — its rule without `HEADER_DOMAIN`. */
  const preChangeCreatedAtRule = (v: unknown): boolean => typeof v === 'number';

  /**
   * `encodeHeader` minus the domain guard, transcribed rather than called.
   *
   * Calling the live `encodeHeader` would reinstate the borrowing one layer
   * down: it is fixed-width, so `b33(stateRoot)` throws on a 64-character
   * poison and the demonstration would stop at module load — the reference
   * implementation inheriting the very property it exists to stand apart from.
   *
   * Same field order, same writers, and **byte-identical to `encodeHeader` for
   * any header inside the domain** — which is what keeps
   * `blockHash(clean) === preChangeBlockHash(clean)` a real no-movement pin
   * rather than a tautology. Outside the domain it substitutes a value-derived
   * filler instead of throwing, so a poisoned header still gets *some* encoding
   * and can be mined and signed. The filler is derived from the value, so two
   * distinct poisons keep distinct hashes.
   */
  const domainFiller = (v: unknown, n: number): Uint8Array =>
    new Uint8Array(createHash('blake2b512').update(`filler:${String(v)}`).digest().subarray(0, n));

  const preChangeEncodeHeader = (h: BlockHeader): Uint8Array => {
    const w = new ByteWriter();
    const hexOrFiller = (v: unknown, n: number): void => {
      if (typeof v === 'string' && v.length === n * 2 && /^[0-9a-f]*$/.test(v)) {
        writeHexNOrThrow(w, v, n);
      } else {
        w.writeBytes(domainFiller(v, n));
      }
    };
    writeVlqU(w, h.protocolVersion);
    writeVlqU(w, h.height);
    hexOrFiller(h.prevBlockHash, 32);
    hexOrFiller(h.utxoTxRoot, 32);
    hexOrFiller(h.stateRoot, 33);
    if (h.validatorId instanceof Uint8Array && h.validatorId.length === 32) {
      writeBytesNOrThrow(w, h.validatorId, 32);
    } else {
      w.writeBytes(domainFiller(h.validatorId, 32));
    }
    writeVlqU(w, h.powNonce);
    writeVlqU(w, h.powTargetBits);
    writeVlqU(w, h.createdAt);
    return w.toBytes();
  };

  /** `blockHash` without the domain guard — total, never `null`. */
  const preChangeBlockHash = (h: BlockHeader): string =>
    createHash('blake2b512')
      .update(Buffer.from(preChangeEncodeHeader(h)))
      .digest()
      .subarray(0, 32)
      .toString('hex');

  /** `computePowHash` without the domain guard — total, never `null`. */
  const preChangePowHash = (h: BlockHeader): Buffer =>
    createHash('blake2b512')
      .update(Buffer.from(preChangeEncodeHeader({ ...h, powNonce: 0 })))
      .digest()
      .subarray(0, 32);

  const leadingZeroBits = (hash: Uint8Array, bits: number): boolean => {
    if (bits > hash.length * 8) return false;
    for (let i = 0; i < bits; i++) {
      if ((hash[Math.floor(i / 8)]! & (1 << (7 - (i % 8)))) !== 0) return false;
    }
    return true;
  };

  /** `verifyOrderingBlockPoW` over the unguarded preimage above. */
  const preChangePoW = (h: BlockHeader): boolean => {
    if (!Number.isSafeInteger(h.powNonce) || h.powNonce < 0) return false;
    if (!Number.isSafeInteger(h.powTargetBits) || h.powTargetBits < 0) return false;
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(h.powNonce));
    const hash = createHash('blake2b512')
      .update(preChangePowHash(h))
      .update(nonceBuf)
      .digest()
      .subarray(0, 32);
    // `powTargetBits` is in units of 1/256 of a bit and this walk counts whole
    // ones. The two coincide exactly at a whole bit, which is what every
    // fixture here carries (VALIDATION_INTERFACE → orderingPowTarget), so the
    // oracle stays independent of the code it pins.
    return leadingZeroBits(hash, Math.floor(h.powTargetBits / 256));
  };

  /** Raw `crypto.verify` over the pre-change `blockHash` — a rejection can never be a broken fixture. */
  const signatureIsGenuine = (h: BlockHeader, sig: Uint8Array): boolean =>
    cryptoVerify(
      null,
      Buffer.from(preChangeBlockHash(h), 'hex'),
      ed25519PublicKeyToKeyObject(kp.publicKey),
      Buffer.from(sig),
    );

  /** Mine against the pre-change rule, so a poison out of the *new* domain can still be solved. */
  const solvePreChange = (h: BlockHeader): BlockHeader => {
    for (let n = 0; n < 1_000_000; n++) {
      const candidate = { ...h, powNonce: n };
      if (preChangePoW(candidate)) return candidate;
    }
    throw new Error('unsolvable fixture');
  };

  // Pre-change, deliberately: this signs the poison fixtures, which the guarded
  // `blockHash` refuses by design. A genuine signature over a header the new
  // domain rejects is precisely what the teeth demonstrations need.
  const signHeader = (h: BlockHeader): Uint8Array =>
    new Uint8Array(sign(null, Buffer.from(preChangeBlockHash(h), 'hex'), privKeyOf(kp)));

  const blockOf = (h: BlockHeader, sig: Uint8Array): OrderingBlock => ({
    header: h,
    utxoTxTree: { utxoTxIds: [SETTLEMENT_ID], utxoTxs: [SETTLEMENT_BYTES], pruneEntries: [] },
    validatorSignature: sig,
  });

  // -------------------------------------------------------------------------
  // The domain, field by field
  // -------------------------------------------------------------------------

  it('accepts the header the honest producer emits', () => {
    expect(verifyHeaderFieldDomains(header())).toEqual({ valid: true });
    // `block-creator`'s `createOrderingBlock` builds exactly these shapes: roots
    // from the Merkle/AVL computations, `validatorId` a 32-byte key, `createdAt`
    // a `Date.now()`. Nothing in the honest production path leaves the domain.
    expect(verifyHeaderFieldDomains(header({ createdAt: Date.now() }))).toEqual({ valid: true });
    expect(verifyHeaderFieldDomains(header({ stateRoot: EMPTY_STATE_ROOT }))).toEqual({ valid: true });
    expect(verifyHeaderFieldDomains(header({ height: 1, powNonce: 0, powTargetBits: 0 }))).toEqual({ valid: true });
    expect(verifyHeaderFieldDomains(header({ height: Number.MAX_SAFE_INTEGER }))).toEqual({ valid: true });
  });

  // powTargetBits is the one numeric field with an upper bound, and it is
  // `orderingPowTarget`'s domain rather than a rule of its own: a header above
  // it already fails `verifyOrderingBlockPoW` (VALIDATION_INTERFACE →
  // orderingPowTarget). Both edges, because the bound is inclusive.
  it('bounds powTargetBits at the scaled domain, inclusive at both edges', () => {
    expect(verifyHeaderFieldDomains(header({ powTargetBits: 0 }))).toEqual({ valid: true });
    expect(verifyHeaderFieldDomains(header({ powTargetBits: 65536 }))).toEqual({ valid: true });
    for (const over of [65537, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      const result = verifyHeaderFieldDomains(header({ powTargetBits: over }));
      expect(result.valid, `powTargetBits ${over}`).toBe(false);
      expect(result.error).toContain('powTargetBits');
    }
  });

  const BAD_NUMBERS: Array<[string, unknown]> = [
    ['NaN', NaN],
    ['negative', -1],
    ['a float', 1.5],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
    ['2^60', 2 ** 60],
    ['a numeric string', '42'],
    ['undefined', undefined],
    ['a bigint', 42n],
  ];

  const BAD_HEX_64: Array<[string, unknown]> = [
    ['63 characters', 'a'.repeat(63)],
    ['65 characters', 'a'.repeat(65)],
    ['64 characters of non-hex', 'zz'.repeat(32)],
    ['64 characters of uppercase hex', 'AB'.repeat(32)],
    ['the empty string', ''],
    ['32 raw bytes', new Uint8Array(32)],
    ['undefined', undefined],
  ];

  const NUMERIC_FIELDS = ['protocolVersion', 'height', 'powNonce', 'powTargetBits', 'createdAt'] as const;
  const HEX32_FIELDS = ['prevBlockHash', 'utxoTxRoot'] as const;

  for (const field of NUMERIC_FIELDS) {
    for (const [name, bad] of BAD_NUMBERS) {
      it(`rejects ${field} that is ${name}`, () => {
        const result = verifyHeaderFieldDomains(header({ [field]: bad } as Partial<BlockHeader>));
        expect(result.valid).toBe(false);
        expect(result.error).toContain(field);
      });
    }
  }

  for (const field of HEX32_FIELDS) {
    for (const [name, bad] of BAD_HEX_64) {
      it(`rejects ${field} that is ${name}`, () => {
        const result = verifyHeaderFieldDomains(header({ [field]: bad } as Partial<BlockHeader>));
        expect(result.valid).toBe(false);
        expect(result.error).toContain(field);
      });
    }
  }

  it('rejects a stateRoot that is not 66 lowercase hex — 66, not 64', () => {
    for (const bad of ['00'.repeat(32), '00'.repeat(34), 'zz'.repeat(33), 'AB'.repeat(33), '', new Uint8Array(33)]) {
      const result = verifyHeaderFieldDomains(header({ stateRoot: bad as string }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('stateRoot');
    }
    expect(verifyHeaderFieldDomains(header({ stateRoot: 'ab'.repeat(33) }))).toEqual({ valid: true });
  });

  it('checks validatorId with isBytes, never a bare .length', () => {
    // A 32-character string, `{length: 32}` and a 32-element Array all satisfy a
    // length check and none of them encode as 32 bytes.
    for (const bad of ['a'.repeat(32), { length: 32 }, new Array(32).fill(0), new Uint32Array(8), new Uint8Array(31), new Uint8Array(33), undefined]) {
      const result = verifyHeaderFieldDomains(header({ validatorId: bad as Uint8Array }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('validatorId');
    }
  });

  it('names every field distinctly, so a rejection is a diagnosis', () => {
    const reasons = new Set<string>();
    for (const field of NUMERIC_FIELDS) {
      reasons.add(verifyHeaderFieldDomains(header({ [field]: NaN } as Partial<BlockHeader>)).error!);
    }
    for (const field of HEX32_FIELDS) {
      reasons.add(verifyHeaderFieldDomains(header({ [field]: 'nope' } as Partial<BlockHeader>)).error!);
    }
    reasons.add(verifyHeaderFieldDomains(header({ stateRoot: 'nope' })).error!);
    reasons.add(verifyHeaderFieldDomains(header({ validatorId: 'nope' as unknown as Uint8Array })).error!);
    // Nine header fields, each with a distinct domain rule.
    expect(reasons.size).toBe(9);
  });

  // -------------------------------------------------------------------------
  // Demonstration 1 — the throw case
  //
  // A header accepted today whose `blockHash` must be `null` after,
  // built to pass everything else so the new check is provably the only thing
  // rejecting it.
  // -------------------------------------------------------------------------

  describe('the throw case: a bare header on the fork-resolution path', () => {
    // 64 hex where 66 belong — a 32-byte digest in the 33-byte `stateRoot`.
    // This reaches `b33`, a fixed-width writer with no sentinel to fall back on,
    // so an unguarded encode throws rather than returning a verdict, and the
    // throw escapes into whatever catch node's ordering-block handler wraps
    // `resolveFork` in. `blockHash` answering `null` is what keeps it a verdict.
    const POISON = '00'.repeat(32);
    const poisoned = solvePreChange(header({ stateRoot: POISON }));
    const sig = signHeader(poisoned);

    it('is accepted by every rule this phase replaced', () => {
      // A bare `typeof stateRoot === 'string'` and no more.
      expect(typeof POISON).toBe('string');
      expect(preChangePoW(poisoned)).toBe(true);
      expect(signatureIsGenuine(poisoned, sig)).toBe(true);
    });

    it('reached the encoder with nothing in front of it, and encoded', () => {
      // The shape of the defect the guard closes: `findForkPoint` reaches
      // `blockHash(header)` with a bare peer header, and an unguarded encoder
      // hashes it happily, so nothing anywhere objects. Stated over the
      // transcribed encoder, because the guarded one refuses this header — which
      // is the fix, and is pinned in the next case.
      expect(() => preChangeBlockHash(poisoned)).not.toThrow();
      expect(preChangeBlockHash(poisoned)).toHaveLength(64);
    });

    it('and the header domain is the only thing that rejects it', () => {
      expect(verifyHeaderFieldDomains(poisoned).valid).toBe(false);
      expect(verifyHeaderFieldDomains(poisoned).error).toContain('stateRoot');
      expect(blockHash(poisoned)).toBeNull();
      expect(computePowHash(poisoned)).toBeNull();
    });

    it('the same header without the poison passes all of it — so the poison is the only variable', () => {
      const clean = solvePreChange(header());
      expect(preChangePoW(clean)).toBe(true);
      expect(signatureIsGenuine(clean, signHeader(clean))).toBe(true);
      expect(verifyHeaderFieldDomains(clean)).toEqual({ valid: true });
      expect(blockHash(clean)).toBe(preChangeBlockHash(clean));
      expect(computePowHash(clean)).toEqual(preChangePowHash(clean));
    });
  });

  // -------------------------------------------------------------------------
  // Demonstration 2 — the collision case, two-sided
  //
  // The half a search for panics cannot find. Without both sides it proves
  // nothing: a rejection means little unless the unguarded encoder is shown to
  // collapse these values onto one hash.
  // -------------------------------------------------------------------------

  describe('the collision case: createdAt', () => {
    const OUT_OF_DOMAIN: Array<[string, number]> = [
      ['NaN', NaN],
      ['-1', -1],
      ['1.5', 1.5],
      ['2^60', 2 ** 60],
    ];

    // Under the positional encoder this collapse is demonstrable rather than
    // predicted: all four values sit outside `vlqU`'s encodable domain, take
    // `VLQ_SENTINEL`, and land on one encoding. Both sides are pinned below,
    // because the collapse only means something alongside its converse — an
    // in-domain `createdAt` still moves the hash.

    it('the migration DOES collapse all four onto one preimage — shown, not predicted', () => {
      // All four are outside `vlqU`'s encodable domain, so all four take
      // `VLQ_SENTINEL` and the four headers share one encoding — a fact about
      // the shipped encoder, measured here rather than argued.
      const hashes = OUT_OF_DOMAIN.map(([, v]) => preChangeBlockHash(header({ createdAt: v })));
      expect(new Set(hashes).size).toBe(1);
      // And it is a genuine collision, not the encoder ignoring the field: an
      // in-domain `createdAt` still moves the hash.
      expect(hashes[0]).not.toBe(preChangeBlockHash(header()));
      expect(preChangeBlockHash(header({ createdAt: 1 })))
        .not.toBe(preChangeBlockHash(header({ createdAt: 2 })));
    });

    it('AFTER, every one of them returns null — closed at its source, not deferred', () => {
      for (const [, v] of OUT_OF_DOMAIN) {
        const h = header({ createdAt: v });
        expect(blockHash(h)).toBeNull();
        expect(computePowHash(h)).toBeNull();
        expect(verifyHeaderFieldDomains(h).error).toContain('createdAt');
      }
    });

    it('the PoW preimage and the signature verdict collapse the same way', () => {
      // The same argument one layer up. `computePowHash` zeroes `powNonce`, so
      // `createdAt` is the only varying field across these four — and they share
      // one preimage, which is one PoW verdict and one signature verdict for
      // four distinct headers. The guard is what keeps that unreachable: no
      // caller can obtain the preimage in the first place.
      const preimages = OUT_OF_DOMAIN.map(([, v]) =>
        preChangePowHash(header({ createdAt: v })).toString('hex'),
      );
      expect(new Set(preimages).size).toBe(1);
      for (const [, v] of OUT_OF_DOMAIN) {
        expect(verifyOrderingBlockPoW(header({ createdAt: v }))).toBe(false);
        expect(computePowHash(header({ createdAt: v }))).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // createdAt is a real behavioural change, not a tightening of the unusable
  // -------------------------------------------------------------------------

  // An out-of-domain `createdAt` clears all three consensus gates today —
  // structure, PoW and the validator signature. `-1`, `1.5` and `2^60` then
  // *apply*: `ordering_blocks.created_at` is `INTEGER NOT NULL` and SQLite
  // stores all three without complaint (measured against better-sqlite3:
  // -1 → integer, 1.5 → real, 2^60 → integer). `NaN` is the one exception —
  // it binds as REAL NaN, which SQLite treats as NULL, so it trips the NOT NULL
  // constraint *inside the apply transaction* and the funnel's totality catch
  // logs "unexpected failure during apply" rather than a stated rejection
  // (NODE_INTERFACE → Ordering block apply-time authorization). The domain pin
  // covers NaN too — just one gate earlier than the other three.
  describe.each([
    ['-1', -1],
    ['1.5', 1.5],
    ['2^60', 2 ** 60],
    ['NaN', NaN],
  ])('a block with createdAt %s is accepted by every consensus gate today', (_label, bad) => {
    const poisoned = solvePreChange(header({ createdAt: bad }));
    const sig = signHeader(poisoned);
    const block = blockOf(poisoned, sig);

    it('clears the rule that governed the field', () => {
      // A bare `typeof === 'number'` admits NaN, ±Infinity, -1 and 1.5, so it
      // governs the field without constraining it at all.
      expect(preChangeCreatedAtRule(bad)).toBe(true);
    });

    it('clears PoW as it stood, and the signature is genuine', () => {
      expect(preChangePoW(poisoned)).toBe(true);
      expect(signatureIsGenuine(poisoned, sig)).toBe(true);
    });

    it('and the structure gate objects to nothing else about it', () => {
      // `createdAt` is the sole objection: the block fails with that message and
      // no other. Every other check in that function — the prune entries, the
      // settlement count, utxoTx alignment, validatorSignature, the height and
      // target floors — still passes on this exact object.
      const result = verifyOrderingBlockStructure(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Ordering block header missing or invalid createdAt');
      // The same block with a real timestamp is accepted outright.
      const honest = blockOf({ ...poisoned, createdAt: 1_700_000_000_000 }, sig);
      expect(verifyOrderingBlockStructure(honest)).toEqual({ valid: true });
    });

    it('after 1f it is rejected at all three gates', () => {
      expect(verifyOrderingBlockStructure(block).valid).toBe(false);
      expect(verifyOrderingBlockPoW(block.header)).toBe(false);
      expect(verifyValidatorSignature(block.header, block.validatorSignature)).toBe(false);
      expect(blockHash(block.header)).toBeNull();
    });

    it('is a DOMAIN pin and not a clock policy', () => {
      // No monotonicity rule and no skew window: a timestamp rule is a consensus
      // rule addition, and "never add checks the reference lacks" applies. Any
      // non-negative safe integer is in the domain, including a wildly wrong one.
      expect(verifyHeaderFieldDomains(header({ createdAt: 0 }))).toEqual({ valid: true });
      expect(verifyHeaderFieldDomains(header({ createdAt: 1 }))).toEqual({ valid: true });
      expect(verifyHeaderFieldDomains(header({ createdAt: Date.now() + 100 * 365 * 86_400_000 }))).toEqual({ valid: true });
      expect(verifyHeaderFieldDomains(header({ createdAt: Number.MAX_SAFE_INTEGER }))).toEqual({ valid: true });
      // A header whose createdAt goes *backwards* relative to its parent is
      // still in the domain — nothing here knows what a parent is.
      expect(verifyHeaderFieldDomains(header({ height: 900, createdAt: 1 }))).toEqual({ valid: true });
    });
  });

  // -------------------------------------------------------------------------
  // Honest paths must not move — pinned, not assumed
  // -------------------------------------------------------------------------

  describe('honest paths do not move', () => {
    it('every header that passes verifyOrderingBlockStructure still hashes', () => {
      const h = solvePreChange(header());
      const block = blockOf(h, signHeader(h));
      expect(verifyOrderingBlockStructure(block)).toEqual({ valid: true });
      expect(blockHash(block.header)).toBe(preChangeBlockHash(block.header));
      expect(verifyOrderingBlockPoW(block.header)).toBe(true);
      expect(verifyValidatorSignature(block.header, block.validatorSignature)).toBe(true);
    });

    it('the guarded pair agrees with the pre-change encoders on every in-domain header', () => {
      // The invariant that makes the guard safe: no honest byte moves. If this
      // fails, `blockHash` is not the unguarded encoder plus a gate — it is a
      // different function, and every stored hash is a different value.
      const variants: Partial<BlockHeader>[] = [
        {},
        { height: 1 },
        { height: Number.MAX_SAFE_INTEGER },
        { createdAt: 0 },
        { createdAt: Date.now() },
        { powNonce: 4_294_967_296 },
        { powTargetBits: 0 },
        { stateRoot: 'ff'.repeat(33) },
        { prevBlockHash: '00'.repeat(32) },
        { validatorId: new Uint8Array(32).fill(0xab) },
      ];
      for (const over of variants) {
        const h = header(over);
        expect(verifyHeaderFieldDomains(h)).toEqual({ valid: true });
        expect(blockHash(h)).toBe(preChangeBlockHash(h));
        expect(computePowHash(h)).toEqual(preChangePowHash(h));
      }
    });

    it('the two callers of the domain agree — one statement, no drift', () => {
      // The reason the domain is one table rather than a rule per caller:
      // `verifyHeaderFieldDomains` and `verifyOrderingBlockStructure` both read
      // `HEADER_DOMAIN`, so a poison fails both or neither.
      const poisons: Partial<BlockHeader>[] = [
        { prevBlockHash: 'zz'.repeat(32) },
        { utxoTxRoot: 'AB'.repeat(32) },
        { utxoTxRoot: '' },
        { stateRoot: '00'.repeat(32) },
        { validatorId: new Uint8Array(31) },
        { protocolVersion: 1.5 },
        { height: NaN },
        { powNonce: -1 },
        { powTargetBits: Infinity },
        { createdAt: NaN },
      ];
      for (const over of poisons) {
        const h = header(over);
        const viaBlock = verifyOrderingBlockStructure(blockOf(h, new Uint8Array(64))).valid;
        const viaHeader = verifyHeaderFieldDomains(h).valid;
        expect(viaHeader).toBe(false);
        expect(viaBlock).toBe(false);
        expect(blockHash(h)).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Totality (M-5), extended past the verify* naming convention
  // -------------------------------------------------------------------------

  describe('totality on adversarial input', () => {
    // `conforms` is not a hedge — it names the honest exceptions, so a "rejects
    // everything" sweep cannot pass by rejecting too much. The corpus holds `0`,
    // which IS a well-formed value
    // for every `vlqU` field: the domain is "non-negative safe integer", and a
    // zero height, nonce or timestamp is inside it. (`height >= 1` is a
    // *semantic* floor and lives in `verifyOrderingBlockStructure`, not here.)
    // Asserting `false` there would be asserting a bug.
    const CONFORMS: Record<string, (v: unknown) => boolean> = {
      protocolVersion: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
      height: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
      powNonce: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
      // The one numeric field with an upper bound: it is `orderingPowTarget`'s
      // domain, not a non-negative integer (VALIDATION_INTERFACE →
      // orderingPowTarget). No MALFORMED entry is a safe integer above 65536,
      // so the bound is mirrored here rather than exercised by the corpus.
      powTargetBits: (v) =>
        typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 65536,
      createdAt: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
      prevBlockHash: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
      utxoTxRoot: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
      stateRoot: (v) => typeof v === 'string' && /^[0-9a-f]{66}$/.test(v),
      validatorId: (v) => v instanceof Uint8Array && v.length === 32,
    };
    const FIELDS = Object.keys(CONFORMS);

    it('verifyHeaderFieldDomains never throws, on the corpus or on any field', () => {
      for (const bad of MALFORMED) {
        expect(() => verifyHeaderFieldDomains(bad)).not.toThrow();
        expect(verifyHeaderFieldDomains(bad).valid).toBe(false);
        for (const field of FIELDS) {
          const h = header({ [field]: bad } as Partial<BlockHeader>);
          expect(() => verifyHeaderFieldDomains(h)).not.toThrow();
          expect(verifyHeaderFieldDomains(h).valid).toBe(CONFORMS[field]!(bad));
        }
      }
    });

    it('blockHash and computePowHash return null instead of throwing', () => {
      for (const bad of MALFORMED) {
        expect(() => blockHash(bad as unknown as BlockHeader)).not.toThrow();
        expect(blockHash(bad as unknown as BlockHeader)).toBeNull();
        expect(() => computePowHash(bad as unknown as BlockHeader)).not.toThrow();
        expect(computePowHash(bad as unknown as BlockHeader)).toBeNull();
        for (const field of FIELDS) {
          const h = header({ [field]: bad } as Partial<BlockHeader>);
          const ok = CONFORMS[field]!(bad);
          expect(() => blockHash(h)).not.toThrow();
          expect(() => computePowHash(h)).not.toThrow();
          expect(blockHash(h) === null).toBe(!ok);
          expect(computePowHash(h) === null).toBe(!ok);
          // Where the corpus value conforms, the guard must be transparent: it
          // adds rejections, and no honest byte moves.
          if (ok) {
            expect(blockHash(h)).toBe(preChangeBlockHash(h));
            expect(computePowHash(h)).toEqual(preChangePowHash(h));
          }
        }
      }
    });

    it('the corpus does contain a conforming value, so the sweep is not vacuous', () => {
      // Guards the two assertions above from degenerating into "everything is
      // null": if no corpus value ever conformed, `CONFORMS` would be dead
      // weight and a regression that rejected *everything* would still pass.
      expect(MALFORMED.some((bad) => CONFORMS.createdAt!(bad))).toBe(true);
      expect(blockHash(header())).not.toBeNull();
      expect(computePowHash(header())).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// The weight bounds — MAX_TX_BYTES and MAX_BLOCK_BODY_BYTES
// ---------------------------------------------------------------------------
//
// ⛔ **Attribution is the requirement.** An oversized object satisfies every
// other structural rule, so a fixture that fails two checks says nothing about
// the one under test. Every rejection below is one byte away from a fixture the
// same test asserts is ACCEPTED, and every assertion names the reason — which is
// what tells this gate apart from the ones above it.

describe('verifyTxStructure — the transaction weight bound', () => {
  const TOO_LARGE = `Transaction too large (max ${MAX_TX_BYTES} bytes)`;
  const NOT_ENCODABLE = 'Transaction is not encodable';

  const karmaOut: AnyBoxCandidate = {
    boxType: 'karma', value: 5n, createdAtBlock: 0, owner: new Uint8Array(32),
  };

  /** What `lpUtf8` costs for `k` ASCII characters: its `vlqU` length prefix plus itself. */
  const contentCost = (k: number): number => k + (k < 128 ? 1 : 2);

  /**
   * A transaction encoding to exactly `target` bytes.
   *
   * ⛔ **No count can land on an arbitrary number.** Every input is `b32` — a
   * fixed 32 bytes, whatever the id — and every signature is 96, so the counts
   * move the size in steps and never between them (TYPES_INTERFACE → Layout —
   * UtxoTransaction). The byte-granular field is the post's `lpUtf8(content)`,
   * bounded at `MAX_CONTENT_BYTES`: the inputs carry the bulk and the content
   * closes the last ≤ 300 bytes. Its own length prefix widens inside that range,
   * so the length is solved against the measured base rather than derived, and
   * dropping one whole input widens the remainder by 32 when no content length
   * closes the gap.
   */
  const txOfEncodedSize = (target: number): UtxoTransaction => {
    const build = (n: number, k: number): UtxoTransaction => ({
      inputs: Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, '0')),
      outputs: [karmaOut],
      signatures: {},
      protocolVersion: 1,
      post: {
        content: 'a'.repeat(k),
        author: new Uint8Array(32).fill(7),
        parentRefs: [],
        protocolVersion: 1,
        type: 'regular' as const,
      },
    });
    for (let n = Math.ceil(target / 32); n >= 0; n--) {
      const withoutContent = encodeTx(build(n, 1)).length - contentCost(1);
      const gap = target - withoutContent;
      for (const k of [gap - 1, gap - 2]) {
        if (k >= 1 && k <= MAX_CONTENT_BYTES && contentCost(k) === gap) return build(n, k);
      }
    }
    throw new Error(`no transaction fixture of exactly ${target} bytes`);
  };

  const atLimit = txOfEncodedSize(MAX_TX_BYTES);
  /** The same transaction, one character longer in its post content. */
  const overLimit: UtxoTransaction = {
    ...atLimit,
    post: { ...atLimit.post!, content: `${atLimit.post!.content}a` },
  };

  it('accepts a transaction encoding to exactly MAX_TX_BYTES', () => {
    expect(encodeTx(atLimit).length).toBe(MAX_TX_BYTES);
    expect(verifyTxStructure(atLimit)).toEqual({ valid: true });
  });

  it('rejects one byte more, and names the weight bound', () => {
    // One character apart from the fixture the test above asserts is valid, so
    // no other rule can be credited with this rejection.
    expect(encodeTx(overLimit).length).toBe(MAX_TX_BYTES + 1);
    expect(verifyTxStructure(overLimit)).toEqual({ valid: false, error: TOO_LARGE });
  });

  // ⚠ **That the measure is the re-encoding and not the received bytes has no
  // test here, and cannot have one** — this function takes a `UtxoTransaction`
  // and never sees the bytes it arrived as, so the clause holds by the
  // signature. The half that IS observable is the block side's opposite measure,
  // pinned below: `utxoTxs` elements are weighed as bytes, never decoded.

  describe('an encoder throw is a rejection, not an escape (M-5)', () => {
    const withOutput = (out: unknown): UtxoTransaction =>
      ({
        inputs: ['aa'.repeat(32)],
        outputs: [out],
        signatures: {},
        protocolVersion: 1,
      }) as unknown as UtxoTransaction;

    // `writeVlqU64OrThrow` refuses every one of these: a `bigint` spans the
    // whole u64 and has no unreachable sentinel to collapse onto, so the writer
    // throws rather than colliding (TYPES_INTERFACE → Totality). They clear
    // every check above — the genesis_proof scan reads `boxType` and nothing
    // else, and no rule here types an output's fields.
    //
    // ⛔ A nested array is on this list, and its verdict is the same as a
    // number's. The encoder walks a **fixed** field list per box arm, so depth
    // is not a property it can be defeated with: an array reaches `vlqU64` as a
    // non-`bigint` and dies at the first throwing writer it meets.
    it.each([
      ['a symbol', Symbol('x')],
      ['a function', () => 1],
      ['a number where a bigint belongs', 5],
      ['a nested array', [[[0]]]],
    ])('rejects an output holding %s', (_label, value) => {
      expect(verifyTxStructure(withOutput({ boxType: 'karma', value, owner: new Uint8Array(32) }))).toEqual({
        valid: false,
        error: NOT_ENCODABLE,
      });
    });

    it('rejects an output whose getter throws inside the encoder', () => {
      const out = { boxType: 'karma', owner: new Uint8Array(32) };
      Object.defineProperty(out, 'value', {
        get() { throw new Error('boom'); },
        enumerable: true,
      });
      expect(verifyTxStructure(withOutput(out))).toEqual({ valid: false, error: NOT_ENCODABLE });
    });

    // ⛔ The two throwing writers the transaction layout reaches outside a box,
    // exercised on the fields that feed them. Both are `OrThrow` for the same
    // reason: a fixed-width field has no spare encoding to sentinel into, so a
    // value outside the width has no bytes at all rather than bytes it shares
    // with a well-formed one.
    it('rejects an input that is not 64 lowercase hex', () => {
      // `writeHexNOrThrow(id, 32)`. Today's one production caller — net's `tx`
      // topic validator — hands this function `decodeTx(raw)`, whose inputs are
      // 64-hex by construction, so no *named* path arrives here with one of
      // these. The pin is on the function's own postcondition rather than on a
      // path: the no-panic rule is what an exported predicate owes every caller
      // (VALIDATION_INTERFACE → Postconditions), and a rule justified by a path
      // instead would be the shape that file warns about.
      for (const bad of ['input1', '', 'aa'.repeat(31), 'AA'.repeat(32), `${'aa'.repeat(32)}f`]) {
        expect(verifyTxStructure({
          inputs: [bad],
          outputs: [karmaOut],
          signatures: {},
          protocolVersion: 1,
        })).toEqual({ valid: false, error: NOT_ENCODABLE });
      }
    });

    it('rejects a signature that is not exactly 64 bytes, and a key that is not a 32-byte id', () => {
      // `writeBytesNOrThrow(sig, 64)` and `writeHexNOrThrow(pubkey, 32)` — the
      // signature map's two halves. Its domain is node's `checkTxEnvelope`, so
      // this is the encoder's floor under that rule and not a second statement
      // of it.
      const signed = (key: string, sig: Uint8Array): UtxoTransaction => ({
        inputs: ['aa'.repeat(32)],
        outputs: [karmaOut],
        signatures: { [key]: sig },
        protocolVersion: 1,
      });
      expect(verifyTxStructure(signed('bb'.repeat(32), new Uint8Array(64)))).toEqual({ valid: true });
      expect(verifyTxStructure(signed('bb'.repeat(32), new Uint8Array(63)))).toEqual({ valid: false, error: NOT_ENCODABLE });
      expect(verifyTxStructure(signed('not-a-key', new Uint8Array(64)))).toEqual({ valid: false, error: NOT_ENCODABLE });
    });
  });
});

describe('verifyOrderingBlockStructure — the body and embedded-transaction bounds', () => {
  const BODY_TOO_LARGE = `Ordering block body too large (max ${MAX_BLOCK_BODY_BYTES} bytes)`;
  const TX_TOO_LARGE = `Ordering block utxoTx too large (max ${MAX_TX_BYTES} bytes)`;

  /**
   * A block that passes every structural check, carrying the transactions given.
   * `pruneEntries` stays empty so the body's weight is the transactions and
   * their framing alone. The last of them is the settlement, which costs the
   * body nothing extra — it rides `utxoTxIds` / `utxoTxs` like any other
   * transaction (TYPES_INTERFACE → OrderingBlock).
   */
  const makeBlock = (utxoTxs: Uint8Array[]): OrderingBlock => ({
    header: {
      protocolVersion: 1,
      height: 1,
      prevBlockHash: '0'.repeat(64),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32).fill(1),
      powNonce: 0,
      powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
      createdAt: 1_700_000_000_000,
    },
    utxoTxTree: {
      utxoTxIds: utxoTxs.map((_, i) => i.toString(16).padStart(64, '0')),
      utxoTxs,
      pruneEntries: [],
    },
    validatorSignature: new Uint8Array(64),
  });

  /**
   * Transactions whose tree measures exactly `target`. Each stays under
   * `MAX_TX_BYTES` so the embedded bound can never be the reason a body-size
   * fixture is refused; the last one absorbs the remainder.
   */
  const bodyOfExactSize = (target: number): Uint8Array[] => {
    const per = 8_000;
    const n = Math.ceil(target / (per + 34));
    const txs = Array.from({ length: n }, () => new Uint8Array(per));
    for (let i = 0; i < 4; i++) {
      const delta = target - utxoTxTreeByteLength(makeBlock(txs).utxoTxTree);
      if (delta === 0) return txs;
      txs[n - 1] = new Uint8Array(txs[n - 1]!.length + delta);
    }
    throw new Error(`no body fixture of exactly ${target} bytes`);
  };

  describe('the body bound', () => {
    it('accepts a body of exactly MAX_BLOCK_BODY_BYTES', () => {
      const txs = bodyOfExactSize(MAX_BLOCK_BODY_BYTES);
      const block = makeBlock(txs);
      expect(utxoTxTreeByteLength(block.utxoTxTree)).toBe(MAX_BLOCK_BODY_BYTES);
      // No embedded transaction is near its own bound, so this fixture isolates
      // the body rule from the one in the `utxoTxs` loop.
      expect(txs.every((t) => t.length <= MAX_TX_BYTES)).toBe(true);
      // The gate measured what the encoder actually writes. A sizer that
      // under-reported here would pass a block this node relays and its peers
      // refuse (TYPES_INTERFACE → Sizing without encoding).
      expect(encodeUtxoTxTree(block.utxoTxTree).length).toBe(MAX_BLOCK_BODY_BYTES);
      expect(verifyOrderingBlockStructure(block)).toEqual({ valid: true });
    });

    it('rejects one byte more, and names the body bound', () => {
      const txs = bodyOfExactSize(MAX_BLOCK_BODY_BYTES);
      txs[txs.length - 1] = new Uint8Array(txs[txs.length - 1]!.length + 1);
      const block = makeBlock(txs);
      expect(utxoTxTreeByteLength(block.utxoTxTree)).toBe(MAX_BLOCK_BODY_BYTES + 1);
      expect(txs.every((t) => t.length <= MAX_TX_BYTES)).toBe(true);
      expect(verifyOrderingBlockStructure(block)).toEqual({ valid: false, error: BODY_TOO_LARGE });
    });
  });

  describe('the embedded-transaction bound', () => {
    // Both fixtures are far under the body cap, so the body bound cannot be
    // credited with either verdict.
    it('accepts an embedded transaction of exactly MAX_TX_BYTES', () => {
      const block = makeBlock([new Uint8Array(MAX_TX_BYTES)]);
      expect(utxoTxTreeByteLength(block.utxoTxTree)).toBeLessThan(MAX_BLOCK_BODY_BYTES);
      expect(verifyOrderingBlockStructure(block)).toEqual({ valid: true });
    });

    it('rejects one byte more, in a block far under the body cap', () => {
      const block = makeBlock([new Uint8Array(MAX_TX_BYTES + 1)]);
      expect(utxoTxTreeByteLength(block.utxoTxTree)).toBeLessThan(MAX_BLOCK_BODY_BYTES);
      expect(verifyOrderingBlockStructure(block)).toEqual({ valid: false, error: TX_TOO_LARGE });
    });

    it('weighs each transaction, not their total', () => {
      // Two transactions summing past the bound are fine; one over it is not.
      const halves = makeBlock([new Uint8Array(MAX_TX_BYTES), new Uint8Array(MAX_TX_BYTES)]);
      expect(verifyOrderingBlockStructure(halves)).toEqual({ valid: true });
    });

    it('refuses an oversized transaction in any position, not only the first', () => {
      const block = makeBlock([
        new Uint8Array(10),
        new Uint8Array(MAX_TX_BYTES + 1),
        new Uint8Array(10),
      ]);
      expect(verifyOrderingBlockStructure(block)).toEqual({ valid: false, error: TX_TOO_LARGE });
    });
  });
});
