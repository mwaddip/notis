// MESH_INTERFACE → The IP certificate — the ACME account is persisted
// so a renewal does not re-register it. acme-client's `createAccount` on
// an existing key with no body sends an empty account update, which RFC
// 8555 servers refuse with `Use POST-as-GET to retrieve account data
// instead of doing an empty update`. The fix stores the account URL
// beside the account key after the first registration and constructs
// the client with `accountUrl` on later `obtain()` calls.

import 'reflect-metadata';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

// Keep call state in a hoisted record so the vi.mock factory, which runs
// at module load, can write to it.
const acmeCalls = vi.hoisted(() => ({
  constructorOpts: [] as Array<{ accountKey: unknown; accountUrl?: string }>,
  createAccountCalls: 0,
  getCertificateReturns: '',
}));

vi.mock('acme-client', () => ({
  default: {
    Client: vi.fn().mockImplementation((opts: { accountKey: unknown; accountUrl?: string }) => {
      acmeCalls.constructorOpts.push({ accountKey: opts.accountKey, accountUrl: opts.accountUrl });
      return {
        createAccount: vi.fn().mockImplementation(async () => { acmeCalls.createAccountCalls += 1; }),
        getAccountUrl: () => 'https://acme.test/account/42',
        createOrder: vi.fn().mockResolvedValue({ status: 'pending' }),
        getAuthorizations: vi.fn().mockResolvedValue([]),
        getChallengeKeyAuthorization: vi.fn().mockResolvedValue('key-auth'),
        completeChallenge: vi.fn().mockResolvedValue(undefined),
        waitForValidStatus: vi.fn().mockResolvedValue(undefined),
        finalizeOrder: vi.fn().mockResolvedValue({ certificate: 'https://acme.test/cert' }),
        getCertificate: vi.fn(async () => acmeCalls.getCertificateReturns),
      };
    }),
    crypto: {
      createPrivateKey: vi.fn(async () => Buffer.from('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n')),
      createCsr: vi.fn(async () => [Buffer.from('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n'), Buffer.from('csr')]),
    },
  },
}));

// Imports after vi.mock so acme.ts resolves to our fake.
import { acmeSource } from '../src/node/acme.js';

async function selfSignedPem(): Promise<string> {
  const keys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=127.0.0.1',
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 10 * 24 * 60 * 60 * 1000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: 'ip', value: '127.0.0.1' },
      ]),
    ],
  });
  return cert.toString('pem');
}

describe('acmeSource — account URL persistence', () => {
  const dirs: string[] = [];
  beforeAll(async () => { acmeCalls.getCertificateReturns = await selfSignedPem(); });
  afterEach(() => {
    acmeCalls.constructorOpts.length = 0;
    acmeCalls.createAccountCalls = 0;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('writes account-url.txt after first obtain() and skips createAccount on later obtain()', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mesh-acme-account-'));
    dirs.push(stateDir);
    const src = acmeSource({
      directoryUrl: 'https://acme.test/dir',
      ip: '127.0.0.1',
      stateDir,
      challengePort: 0,
    });

    await src.obtain();
    expect(acmeCalls.createAccountCalls, 'first obtain registers the account').toBe(1);
    const urlPath = join(stateDir, 'acme', 'account-url.txt');
    expect(existsSync(urlPath), 'account URL is persisted beside the key').toBe(true);
    expect(readFileSync(urlPath, 'utf8').trim()).toBe('https://acme.test/account/42');
    expect(acmeCalls.constructorOpts[0]?.accountUrl, 'first client has no accountUrl').toBeUndefined();

    acmeCalls.constructorOpts.length = 0;
    acmeCalls.createAccountCalls = 0;

    await src.obtain();
    expect(acmeCalls.createAccountCalls, 'second obtain must not re-register the account').toBe(0);
    expect(acmeCalls.constructorOpts[0]?.accountUrl, 'second client is constructed with accountUrl').toBe('https://acme.test/account/42');
  });
});
