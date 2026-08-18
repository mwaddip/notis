import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { profileFor } from '@dagsocial/types';
import { loadConfig } from '../src/config.js';

let dir: string;
let keyPath: string;
let pubHex: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'faucet-'));
  keyPath = join(dir, 'faucet.key');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  writeFileSync(keyPath, pkcs8.toString('hex') + '\n', { mode: 0o600 });
  pubHex = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .subarray(-32).toString('hex');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = (over: Record<string, string> = {}) => ({
  NODE_URL: 'http://localhost:3000',
  NETWORK_TYPE: 'testnet',
  FAUCET_KEY_PATH: keyPath,
  FAUCET_PUBLIC_KEY: pubHex,
  FAUCET_BOND_AMOUNT: '250',
  FAUCET_CREDIT_AMOUNT: '100000000000',
  ...over,
}) as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('loads a well-formed environment', () => {
    const cfg = loadConfig(env());
    expect(cfg.publicKeyHex).toBe(pubHex);
    expect(cfg.bondAmount).toBe(250n);
    expect(cfg.networkType).toBe('testnet');
    expect(cfg.port).toBe(3100);            // default
    expect(cfg.rateLimitPerHour).toBe(5);   // default
  });

  it('strips a trailing slash from the node URL', () => {
    expect(loadConfig(env({ NODE_URL: 'http://x/testnet/api/' })).nodeUrl)
      .toBe('http://x/testnet/api');
  });

  // ⛔ The refusal that matters most: a key file that does not derive the
  // configured public key would sign transactions the node attributes to a box
  // the faucet does not own, and every invite would fail at signature check
  // with no hint that the KEY is wrong.
  it('refuses a key file that does not derive the configured public key', () => {
    const other = generateKeyPairSync('ed25519');
    const otherHex = (other.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
      .subarray(-32).toString('hex');
    expect(() => loadConfig(env({ FAUCET_PUBLIC_KEY: otherHex })))
      .toThrow(/does not derive/);
  });

  it('refuses a missing key file, naming the path', () => {
    expect(() => loadConfig(env({ FAUCET_KEY_PATH: '/nonexistent/k' })))
      .toThrow(/nonexistent/);
  });

  it('refuses a key file that is not a PKCS8 DER secret', () => {
    const junk = join(dir, 'junk.key');
    writeFileSync(junk, 'aabbccdd\n', { mode: 0o600 });
    expect(() => loadConfig(env({ FAUCET_KEY_PATH: junk })))
      .toThrow(/not an Ed25519 PKCS8 DER secret/);
  });

  it('refuses a bond below the network floor', () => {
    expect(() => loadConfig(env({ FAUCET_BOND_AMOUNT: '1' }))).toThrow(/bond/i);
  });

  it('refuses a bond above the network ceiling', () => {
    expect(() => loadConfig(env({ FAUCET_BOND_AMOUNT: '1001' }))).toThrow(/bond/i);
  });

  // ⛔ The range is the NETWORK's, not the universal constants'. Testnet's
  // ceiling is four times `INVITE_BOND_MAX`, so a bond the node accepts every
  // day sits above the universal one — a check written against the constants
  // refuses a working configuration at startup and names the bond as the fault.
  it('accepts a bond the network allows and the universal ceiling does not', () => {
    const testnetMax = profileFor('testnet').inviteBondMax;
    expect(testnetMax).toBeGreaterThan(profileFor('mainnet').inviteBondMax);
    const cfg = loadConfig(env({ FAUCET_BOND_AMOUNT: String(testnetMax) }));
    expect(cfg.bondAmount).toBe(testnetMax);
  });

  it('refuses a malformed public key', () => {
    expect(() => loadConfig(env({ FAUCET_PUBLIC_KEY: 'XYZ' })))
      .toThrow(/64 lowercase hex/);
  });

  it('refuses an unknown network', () => {
    expect(() => loadConfig(env({ NETWORK_TYPE: 'staging' })))
      .toThrow(/NETWORK_TYPE/);
  });

  it('refuses a non-integer port rather than listening on a random one', () => {
    expect(() => loadConfig(env({ PORT: 'auto' }))).toThrow(/PORT/);
  });

  it('refuses a rate limit that is not a positive integer', () => {
    expect(() => loadConfig(env({ RATE_LIMIT_PER_HOUR: '0' })))
      .toThrow(/RATE_LIMIT_PER_HOUR/);
  });

  it('refuses a non-numeric amount, naming the variable', () => {
    expect(() => loadConfig(env({ FAUCET_CREDIT_AMOUNT: 'lots' })))
      .toThrow(/FAUCET_CREDIT_AMOUNT/);
  });

  it('never puts key material in a thrown message', () => {
    const secretHex = readFileSync(keyPath, 'utf8').trim();
    let message = '';
    try {
      loadConfig(env({ FAUCET_BOND_AMOUNT: '1' }));
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/bond/i);
    expect(message).not.toContain(secretHex);
  });
});
