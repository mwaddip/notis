// NET_INTERFACE → The node key.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import type { Ed25519PublicKey } from '@libp2p/interface';
import { generateKeyPair, ED25519_PKCS8_PREFIX, hexToBytes } from '@dagsocial/types';
import type { KeyPair } from '@dagsocial/types';
import { loadNodeKey, NodeKeyError } from '../src/node-key.js';
import { NetNode } from '../src/node.js';
import { makeConfig } from './helpers.js';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';
import type { NetValidators } from '../src/types.js';

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

/**
 * NET_INTERFACE → The node key → "`net` runs under the key its caller hands it."
 * The libp2p peer id of a 32-byte Ed25519 public key, computed independently of
 * `net`'s own `peerId()` so the two paths can be compared.
 */
function peerIdOf(publicKey: Uint8Array): string {
  const pk = publicKeyFromRaw(publicKey) as Ed25519PublicKey;
  return peerIdFromPublicKey(pk).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function readBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return null;
  }
}

function modeOrNull(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

function mtimeOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

describe('NET_INTERFACE → The node key: loadNodeKey', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notis-node-key-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // NET_INTERFACE → The node key → "The key file holds the key's `KeyPair.secretKey`"
  it('writes a fresh key file at mode 0600 when the path is empty', async () => {
    const kpPath = join(dir, 'nodekey');
    const before = await readBytesOrNull(kpPath);
    expect(before).toBeNull();

    const kp = await loadNodeKey(kpPath);
    expect(kp.secretKey.length).toBe(48);

    const bytes = await readBytesOrNull(kpPath);
    const mode = modeOrNull(kpPath);
    // The file holds what loadNodeKey answered, and its mode is 0o600.
    expect({ bytes: bytes ? hex(bytes) : null, mode })
      .toEqual({ bytes: hex(kp.secretKey), mode: 0o600 });
  });

  // NET_INTERFACE → The node key → "A node runs under one key, and the key persists"
  it('reads an existing key file twice without rewriting it', async () => {
    const kpPath = join(dir, 'nodekey');
    const written = generateKeyPair();
    writeFileSync(kpPath, written.secretKey);
    const beforeMtime = mtimeOrNull(kpPath);
    // A moment, so a rewrite would land at a different mtime.
    await sleep(25);

    const kp1 = await loadNodeKey(kpPath);
    const kp2 = await loadNodeKey(kpPath);

    const afterBytes = await readBytesOrNull(kpPath);
    const afterMtime = mtimeOrNull(kpPath);
    // Both answers carry the pre-written key's publicKey, and the file is
    // byte-for-byte and mtime-for-mtime the one that was written.
    expect({
      kp1Public: hex(kp1.publicKey),
      kp2Public: hex(kp2.publicKey),
      bytes: afterBytes ? hex(afterBytes) : null,
      mtime: afterMtime,
    }).toEqual({
      kp1Public: hex(written.publicKey),
      kp2Public: hex(written.publicKey),
      bytes: hex(written.secretKey),
      mtime: beforeMtime,
    });
  });

  // NET_INTERFACE → The node key → "The key file holds the key's `KeyPair.secretKey`"
  for (const length of [0, 47, 49]) {
    it(`a file of ${length} bytes is refused with NodeKeyError, and left untouched`, async () => {
      const kpPath = join(dir, 'nodekey');
      const original = new Uint8Array(length).fill(0x42);
      writeFileSync(kpPath, original);
      const beforeMtime = mtimeOrNull(kpPath);
      await sleep(25);

      let caught: unknown = null;
      try {
        await loadNodeKey(kpPath);
      } catch (e) {
        caught = e;
      }

      const afterBytes = await readBytesOrNull(kpPath);
      const afterMtime = mtimeOrNull(kpPath);
      // The call throws a NodeKeyError whose message names the path, and the
      // file's bytes and mtime are unchanged.
      expect({
        isNodeKeyError: caught instanceof NodeKeyError,
        messageNamesPath: caught instanceof Error ? caught.message.includes(kpPath) : false,
        bytes: afterBytes ? hex(afterBytes) : null,
        mtime: afterMtime,
      }).toEqual({
        isNodeKeyError: true,
        messageNamesPath: true,
        bytes: hex(original),
        mtime: beforeMtime,
      });
    });
  }

  // NET_INTERFACE → The node key → "The key file holds the key's `KeyPair.secretKey`".
  // A file whose first 16 bytes form the PKCS8 prefix but whose length is not
  // 48 — 47 and 49 bytes — holds the length guard that the all-`0x42` cases
  // leave the prefix guard to catch.
  for (const extraSeedBytes of [31, 33]) {
    const totalLen = 16 + extraSeedBytes;
    it(`a ${totalLen}-byte file with a valid prefix is refused and left untouched`, async () => {
      const kpPath = join(dir, 'nodekey');
      const original = new Uint8Array(totalLen);
      const prefix = hexToBytes(ED25519_PKCS8_PREFIX);
      original.set(prefix, 0);
      for (let i = prefix.length; i < totalLen; i++) original[i] = (i * 7) & 0xff;
      writeFileSync(kpPath, original);
      const beforeMtime = mtimeOrNull(kpPath);
      await sleep(25);

      let caught: unknown = null;
      try {
        await loadNodeKey(kpPath);
      } catch (e) {
        caught = e;
      }

      const afterBytes = await readBytesOrNull(kpPath);
      const afterMtime = mtimeOrNull(kpPath);
      expect({
        isNodeKeyError: caught instanceof NodeKeyError,
        messageNamesPath: caught instanceof Error ? caught.message.includes(kpPath) : false,
        bytes: afterBytes ? hex(afterBytes) : null,
        mtime: afterMtime,
      }).toEqual({
        isNodeKeyError: true,
        messageNamesPath: true,
        bytes: hex(original),
        mtime: beforeMtime,
      });
    });
  }

  // NET_INTERFACE → The node key → "The key file holds the key's `KeyPair.secretKey`"
  it('a 48-byte file without the PKCS8 prefix is refused and left untouched', async () => {
    const kpPath = join(dir, 'nodekey');
    const good = generateKeyPair();
    const bad = new Uint8Array(good.secretKey);
    bad[0] = (bad[0]! ^ 0xff) & 0xff; // break the prefix
    writeFileSync(kpPath, bad);
    const beforeMtime = mtimeOrNull(kpPath);
    await sleep(25);

    let caught: unknown = null;
    try {
      await loadNodeKey(kpPath);
    } catch (e) {
      caught = e;
    }

    const afterBytes = await readBytesOrNull(kpPath);
    const afterMtime = mtimeOrNull(kpPath);
    expect({
      isNodeKeyError: caught instanceof NodeKeyError,
      messageNamesPath: caught instanceof Error ? caught.message.includes(kpPath) : false,
      bytes: afterBytes ? hex(afterBytes) : null,
      mtime: afterMtime,
    }).toEqual({
      isNodeKeyError: true,
      messageNamesPath: true,
      bytes: hex(bad),
      mtime: beforeMtime,
    });
  });

  // NET_INTERFACE → The node key → "The key file holds the key's `KeyPair.secretKey`".
  // The path names an existing directory, which cannot be read as a file and
  // cannot be written as a file either.
  it('a path that names a directory is refused with NodeKeyError', async () => {
    const dirAsKey = join(dir, 'subdir');
    // Make the path a directory so neither read nor write-create reaches a file.
    rmSync(dirAsKey, { recursive: true, force: true });
    // Build the directory in place of the key file.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dirAsKey);

    let caught: unknown = null;
    try {
      await loadNodeKey(dirAsKey);
    } catch (e) {
      caught = e;
    }

    expect({
      isNodeKeyError: caught instanceof NodeKeyError,
      messageNamesPath: caught instanceof Error ? caught.message.includes(dirAsKey) : false,
    }).toEqual({
      isNodeKeyError: true,
      messageNamesPath: true,
    });
  });
});

describe('NET_INTERFACE → The node key: NetConfig.nodeKey through start()', () => {
  // Generous bound for a libp2p start on loopback.
  const TIMEOUT = 25_000;

  // NET_INTERFACE → The node key → "`net` runs under the key its caller hands it"
  it('peerId() answers the libp2p peer id of the config key', async () => {
    const kp = generateKeyPair();
    const expected = peerIdOf(kp.publicKey);
    const net = new NetNode(
      makeConfig({ nodeKey: kp, listenAddrs: '/ip4/127.0.0.1/tcp/0' }),
      validators,
    );
    let actual = '';
    try {
      await net.start();
      actual = net.peerId();
    } finally {
      await net.stop();
    }
    expect(actual).toBe(expected);
  }, TIMEOUT);

  // NET_INTERFACE → The node key → "A node runs under one key, and the key persists"
  it('a stopped node starts again with the same peer id', async () => {
    const kp = generateKeyPair();
    const net = new NetNode(
      makeConfig({ nodeKey: kp, listenAddrs: '/ip4/127.0.0.1/tcp/0' }),
      validators,
    );
    let first = '';
    let second = '';
    try {
      await net.start();
      first = net.peerId();
      await net.stop();
      await net.start();
      second = net.peerId();
    } finally {
      await net.stop();
    }
    expect({ second, first }).toEqual({ second: first, first: peerIdOf(kp.publicKey) });
  }, TIMEOUT);

  // NET_INTERFACE → The node key → "`net` runs under the key its caller hands it"
  // (and NET_INTERFACE → Node Lifecycle, which binds `start` to the throw-stops
  // rule).
  it('a crossed key pair is refused at start, with nothing listening behind the error', async () => {
    const kp = generateKeyPair();
    const other = generateKeyPair();
    const crossed: KeyPair = { publicKey: other.publicKey, secretKey: kp.secretKey };
    const net = new NetNode(
      makeConfig({ nodeKey: crossed, listenAddrs: '/ip4/127.0.0.1/tcp/0' }),
      validators,
    );
    let rejected = false;
    try {
      await net.start();
    } catch {
      rejected = true;
    }
    const addrs = net.libp2pNode?.getMultiaddrs() ?? [];
    await net.stop();
    expect({ rejected, listening: addrs.length }).toEqual({ rejected: true, listening: 0 });
  }, TIMEOUT);

  // NET_INTERFACE → libp2p Stack. libp2p's handshake checks the remote peer id
  // against the id named in the dial address, so a bootstrap address naming a
  // third key cannot resolve to the listener behind it.
  it('a bootstrap address naming a third key never connects to the listener behind it', async () => {
    const nodeA = new NetNode(
      makeConfig({ listenAddrs: '/ip4/127.0.0.1/tcp/0' }),
      validators,
    );
    let nodeB: NetNode | null = null;
    let aPeerId = '';
    let bPeers: string[] = [];
    try {
      await nodeA.start();
      aPeerId = nodeA.peerId();
      const addrs = nodeA.libp2pNode!.getMultiaddrs();
      const bareAddr = addrs[0]!.toString().replace(/\/p2p\/[^/]+$/, '');
      const third = generateKeyPair();
      const bogus = `${bareAddr}/p2p/${peerIdOf(third.publicKey)}`;
      nodeB = new NetNode(
        makeConfig({
          listenAddrs: '/ip4/127.0.0.1/tcp/0',
          bootstrapPeers: [bogus],
          minPeers: 0,
        }),
        validators,
      );
      await nodeB.start();
      // A few seconds for the dial to settle (succeed or fail at identity check).
      await sleep(3_000);
      bPeers = nodeB.peers().map((p) => p.id);
    } finally {
      await nodeB?.stop();
      await nodeA.stop();
    }
    expect(bPeers).not.toContain(aPeerId);
  }, TIMEOUT);
});
