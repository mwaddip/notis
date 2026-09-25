import { createHash, generateKeyPairSync, type KeyObject } from 'crypto';
import { canonicalBoxBytes, computeBoxId, u32BE } from '@dagsocial/types';
import type { AnyBox, BoxId } from '@dagsocial/types';

/**
 * Convert a short string label to a deterministic 32-byte Uint8Array
 * suitable as a UserId (Ed25519 public key) for testing.
 */
export function uid(label: string): Uint8Array {
  const h = createHash('blake2b512').update(label).digest();
  return new Uint8Array(h.subarray(0, 32));
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
export function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

export interface TestIdentity {
  userId: Uint8Array;
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

export function makeTestIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubKey = rawPublicKey(publicKey);
  const userId = pubKey;
  return { userId, publicKey: pubKey, privateKey };
}

/**
 * A `u32BE`-encodable nonce derived from a caller-supplied label.
 *
 * Deterministic, so a fixture built twice with the same label gets the same
 * ids across runs and file orderings. Masked to 31 bits so the value can
 * never reach `U32_SENTINEL` (`0xffffffff`), which `u32BE` reserves for the
 * un-encodable case.
 */
export function labelNonce(label: string): number {
  const h = createHash('blake2b512').update(label).digest();
  return h.readUInt32BE(0) & 0x7fffffff;
}

/**
 * Synthetic creating-transaction provenance for a seeded fixture box.
 *
 * Fixtures seed boxes directly rather than through a real transaction or a
 * mint, so they have no txId of their own — but `tx_id` and `output_index`
 * are NOT NULL, and the box id derives from them (NODE_INTERFACE → Box
 * Identity and Mint Provenance). This manufactures a stand-in, deterministic
 * on the candidate bytes plus the seed height and nonce, with its own domain
 * tag so a fixture id can never be mistaken for one a real mint or
 * transaction would produce.
 */
const FIXTURE_TX_DOMAIN = new TextEncoder().encode('dagsocial/test-fixture-tx/1');

export function fixtureProvenance(
  candidate: object,
  seedHeight: number,
  nonce = 0,
): { txId: string; index: number } {
  const txId = createHash('blake2b512')
    .update(FIXTURE_TX_DOMAIN)
    .update(canonicalBoxBytes(candidate as never))
    .update(u32BE(seedHeight))
    .update(u32BE(nonce))
    .digest()
    .subarray(0, 32)
    .toString('hex');
  return { txId, index: 0 };
}

/**
 * A box as it exists once seeded: `id` present.
 *
 * `BoxBase.id` is optional because it is genuinely absent for one
 * expression — between building the candidate-plus-provenance object and
 * hashing it. A box that has been through `seedProvenance` is past that
 * point.
 */
export type Stored<B extends AnyBox = AnyBox> = B & { id: BoxId };

/**
 * Give a hand-built candidate the provenance and id a stored box must have.
 *
 * Mutates in place so a factory that already holds a reference to the
 * candidate keeps seeing the finished box. `computeBoxId(result) ===
 * result.id` holds for everything it returns.
 */
export function seedProvenance<T extends AnyBox>(
  candidate: object,
  seedHeight = 1,
  nonce = 0,
): Stored<T> {
  Object.assign(candidate, fixtureProvenance(candidate, seedHeight, nonce));
  Object.assign(candidate, { id: computeBoxId(candidate as T) });
  return candidate as Stored<T>;
}

/**
 * The bond the fixtures name where the value is incidental — any amount
 * inside the running profile's range, which the devnet profile floors at 5
 * and caps at 250.
 */
export const FIXTURE_BOND_KARMA = 25n;
