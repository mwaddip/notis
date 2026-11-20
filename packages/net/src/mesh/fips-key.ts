// MESH_INTERFACE → FIPS → "A node's FIPS key persists" — the one reader
// and writer of a node's FIPS key file. The file holds the 32 raw bytes
// of fips-ts's `FipsIdentity.secretKey`. A file of any other length, a
// secret fips-ts refuses, or a path that cannot be read or written stops
// the node at start with `MeshStateError` naming the path, and the file
// is left as it is.
//
// Node-only: imports `node:fs`.

import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentity, identityFromSecretKey } from '@fips/core';
import type { FipsIdentity } from '@fips/core';
import { MeshStateError } from './config.js';

const FIPS_KEY_FILE = 'fips.key';
const FIPS_SECRET_KEY_LEN = 32;

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS key persists" — reads
 * `<stateDir>/fips.key` and answers the identity. Where no file is at
 * the path, writes a fresh key with mode `0600` opened exclusively and
 * answers it. Refuses a file of any other length than 32 bytes, a
 * secret fips-ts refuses, or a path that cannot be read or written
 * with `MeshStateError` naming the path, leaving the file's bytes as
 * they were.
 */
export async function loadFipsKey(stateDir: string): Promise<FipsIdentity> {
  const path = join(stateDir, FIPS_KEY_FILE);
  // Create the directory if absent, as `openMeshDatastore` does — the
  // FIPS key shares the mesh state directory with the WebRTC-direct
  // datastore (MESH_INTERFACE → FIPS → "A node's FIPS key persists").
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    throw new MeshStateError(`${path}: ${(err as Error).message}`);
  }

  let secret: Uint8Array | null = null;
  try {
    const buf = await readFile(path);
    secret = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new MeshStateError(`${path}: ${(err as Error).message}`);
    }
  }

  if (secret !== null) {
    if (secret.length !== FIPS_SECRET_KEY_LEN) {
      throw new MeshStateError(
        `${path}: fips.key length ${secret.length}, must be ${FIPS_SECRET_KEY_LEN}`,
      );
    }
    try {
      return await identityFromSecretKey(secret);
    } catch (err) {
      throw new MeshStateError(`${path}: ${(err as Error).message}`);
    }
  }

  const fresh = await generateIdentity();
  try {
    await writeFile(path, fresh.secretKey, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    throw new MeshStateError(`${path}: ${(err as Error).message}`);
  }
  return fresh;
}
