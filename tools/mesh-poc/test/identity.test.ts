import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair as libp2pGenerateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { ED25519_PKCS8_PREFIX, generateKeyPair, hexToBytes } from '@dagsocial/types';
import { bytesToHex } from '@dagsocial/types';
import { NodeKeyError } from '@dagsocial/net';
import {
  MeshKeyError,
  nodeKeyFromKeyPair,
  peerIdFromNotisId,
  notisIdFromPeerId,
} from '../src/identity.js';
import { loadOrCreateNodeKey } from '../src/node/key-store.js';
import { dhtProtocol } from '../src/protocols.js';

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

  it('the key file persists the identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-poc-key-'));
    try {
      const p = join(dir, 'node.key');
      const a = await loadOrCreateNodeKey(p);
      const b = await loadOrCreateNodeKey(p);
      expect(a.notisId).toBe(b.notisId);
      const st = statSync(p);
      expect(st.size).toBe(48);
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a key file of the wrong length is refused, never replaced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-poc-key-'));
    try {
      const p = join(dir, 'node.key');
      const before = new Uint8Array(47);
      for (let i = 0; i < 47; i++) before[i] = i;
      writeFileSync(p, before, { mode: 0o600 });
      await expect(loadOrCreateNodeKey(p)).rejects.toThrow(NodeKeyError);
      const after = readFileSync(p);
      expect(after.length).toBe(47);
      expect(Array.from(after)).toEqual(Array.from(before));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a 48-byte file without the prefix is refused and left as it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-poc-key-'));
    try {
      const p = join(dir, 'node.key');
      // 48 bytes whose first 16 do not equal the RFC 8410 PKCS8 prefix the
      // secretKey carries (`TYPES_INTERFACE → Identity`).
      const prefix = hexToBytes(ED25519_PKCS8_PREFIX);
      const before = new Uint8Array(48);
      for (let i = 0; i < 48; i++) before[i] = i;
      // Make sure the first 16 bytes differ from the prefix at some byte.
      let diff = false;
      for (let i = 0; i < prefix.length; i++) if (before[i] !== prefix[i]) { diff = true; break; }
      expect(diff).toBe(true);
      writeFileSync(p, before, { mode: 0o600 });
      await expect(loadOrCreateNodeKey(p)).rejects.toThrow(NodeKeyError);
      const after = readFileSync(p);
      expect(after.length).toBe(48);
      expect(Array.from(after)).toEqual(Array.from(before));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
