import { describe, it, expect } from 'vitest';
import {
  encodePoPowHeader,
  decodePoPowHeader,
  encodeNipopowProof,
  decodeNipopowProof,
  MAX_NIPOPOW_PARAM,
} from '../src/index.js';
import { ReaderError, writeVlqU, ByteWriter } from '@dagsocial/types';
import { buildMinedChain, makeReader } from './helpers.js';
import { proveWithReader } from '../src/prover.js';

describe('PoPowHeader codec', () => {
  const chain = buildMinedChain({ count: 5 });

  it('round-trips a PoPowHeader', () => {
    const ph = chain.popowHeaders[3]!;
    const bytes = encodePoPowHeader(ph);
    const decoded = decodePoPowHeader(bytes);
    expect(decoded.header).toEqual(ph.header);
    expect(decoded.interlinks).toEqual(ph.interlinks);
  });

  it('round-trips genesis PoPowHeader (empty interlinks)', () => {
    const ph = chain.popowHeaders[0]!;
    const bytes = encodePoPowHeader(ph);
    const decoded = decodePoPowHeader(bytes);
    expect(decoded.header.height).toBe(1);
    expect(decoded.interlinks).toEqual([]);
  });

  it('refuses trailing bytes', () => {
    const ph = chain.popowHeaders[2]!;
    const bytes = encodePoPowHeader(ph);
    const extended = new Uint8Array(bytes.length + 1);
    extended.set(bytes);
    extended[bytes.length] = 0xff;
    expect(() => decodePoPowHeader(extended)).toThrow(ReaderError);
  });

  it('refuses truncated bytes', () => {
    const ph = chain.popowHeaders[2]!;
    const bytes = encodePoPowHeader(ph);
    expect(() => decodePoPowHeader(bytes.subarray(0, 10))).toThrow(ReaderError);
  });
});

describe('NipopowProof codec', () => {
  const chain = buildMinedChain({ count: 30 });
  const reader = makeReader(chain);

  it('round-trips a proof', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const bytes = encodeNipopowProof(proof);
    const decoded = decodeNipopowProof(bytes);
    expect(decoded.m).toBe(proof.m);
    expect(decoded.k).toBe(proof.k);
    expect(decoded.prefix.length).toBe(proof.prefix.length);
    expect(decoded.suffixHead.header.height).toBe(proof.suffixHead.header.height);
    expect(decoded.suffixTail.length).toBe(proof.suffixTail.length);
  });

  it('refuses m = 0', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const bytes = encodeNipopowProof(proof);
    // Replace first byte (the vlqU for m) with 0
    const w = new ByteWriter();
    writeVlqU(w, 0);
    const zeroM = w.toBytes();
    const modified = new Uint8Array(bytes.length);
    modified.set(zeroM);
    modified.set(bytes.subarray(1), zeroM.length);
    expect(() => decodeNipopowProof(modified.subarray(0, bytes.length))).toThrow(ReaderError);
  });

  it('refuses m = MAX_NIPOPOW_PARAM + 1', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const bytes = encodeNipopowProof(proof);
    const w = new ByteWriter();
    writeVlqU(w, MAX_NIPOPOW_PARAM + 1);
    const bigM = w.toBytes();
    const modified = new Uint8Array(bigM.length + bytes.length);
    modified.set(bigM);
    modified.set(bytes.subarray(1), bigM.length);
    expect(() => decodeNipopowProof(modified)).toThrow(ReaderError);
  });

  it('refuses k = 0', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const bytes = encodeNipopowProof(proof);
    // m is 1 byte (vlqU of 3), k follows
    const w = new ByteWriter();
    writeVlqU(w, proof.m);
    writeVlqU(w, 0);
    const head = w.toBytes();
    // Skip original m + k bytes
    const origW = new ByteWriter();
    writeVlqU(origW, proof.m);
    writeVlqU(origW, proof.k);
    const origHead = origW.toBytes();
    const tail = bytes.subarray(origHead.length);
    const modified = new Uint8Array(head.length + tail.length);
    modified.set(head);
    modified.set(tail, head.length);
    expect(() => decodeNipopowProof(modified)).toThrow(ReaderError);
  });

  it('refuses trailing bytes on proof', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const bytes = encodeNipopowProof(proof);
    const extended = new Uint8Array(bytes.length + 1);
    extended.set(bytes);
    expect(() => decodeNipopowProof(extended)).toThrow(ReaderError);
  });
});
