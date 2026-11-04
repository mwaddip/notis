// MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists"
// — "A state directory whose certificate cannot be read stops the node
// at start, naming the directory". The pre-check catches two cases
// the webrtc transport would otherwise handle unsafely: a truncated
// entry (the transport would throw a non-NotFoundError that takes
// `start` down past libp2p's control), and a certificate of another
// key (the transport silently replaces it, changing every anchor's
// address). After a refusal the entry's bytes are unchanged.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@dagsocial/types';
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

import { NetNode, MeshStateError } from '../../src/index.js';
import type { NetValidators, MeshConfig } from '../../src/index.js';
import { makeConfig } from '../helpers.js';

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

function meshFor(stateDir: string): MeshConfig {
  // `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by
  // IP"` — this case tests the state directory, not STUN, so the server
  // is off. `stun: null` keeps the default `STUN_PORT` (3478) unbound,
  // so this file never races another mesh case under vitest's forks
  // pool (`MeshConfig.stun`: `null` encodes "off").
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:0',
    stun: null,
  };
}

/** The file FsDatastore writes the X.509 PEM bytes to, by walking the tree. */
function findCertFile(stateDir: string): string | null {
  const dsRoot = join(stateDir, 'datastore');
  if (!existsSync(dsRoot)) return null;
  const q: string[] = [dsRoot];
  while (q.length > 0) {
    const d = q.shift()!;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        q.push(p);
      } else if (name.endsWith('.data')) {
        const bytes = readFileSync(p);
        // The certificate is PEM text; the keychain entry is PBES-encrypted
        // binary. PEM sniffs on `-----BEGIN`.
        if (bytes.length >= 11 && bytes.toString('utf8', 0, 11) === '-----BEGIN ') return p;
      }
    }
  }
  return null;
}

async function makeStateDirWithCert(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'net-state-dir-'));
  const node = new NetNode(makeConfig({
    nodeKey: generateKeyPair(),
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    mesh: meshFor(dir),
  }), validators);
  await node.start();
  await node.stop();
  return dir;
}

describe('mesh — state directory pre-check', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    dirs = [];
  });

  it('refuses a truncated certificate entry, leaves the bytes unchanged', async () => {
    const dir = await makeStateDirWithCert();
    dirs.push(dir);
    const certPath = findCertFile(dir);
    expect(certPath).toBeTruthy();
    const original = readFileSync(certPath!);
    const half = original.subarray(0, Math.floor(original.length / 2));
    writeFileSync(certPath!, half);

    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshFor(dir),
    }), validators);
    let thrown: unknown;
    try { await node.start(); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(MeshStateError);
    expect((thrown as Error).message).toContain(dir);
    // The certificate bytes are unchanged after the refusal.
    expect(readFileSync(certPath!).equals(half)).toBe(true);
  }, 30_000);

  it('refuses a certificate of another key, leaves the bytes unchanged', async () => {
    // Build two independent state directories, each with its own
    // certificate and keychain entries. Swap one directory's cert into
    // the other's: the cert's public key now does not match the
    // keychain's stored private key.
    const dirA = await makeStateDirWithCert();
    const dirB = await makeStateDirWithCert();
    dirs.push(dirA, dirB);
    const certA = findCertFile(dirA);
    const certB = findCertFile(dirB);
    expect(certA).toBeTruthy();
    expect(certB).toBeTruthy();

    const bytesB = readFileSync(certB!);
    writeFileSync(certA!, bytesB);
    const injectedBytes = readFileSync(certA!);

    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshFor(dirA),
    }), validators);
    let thrown: unknown;
    try { await node.start(); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(MeshStateError);
    expect((thrown as Error).message).toContain(dirA);
    // The certificate bytes are unchanged after the refusal.
    expect(readFileSync(certA!).equals(injectedBytes)).toBe(true);
  }, 60_000);
});
