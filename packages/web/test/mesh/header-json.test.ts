import { describe, it, expect } from 'vitest';
import {
  bytesToHex,
  profileFor,
} from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';
import { headerFromJson } from '../../src/mesh/header-json.js';
import { makeLinkedChain } from './helpers/devnet-block.js';

// MESH_INTERFACE → The client's node list → "The client's chain" — the
// served `/blocks/:height`'s `header` JSON object (NODE_INTERFACE → Blocks)
// read as a BlockHeader, `validatorId` hex to bytes, held to
// `verifyHeaderFieldDomains`.

const devnetProfile = profileFor('devnet');

// The shape of the served `header`: the eleven header fields of
// `TYPES_INTERFACE → Layout — Block`, `validatorId` as 64 lowercase hex,
// every root as its hex (NODE_INTERFACE → Blocks).
function headerToJson(h: BlockHeader): Record<string, unknown> {
  return {
    protocolVersion: h.protocolVersion,
    height: h.height,
    prevBlockHash: h.prevBlockHash,
    utxoTxRoot: h.utxoTxRoot,
    stateRoot: h.stateRoot,
    validatorId: bytesToHex(h.validatorId),
    powNonce: h.powNonce,
    powTargetBits: h.powTargetBits,
    createdAt: h.createdAt,
    interlinkRoot: h.interlinkRoot,
    adProofsRoot: h.adProofsRoot,
  };
}

describe('headerFromJson — the served header reader', () => {
  it('round-trips a served devnet header', () => {
    const [block1] = makeLinkedChain(1, devnetProfile);
    const original = block1!.header;
    const json = headerToJson(original);
    const read = headerFromJson(json);
    expect(read).not.toBeNull();
    expect(read!.protocolVersion).toBe(original.protocolVersion);
    expect(read!.height).toBe(original.height);
    expect(read!.prevBlockHash).toBe(original.prevBlockHash);
    expect(read!.utxoTxRoot).toBe(original.utxoTxRoot);
    expect(read!.stateRoot).toBe(original.stateRoot);
    expect(bytesToHex(read!.validatorId)).toBe(bytesToHex(original.validatorId));
    expect(read!.powNonce).toBe(original.powNonce);
    expect(read!.powTargetBits).toBe(original.powTargetBits);
    expect(read!.createdAt).toBe(original.createdAt);
    expect(read!.interlinkRoot).toBe(original.interlinkRoot);
    expect(read!.adProofsRoot).toBe(original.adProofsRoot);
  });

  it('null for a missing field', () => {
    const [block1] = makeLinkedChain(1, devnetProfile);
    const json = headerToJson(block1!.header) as Record<string, unknown>;
    delete json['interlinkRoot'];
    expect(headerFromJson(json)).toBeNull();
  });

  it('null for a non-hex validatorId', () => {
    const [block1] = makeLinkedChain(1, devnetProfile);
    const json = headerToJson(block1!.header);
    json['validatorId'] = 'z'.repeat(64);
    expect(headerFromJson(json)).toBeNull();
  });

  it('null for a float height', () => {
    const [block1] = makeLinkedChain(1, devnetProfile);
    const json = headerToJson(block1!.header);
    json['height'] = 1.5;
    expect(headerFromJson(json)).toBeNull();
  });

  it('null for a non-object input', () => {
    expect(headerFromJson(null)).toBeNull();
    expect(headerFromJson(undefined)).toBeNull();
    expect(headerFromJson('string')).toBeNull();
    expect(headerFromJson(42)).toBeNull();
  });

  it('null for a validatorId that is not a string', () => {
    const [block1] = makeLinkedChain(1, devnetProfile);
    const json = headerToJson(block1!.header);
    // The on-wire shape is a hex string (`blockToJson`); a non-string value is
    // outside what the node serves, and `headerFromJson` refuses it.
    json['validatorId'] = 42;
    expect(headerFromJson(json)).toBeNull();
  });
});
