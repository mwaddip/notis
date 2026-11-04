// MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists"
// — a mesh node's state directory holds the WebRTC-direct certificate
// and the keychain's stored private key. `@libp2p/webrtc@7.0.2`'s
// `loadCertificate` throws a non-`NotFoundError` for a certificate it
// cannot parse — which takes `start` down past libp2p's control — and
// silently replaces a certificate of another key, which changes every
// anchor's address. Both are caught here, before libp2p starts, as
// `MeshStateError` naming the directory, and the entry's bytes are
// unchanged after.
//
// Node-only: `FsDatastore` is a filesystem datastore.

import { X509Certificate } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Key } from 'interface-datastore';
import { FsDatastore } from 'datastore-fs';
import { keychain } from '@libp2p/keychain';
import type { ComponentLogger } from '@libp2p/interface';
import { MeshStateError } from './config.js';

// A silent `ComponentLogger` — the keychain reads
// `components.logger.forComponent(name)` and calls the returned
// logger as a function and through `.error` / `.trace`. A full
// `@libp2p/logger` is not a `@dagsocial/net` dependency here, and
// the precheck's success path writes nothing.
function silentLogger(): ComponentLogger {
  const log = Object.assign(
    (..._: unknown[]): void => { /* silent */ },
    {
      error: (..._: unknown[]): void => { /* silent */ },
      trace: (..._: unknown[]): void => { /* silent */ },
      enabled: false,
    },
  ) as never;
  return { forComponent: () => log } as unknown as ComponentLogger;
}

// `@libp2p/webrtc@7.0.2/dist/src/constants.js`.
const DEFAULT_CERTIFICATE_DATASTORE_KEY = '/libp2p/webrtc-direct/certificate';
const DEFAULT_CERTIFICATE_PRIVATE_KEY_NAME = 'webrtc-direct-certificate-private-key';

/**
 * Open the state directory's datastore, create the directory if absent,
 * and return the datastore ready for libp2p to use.
 */
export function openMeshDatastore(stateDir: string): FsDatastore {
  mkdirSync(stateDir, { recursive: true });
  return new FsDatastore(join(stateDir, 'datastore'));
}

/**
 * Hold the stored WebRTC-direct certificate against the keychain's
 * stored private key. If neither is present, there is nothing to catch
 * and the webrtc transport will create both at start. If one is
 * present without the other, or they are present but mismatched, or
 * the certificate does not parse, `MeshStateError`.
 *
 * The datastore is opened read-only here (no writes), so a refusal
 * leaves the directory as it is.
 */
export async function assertStateDirIntegrity(stateDir: string): Promise<void> {
  const ds = openMeshDatastore(stateDir);
  try {
    const certKey = new Key(DEFAULT_CERTIFICATE_DATASTORE_KEY);
    let certBytes: Uint8Array | null = null;
    try {
      certBytes = await ds.get(certKey);
    } catch (e) {
      if (!isNotFound(e)) {
        throw new MeshStateError(
          `mesh state directory ${JSON.stringify(stateDir)}: certificate read failed: ${(e as Error).message}`,
        );
      }
    }

    // Read the keychain's stored webrtc-direct private key, if any.
    // Pass-less keychain matches the libp2p configuration the node
    // starts with (`MESH_INTERFACE → Place in the workspace`).
    const kc = keychain()({ datastore: ds, logger: silentLogger() });
    let storedPublicKey: Uint8Array | null = null;
    let storedPublicJwk: { crv?: string; x?: string; y?: string } = {};
    try {
      const pk = await kc.exportKey(DEFAULT_CERTIFICATE_PRIVATE_KEY_NAME);
      storedPublicKey = pk.publicKey.raw;
      const jwk = (pk.publicKey as unknown as { jwk?: JsonWebKey }).jwk;
      if (jwk) {
        storedPublicJwk = { crv: jwk.crv, x: jwk.x, y: jwk.y };
      }
    } catch (e) {
      if (!isNotFound(e)) {
        throw new MeshStateError(
          `mesh state directory ${JSON.stringify(stateDir)}: keychain read failed: ${(e as Error).message}`,
        );
      }
    }

    if (certBytes === null && storedPublicKey === null) {
      // First start on a fresh directory.
      return;
    }
    if (certBytes === null) {
      throw new MeshStateError(
        `mesh state directory ${JSON.stringify(stateDir)}: keychain holds a WebRTC-direct private key but no certificate`,
      );
    }
    if (storedPublicKey === null) {
      throw new MeshStateError(
        `mesh state directory ${JSON.stringify(stateDir)}: a WebRTC-direct certificate is stored but the keychain holds no private key`,
      );
    }

    let cert: X509Certificate;
    try {
      // `@libp2p/webrtc@7.0.2` stores the certificate as PEM bytes
      // (`uint8ArrayFromString(cert.toString('pem'))`, transport.js
      // line 214). node:crypto's X509Certificate reads PEM as a
      // Buffer or string; a buffer whose bytes do not sniff as PEM
      // or DER throws here.
      cert = new X509Certificate(Buffer.from(certBytes));
    } catch (e) {
      throw new MeshStateError(
        `mesh state directory ${JSON.stringify(stateDir)}: stored WebRTC-direct certificate did not parse: ${(e as Error).message}`,
      );
    }

    // The keychain holds a libp2p ECDSA key whose `publicKey.jwk`
    // names the same P-256 curve the certificate carries. Compare the
    // JWK `x` and `y` coordinates against the certificate's public key
    // exported as JWK — this spelling is stable across libp2p's PKI
    // encoding and Node's SPKI.
    let certJwk: JsonWebKey;
    try {
      certJwk = cert.publicKey.export({ format: 'jwk' }) as JsonWebKey;
    } catch (e) {
      throw new MeshStateError(
        `mesh state directory ${JSON.stringify(stateDir)}: stored WebRTC-direct certificate's public key could not be read: ${(e as Error).message}`,
      );
    }
    if (storedPublicJwk.crv !== certJwk.crv
        || storedPublicJwk.x !== certJwk.x
        || storedPublicJwk.y !== certJwk.y) {
      throw new MeshStateError(
        `mesh state directory ${JSON.stringify(stateDir)}: stored WebRTC-direct certificate belongs to a different key`,
      );
    }
  } finally {
    // FsDatastore has no explicit close; the handle goes with GC. The
    // one process-wide file handle libp2p will open on the same
    // directory is a fresh one.
  }
}

function isNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: string }).name;
  return name === 'NotFoundError';
}
