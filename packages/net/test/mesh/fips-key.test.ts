// MESH_INTERFACE → FIPS → "A node's FIPS key persists" — `fips.key` in the
// mesh state directory, 32 raw bytes, mode `0600`. MESH_INTERFACE → FIPS
// → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`" — the npub
// spelling of the x-only key, and `02‖x`, the even-parity compressed form
// a dial addresses it by.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from '@fips/core';
import { loadFipsKey } from '../../src/mesh/fips-key.js';
import { npubOf, dialKeyHex } from '../../src/mesh/fips-identity.js';
import { MeshStateError } from '../../src/mesh/config.js';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

describe('MESH_INTERFACE → FIPS: loadFipsKey', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notis-fips-key-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a fresh key with mode 0600', async () => {
    const id = await loadFipsKey(dir);
    const path = join(dir, 'fips.key');
    const bytes = new Uint8Array(readFileSync(path));
    expect(bytes.length).toBe(32);
    expect(bytesEqual(bytes, id.secretKey)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('answers the same npub on a second load', async () => {
    const first = await loadFipsKey(dir);
    const second = await loadFipsKey(dir);
    expect(npubOf(second)).toBe(npubOf(first));
  });

  it('refuses a 31-byte file, naming it', async () => {
    const path = join(dir, 'fips.key');
    writeFileSync(path, new Uint8Array(31), { mode: 0o600 });
    await expect(loadFipsKey(dir)).rejects.toSatisfy(
      (e: unknown) => e instanceof MeshStateError && (e as Error).message.includes(path),
    );
  });

  it('refuses 32 zero bytes, naming it', async () => {
    const path = join(dir, 'fips.key');
    writeFileSync(path, new Uint8Array(32), { mode: 0o600 });
    await expect(loadFipsKey(dir)).rejects.toSatisfy(
      (e: unknown) => e instanceof MeshStateError && (e as Error).message.includes(path),
    );
  });

  it("leaves a refused file's bytes unchanged", async () => {
    const path = join(dir, 'fips.key');
    const before = new Uint8Array(31);
    for (let i = 0; i < before.length; i++) before[i] = (i * 7 + 1) & 0xff;
    writeFileSync(path, before, { mode: 0o600 });
    await expect(loadFipsKey(dir)).rejects.toBeInstanceOf(MeshStateError);
    const after = new Uint8Array(readFileSync(path));
    expect(bytesEqual(after, before)).toBe(true);
  });

  it('dialKeyHex of an odd-parity identity x-only key is 02 followed by x', async () => {
    let id = await generateIdentity();
    for (let i = 0; i < 64 && id.publicKey[0] !== 0x03; i++) {
      id = await generateIdentity();
    }
    expect(id.publicKey[0]).toBe(0x03);
    const h = dialKeyHex(id.xOnlyPubkey);
    expect(h).toBe('02' + hex(id.xOnlyPubkey));
  });
});

