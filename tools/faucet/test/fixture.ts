import { createPublicKey, generateKeyPairSync, verify } from 'crypto';
import { ED25519_SPKI_PREFIX } from '@dagsocial/types';
import type { FaucetConfig } from '../src/config.js';

// ⛔ Box ids are 64 hex characters. `computeTxId` writes inputs through
// `writeHexNOrThrow`, so a short stand-in throws before any assertion runs.
export const B1 = '11'.repeat(32);
export const B2 = '22'.repeat(32);
export const C1 = '33'.repeat(32);
export const K1 = '44'.repeat(32);

const kp = generateKeyPairSync('ed25519');
export const pkcs8 = kp.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
export const pubHex = (kp.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32).toString('hex');

export const recipient = 'aa'.repeat(32);

/**
 * The era a fixture transaction declares — the one the default schedule `[1@0]`
 * fixes at any fixture height, which is what a node on that schedule answers
 * from `GET /status` (NODE_INTERFACE → Status). The builders stamp the era the
 * node reports, so a fixture passes this as that era.
 */
export const ERA = 1;

export const baseCfg: FaucetConfig = {
  nodeUrl: 'http://x',
  networkType: 'testnet',
  publicKeyHex: pubHex,
  secretKey: pkcs8,
  bondAmount: 250n,
  creditAmount: 1n,
  port: 1,
  rateLimitPerHour: 1,
};

export const outputsOf = (tx: Record<string, unknown>): Record<string, unknown>[] =>
  tx.outputs as Record<string, unknown>[];

/** The project's verification shape: raw Ed25519 over the id bytes, KeyObject from SPKI. */
export function verifies(tx: Record<string, unknown>, txId: string, ownerHex: string): boolean {
  const sigHex = (tx.signatures as Record<string, string>)[ownerHex]!;
  const spki = Buffer.concat([
    Buffer.from(ED25519_SPKI_PREFIX, 'hex'),
    Buffer.from(ownerHex, 'hex'),
  ]);
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return verify(null, Buffer.from(txId, 'hex'), pub, Buffer.from(sigHex, 'hex'));
}
