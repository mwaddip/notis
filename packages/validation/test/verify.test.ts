import { describe, it, expect } from 'vitest';
import { createHash, sign, createPrivateKey, verify as cryptoVerify } from 'crypto';
import { readFileSync } from 'fs';
import {
  verifyPoW,
  verifyPostSignature,
  verifyValidatorSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyContentCharacters,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyBlockChainLink,
  verifyOrderingBlockPoW,
  blockHash,
  computePowHash,
  blockHashChecked,
  computePowHashChecked,
  isValidVouchTarget,
  verifyPostFieldDomains,
  verifyHeaderFieldDomains,
  ed25519PublicKeyToKeyObject,
} from '../src/verify.js';
import { isDisallowedContentCodepoint, PINNED_UNICODE_VERSION } from '../src/content-charset.js';
import { generateKeyPair, computePostId, signingHash, postPowPreimage, EMPTY_STATE_ROOT, MAX_PARENT_REFS } from '@dagsocial/types';
import type { Post, SubBlock, SubBlockEntry, PruneEntry, BlockHeader, OrderingBlock, UtxoTransaction, CoinbaseOutput } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// verifyPoW
// ---------------------------------------------------------------------------

describe('verifyPoW', () => {
  it('accepts a valid PoW solution', () => {
    const input = Buffer.from('test input');
    let nonce = 0;
    const targetBits = 4;
    // Find a valid nonce
    while (nonce < 100000) {
      if (verifyPoW(input, nonce, targetBits)) break;
      nonce++;
    }
    expect(verifyPoW(input, nonce, targetBits)).toBe(true);
  });

  it('rejects an invalid PoW solution', () => {
    const input = Buffer.from('test input');
    expect(verifyPoW(input, 0, 20)).toBe(false);
  });

  it('verifies the same solution consistently', () => {
    const input = Buffer.from('hello world');
    let nonce = 0;
    while (nonce < 100000 && !verifyPoW(input, nonce, 4)) nonce++;
    for (let i = 0; i < 5; i++) {
      expect(verifyPoW(input, nonce, 4)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyPostSignature
// ---------------------------------------------------------------------------

describe('verifyPostSignature', () => {
  it('accepts a valid Ed25519 signature', () => {
    const kp = generateKeyPair();
    const post: Post = {
      content: 'hello',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64), // placeholder
    };
    // Sign the post
    const sig = sign(null, signingHash(post), createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' }));
    post.signature = new Uint8Array(sig);
    expect(verifyPostSignature(post, kp.publicKey)).toBe(true);
  });

  it('rejects a signature with wrong public key', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const post: Post = {
      content: 'hello',
      author: kp1.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    const sig = sign(null, signingHash(post), createPrivateKey({ key: Buffer.from(kp1.secretKey), format: 'der', type: 'pkcs8' }));
    post.signature = new Uint8Array(sig);
    expect(verifyPostSignature(post, kp2.publicKey)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const kp = generateKeyPair();
    const post: Post = {
      content: 'hello',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    const sig = sign(null, signingHash(post), createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' }));
    // Tamper with one byte
    const tampered = new Uint8Array(sig);
    tampered[0] = (tampered[0]! + 1) % 256;
    post.signature = tampered;
    expect(verifyPostSignature(post, kp.publicKey)).toBe(false);
  });
});

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
    subBlockRoot: '11'.repeat(32),
    utxoTxRoot: '22'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32),
    powNonce: 12345,
    powTargetBits: 4,
    createdAt: 1_700_000_000_000,
    ...over,
  });

  /** Sign exactly what the block creator signs: the 32 raw bytes of blockHash(header). */
  const signHeader = (header: BlockHeader, kp: KeyPair): Uint8Array =>
    new Uint8Array(sign(null, Buffer.from(blockHash(header), 'hex'), privKeyOf(kp)));

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
    expect(verifyContentCharacters('hello world').valid).toBe(false);
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
  // path already uses (`refs(n)`, below). The literals they replaced were `8`
  // and `9`, and when `MAX_PARENT_REFS` moved to 1 they failed differently:
  // `8` broke loudly, while `9` kept passing and quietly stopped testing the
  // off-by-one it existed for — 9 is now eight *over* the bound, not one over.
  // A test that still passes for a weaker reason than its name claims shows up
  // in no failure list, which is why the bound is never spelled as a number.
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
// verifySubBlockStructure
// ---------------------------------------------------------------------------

describe('verifySubBlockStructure', () => {
  // A UserId is 32 raw bytes — an Ed25519 public key. These fixtures carried
  // the display string 'user1', which no identity can ever be; the test tree
  // was unchecked, so it typechecked as nothing.
  const TEST_USER: Uint8Array = new Uint8Array(32).fill(1);

  const makeBasePost = (): Post => ({
    content: 'test',
    author: TEST_USER,
    parentRefs: [],
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: 1,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
  });

  it('accepts a valid sub-block', () => {
    const sb: SubBlock = {
      subBlockId: computePostId(makeBasePost()),
      post: makeBasePost(),
      producerId: TEST_USER,
      protocolVersion: 1,
    };
    expect(verifySubBlockStructure(sb)).toEqual({ valid: true });
  });

  it('T2b pin: accepts a sub-block without the retired likeBoxes field', () => {
    // Two-sided pin, after-leg. Before-leg captured on the pre-T2b tree
    // (2026-08-08): this exact shape was rejected with
    // { valid: false, error: 'Sub-block likeBoxes must be an array' }.
    // The `as SubBlock` cast is gone with the typed test tree: once
    // `producerId` is real bytes this object IS a complete SubBlock, which is
    // precisely the claim — `likeBoxes` is retired, so nothing is missing. The
    // compiler now proves that instead of being told to assume it.
    const sb: SubBlock = {
      subBlockId: 'ab'.repeat(32),
      post: makeBasePost(),
      producerId: TEST_USER,
      protocolVersion: 1,
    };
    expect(verifySubBlockStructure(sb)).toEqual({ valid: true });
  });

  it('rejects sub-block missing post', () => {
    const sb = {
      subBlockId: 'abc',
      producerId: 'user1',
      protocolVersion: 1,
    } as unknown as SubBlock;
    expect(verifySubBlockStructure(sb).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyTxStructure
// ---------------------------------------------------------------------------

describe('verifyTxStructure', () => {
  it('accepts a valid transaction', () => {
    const tx: UtxoTransaction = {
      inputs: ['input1'],
      outputs: [{ boxType: 'karma', value: 5n, owner: new Uint8Array(32), guard: 'owner_signature', proofSource: 'abc' }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx)).toEqual({ valid: true });
  });

  it('rejects transaction with no inputs', () => {
    const tx: UtxoTransaction = {
      inputs: [],
      outputs: [{ boxType: 'karma', value: 5n, owner: new Uint8Array(32), guard: 'owner_signature', proofSource: 'abc' }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx).valid).toBe(false);
  });

  it('rejects transaction with no outputs', () => {
    const tx: UtxoTransaction = {
      inputs: ['input1'],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx).valid).toBe(false);
  });

  it('rejects transaction with duplicate inputs', () => {
    const tx: UtxoTransaction = {
      inputs: ['input1', 'input1'],
      outputs: [{ boxType: 'karma', value: 5n, owner: new Uint8Array(32), guard: 'owner_signature', proofSource: 'abc' }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx).valid).toBe(false);
  });

  it('rejects transaction missing protocolVersion', () => {
    const tx = {
      inputs: ['input1'],
      outputs: [{ boxType: 'karma', value: 5n }],
      signatures: {},
    } as unknown as UtxoTransaction;
    expect(verifyTxStructure(tx).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyOrderingBlockStructure
// ---------------------------------------------------------------------------

describe('verifyOrderingBlockStructure', () => {
  const makeValidBlock = (): OrderingBlock => ({
    header: {
      protocolVersion: 1,
      height: 1,
      prevBlockHash: '0'.repeat(64),
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32).fill(1),
      powNonce: 0,
      powTargetBits: 12,
      createdAt: Date.now(),
    },
    subBlockTree: {
      subBlockRefs: [],
      subBlockEntries: [],
      pruneEntries: [],
    },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
      coinbaseOutputs: [],
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

  it('rejects block with subBlockEntries misaligned with subBlockRefs', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = []; // misaligned — 1 ref, 0 entries
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects subBlockEntries with invalid postId', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = [
      { postId: 'too-short', parentRefs: [], author: 'cc'.repeat(32) },
    ];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid postId');
  });

  it('accepts a subBlockEntry with a 64-char author (control for the author check)', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = [
      { postId: 'aa'.repeat(32), parentRefs: [], author: 'cc'.repeat(32) },
    ];
    expect(verifyOrderingBlockStructure(block)).toEqual({ valid: true });
  });

  it('rejects subBlockEntries with a missing author', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = [
      { postId: 'aa'.repeat(32), parentRefs: [] } as unknown as SubBlockEntry,
    ];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid author');
  });

  it('rejects subBlockEntries with a wrong-length author', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = [
      { postId: 'aa'.repeat(32), parentRefs: [], author: 'too-short' },
    ];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid author');
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
        coinbaseOutputs: [],
      },
    } as unknown as OrderingBlock;
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('accepts coinbase outputs with non-negative bigint values', () => {
    const block = makeValidBlock();
    block.utxoTxTree.coinbaseOutputs = [
      { owner: new Uint8Array(32).fill(2), value: 5n, lockedUntilBlock: 1, isTreasury: false },
      { owner: new Uint8Array(32).fill(3), value: 0n, lockedUntilBlock: 1, isTreasury: true },
    ];
    expect(verifyOrderingBlockStructure(block)).toEqual({ valid: true });
  });

  it('rejects a coinbase output with a number value (bigint required)', () => {
    const block = makeValidBlock();
    block.utxoTxTree.coinbaseOutputs = [
      { owner: new Uint8Array(32).fill(2), value: 5, lockedUntilBlock: 1, isTreasury: false } as unknown as CoinbaseOutput,
    ];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid value');
  });

  it('rejects a coinbase output with a negative bigint value', () => {
    const block = makeValidBlock();
    block.utxoTxTree.coinbaseOutputs = [
      { owner: new Uint8Array(32).fill(2), value: -1n, lockedUntilBlock: 1, isTreasury: false },
    ];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid value');
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
    trigger: 'author',
  });

  /** The valid block, carrying one prune entry with `over` applied to it. */
  const blockWithPrune = (over: Record<string, unknown> = {}): OrderingBlock => {
    const block = makeValidBlock();
    block.subBlockTree.pruneEntries = [
      { ...makeValidPruneEntry(), ...over } as unknown as PruneEntry,
    ];
    return block;
  };

  it('accepts a well-formed prune entry (control for every rejection below)', () => {
    expect(verifyOrderingBlockStructure(blockWithPrune())).toEqual({ valid: true });
  });

  it('accepts the "storage_prune" trigger', () => {
    expect(verifyOrderingBlockStructure(blockWithPrune({ trigger: 'storage_prune' })))
      .toEqual({ valid: true });
  });

  it('rejects a block with no pruneEntries field at all', () => {
    const block = makeValidBlock();
    delete (block.subBlockTree as unknown as Record<string, unknown>).pruneEntries;
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('pruneEntries');
  });

  it('rejects a non-array pruneEntries', () => {
    const block = makeValidBlock();
    (block.subBlockTree as unknown as Record<string, unknown>).pruneEntries = 'nope';
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects a prune entry that is not an object', () => {
    const block = makeValidBlock();
    (block.subBlockTree as unknown as Record<string, unknown>).pruneEntries = [42];
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
    // The alphabet, which the old message claimed and the old check did not
    // enforce: 64 characters that are not hex.
    { name: 'subtreePostIds holds a 64-char non-hex string', over: { subtreePostIds: ['zz'.repeat(32)] }, error: 'subtreePostId must be 64 lowercase hex' },
    { name: 'subtreePostIds holds an uppercase-hex id', over: { subtreePostIds: ['AA'.repeat(32)] }, error: 'subtreePostId must be 64 lowercase hex' },
    { name: 'rootPostHash is 64 chars of non-hex', over: { rootPostHash: 'zz'.repeat(32) }, error: 'invalid rootPostHash' },
    { name: 'rootPostHash is uppercase hex', over: { rootPostHash: 'AA'.repeat(32) }, error: 'invalid rootPostHash' },
    // The kill shot: a CBOR integer where 32 bytes belong. `Buffer.from(42)`
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
    { name: 'trigger is an unknown string', over: { trigger: 'whatever' }, error: 'invalid trigger' },
    { name: 'trigger is missing', over: { trigger: undefined }, error: 'invalid trigger' },
    { name: 'trigger is a number', over: { trigger: 1 }, error: 'invalid trigger' },
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
    expect(errors.size).toBe(7);
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
// Phase 1e — the hex-alphabet pin has teeth
//
// Every block below is mined and signed for real, and differs from a control
// block that this function accepts in exactly one field. So for each case the
// claim "the alphabet check is the only thing rejecting it" is measured, not
// asserted: each surviving check is exercised individually on the *poisoned*
// block and shown to pass, and the control proves the rest of the structure
// check passes on an otherwise identical object.
//
// The path this closes is not the preimage but the store. `block-apply.ts:579`
// takes `subBlockId = entry.postId` and `:584` writes
// `insertPostPlaceholder(subBlockId, entry.parentRefs)` whenever a block
// confirms a sub-block whose content has not arrived; `insertPost` then
// upgrades the row without ever revisiting `parent_refs`. A 64-character
// non-hex ref therefore reaches `dag_posts.parent_refs` and stays there, and
// `rowToPost` → `computePostId` reads it at feed-service and stump-engine.
// ---------------------------------------------------------------------------

describe('ordering-block hex domains — the pin has teeth', () => {
  type KeyPair = ReturnType<typeof generateKeyPair>;

  const privKeyOf = (kp: KeyPair) =>
    createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' });

  const signHeader = (header: BlockHeader, kp: KeyPair): Uint8Array =>
    new Uint8Array(sign(null, Buffer.from(blockHash(header), 'hex'), privKeyOf(kp)));

  /** Mine the header for real against its own `powTargetBits`. */
  const solve = (header: BlockHeader): BlockHeader => {
    for (let n = 0; n < 1_000_000; n++) {
      const candidate = { ...header, powNonce: n };
      if (verifyOrderingBlockPoW(candidate)) return candidate;
    }
    throw new Error('unsolvable fixture');
  };

  /**
   * The rule as it stood before this phase, transcribed from the code it
   * replaced (`typeof ref !== 'string' || ref.length !== 64`). Keeping it here
   * is what makes "accepted today" a measurement rather than a memory: every
   * poison below is asserted to satisfy it.
   */
  const preChangeRule = (v: unknown): boolean => typeof v === 'string' && v.length === 64;

  /**
   * `isEncodableHeader`'s rule for the string header fields, transcribed from
   * the code Phase 1f replaced (`typeof h.prevBlockHash !== 'string'` and the
   * four lines around it). It was the *only* header gate `verifyOrderingBlockPoW`
   * and `verifyValidatorSignature` had, which is what let a poisoned header mine
   * and sign — so asserting a poison satisfies it makes "it used to ride through
   * PoW" a measurement rather than a memory.
   */
  const preChangeEncoderRule = (v: unknown): boolean => typeof v === 'string';

  /** 64 characters, a string, and not hex. */
  const NON_HEX_64 = 'zz'.repeat(32);
  /** 64 characters of hex in the wrong case — decodes to the same 32 bytes. */
  const UPPER_HEX_64 = 'AB'.repeat(32);
  const GOOD = 'ab'.repeat(32);

  const kp = generateKeyPair();

  /**
   * A block whose body carries `entries` / `pruneEntries` / `utxoTxIds`, with a
   * genuinely mined and signed header.
   *
   * `subBlockRoot` and `utxoTxRoot` are producer-chosen 64-hex strings here,
   * not recomputed: this function does not recompute them (that is apply-time,
   * in `@dagsocial/node`), and a malicious validator computes the real roots
   * over its own poisoned body anyway — `computeSubBlockRoot`'s leaf preimage
   * is `JSON.stringify({postId, parentRefs, author})`, which accepts any
   * string. Nothing about the poison is visible to PoW or to the signature.
   */
  const makeBlock = (
    body: Partial<OrderingBlock['subBlockTree']> & { utxoTxIds?: string[] } = {},
    headerOver: Partial<BlockHeader> = {},
    /**
     * Header fields substituted **after** mining and signing, for values that
     * cannot be mined at all: `isEncodableHeader` gates `verifyOrderingBlockPoW`
     * and `blockHash`, so a header holding a non-`Uint8Array` `validatorId` or a
     * non-string `stateRoot` has no PoW solution to find. That is not a gap in
     * the fixture — it is the finding, and the tests using this argument assert
     * it explicitly rather than pretending the poison rode through PoW.
     */
    postSolve: Partial<BlockHeader> = {},
  ): OrderingBlock => {
    const { utxoTxIds = [], ...tree } = body;
    const subBlockEntries = tree.subBlockEntries ?? [];
    const solved = solve({
      protocolVersion: 1,
      height: 42,
      prevBlockHash: '11'.repeat(32),
      subBlockRoot: '22'.repeat(32),
      utxoTxRoot: '33'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: kp.publicKey,
      powNonce: 0,
      powTargetBits: 4,
      createdAt: 1_700_000_000_000,
      ...headerOver,
    });
    // Signed over the mined header, then substituted — so the signature is real
    // and covers the pre-substitution header, exactly as an attacker splicing a
    // field into a signed block would leave it.
    const validatorSignature = signHeader(solved, kp);
    return {
      header: { ...solved, ...postSolve },
      subBlockTree: {
        subBlockRefs: subBlockEntries.map((e) => e.postId),
        subBlockEntries,
        pruneEntries: tree.pruneEntries ?? [],
      },
      utxoTxTree: { utxoTxIds, utxoTxs: utxoTxIds.map(() => new Uint8Array(1)), coinbaseOutputs: [] },
      validatorSignature,
    };
  };

  const entry = (over: Partial<SubBlockEntry> = {}): SubBlockEntry => ({
    postId: GOOD,
    parentRefs: [],
    author: 'cd'.repeat(32),
    ...over,
  });

  const prune = (over: Partial<PruneEntry> = {}): PruneEntry => ({
    rootPostHash: GOOD,
    subtreePostIds: [GOOD],
    subtreeMerkleRoot: new Uint8Array(32).fill(7),
    authorId: new Uint8Array(32).fill(3),
    authorSignature: new Uint8Array(64).fill(9),
    trigger: 'author',
    ...over,
  });

  /**
   * The Stage-1 ordering-block pipeline as `net/gossip.ts:94-122` runs it,
   * minus the structure step — so a `true` here means the *only* remaining
   * question is what this phase changed.
   */
  const everythingElsePasses = (block: OrderingBlock): boolean =>
    verifyProtocolVersion(block.header.protocolVersion) &&
    Number.isSafeInteger(block.header.height) &&
    verifyOrderingBlockPoW(block.header) &&
    verifyValidatorSignature(block.header, block.validatorSignature);

  const CASES: Array<{ name: string; poison: string; block: () => OrderingBlock; error: string }> = [
    {
      name: 'subBlockEntry.parentRefs — the placeholder-write path',
      poison: NON_HEX_64,
      block: () => makeBlock({ subBlockEntries: [entry({ parentRefs: [NON_HEX_64] })] }),
      error: 'parentRef must be 64 lowercase hex',
    },
    {
      name: 'subBlockEntry.postId — the placeholder row id',
      poison: NON_HEX_64,
      block: () => makeBlock({ subBlockEntries: [entry({ postId: NON_HEX_64 })] }),
      error: 'invalid postId',
    },
    {
      name: 'subBlockEntry.author — the consensus-carried authorship claim (H-3)',
      poison: NON_HEX_64,
      block: () => makeBlock({ subBlockEntries: [entry({ author: NON_HEX_64 })] }),
      error: 'invalid author',
    },
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
      name: 'subBlockEntry.parentRefs in uppercase hex',
      poison: UPPER_HEX_64,
      block: () => makeBlock({ subBlockEntries: [entry({ parentRefs: [UPPER_HEX_64] })] }),
      error: 'parentRef must be 64 lowercase hex',
    },
  ];

  /**
   * The header half of Phase 1e's demonstration, **moved here by Phase 1f**.
   *
   * These four cases used to sit in `CASES` above, and each asserted that a
   * header carrying the poison *still cleared PoW and the validator signature* —
   * which was true, because `isEncodableHeader` was the only header gate those
   * two functions had and it checked `typeof === 'string'` and nothing more. 1f
   * replaces that gate with the full domain, so the claim inverts: the poison no
   * longer mines at all, and the fixture cannot even be built with `headerOver`
   * (`solve()` throws `unsolvable fixture`). The poison is therefore spliced in
   * **after** mining and signing, exactly as an attacker splicing a field into a
   * signed block would leave it.
   *
   * Recorded rather than deleted because the movement *is* the phase: 1f is not
   * only a `createdAt` pin and a fork-resolution guard — it also tightens
   * `verifyOrderingBlockPoW` and `verifyValidatorSignature` on every string
   * header field, and this is the measurement of that.
   */
  const HEADER_CASES: Array<{ name: string; poison: string; over: Partial<BlockHeader>; error: string }> = [
    { name: 'header.prevBlockHash', poison: NON_HEX_64, over: { prevBlockHash: NON_HEX_64 }, error: 'invalid prevBlockHash' },
    { name: 'header.subBlockRoot', poison: NON_HEX_64, over: { subBlockRoot: NON_HEX_64 }, error: 'missing subBlockRoot' },
    { name: 'header.utxoTxRoot', poison: NON_HEX_64, over: { utxoTxRoot: NON_HEX_64 }, error: 'missing utxoTxRoot' },
    { name: 'header.prevBlockHash in uppercase hex', poison: UPPER_HEX_64, over: { prevBlockHash: UPPER_HEX_64 }, error: 'invalid prevBlockHash' },
  ];

  it('has a control block that this function accepts', () => {
    const control = makeBlock({
      subBlockEntries: [entry({ parentRefs: [GOOD] })],
      pruneEntries: [prune()],
      utxoTxIds: [GOOD],
    });
    expect(verifyOrderingBlockStructure(control)).toEqual({ valid: true });
    expect(everythingElsePasses(control)).toBe(true);
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
        // And by the encoder guard 1f replaced, which is why it used to mine.
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
        expect(blockHashChecked(block.header)).toBeNull();
        expect(computePowHashChecked(block.header)).toBeNull();
        expect(verifyOrderingBlockPoW(block.header)).toBe(false);
        expect(verifyValidatorSignature(block.header, block.validatorSignature)).toBe(false);
        expect(verifyHeaderFieldDomains(block.header).valid).toBe(false);
      });

      it('and the unguarded pair still encodes it — the expand step changed nothing there', () => {
        // `blockHash` / `computePowHash` are untouched in 1f-1 and `node` / `net`
        // are still on them. If this ever fails, the expand step has leaked.
        const block = makeBlock({}, {}, c.over);
        expect(typeof blockHash(block.header)).toBe('string');
        expect(blockHash(block.header)).toHaveLength(64);
      });
    });
  }

  // -------------------------------------------------------------------------
  // stateRoot — 66 characters, and it was not checked at all
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

    // Every value here is a *string*, so `isEncodableHeader` let it through and
    // the header mined and signed with the poison inside its own PoW preimage —
    // which is what these tests asserted at Phase 1e (`verifyOrderingBlockPoW`
    // and `verifyValidatorSignature` both `true`, structure the only rejector).
    //
    // **Phase 1f inverts that half.** `isEncodableHeader` is gone and both
    // functions now establish the full header domain, so none of these mines any
    // more and the fixture has to splice the poison in after signing. The
    // `preChangeEncoderRule` assertion is what keeps "it used to ride through
    // PoW" a measurement; the label assertion is what proves 1e's diagnosis did
    // not move when its check was delegated.
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
        expect(blockHashChecked(block.header)).toBeNull();
        const result = verifyOrderingBlockStructure(block);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('invalid stateRoot');
      });
    }

    it('a non-string stateRoot was already unminable — the pin states the verdict, it does not change it', () => {
      // `isEncodableHeader` requires `typeof stateRoot === 'string'`, so this
      // header has no PoW solution and `verifyOrderingBlockPoW` rejects it
      // today. Worth pinning as a separate claim: it is the one stateRoot case
      // that is NOT a behavioural change, and folding it in with the five above
      // would overstate what this phase rejects.
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
        // Substituted after mining: `isEncodableHeader` already demands a byte
        // view, so this header has no PoW solution and never had one. Unlike
        // the hex cases, this is not new rejection — it moves the verdict from
        // "PoW failed" to "the structure gate names the field", which is where
        // the contract says structure validation is supposed to answer.
        const block = makeBlock({}, {}, { validatorId: bad as Uint8Array });
        expect(verifyOrderingBlockPoW(block.header)).toBe(false);
        const result = verifyOrderingBlockStructure(block);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('invalid validatorId');
      });

      it(`rejects a coinbase owner that is ${label(bad)}`, () => {
        const block = makeBlock();
        block.utxoTxTree.coinbaseOutputs = [
          { owner: bad as Uint8Array, value: 1n, lockedUntilBlock: 42, isTreasury: false },
        ];
        const result = verifyOrderingBlockStructure(block);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('invalid owner');
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
    /** N distinct well-formed refs, so the count rule is the only thing under test. */
    const refs = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));

    it('accepts exactly MAX_PARENT_REFS refs', () => {
      const block = makeBlock({ subBlockEntries: [entry({ parentRefs: refs(MAX_PARENT_REFS) })] });
      expect(verifyOrderingBlockStructure(block)).toEqual({ valid: true });
    });

    it('rejects one more than MAX_PARENT_REFS', () => {
      const block = makeBlock({
        subBlockEntries: [entry({ parentRefs: refs(MAX_PARENT_REFS + 1) })],
      });
      const result = verifyOrderingBlockStructure(block);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid parentRefs');
    });

    // The point of the two above: they are written against the constant, so
    // when `MAX_PARENT_REFS` moves (Phase 2 takes it to 1) the boundary moves
    // with it and no edit is needed here. A literal `8` in the source would
    // leave the post path capped at the new value while this path — the one
    // that feeds `insertPostPlaceholder` — kept accepting the old one, and
    // this test would not notice.
    it('tracks the constant rather than the number 8', () => {
      const atBound = refs(MAX_PARENT_REFS);
      const overBound = refs(MAX_PARENT_REFS + 1);
      expect(atBound).toHaveLength(MAX_PARENT_REFS);
      expect(
        verifyOrderingBlockStructure(makeBlock({ subBlockEntries: [entry({ parentRefs: atBound })] }))
          .valid,
      ).toBe(true);
      expect(
        verifyOrderingBlockStructure(
          makeBlock({ subBlockEntries: [entry({ parentRefs: overBound })] }),
        ).valid,
      ).toBe(false);
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
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
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
          { block: put({}, { subBlockRoot: bad as string }), conforms: isHex(bad, 64) },
          { block: put({}, { utxoTxRoot: bad as string }), conforms: isHex(bad, 64) },
          { block: put({}, { validatorId: bad as Uint8Array }), conforms: isBytesOf(bad, 32) },
          { block: put({ validatorSignature: bad as Uint8Array }), conforms: isBytesOf(bad, 64) },
          {
            block: put({
              utxoTxTree: { utxoTxIds: [bad as string], utxoTxs: [new Uint8Array(1)], coinbaseOutputs: [] },
            }),
            conforms: isHex(bad, 64),
          },
          {
            block: put({
              subBlockTree: {
                subBlockRefs: [GOOD],
                subBlockEntries: [{ postId: bad, parentRefs: [bad], author: bad } as unknown as SubBlockEntry],
                pruneEntries: [],
              },
            }),
            conforms: isHex(bad, 64),
          },
          {
            block: put({
              subBlockTree: {
                subBlockRefs: [],
                subBlockEntries: [],
                pruneEntries: [
                  { ...prune(), rootPostHash: bad, subtreePostIds: [bad] } as unknown as PruneEntry,
                ],
              },
            }),
            conforms: isHex(bad, 64),
          },
          {
            block: put({
              utxoTxTree: {
                utxoTxIds: [],
                utxoTxs: [],
                coinbaseOutputs: [
                  { owner: bad, value: 1n, lockedUntilBlock: 42, isTreasury: false } as unknown as CoinbaseOutput,
                ],
              },
            }),
            conforms: isBytesOf(bad, 32),
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
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32).fill(1),
      powNonce: 0,
      powTargetBits: 12,
      createdAt: Date.now(),
    },
    subBlockTree: {
      subBlockRefs: [],
      subBlockEntries: [],
      pruneEntries: [],
    },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
      coinbaseOutputs: [],
    },
    validatorSignature: new Uint8Array(64),
  });

  // `'0000'` here until Phase 1f: a four-character `prevBlockHash` no producer
  // could ever emit (a real one is `blockHash`'s 64 lowercase hex, always). It
  // survived because this function's only header gate was `isEncodableHeader`,
  // which checked `typeof === 'string'`. Under the header domain the *previous*
  // block is now rejected outright, so all three tests below would have gone
  // green-but-vacuous — "rejects mismatched prevBlockHash" passing on a
  // malformed-`prev` rejection that never reached the comparison. The genuine
  // hash is what each test needs, so `GENESIS_PREV` is well-formed and the
  // mismatch case uses a well-formed *wrong* hash.
  const GENESIS_PREV = '00'.repeat(32);
  const WRONG_HASH = 'ff'.repeat(32);

  it('accepts a valid chain link', () => {
    const prev = makeBlock(1, GENESIS_PREV);
    const prevHash = blockHash(prev.header);
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
    expect(blockHashChecked(prev.header)).not.toBe(WRONG_HASH);
    expect(verifyBlockChainLink(next, prev)).toBe(false);
  });

  it('rejects non-sequential height', () => {
    const prev = makeBlock(1, GENESIS_PREV);
    const prevHash = blockHash(prev.header);
    const next = makeBlock(3, prevHash);
    // Same guard: the hash link is correct, so only the height can be rejecting.
    expect(next.header.prevBlockHash).toBe(blockHashChecked(prev.header));
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

describe('integer guards on nonce and targetBits (M-6)', () => {
  const input = Buffer.from('m-6 fixture');
  let goodNonce = 0;
  while (goodNonce < 100000 && !verifyPoW(input, goodNonce, 4)) goodNonce++;

  it('has a valid baseline solution to degrade from', () => {
    expect(verifyPoW(input, goodNonce, 4)).toBe(true);
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

  for (const [name, bad] of badNumbers) {
    it(`rejects a ${name} nonce`, () => {
      expect(verifyPoW(input, bad, 4)).toBe(false);
    });

    it(`rejects a ${name} targetBits`, () => {
      expect(verifyPoW(input, goodNonce, bad)).toBe(false);
    });
  }

  it('rejects a targetBits wider than the 256-bit digest', () => {
    // The old loop indexed past the end of the digest, where `undefined & mask`
    // coerces to 0. That only mis-accepted an all-zero digest (unreachable in
    // practice), unlike the NaN/Infinity cases above which accepted any hash.
    expect(verifyPoW(input, goodNonce, 257)).toBe(false);
    expect(verifyPoW(input, goodNonce, 1_000_000)).toBe(false);
  });

  it('still evaluates a satisfiable target at full digest width', () => {
    expect(verifyPoW(input, goodNonce, 256)).toBe(false);
    expect(verifyPoW(input, goodNonce, 0)).toBe(true);
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

  const makeGoodPost = (): Post => {
    const post: Post = {
      content: 'hello',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: 1_700_000_000_000,
      signature: new Uint8Array(64),
    };
    const sig = sign(
      null,
      signingHash(post),
      createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' }),
    );
    post.signature = new Uint8Array(sig);
    return post;
  };

  const makeHeader = (over: Partial<BlockHeader> = {}): BlockHeader => ({
    protocolVersion: 1,
    height: 1,
    prevBlockHash: '0'.repeat(64),
    subBlockRoot: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(1),
    powNonce: 0,
    powTargetBits: 4,
    createdAt: 1_700_000_000_000,
    ...over,
  });

  const goodPost = makeGoodPost();
  const goodInput = Buffer.from('pow input');
  const goodBlock: OrderingBlock = {
    header: makeHeader(),
    subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
    utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
    validatorSignature: new Uint8Array(64),
  };

  // --- the fuzz sweep: every argument position of every exported verify fn ---

  it('verifyPoW survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyPoW(bad as any, 0, 4)).not.toThrow();
      expect(() => verifyPoW(goodInput, bad as any, 4)).not.toThrow();
      expect(() => verifyPoW(goodInput, 0, bad as any)).not.toThrow();
      expect(() => verifyPoW(bad as any, bad as any, bad as any)).not.toThrow();
    }
  });

  it('verifyPostSignature survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyPostSignature(bad as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature(goodPost, bad as any)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, content: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, author: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, parentRefs: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, challenge: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, signature: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, protocolVersion: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, timestamp: bad } as any, kp.publicKey)).not.toThrow();
    }
  });

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

  it('verifySubBlockStructure survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifySubBlockStructure(bad as any)).not.toThrow();
    }
  });

  it('verifyTxStructure survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyTxStructure(bad as any)).not.toThrow();
      expect(() => verifyTxStructure({ inputs: bad, outputs: bad, protocolVersion: 1 } as any)).not.toThrow();
    }
  });

  it('verifyOrderingBlockStructure survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyOrderingBlockStructure(bad as any)).not.toThrow();
      expect(() => verifyOrderingBlockStructure({ ...goodBlock, header: bad } as any)).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          subBlockTree: { subBlockRefs: [bad], subBlockEntries: [bad], pruneEntries: [bad] },
        } as any),
      ).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: bad },
        } as any),
      ).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          subBlockTree: {
            subBlockRefs: [],
            subBlockEntries: [],
            pruneEntries: [
              {
                rootPostHash: bad,
                subtreePostIds: bad,
                subtreeMerkleRoot: bad,
                authorId: bad,
                authorSignature: bad,
                trigger: bad,
              },
            ],
          },
        } as any),
      ).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          utxoTxTree: { utxoTxIds: [], utxoTxs: [], likeBoxIds: [], coinbaseOutputs: [bad] },
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
    expect(verifyPostSignature(goodPost, new Uint8Array(31))).toBe(false);
    expect(verifyPostSignature(goodPost, new Uint8Array(33))).toBe(false);
    expect(verifyPostSignature(goodPost, new Uint8Array(0))).toBe(false);
    expect(verifyPostSignature(goodPost, 'not-a-key' as any)).toBe(false);
    // 32 bytes that are not a valid curve point must still reject cleanly.
    expect(verifyPostSignature(goodPost, new Uint8Array(32).fill(0xff))).toBe(false);
  });

  it('rejects a post whose shape would throw inside signingHash', () => {
    expect(verifyPostSignature({ ...goodPost, parentRefs: 'nope' } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, parentRefs: [Symbol('x')] } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, challenge: undefined } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, author: undefined } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, author: 42 } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, content: 42 } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, signature: 'abc' } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature(null as any, kp.publicKey)).toBe(false);
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

  it('rejects a malformed ordering block header instead of throwing in CBOR', () => {
    expect(verifyOrderingBlockPoW(null as any)).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ prevBlockHash: Symbol('s') as any }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ validatorId: undefined as any }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powNonce: NaN }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powNonce: -1 }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powNonce: 1.5 }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powTargetBits: NaN }))).toBe(false);
    // Wider than the digest — the old loop accepted every hash here.
    expect(verifyOrderingBlockPoW(makeHeader({ powTargetBits: 1_000_000 }))).toBe(false);
    expect(verifyBlockChainLink(null as any, goodBlock)).toBe(false);
    expect(verifyBlockChainLink(goodBlock, null as any)).toBe(false);
  });

  // --- the happy path is unchanged ---

  it('leaves the happy path intact', () => {
    expect(verifyPostSignature(goodPost, kp.publicKey)).toBe(true);
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
// Numeric guard on the signable-post fields (M-6 follow-up to the P1 encoder)
// ---------------------------------------------------------------------------

describe('integer guards on protocolVersion and timestamp (M-6)', () => {
  const kp = generateKeyPair();
  const priv = createPrivateKey({
    key: Buffer.from(kp.secretKey),
    format: 'der',
    type: 'pkcs8',
  });

  /** A correctly signed post — the signature covers the *stated* fields. */
  const signedPost = (over: Partial<Post> = {}): Post => {
    const post: Post = {
      content: 'guard me',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32).fill(7),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: 1_700_000_000_000,
      signature: new Uint8Array(64),
      ...over,
    };
    post.signature = new Uint8Array(sign(null, signingHash(post), priv));
    return post;
  };

  const OUT_OF_DOMAIN = [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['negative', -1],
    ['fractional', 1.5],
    ['above the safe range', Number.MAX_SAFE_INTEGER + 2],
    ['not a number', '1700000000000'],
  ] as const;

  it.each(OUT_OF_DOMAIN)('rejects a %s timestamp without throwing', (_label, value) => {
    // Signed over the malformed field, so only the guard can reject it.
    const post = signedPost({ timestamp: value as number });
    let result: boolean | undefined;
    expect(() => {
      result = verifyPostSignature(post, kp.publicKey);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it.each(OUT_OF_DOMAIN)('rejects a %s protocolVersion without throwing', (_label, value) => {
    const post = signedPost({ protocolVersion: value as number });
    let result: boolean | undefined;
    expect(() => {
      result = verifyPostSignature(post, kp.publicKey);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('keeps the encoder sentinel out of reach: NaN and -1 no longer share a verdict path', () => {
    // Both encode to the same all-ones sentinel bytes in `signingHash`, so
    // before the guard a signature over one validated the other. Both are now
    // rejected outright.
    const withNaN = signedPost({ timestamp: NaN });
    const withNegative = { ...withNaN, timestamp: -1 };
    expect(signingHash(withNaN)).toEqual(signingHash(withNegative as Post));
    expect(verifyPostSignature(withNaN, kp.publicKey)).toBe(false);
    expect(verifyPostSignature(withNegative as Post, kp.publicKey)).toBe(false);
  });

  it('accepts a well-formed post (guard does not regress the happy path)', () => {
    expect(verifyPostSignature(signedPost(), kp.publicKey)).toBe(true);
    // Boundary values inside the domain still verify.
    expect(verifyPostSignature(signedPost({ timestamp: 0 }), kp.publicKey)).toBe(true);
    expect(
      verifyPostSignature(signedPost({ timestamp: Number.MAX_SAFE_INTEGER }), kp.publicKey),
    ).toBe(true);
    expect(verifyPostSignature(signedPost({ protocolVersion: 0 }), kp.publicKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixed-width field domains — the b32 precondition (spec §2.5 / §6.1)
// ---------------------------------------------------------------------------
//
// `author` and `challenge` become `b32`, `parentRefs` becomes `arr(refs, b32)`.
// A fixed-width writer's wire domain IS its encodable domain, so it has no
// unreachable sentinel and must throw rather than pad or truncate — padding
// would map a malformed id onto a well-formed one's encoding. The domain has to
// be established before that writer is reachable.
//
// The pin is only meaningful if it fires, and proving that it fires got harder
// in Phase 2, not easier. Before the migration each case was *signed over its
// own malformed fields*, so raw `crypto.verify` could show the signature was
// genuine and the domain pin was therefore the only thing rejecting the post.
// That evidence no longer exists: a post outside the domain has no encoding, so
// `signingHash` cannot be reached and such a post **cannot be signed at all**.
// It is not weaker evidence obtained differently — the state it described is
// unreachable now.
//
// What replaces it, per case:
//
//  1. **Build well-formed, sign, then poison.** The honest twin is kept and
//     asserted `{ valid: true }`, so the two objects differ in exactly the one
//     field under test and "the prior checks passed" is a measurement rather
//     than a hope. `signatureIsGenuine` still runs — on the twin — because a
//     silently broken builder would make every "rejects X" case below pass for
//     the wrong reason.
//  2. **Assert the error label, never just `valid: false`.** `verifyPostFieldDomains`
//     returns at its first failure, so the label is positional evidence:
//     `'Post challenge must be exactly 32 bytes'` can only be reached with
//     content, author and every parentRef already in domain.
//  3. **Assert the writer's own throw, with its width or char count in it.**
//     That is what ties the rejection to the reason the rule exists — this post
//     has no encoding — and it names the specific malformed value that reached
//     the writer, so a case cannot quietly start testing a different one.
//
// `verifyPostSignature` returning `false` rather than throwing is the third
// leg: it proves the domain gate runs *before* `signingHash`, since reaching
// `signingHash` on these fixtures would panic.

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
   * Every field passed here must be **in domain**: `signingHash` encodes the
   * post, and a 31-byte author or a non-hex ref has no encoding, so this helper
   * throws rather than producing the fixture. That is the whole reason
   * `signedThenPoisoned` exists below.
   */
  const signedPost = (over: Partial<Post> = {}): Post => {
    const post: Post = {
      content: 'pin the domain',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32).fill(9),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: 1_700_000_000_000,
      signature: new Uint8Array(64),
      ...over,
    };
    post.signature = new Uint8Array(sign(null, signingHash(post), priv));
    return post;
  };

  const subBlockOf = (post: Post): SubBlock => ({
    subBlockId: computePostId(post),
    post,
    producerId: new Uint8Array(32).fill(3),
    protocolVersion: 1,
  });

  /**
   * The signature really does cover this post. Only callable on an in-domain
   * post now — `signingHash` is the same encoder that refuses the poisoned one
   * — so its job has changed from "prove the malformed post is otherwise
   * flawless" to "prove the builder these fixtures are cut from is sound".
   */
  const signatureIsGenuine = (post: Post): boolean =>
    cryptoVerify(null, signingHash(post), pubKeyObj, Buffer.from(post.signature));

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
   * The signature is genuine over the *pre-poison* bytes and does not cover the
   * poisoned field. These tests want that — they assert the **domain** rule
   * rejects, and a signature covering a 31-byte author is not a thing that can
   * exist.
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
    // `verifyParentRefsCount` and the old `typeof ref === 'string'` guard, and
    // before this phase `postFieldBytes` length-prefixed the UTF-8 of the text
    // and encoded it faithfully. Under `arr(refs, b32)` it has no encoding —
    // which is why the poison now goes on *after* the signature.
    const { honest, post } = signedThenPoisoned({ parentRefs: ['z'.repeat(64)] });
    const sb = { ...subBlockOf(honest), post };

    // The builder is sound: the twin this post is cut from is signed, genuine
    // and in domain, so nothing below is passing on a broken fixture.
    expect(signatureIsGenuine(honest)).toBe(true);
    expect(verifyPostFieldDomains(honest)).toEqual({ valid: true });

    // Everything Stage 1 checks besides the domain still says yes:
    expect(verifyContentLimits(post.content)).toEqual({ valid: true });
    expect(verifyContentCharacters(post.content)).toEqual({ valid: true });
    expect(verifyParentRefsCount(post.parentRefs)).toEqual({ valid: true });
    expect(verifyProtocolVersion(post.protocolVersion)).toBe(true);
    // …and the encoder refuses it outright, naming the ref it choked on. This
    // is the reason the pin must run first: there is no preimage to check
    // anything else against.
    expect(() => postPowPreimage(post)).toThrow(
      'writeHexNOrThrow: expected 64 lowercase hex chars, got 64 chars',
    );

    // The pin is the only thing that rejects it — at all three entry points.
    expect(verifyPostFieldDomains(post)).toEqual({
      valid: false,
      error: 'Post parentRef must be 64 lowercase hex characters',
    });
    expect(verifySubBlockStructure(sb)).toEqual({
      valid: false,
      error: 'Post parentRef must be 64 lowercase hex characters',
    });
    // `false`, and — the load-bearing half — *without throwing*. Reaching
    // `signingHash` on this post would panic, so returning a verdict at all
    // proves the domain gate ran ahead of the crypto.
    expect(() => verifyPostSignature(post, kp.publicKey)).not.toThrow();
    expect(verifyPostSignature(post, kp.publicKey)).toBe(false);
    expect(verifyPostSignature(honest, kp.publicKey)).toBe(true);
  });

  it('TEETH: `verifySubBlockStructure` rejected nothing about the post before — now it gates gossip', () => {
    // This sub-block satisfies every check the function made prior to this
    // phase: post present, subBlockId present, protocolVersion a number,
    // producerId present. It is `net/gossip.ts:201`, which gates `:222`.
    const { honest, post } = signedThenPoisoned({ author: new Uint8Array(31).fill(4) });
    const sb = { ...subBlockOf(honest), post };
    expect(sb.post).toBeTruthy();
    expect(sb.subBlockId).toBeTruthy();
    expect(typeof sb.protocolVersion).toBe('number');
    expect(sb.producerId).toBeTruthy();
    // Those four checks are exactly what the honest twin also passes, and the
    // author width is the only difference between the two sub-blocks — so the
    // verdict below can only be the post-domain leg.
    expect(verifySubBlockStructure({ ...sb, post: honest })).toEqual({ valid: true });
    expect(verifySubBlockStructure(sb)).toEqual({
      valid: false,
      error: 'Post author must be exactly 32 bytes',
    });
    // It reaches that verdict without encoding the post — which it could not
    // do. This is the relay path, inside a topic validator whose catch arm
    // bans the *forwarding* peer, so a throw here is the wrong penalty class.
    expect(() => postPowPreimage(post)).toThrow('writeBytesNOrThrow: expected 32 bytes, got 31');
    expect(() => verifySubBlockStructure(sb)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // author / challenge widths
  // -------------------------------------------------------------------------

  it.each([0, 1, 31, 33, 64])('rejects a %i-byte author', (n) => {
    const { honest, post } = signedThenPoisoned({ author: new Uint8Array(n).fill(4) });
    // The twin differs in the author width and nothing else, and it is signed,
    // genuine and accepted — so the verdict below is about the width.
    expect(signatureIsGenuine(honest)).toBe(true);
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
    expect(() => postPowPreimage(post)).toThrow(`writeBytesNOrThrow: expected 32 bytes, got ${n}`);
  });

  it.each([0, 1, 31, 33, 64])('rejects a %i-byte challenge', (n) => {
    const { honest, post } = signedThenPoisoned({ challenge: new Uint8Array(n).fill(5) });
    expect(signatureIsGenuine(honest)).toBe(true);
    expect(verifyPostFieldDomains(honest)).toEqual({ valid: true });
    // `challenge` is the fourth rule, so reaching this label is positive
    // evidence that content, author *and* every parentRef were in domain —
    // `verifyPostFieldDomains` returns at its first failure.
    expect(verifyPostFieldDomains(post)).toEqual({
      valid: false,
      error: 'Post challenge must be exactly 32 bytes',
    });
    // The writer message is width-only and does not name the field, but the
    // author here is the honest 32-byte key, so `challenge` is the only `b32`
    // in this post that can be `n` bytes wide.
    expect(() => postPowPreimage(post)).toThrow(`writeBytesNOrThrow: expected 32 bytes, got ${n}`);
  });

  it('the widths it rejects encoded faithfully before this phase, and have no encoding now — a domain pin, not a collision fix', () => {
    // BOTH halves, because the pair is the claim.
    //
    // BEFORE: `author` went in length-prefixed, so a 31-byte and a 32-byte
    // author produced *different* preimages. Nothing was colliding, and that is
    // precisely why no existing check caught the narrowing — the field was
    // encoded faithfully at every width, and it acquired a domain rather than
    // losing an ambiguity. That assertion cannot be executed any more: the
    // encoder it described is deleted, and re-implementing it here would be a
    // mirror of a dead dialect, which is the drift class this format exists to
    // remove. It is recorded here and pinned by its consequences below.
    //
    // AFTER: `b32` is fixed-width, so 31 bytes has no encoding at all.
    //
    // If this had been a *collision* fix, the honest 32-byte case would have
    // had to move too — a colliding pair is repaired by changing what both
    // members encode to. It does not move, and that asymmetry is the evidence.
    const { honest: full, post: short } = signedThenPoisoned({
      author: new Uint8Array(31).fill(4),
    });

    // Half one — the width that used to encode faithfully now has no encoding,
    // and the writer says which width it refused.
    expect(() => postPowPreimage(short)).toThrow('writeBytesNOrThrow: expected 32 bytes, got 31');

    // Half two — the honest width is untouched. It still encodes, and it still
    // encodes *faithfully*: the 32 author bytes cross the preimage unchanged,
    // at the offset the layout fixes them at (field 2, straight after
    // `lpUtf8(content)`; the content is 14 bytes so its VLQ length prefix is a
    // single byte).
    const bytes = postPowPreimage(full);
    const authorAt = 1 + Buffer.byteLength(full.content, 'utf8');
    expect(Buffer.from(bytes.subarray(authorAt, authorAt + 32))).toEqual(Buffer.from(full.author));

    expect(verifyPostFieldDomains(short).valid).toBe(false);
    expect(verifyPostFieldDomains(full).valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // parentRefs: 64 LOWERCASE hex
  // -------------------------------------------------------------------------

  it('rejects an uppercase-hex parentRef — hex→bytes must stay injective', () => {
    // 'AB…' and 'ab…' decode to the same 32 bytes, so accepting both would let
    // two distinct in-memory posts share one preimage. That is the malleability
    // the M-1 encoding exists to close, arriving through the codec boundary —
    // and under `b32` the upper spelling has no encoding at all, so the
    // collision is removed rather than merely rejected. The domain check is
    // what keeps that unencodable state from ever reaching the writer.
    const lower = 'ab'.repeat(32);
    const upper = lower.toUpperCase();
    expect(Buffer.from(upper, 'hex').equals(Buffer.from(lower, 'hex'))).toBe(true);

    // Lowercase is in domain, so it goes through the honest builder and is
    // signable — the control that makes the rejection below about the case.
    const good = signedPost({ parentRefs: [lower] });
    expect(verifyPostFieldDomains(good)).toEqual({ valid: true });
    expect(signatureIsGenuine(good)).toBe(true);

    const { post } = signedThenPoisoned({ parentRefs: [upper] });
    expect(verifyPostFieldDomains(post)).toEqual({
      valid: false,
      error: 'Post parentRef must be 64 lowercase hex characters',
    });
    // 64 characters, and still refused — so it is the alphabet, not the width.
    expect(() => postPowPreimage(post)).toThrow(
      'writeHexNOrThrow: expected 64 lowercase hex chars, got 64 chars',
    );
  });

  // The third column is the writer's own message, which carries the *character
  // count* it saw. That is what separates the width cases from the alphabet
  // cases here: `verifyPostFieldDomains` gives all six the same label, so
  // without it a case could silently start failing for the wrong reason —
  // '65 hex chars' passing because the ref went missing, say — and nothing
  // would show.
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
    expect(() => postPowPreimage(post)).toThrow(
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
    expect(() => postPowPreimage(post)).toThrow(
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
    const parent = signedPost({ content: 'parent' });
    const parentId = computePostId(parent);
    expect(parentId).toMatch(/^[0-9a-f]{64}$/);

    const child = signedPost({ content: 'child', parentRefs: [parentId] });
    expect(verifyPostFieldDomains(child)).toEqual({ valid: true });
    expect(verifyPostSignature(child, kp.publicKey)).toBe(true);
    expect(verifySubBlockStructure(subBlockOf(child))).toEqual({ valid: true });
  });

  it('accepts the full MAX_PARENT_REFS-wide honest case', () => {
    // Driven by the constant, not by `length: 8` — the shape `refs(n)` on the
    // ordering-block path already uses. The literal made the test name false
    // the moment the constant moved, and it is the name that carries the
    // property: whatever the bound is, a post sitting exactly on it is accepted
    // by all three checks at once.
    //
    // Honest about what this now proves: at MAX_PARENT_REFS = 1 it is a
    // one-ref post, so it no longer discriminates "many refs" from "one ref"
    // and largely overlaps the well-formed case above. What survives is the
    // agreement of the three checks at the bound, plus a tripwire that
    // self-adjusts if the bound ever moves back up.
    const refs = Array.from({ length: MAX_PARENT_REFS }, (_, i) =>
      computePostId(signedPost({ content: `parent ${i}` })),
    );
    expect(refs).toHaveLength(MAX_PARENT_REFS);
    expect(new Set(refs).size).toBe(MAX_PARENT_REFS);
    const post = signedPost({ parentRefs: refs });
    expect(verifyParentRefsCount(post.parentRefs)).toEqual({ valid: true });
    expect(verifyPostFieldDomains(post)).toEqual({ valid: true });
    expect(verifyPostSignature(post, kp.publicKey)).toBe(true);
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
      expect(() => verifyPostFieldDomains({ ...good, challenge: bad } as unknown as Post)).not.toThrow();
      expect(() => verifyPostFieldDomains({ ...good, parentRefs: bad } as unknown as Post)).not.toThrow();
      expect(() => verifyPostFieldDomains({ ...good, parentRefs: [bad] } as unknown as Post)).not.toThrow();
    }
  });

  it('verifySubBlockStructure stays total now that it reaches into the post', () => {
    for (const bad of MALFORMED) {
      expect(() => verifySubBlockStructure({ ...subBlockOf(signedPost()), post: bad } as unknown as SubBlock)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 1f — the header encoders establish their own domain (spec §6.2)
//
// Two defects, and only one of them is a panic.
//
// The first is an ungated door into `encodeHeader`. `net/sync.ts:103` returns
// `decode(response) as BlockHeader[]` — a raw cbor-x decode and a TypeScript
// cast, with no runtime validation of any kind, not even `Array.isArray` — and
// `node/index.ts:240` hands those bare headers to `findForkPoint`, which calls
// `blockHash` at `fork-resolution.ts:65`. `blockHash` checks nothing.
// `verifyOrderingBlockStructure` cannot cover that path: it takes an
// `OrderingBlock` and the path carries headers.
//
// The second does not throw, which is why a search for panics could not see it.
// `createdAt` had no domain check anywhere in the repo, and its layout writer is
// `vlqU`, which is total *by sentinel* — so `NaN`, `-1`, `1.5` and `2^60` would
// all encode to `VLQ_SENTINEL`, giving distinct headers one `blockHash`, one PoW
// preimage and one signature verdict. cbor-x distinguishes those values today,
// which is the half this file can measure: the malleability is something the
// migration would *introduce*, not something already present.
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
    subBlockRoot: '22'.repeat(32),
    utxoTxRoot: '33'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: kp.publicKey,
    powNonce: 0,
    powTargetBits: 4,
    createdAt: 1_700_000_000_000,
    ...over,
  });

  // -------------------------------------------------------------------------
  // The rules Phase 1f replaced, transcribed from the code it deleted.
  //
  // Keeping them here is what makes "accepted today" a measurement rather than
  // a memory — the 1c idiom. All three ran on the *pre-change* implementation
  // and are reproduced verbatim, over the unguarded `blockHash` /
  // `computePowHash` this phase deliberately leaves in place.
  // -------------------------------------------------------------------------

  /** `isEncodableHeader`'s rule for `createdAt`: `typeof h.createdAt !== 'number'`. */
  const preChangeCreatedAtRule = (v: unknown): boolean => typeof v === 'number';

  const leadingZeroBits = (hash: Uint8Array, bits: number): boolean => {
    if (bits > hash.length * 8) return false;
    for (let i = 0; i < bits; i++) {
      if ((hash[Math.floor(i / 8)]! & (1 << (7 - (i % 8)))) !== 0) return false;
    }
    return true;
  };

  /** `verifyOrderingBlockPoW` exactly as it stood before Phase 1f. */
  const preChangePoW = (h: BlockHeader): boolean => {
    if (!Number.isSafeInteger(h.powNonce) || h.powNonce < 0) return false;
    if (!Number.isSafeInteger(h.powTargetBits) || h.powTargetBits < 0) return false;
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(h.powNonce));
    const hash = createHash('blake2b512')
      .update(computePowHash(h))
      .update(nonceBuf)
      .digest()
      .subarray(0, 32);
    return leadingZeroBits(hash, h.powTargetBits);
  };

  /** Raw `crypto.verify` over the unguarded `blockHash` — a rejection can never be a broken fixture. */
  const signatureIsGenuine = (h: BlockHeader, sig: Uint8Array): boolean =>
    cryptoVerify(
      null,
      Buffer.from(blockHash(h), 'hex'),
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

  const signHeader = (h: BlockHeader): Uint8Array =>
    new Uint8Array(sign(null, Buffer.from(blockHash(h), 'hex'), privKeyOf(kp)));

  const blockOf = (h: BlockHeader, sig: Uint8Array): OrderingBlock => ({
    header: h,
    subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
    utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
    validatorSignature: sig,
  });

  // -------------------------------------------------------------------------
  // The domain, field by field
  // -------------------------------------------------------------------------

  it('accepts the header the honest producer emits', () => {
    expect(verifyHeaderFieldDomains(header())).toEqual({ valid: true });
    // `block-creator.ts:411-422` builds exactly these shapes: roots from the
    // Merkle/AVL computations, `validatorId` a 32-byte key, `createdAt` a
    // `Date.now()`. Nothing in the honest production path leaves the domain.
    expect(verifyHeaderFieldDomains(header({ createdAt: Date.now() }))).toEqual({ valid: true });
    expect(verifyHeaderFieldDomains(header({ stateRoot: EMPTY_STATE_ROOT }))).toEqual({ valid: true });
    expect(verifyHeaderFieldDomains(header({ height: 1, powNonce: 0, powTargetBits: 0 }))).toEqual({ valid: true });
    expect(verifyHeaderFieldDomains(header({ height: Number.MAX_SAFE_INTEGER }))).toEqual({ valid: true });
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
  const HEX32_FIELDS = ['prevBlockHash', 'subBlockRoot', 'utxoTxRoot'] as const;

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
    expect(reasons.size).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Demonstration 1 — the throw case
  //
  // A header accepted today whose `blockHashChecked` must be `null` after,
  // built to pass everything else so the new check is provably the only thing
  // rejecting it.
  // -------------------------------------------------------------------------

  describe('the throw case: a bare header on the fork-resolution path', () => {
    // 64 hex where 66 belong — a 32-byte digest in the 33-byte `stateRoot`.
    // Under Phase 3 this reaches `b33`, a fixed-width writer with no sentinel to
    // fall back on, so it throws; the throw lands in `node/index.ts:298`'s broad
    // catch and the node silently declines to reorg.
    const POISON = '00'.repeat(32);
    const poisoned = solvePreChange(header({ stateRoot: POISON }));
    const sig = signHeader(poisoned);

    it('is accepted by every rule this phase replaced', () => {
      // `isEncodableHeader` asked `typeof stateRoot === 'string'` and no more.
      expect(typeof POISON).toBe('string');
      expect(preChangePoW(poisoned)).toBe(true);
      expect(signatureIsGenuine(poisoned, sig)).toBe(true);
    });

    it('reaches the encoder today with nothing in front of it, and encodes', () => {
      // This is the whole defect: `findForkPoint` calls `blockHash(header)` on a
      // bare peer header that passed no check whatsoever. Today the encoder is
      // happy, so nothing anywhere objects.
      expect(() => blockHash(poisoned)).not.toThrow();
      expect(blockHash(poisoned)).toHaveLength(64);
    });

    it('and the header domain is the only thing that rejects it', () => {
      expect(verifyHeaderFieldDomains(poisoned).valid).toBe(false);
      expect(verifyHeaderFieldDomains(poisoned).error).toContain('stateRoot');
      expect(blockHashChecked(poisoned)).toBeNull();
      expect(computePowHashChecked(poisoned)).toBeNull();
    });

    it('the same header without the poison passes all of it — so the poison is the only variable', () => {
      const clean = solvePreChange(header());
      expect(preChangePoW(clean)).toBe(true);
      expect(signatureIsGenuine(clean, signHeader(clean))).toBe(true);
      expect(verifyHeaderFieldDomains(clean)).toEqual({ valid: true });
      expect(blockHashChecked(clean)).toBe(blockHash(clean));
      expect(computePowHashChecked(clean)).toEqual(computePowHash(clean));
    });
  });

  // -------------------------------------------------------------------------
  // Demonstration 2 — the collision case, two-sided
  //
  // This one is the whole point. Without the first half it proves nothing about
  // why the phase exists.
  // -------------------------------------------------------------------------

  describe('the collision case: createdAt', () => {
    const OUT_OF_DOMAIN: Array<[string, number]> = [
      ['NaN', NaN],
      ['-1', -1],
      ['1.5', 1.5],
      ['2^60', 2 ** 60],
    ];

    it('TODAY they hash differently — the collision is one the migration would INTRODUCE', () => {
      // cbor-x is a self-describing encoder: a float NaN, a negative integer, a
      // non-integral float and a large integer are four distinct encodings, so
      // four distinct headers today have four distinct block hashes. Under
      // `vlqU` all four are outside the encodable range and map onto
      // `VLQ_SENTINEL` — one preimage, one PoW verdict, one signature verdict.
      // Pinning the *current* distinctness is what makes that a regression the
      // migration would cause rather than a defect it inherits.
      const hashes = OUT_OF_DOMAIN.map(([, v]) => blockHash(header({ createdAt: v })));
      expect(new Set(hashes).size).toBe(OUT_OF_DOMAIN.length);
      // And each differs from the in-domain control, so `createdAt` is genuinely
      // inside the preimage rather than being ignored by the encoder.
      expect(hashes).not.toContain(blockHash(header()));
    });

    it('AFTER, every one of them returns null — closed at its source, not deferred', () => {
      for (const [, v] of OUT_OF_DOMAIN) {
        const h = header({ createdAt: v });
        expect(blockHashChecked(h)).toBeNull();
        expect(computePowHashChecked(h)).toBeNull();
        expect(verifyHeaderFieldDomains(h).error).toContain('createdAt');
      }
    });

    it('the PoW preimage and the signature verdict collapse the same way', () => {
      // The same argument one layer up: distinct preimages today, no preimage at
      // all after. `computePowHash` zeroes `powNonce`, so `createdAt` is the only
      // varying field in these four.
      const preimages = OUT_OF_DOMAIN.map(([, v]) =>
        Buffer.from(computePowHash(header({ createdAt: v }))).toString('hex'),
      );
      expect(new Set(preimages).size).toBe(OUT_OF_DOMAIN.length);
      for (const [, v] of OUT_OF_DOMAIN) {
        expect(verifyOrderingBlockPoW(header({ createdAt: v }))).toBe(false);
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
  // logs "unexpected failure during apply" rather than a stated rejection. That
  // is the same defect shape the spec's boundary check names (§2.1 step 4), so
  // 1f fixes NaN too — just one gate earlier than the other three.
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
      // One occurrence in the whole package before 1f — `isEncodableHeader`'s
      // `typeof === 'number'`, which admits NaN, ±Infinity, -1 and 1.5.
      expect(preChangeCreatedAtRule(bad)).toBe(true);
    });

    it('clears PoW as it stood, and the signature is genuine', () => {
      expect(preChangePoW(poisoned)).toBe(true);
      expect(signatureIsGenuine(poisoned, sig)).toBe(true);
    });

    it('and the structure gate objects to nothing else about it', () => {
      // The proof that the pre-1f structure check accepted this block: after 1f
      // it fails with the `createdAt` message and no other. Every other check in
      // that function — entry alignment, prune entries, utxoTx alignment,
      // coinbase outputs, validatorSignature, the height and target floors —
      // still passes on this exact object.
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
      expect(blockHashChecked(block.header)).toBeNull();
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
      expect(blockHashChecked(block.header)).toBe(blockHash(block.header));
      expect(verifyOrderingBlockPoW(block.header)).toBe(true);
      expect(verifyValidatorSignature(block.header, block.validatorSignature)).toBe(true);
    });

    it('the guarded pair agrees with the unguarded pair on every in-domain header', () => {
      // The expand step's invariant: no honest byte moves in this phase. If this
      // fails, `blockHashChecked` is not the same function plus a gate.
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
        expect(blockHashChecked(h)).toBe(blockHash(h));
        expect(computePowHashChecked(h)).toEqual(computePowHash(h));
      }
    });

    it('the two callers of the domain agree — one statement, no drift', () => {
      // The reason this is one function rather than two: `isEncodableHeader` and
      // `verifyOrderingBlockStructure` used to state the header domain
      // separately. A poison either fails both or neither.
      const poisons: Partial<BlockHeader>[] = [
        { prevBlockHash: 'zz'.repeat(32) },
        { subBlockRoot: 'AB'.repeat(32) },
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
        expect(blockHashChecked(h)).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Totality (M-5), extended past the verify* naming convention
  // -------------------------------------------------------------------------

  describe('totality on adversarial input', () => {
    // `conforms` is not a hedge — it names the honest exceptions, in the idiom
    // Phase 1e established. The corpus holds `0`, which IS a well-formed value
    // for every `vlqU` field: the domain is "non-negative safe integer", and a
    // zero height, nonce or timestamp is inside it. (`height >= 1` is a
    // *semantic* floor and lives in `verifyOrderingBlockStructure`, not here.)
    // Asserting `false` there would be asserting a bug.
    const CONFORMS: Record<string, (v: unknown) => boolean> = {
      protocolVersion: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
      height: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
      powNonce: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
      powTargetBits: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
      createdAt: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
      prevBlockHash: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
      subBlockRoot: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
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

    it('blockHashChecked and computePowHashChecked return null instead of throwing', () => {
      for (const bad of MALFORMED) {
        expect(() => blockHashChecked(bad as unknown as BlockHeader)).not.toThrow();
        expect(blockHashChecked(bad as unknown as BlockHeader)).toBeNull();
        expect(() => computePowHashChecked(bad as unknown as BlockHeader)).not.toThrow();
        expect(computePowHashChecked(bad as unknown as BlockHeader)).toBeNull();
        for (const field of FIELDS) {
          const h = header({ [field]: bad } as Partial<BlockHeader>);
          const ok = CONFORMS[field]!(bad);
          expect(() => blockHashChecked(h)).not.toThrow();
          expect(() => computePowHashChecked(h)).not.toThrow();
          expect(blockHashChecked(h) === null).toBe(!ok);
          expect(computePowHashChecked(h) === null).toBe(!ok);
          // Where the corpus value conforms, the guard must be transparent —
          // the whole point of the expand step is that no honest byte moves.
          if (ok) {
            expect(blockHashChecked(h)).toBe(blockHash(h));
            expect(computePowHashChecked(h)).toEqual(computePowHash(h));
          }
        }
      }
    });

    it('the corpus does contain a conforming value, so the sweep is not vacuous', () => {
      // Guards the two assertions above from degenerating into "everything is
      // null": if no corpus value ever conformed, `CONFORMS` would be dead
      // weight and a regression that rejected *everything* would still pass.
      expect(MALFORMED.some((bad) => CONFORMS.createdAt!(bad))).toBe(true);
      expect(blockHashChecked(header())).not.toBeNull();
      expect(computePowHashChecked(header())).not.toBeNull();
    });
  });
});
