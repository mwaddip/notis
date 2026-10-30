// MESH_INTERFACE → The IP certificate — Pebble reuses a valid
// authorization for an identifier half the time by default (its config's
// `authzReuse`), and Let's Encrypt reuses them too. `obtain()`'s second
// run then sees `authz.status === 'valid'` and must skip the challenge;
// `completeChallenge` on a valid authorization fails RFC 8555 with
// `Cannot update challenge with status valid, only status pending`.
//
// The fake ACME here answers one `valid` authz and one `pending` authz;
// `completeChallenge` is called exactly once, for the pending identifier.

import 'reflect-metadata';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

interface Authz {
  readonly identifier: { readonly type: 'ip'; readonly value: string };
  readonly status: 'valid' | 'pending';
  readonly challenges: ReadonlyArray<{ readonly type: string; readonly token: string }>;
}

const acmeCalls = vi.hoisted(() => ({
  authorizations: [] as Authz[],
  completeChallengeTokens: [] as string[],
  waitForValidStatusTokens: [] as string[],
  getCertificateReturns: '',
}));

vi.mock('acme-client', () => ({
  default: {
    Client: vi.fn().mockImplementation(() => ({
      createAccount: vi.fn().mockResolvedValue(undefined),
      getAccountUrl: () => 'https://acme.test/account/1',
      createOrder: vi.fn().mockResolvedValue({ status: 'pending' }),
      getAuthorizations: vi.fn(async () => acmeCalls.authorizations),
      getChallengeKeyAuthorization: vi.fn(async () => 'key-auth'),
      completeChallenge: vi.fn(async (c: { token: string }) => {
        acmeCalls.completeChallengeTokens.push(c.token);
      }),
      waitForValidStatus: vi.fn(async (c: { token: string }) => {
        acmeCalls.waitForValidStatusTokens.push(c.token);
      }),
      finalizeOrder: vi.fn().mockResolvedValue({ certificate: 'https://acme.test/cert' }),
      getCertificate: vi.fn(async () => acmeCalls.getCertificateReturns),
    })),
    crypto: {
      createPrivateKey: vi.fn(async () => Buffer.from('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n')),
      createCsr: vi.fn(async () => [Buffer.from('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n'), Buffer.from('csr')]),
    },
  },
}));

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

describe('acmeSource — authorization reuse', () => {
  const dirs: string[] = [];
  beforeAll(async () => { acmeCalls.getCertificateReturns = await selfSignedPem(); });
  afterEach(() => {
    acmeCalls.authorizations.length = 0;
    acmeCalls.completeChallengeTokens.length = 0;
    acmeCalls.waitForValidStatusTokens.length = 0;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it.fails('skips a valid authorization and completes only the pending one', async () => {
    acmeCalls.authorizations.push(
      {
        identifier: { type: 'ip', value: '10.100.0.11' },
        status: 'valid',
        challenges: [{ type: 'http-01', token: 'tok-valid' }],
      },
      {
        identifier: { type: 'ip', value: '10.100.0.11' },
        status: 'pending',
        challenges: [{ type: 'http-01', token: 'tok-pending' }],
      },
    );
    const stateDir = mkdtempSync(join(tmpdir(), 'mesh-acme-authz-'));
    dirs.push(stateDir);
    const src = acmeSource({
      directoryUrl: 'https://acme.test/dir',
      ip: '127.0.0.1',
      stateDir,
      challengePort: 0,
    });

    await src.obtain();
    expect(acmeCalls.completeChallengeTokens, 'completeChallenge is called for the pending token alone').toEqual(['tok-pending']);
    expect(acmeCalls.waitForValidStatusTokens, 'waitForValidStatus is called for the pending token alone').toEqual(['tok-pending']);
  });

  it.fails('a solely-valid authorization completes no challenges and still finalizes the order', async () => {
    acmeCalls.authorizations.push({
      identifier: { type: 'ip', value: '10.100.0.11' },
      status: 'valid',
      challenges: [{ type: 'http-01', token: 'tok-reused' }],
    });
    const stateDir = mkdtempSync(join(tmpdir(), 'mesh-acme-authz-'));
    dirs.push(stateDir);
    const src = acmeSource({
      directoryUrl: 'https://acme.test/dir',
      ip: '127.0.0.1',
      stateDir,
      challengePort: 0,
    });

    await src.obtain();
    expect(acmeCalls.completeChallengeTokens, 'no challenge is answered for a reused authz').toEqual([]);
    expect(acmeCalls.waitForValidStatusTokens, 'nothing to wait for either').toEqual([]);
  });
});
