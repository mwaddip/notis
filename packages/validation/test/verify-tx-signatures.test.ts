import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { verifyEd25519, verifyTxSignatures } from '../src/index.js';
import { bytesToHex, computeTxId, hexToBytes } from '@dagsocial/types';
import type { AnyBoxCandidate, UtxoTransaction } from '@dagsocial/types';
import { RFC8032_VECTORS } from './rfc8032-vectors.js';

// verifyTxSignatures — VALIDATION_INTERFACE → verifyTxSignatures: every entry
// of the signature map verifies over the transaction's id as one
// `verifyEd25519Batch` in the map's decoded order. The empty map answers
// `true`. Total: `false`, never a throw, on a map key that is not 64 lowercase
// hex, a value that is not a 64-byte view, a signatures that is not a plain
// object, or a transaction whose id cannot be computed.

interface Key {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** A 32-byte seed derived from `label`'s UTF-8 bytes, left-aligned, zero-padded. */
const seedOf = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).subarray(0, 32));
  return out;
};

/** A deterministic key pair fixed by `label`. */
const keyFromLabel = (label: string): Key => {
  const secretKey = seedOf(label);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
};

const KEY_A = keyFromLabel('verify-tx-signatures key alpha');
const KEY_B = keyFromLabel('verify-tx-signatures key beta');
const KEY_C = keyFromLabel('verify-tx-signatures key gamma');

const karmaOutput = (value: bigint): AnyBoxCandidate => ({
  boxType: 'karma',
  value,
  createdAtBlock: 0,
  owner: new Uint8Array(32),
});

/** A minimal well-formed transaction with no signatures yet. */
const baseTx = (): UtxoTransaction => ({
  inputs: ['aa'.repeat(32)],
  outputs: [karmaOutput(5n)],
  signatures: {},
  protocolVersion: 1,
});

/** `tx` with signatures from each `key` over `computeTxId(tx)`'s 32 bytes. */
const signWith = (tx: UtxoTransaction, keys: readonly Key[]): UtxoTransaction => {
  const message = hexToBytes(computeTxId(tx));
  const signatures: Record<string, Uint8Array> = {};
  for (const k of keys) {
    signatures[bytesToHex(k.publicKey)] = ed25519.sign(message, k.secretKey);
  }
  return { ...tx, signatures };
};

// ---------------------------------------------------------------------------
// Positive cases — a map every entry of which verifies answers `true`
// (VALIDATION_INTERFACE → verifyTxSignatures → "Every entry of a transaction's
// signature map verifies over its id").
// ---------------------------------------------------------------------------

describe('verifyTxSignatures — passing maps', () => {
  it('a transaction signed by one key answers true', () => {
    const tx = signWith(baseTx(), [KEY_A]);
    expect(verifyTxSignatures(tx)).toBe(true);
  });

  it('a transaction signed by three keys answers true', () => {
    const tx = signWith(baseTx(), [KEY_A, KEY_B, KEY_C]);
    expect(verifyTxSignatures(tx)).toBe(true);
  });

  it('the empty map answers true', () => {
    // VALIDATION_INTERFACE → verifyTxSignatures → "The empty map answers
    // `true`" — matching VALIDATION_INTERFACE → verifyEd25519Batch → "The
    // empty batch is `true`, and a batch of one is `verifyEd25519` itself".
    expect(verifyTxSignatures(baseTx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Falsifying cases — a single mismatched entry falsifies the whole map
// (VALIDATION_INTERFACE → verifyEd25519Batch → "A batch answers what its
// entries would").
// ---------------------------------------------------------------------------

describe('verifyTxSignatures — maps with one bad entry', () => {
  it('one entry with a single byte flipped in its signature answers false', () => {
    const tx = signWith(baseTx(), [KEY_A, KEY_B, KEY_C]);
    const keyA = bytesToHex(KEY_A.publicKey);
    const flipped = new Uint8Array(tx.signatures[keyA]!);
    flipped[0] = flipped[0]! ^ 0x01;
    const bad: UtxoTransaction = { ...tx, signatures: { ...tx.signatures, [keyA]: flipped } };
    expect(verifyTxSignatures(bad)).toBe(false);
  });

  it('one entry signed over another transaction\'s id answers false', () => {
    // The entry's signature carries `KEY_A` over `otherTx`'s id, but it lives
    // in `tx`'s map — the batch recomputes the message as `tx`'s id.
    const tx = signWith(baseTx(), [KEY_B, KEY_C]);
    const otherTx: UtxoTransaction = { ...baseTx(), outputs: [karmaOutput(9n)] };
    const otherId = hexToBytes(computeTxId(otherTx));
    const foreign = ed25519.sign(otherId, KEY_A.secretKey);
    const bad: UtxoTransaction = {
      ...tx,
      signatures: { ...tx.signatures, [bytesToHex(KEY_A.publicKey)]: foreign },
    };
    expect(verifyTxSignatures(bad)).toBe(false);
  });

  it('one entry whose key is not the key that signed answers false', () => {
    // `KEY_B`'s signature over `tx`'s id is filed under `KEY_C`'s key, so the
    // batch checks `KEY_C`'s equation and the entry refuses.
    const message = hexToBytes(computeTxId(baseTx()));
    const sigByB = ed25519.sign(message, KEY_B.secretKey);
    const tx = signWith(baseTx(), [KEY_A]);
    const bad: UtxoTransaction = {
      ...tx,
      signatures: { ...tx.signatures, [bytesToHex(KEY_C.publicKey)]: sigByB },
    };
    expect(verifyTxSignatures(bad)).toBe(false);
  });

  it('a transaction changed after signing (one output\'s value) answers false', () => {
    const signed = signWith(baseTx(), [KEY_A, KEY_B]);
    const mutated: UtxoTransaction = { ...signed, outputs: [karmaOutput(6n)] };
    expect(verifyTxSignatures(mutated)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Totality — `false`, never a throw, on shapes outside the signature-map
// domain (VALIDATION_INTERFACE → verifyTxSignatures → "Total").
// ---------------------------------------------------------------------------

describe('verifyTxSignatures — totality', () => {
  const validTx = signWith(baseTx(), [KEY_A]);
  const validKey = bytesToHex(KEY_A.publicKey);
  const validSignature = validTx.signatures[validKey]!;

  it('a key in uppercase hex answers false without a throw', () => {
    const upperKey = validKey.toUpperCase();
    const bad: UtxoTransaction = { ...baseTx(), signatures: { [upperKey]: validSignature } };
    expect(() => verifyTxSignatures(bad)).not.toThrow();
    expect(verifyTxSignatures(bad)).toBe(false);
  });

  it('a key of 62 hex characters answers false without a throw', () => {
    const shortKey = validKey.slice(0, 62);
    const bad: UtxoTransaction = { ...baseTx(), signatures: { [shortKey]: validSignature } };
    expect(() => verifyTxSignatures(bad)).not.toThrow();
    expect(verifyTxSignatures(bad)).toBe(false);
  });

  it('a value that is not a Uint8Array answers false without a throw', () => {
    const bad: UtxoTransaction = {
      ...baseTx(),
      signatures: { [validKey]: 'not-a-byte-view' as unknown as Uint8Array },
    };
    expect(() => verifyTxSignatures(bad)).not.toThrow();
    expect(verifyTxSignatures(bad)).toBe(false);
  });

  it('a value of 63 bytes answers false without a throw', () => {
    const bad: UtxoTransaction = {
      ...baseTx(),
      signatures: { [validKey]: new Uint8Array(63) },
    };
    expect(() => verifyTxSignatures(bad)).not.toThrow();
    expect(verifyTxSignatures(bad)).toBe(false);
  });

  it('a signatures that is an array answers false without a throw', () => {
    // An array is `typeof === 'object'` and not `null`, so the plain-object
    // check is the one that refuses it.
    const bad = { ...baseTx(), signatures: [] as unknown as Record<string, Uint8Array> } as UtxoTransaction;
    expect(() => verifyTxSignatures(bad)).not.toThrow();
    expect(verifyTxSignatures(bad)).toBe(false);
  });

  it('a signatures that is null answers false without a throw', () => {
    const bad = { ...baseTx(), signatures: null as unknown as Record<string, Uint8Array> } as UtxoTransaction;
    expect(() => verifyTxSignatures(bad)).not.toThrow();
    expect(verifyTxSignatures(bad)).toBe(false);
  });

  it('a non-object tx answers false without a throw', () => {
    // The function reads `tx.signatures`, so a `tx` that is `null` or a
    // primitive must be refused before the read reaches it
    // (VALIDATION_INTERFACE → verifyTxSignatures → "Total").
    for (const bad of [null, undefined, 'not an object', 42]) {
      expect(() => verifyTxSignatures(bad as unknown as UtxoTransaction)).not.toThrow();
      expect(verifyTxSignatures(bad as unknown as UtxoTransaction)).toBe(false);
    }
  });

  it('a tx whose id cannot be computed answers false without a throw', () => {
    // `computeTxId` reaches `writeHexNOrThrow` for every `inputs` entry
    // (TYPES_INTERFACE → Layout — UtxoTransaction), which throws on anything
    // outside 64 lowercase hex. The contract's "a transaction whose id cannot
    // be computed" case is this one and its siblings
    // (VALIDATION_INTERFACE → verifyTxSignatures → "Total").
    const bad: UtxoTransaction = {
      ...baseTx(),
      inputs: ['xx'.repeat(32)],
      signatures: { [bytesToHex(KEY_A.publicKey)]: validSignature },
    };
    expect(() => verifyTxSignatures(bad)).not.toThrow();
    expect(verifyTxSignatures(bad)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agreement with the single check — a one-entry map answers exactly what
// `verifyEd25519` answers for that entry over the transaction's id, resting on
// VALIDATION_INTERFACE → verifyEd25519Batch → "The empty batch is `true`, and
// a batch of one is `verifyEd25519` itself".
// ---------------------------------------------------------------------------

describe('verifyTxSignatures — agreement with the single check', () => {
  const tx = baseTx();
  const message = hexToBytes(computeTxId(tx));

  it.each(RFC8032_VECTORS)(
    'answers verifyEd25519 for the RFC 8032 §7.1 vector $name as a one-entry map',
    ({ publicKey, signature }) => {
      const entryTx: UtxoTransaction = {
        ...tx,
        signatures: { [bytesToHex(publicKey)]: signature },
      };
      const direct = verifyEd25519(signature, message, publicKey);
      expect(verifyTxSignatures(entryTx)).toBe(direct);
    },
  );

  describe('the two malleation forms', () => {
    // VALIDATION_INTERFACE → Acceptance criterion — a scalar raised by the
    // group order (`S + L`) and the high-bit variant each refuse under
    // `verifyEd25519`, and the one-entry map answers the same.
    const genuine = RFC8032_VECTORS[0]!;
    const r = genuine.signature.subarray(0, 32);
    const s = genuine.signature.subarray(32, 64);

    /** Little-endian bytes to a bigint. */
    const leToBigInt = (b: Uint8Array): bigint => {
      let v = 0n;
      for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
      return v;
    };
    /** A bigint to fixed-length little-endian bytes. */
    const bigIntToLe = (value: bigint, len: number): Uint8Array => {
      const out = new Uint8Array(len);
      let v = value;
      for (let i = 0; i < len; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    };
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;

    it('S + L — the one-entry map answers verifyEd25519 for that signature over the transaction\'s id', () => {
      const sPlusL = bigIntToLe(leToBigInt(s) + L, 32);
      const malleated = new Uint8Array(64);
      malleated.set(r, 0);
      malleated.set(sPlusL, 32);
      const entryTx: UtxoTransaction = {
        ...tx,
        signatures: { [bytesToHex(genuine.publicKey)]: malleated },
      };
      const direct = verifyEd25519(malleated, message, genuine.publicKey);
      expect(verifyTxSignatures(entryTx)).toBe(direct);
    });

    it('the high bit of the last byte set — the one-entry map answers verifyEd25519 for that signature over the transaction\'s id', () => {
      const malleated = new Uint8Array(genuine.signature);
      malleated[63] = malleated[63]! | 0x80;
      const entryTx: UtxoTransaction = {
        ...tx,
        signatures: { [bytesToHex(genuine.publicKey)]: malleated },
      };
      const direct = verifyEd25519(malleated, message, genuine.publicKey);
      expect(verifyTxSignatures(entryTx)).toBe(direct);
    });
  });
});
