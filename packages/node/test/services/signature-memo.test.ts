// The signature memo answers an accepted triple with no second call and
// records nothing a refusal brought back (NODE_INTERFACE → The signature memo).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPrivateKey, sign as cryptoSign } from 'crypto';
import { generateKeyPair } from '@dagsocial/types';
import { verifyEd25519, verifyEd25519Batch, type Ed25519BatchEntry } from '@dagsocial/validation';
import { createSignatureMemo, SIGNATURE_MEMO_ENTRIES, signatureMemo } from '../../src/services/signature-memo.js';

vi.mock('@dagsocial/validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dagsocial/validation')>();
  return {
    ...actual,
    verifyEd25519: vi.fn(actual.verifyEd25519),
    verifyEd25519Batch: vi.fn(actual.verifyEd25519Batch),
  };
});

type Triple = { signature: Uint8Array; message: Uint8Array; publicKey: Uint8Array };

function makeTriple(messageBytes: Uint8Array): Triple {
  const { publicKey, secretKey } = generateKeyPair();
  const priv = createPrivateKey({ key: Buffer.from(secretKey), format: 'der', type: 'pkcs8' });
  const signature = new Uint8Array(cryptoSign(null, Buffer.from(messageBytes), priv));
  return { signature, message: messageBytes, publicKey };
}

function flip(sig: Uint8Array): Uint8Array {
  const copy = new Uint8Array(sig);
  copy[0]! ^= 0x01;
  return copy;
}

beforeEach(() => {
  vi.mocked(verifyEd25519).mockClear();
  vi.mocked(verifyEd25519Batch).mockClear();
});

describe('createSignatureMemo', () => {
  it.fails('an honest triple answers true, the rule is called once, then true with no call', () => {
    const memo = createSignatureMemo(16);
    const t = makeTriple(new Uint8Array(32).fill(1));
    expect(memo.verify(t.signature, t.message, t.publicKey)).toBe(true);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(1);
    expect(memo.verify(t.signature, t.message, t.publicKey)).toBe(true);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(1);
  });

  it('a refused triple answers false, the rule is called both times', () => {
    const memo = createSignatureMemo(16);
    const t = makeTriple(new Uint8Array(32).fill(2));
    const bad = flip(t.signature);
    expect(memo.verify(bad, t.message, t.publicKey)).toBe(false);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(1);
    expect(memo.verify(bad, t.message, t.publicKey)).toBe(false);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(2);
  });

  it('the width trap: a 63-byte signature carved from a held triple\'s 128 bytes reaches the rule', () => {
    const memo = createSignatureMemo(16);
    const message = new Uint8Array(32).fill(3);
    const t = makeTriple(message);
    // Prime the memo on the honest triple — 64 + 32 + 32 = 128 bytes.
    expect(memo.verify(t.signature, t.message, t.publicKey)).toBe(true);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(1);
    // The same 128 bytes, split as (63-byte signature) ‖ (last byte of
    // signature + first 31 bytes of key = 32-byte key) ‖ (last byte of key +
    // 32-byte message = 33-byte message). A string lookup with no width
    // check would hit the honest entry.
    const badSig = t.signature.subarray(0, 63);
    const altKey = new Uint8Array(32);
    altKey[0] = t.signature[63]!;
    altKey.set(t.publicKey.subarray(0, 31), 1);
    const altMsg = new Uint8Array(33);
    altMsg[0] = t.publicKey[31]!;
    altMsg.set(message, 1);
    expect(memo.verify(badSig, altMsg, altKey)).toBe(false);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(2);
  });

  it('the width trap: a 31-byte key carved from a held triple\'s 128 bytes reaches the rule', () => {
    const memo = createSignatureMemo(16);
    const message = new Uint8Array(32).fill(15);
    const t = makeTriple(message);
    // Prime the memo on the honest triple.
    expect(memo.verify(t.signature, t.message, t.publicKey)).toBe(true);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(1);
    // The same 128 bytes, split as (64-byte signature) ‖ (31 bytes of key) ‖
    // (last byte of key + 32-byte message = 33-byte message). A string lookup
    // with no width check would hit the honest entry.
    const altKey = t.publicKey.subarray(0, 31);
    const altMsg = new Uint8Array(33);
    altMsg[0] = t.publicKey[31]!;
    altMsg.set(message, 1);
    expect(memo.verify(t.signature, altMsg, altKey)).toBe(false);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(2);
  });

  it.fails('a batch the memo holds whole answers true with no batch call', () => {
    const memo = createSignatureMemo(16);
    const t1 = makeTriple(new Uint8Array(32).fill(4));
    const t2 = makeTriple(new Uint8Array(32).fill(5));
    const entries: Ed25519BatchEntry[] = [t1, t2];
    expect(memo.verifyBatch(entries)).toBe(true);
    expect(vi.mocked(verifyEd25519Batch).mock.calls.length).toBe(1);
    expect(memo.verifyBatch(entries)).toBe(true);
    expect(vi.mocked(verifyEd25519Batch).mock.calls.length).toBe(1);
  });

  it.fails('a batch partly held calls the rule once with exactly the unheld entries in order, each a hit after', () => {
    const memo = createSignatureMemo(16);
    const t1 = makeTriple(new Uint8Array(32).fill(6));
    const t2 = makeTriple(new Uint8Array(32).fill(7));
    const t3 = makeTriple(new Uint8Array(32).fill(8));
    // Prime t2 alone.
    expect(memo.verify(t2.signature, t2.message, t2.publicKey)).toBe(true);
    vi.mocked(verifyEd25519Batch).mockClear();
    const entries: Ed25519BatchEntry[] = [t1, t2, t3];
    expect(memo.verifyBatch(entries)).toBe(true);
    expect(vi.mocked(verifyEd25519Batch).mock.calls.length).toBe(1);
    const called = vi.mocked(verifyEd25519Batch).mock.calls[0]![0] as ReadonlyArray<Ed25519BatchEntry>;
    expect(called.length).toBe(2);
    expect(called[0]).toEqual(t1);
    expect(called[1]).toEqual(t3);
    vi.mocked(verifyEd25519Batch).mockClear();
    expect(memo.verifyBatch(entries)).toBe(true);
    expect(vi.mocked(verifyEd25519Batch).mock.calls.length).toBe(0);
  });

  it('a batch answering false records nothing — an honest entry calls the rule when asked alone', () => {
    const memo = createSignatureMemo(16);
    const t1 = makeTriple(new Uint8Array(32).fill(9));
    const t2 = makeTriple(new Uint8Array(32).fill(10));
    const flipped: Ed25519BatchEntry = { signature: flip(t2.signature), message: t2.message, publicKey: t2.publicKey };
    expect(memo.verifyBatch([t1, flipped])).toBe(false);
    vi.mocked(verifyEd25519).mockClear();
    expect(memo.verify(t1.signature, t1.message, t1.publicKey)).toBe(true);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(1);
  });

  it('a batch holding a 63-byte signature reaches the rule and answers false', () => {
    const memo = createSignatureMemo(16);
    const t1 = makeTriple(new Uint8Array(32).fill(11));
    const bad: Ed25519BatchEntry = { signature: t1.signature.subarray(0, 63), message: t1.message, publicKey: t1.publicKey };
    expect(memo.verifyBatch([bad])).toBe(false);
    expect(vi.mocked(verifyEd25519Batch).mock.calls.length).toBe(1);
    const called = vi.mocked(verifyEd25519Batch).mock.calls[0]![0] as ReadonlyArray<Ed25519BatchEntry>;
    expect(called.length).toBe(1);
    expect(called[0]!.signature.length).toBe(63);
  });

  it.fails('at capacity 2, recording A, B, a hit on A, then C drops A — A calls the rule again, B and C do not', () => {
    const memo = createSignatureMemo(2);
    const a = makeTriple(new Uint8Array(32).fill(12));
    const b = makeTriple(new Uint8Array(32).fill(13));
    const c = makeTriple(new Uint8Array(32).fill(14));
    expect(memo.verify(a.signature, a.message, a.publicKey)).toBe(true);
    expect(memo.verify(b.signature, b.message, b.publicKey)).toBe(true);
    expect(memo.verify(a.signature, a.message, a.publicKey)).toBe(true);
    expect(memo.verify(c.signature, c.message, c.publicKey)).toBe(true);
    vi.mocked(verifyEd25519).mockClear();
    expect(memo.verify(a.signature, a.message, a.publicKey)).toBe(true);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(1);
    expect(memo.verify(b.signature, b.message, b.publicKey)).toBe(true);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(1);
    expect(memo.verify(c.signature, c.message, c.publicKey)).toBe(true);
    expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(1);
  });

  it('signatureMemo.capacity is SIGNATURE_MEMO_ENTRIES', () => {
    expect(SIGNATURE_MEMO_ENTRIES).toBe(65_536);
    expect(signatureMemo.capacity).toBe(SIGNATURE_MEMO_ENTRIES);
  });
});
