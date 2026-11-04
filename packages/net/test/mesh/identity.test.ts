// MESH_INTERFACE → Identity — one key, two spellings: the 64-lowercase-hex
// Notis spelling and libp2p's identity-multihash peer id. The DHT protocol
// name is MESH_INTERFACE → Discovery → "The DHT is Notis's own".

import { describe, it, expect } from 'vitest';
import { generateKeyPair as libp2pGenerateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair, bytesToHex } from '@dagsocial/types';
import {
  MeshKeyError,
  nodeKeyFromKeyPair,
  peerIdFromNotisId,
  notisIdFromPeerId,
} from '../../src/mesh/identity.js';
import { dhtProtocol } from '../../src/mesh/constants.js';

describe('identity', () => {
  it('peer id is the identity multihash of the key', () => {
    const kp = generateKeyPair();
    const nk = nodeKeyFromKeyPair(kp);
    const prefix = new Uint8Array([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]);
    const expected = new Uint8Array(prefix.length + kp.publicKey.length);
    expected.set(prefix, 0);
    expected.set(kp.publicKey, prefix.length);
    expect(Array.from(nk.peerId.toMultihash().bytes)).toEqual(Array.from(expected));
  });

  it('the two spellings round-trip', () => {
    const kp = generateKeyPair();
    const id = bytesToHex(kp.publicKey);
    const pid = peerIdFromNotisId(id);
    expect(notisIdFromPeerId(pid)).toBe(id);
    const nk = nodeKeyFromKeyPair(kp);
    expect(nk.notisId).toBe(id);
  });

  it('uppercase hex is refused', () => {
    expect(() => peerIdFromNotisId('AB'.repeat(32))).toThrow(MeshKeyError);
  });

  it('short hex is refused', () => {
    expect(() => peerIdFromNotisId('ab'.repeat(31))).toThrow(MeshKeyError);
  });

  it('a secp256k1 peer id is refused', async () => {
    const sk = await libp2pGenerateKeyPair('secp256k1');
    const pid = peerIdFromPrivateKey(sk);
    expect(() => notisIdFromPeerId(pid)).toThrow(MeshKeyError);
  });

  it("a key pair whose public key is not its seed's is refused", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const crossed = { publicKey: b.publicKey, secretKey: a.secretKey };
    expect(() => nodeKeyFromKeyPair(crossed)).toThrow(MeshKeyError);
  });

  it("the DHT protocol is Notis's own", () => {
    expect(dhtProtocol('devnet')).toBe('/notis/devnet/kad/1.0.0');
    expect(dhtProtocol('testnet')).toBe('/notis/testnet/kad/1.0.0');
    expect(dhtProtocol('mainnet')).toBe('/notis/mainnet/kad/1.0.0');
  });
});
