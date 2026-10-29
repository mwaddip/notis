import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair as libp2pGenerateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@dagsocial/types';
import { bytesToHex } from '@dagsocial/types';
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

  it('a key file of the wrong length is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-poc-key-'));
    try {
      const p = join(dir, 'node.key');
      writeFileSync(p, new Uint8Array(47), { mode: 0o600 });
      await expect(loadOrCreateNodeKey(p)).rejects.toThrow(MeshKeyError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the DHT protocol is Notis's own", () => {
    expect(dhtProtocol('devnet')).toBe('/notis/devnet/kad/1.0.0');
    expect(dhtProtocol('testnet')).toBe('/notis/testnet/kad/1.0.0');
    expect(dhtProtocol('mainnet')).toBe('/notis/mainnet/kad/1.0.0');
  });
});
