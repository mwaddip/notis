import { readFileSync } from 'fs';
import { createPrivateKey, createPublicKey } from 'crypto';
import { NETWORK_PROFILES, profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';

export interface FaucetConfig {
  readonly nodeUrl: string;
  readonly networkType: NetworkType;
  readonly publicKeyHex: string;
  readonly secretKey: Buffer;
  readonly bondAmount: bigint;
  readonly creditAmount: bigint;
  readonly port: number;
  readonly rateLimitPerHour: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]+$/;

/**
 * Turn the environment into a validated config, or throw naming what is wrong.
 *
 * ⛔ **Every refusal is at startup, not per request.** A bond outside the
 * network's range makes the node reject every invite with a message about the
 * bond, which reads as a broken faucet rather than a misconfigured one.
 *
 * ⛔ **No message here carries key material.** The path is named, the bytes
 * never are.
 */
export function loadConfig(env: NodeJS.ProcessEnv): FaucetConfig {
  const nodeUrl = req(env, 'NODE_URL');

  // ⛔ **The bond range is PER-NETWORK, so the network has to be stated**
  // (TYPES_INTERFACE → Network profiles). The universal constants are one
  // profile's values, not a bound over all of them: a network's ceiling may sit
  // above `INVITE_BOND_MAX` and its floor below `INVITE_BOND_MIN`, so a check
  // written against the constants refuses configurations the node accepts and
  // blames the bond for it.
  const raw = req(env, 'NETWORK_TYPE');
  if (!Object.hasOwn(NETWORK_PROFILES, raw)) {
    throw new Error(
      `NETWORK_TYPE is ${JSON.stringify(raw)} — expected 'mainnet' | 'testnet' | 'devnet'`,
    );
  }
  const networkType = raw as NetworkType;
  const profile = profileFor(networkType);

  const publicKeyHex = req(env, 'FAUCET_PUBLIC_KEY');
  if (!HEX64.test(publicKeyHex)) {
    throw new Error('FAUCET_PUBLIC_KEY must be 64 lowercase hex characters, an Ed25519 public key');
  }

  const keyPath = req(env, 'FAUCET_KEY_PATH');
  let secretKey: Buffer;
  try {
    secretKey = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex');
  } catch {
    throw new Error(`Cannot read the faucet key at ${keyPath}`);
  }

  // ⛔ The key and its declared identity must agree, or every signature is
  // attributed to a box this service does not own. The underlying decode error
  // is replaced rather than wrapped: it is raised over the secret bytes, and
  // nothing derived from them may reach a log.
  let derived: string;
  try {
    derived = (createPublicKey(
      createPrivateKey({ key: secretKey, format: 'der', type: 'pkcs8' }),
    ).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
  } catch {
    throw new Error(`The file at ${keyPath} is not an Ed25519 PKCS8 DER secret, hex-encoded`);
  }
  if (derived !== publicKeyHex) {
    throw new Error(
      `The key at ${keyPath} does not derive FAUCET_PUBLIC_KEY. Refusing to start — ` +
      'every transaction it signed would be attributed to a box it does not own.',
    );
  }

  const bondAmount = amount(env, 'FAUCET_BOND_AMOUNT');
  if (bondAmount < profile.inviteBondMin || bondAmount > profile.inviteBondMax) {
    throw new Error(
      `FAUCET_BOND_AMOUNT is ${bondAmount}, outside ${networkType}'s invite bond range ` +
      `[${profile.inviteBondMin}, ${profile.inviteBondMax}]. Every invite would be rejected.`,
    );
  }

  return {
    nodeUrl: nodeUrl.replace(/\/$/, ''),
    networkType,
    publicKeyHex,
    secretKey,
    bondAmount,
    creditAmount: amount(env, 'FAUCET_CREDIT_AMOUNT'),
    port: positiveInt(env, 'PORT', 3100, 65535),
    rateLimitPerHour: positiveInt(env, 'RATE_LIMIT_PER_HOUR', 5),
  };
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') throw new Error(`${name} is required`);
  return v.trim();
}

/** A base-units amount. Decimal text only — `BigInt()` alone reports the value, not the variable. */
function amount(env: NodeJS.ProcessEnv, name: string): bigint {
  const v = req(env, name);
  if (!DECIMAL.test(v)) {
    throw new Error(`${name} must be a non-negative decimal integer in base units, got ${v}`);
  }
  return BigInt(v);
}

/**
 * An optional positive integer.
 *
 * ⚠ **`Number()` alone answers `NaN` for anything unparseable**, and a `NaN`
 * port makes `listen` pick a free one — a misconfiguration that starts cleanly
 * and serves on an address nothing is proxying to.
 */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max?: number): number {
  const v = env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const t = v.trim();
  const n = DECIMAL.test(t) ? Number(t) : NaN;
  if (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max)) {
    throw new Error(`${name} must be a positive integer${max !== undefined ? ` below ${max + 1}` : ''}, got ${t}`);
  }
  return n;
}
