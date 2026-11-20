// MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
// — the `fips` multiaddr protocol is Notis's, numbered `FIPS_MULTIADDR_CODE`
// from multicodec's private-use range: its value is the npub as text and
// the 32-byte x-only key as bytes.
//
// Browser-safe: imports no Node built-in.

import { multiaddr, registry } from '@multiformats/multiaddr';
import type { Multiaddr } from '@multiformats/multiaddr';
import {
  encodeNpub,
  decodeNpub,
  X_ONLY_PUBKEY_LENGTH,
} from '@fips/core';
import { FIPS_MULTIADDR_CODE } from './constants.js';

export const FIPS_PROTOCOL_NAME = 'fips';

let registered = false;

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — register the `fips` multiaddr protocol with `@multiformats/multiaddr`'s
 * `registry`. Idempotent: a second call is a no-op.
 */
export function registerFipsProtocol(): void {
  if (registered) return;
  registry.addProtocol({
    code: FIPS_MULTIADDR_CODE,
    name: FIPS_PROTOCOL_NAME,
    // A variable-length value: the npub string, bech32-encoded over the
    // 32-byte x-only key.
    size: -1,
    stringToValue(value) {
      // Refuses a value that is not a valid npub.
      decodeNpub(value);
      return value;
    },
    valueToString(value) {
      return value;
    },
    valueToBytes(value) {
      // `@multiformats/multiaddr`'s registry requires a `Uint8Array<ArrayBuffer>`;
      // fips-ts's `decodeNpub` answers over a `SharedArrayBuffer`-permissive
      // backing store (`ArrayBufferLike`), so the bytes are copied into a
      // fresh array first.
      const bytes = decodeNpub(value);
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      return copy;
    },
    bytesToValue(bytes) {
      return encodeNpub(bytes);
    },
    validate(value) {
      decodeNpub(value);
    },
  });
  registered = true;
}

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — build the multiaddr `/fips/<npub>/p2p/<peerId>` from the key's x-only
 * form and the libp2p peer id.
 */
export function fipsMultiaddr(xOnly: Uint8Array, peerId: string): Multiaddr {
  registerFipsProtocol();
  if (xOnly.length !== X_ONLY_PUBKEY_LENGTH) {
    throw new Error(`fips multiaddr: x-only key length ${xOnly.length}, must be ${X_ONLY_PUBKEY_LENGTH}`);
  }
  return multiaddr(`/${FIPS_PROTOCOL_NAME}/${encodeNpub(xOnly)}/p2p/${peerId}`);
}

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — read the x-only key and the peer id from a `/fips/<npub>/p2p/<peerId>`
 * multiaddr, or answer null when the address is not exactly that shape.
 */
export function parseFipsMultiaddr(
  ma: Multiaddr,
): { xOnly: Uint8Array; peerId: string } | null {
  const components = ma.getComponents();
  if (components.length !== 2) return null;
  const [first, second] = components;
  if (!first || first.name !== FIPS_PROTOCOL_NAME) return null;
  if (!second || second.name !== 'p2p') return null;
  if (first.value === undefined || second.value === undefined) return null;
  let xOnly: Uint8Array;
  try {
    xOnly = decodeNpub(first.value);
  } catch {
    return null;
  }
  return { xOnly, peerId: second.value };
}

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — true when the first component of `ma` is the `fips` protocol.
 */
export function isFipsMultiaddr(ma: Multiaddr): boolean {
  const components = ma.getComponents();
  const first = components[0];
  return !!first && first.name === FIPS_PROTOCOL_NAME;
}
