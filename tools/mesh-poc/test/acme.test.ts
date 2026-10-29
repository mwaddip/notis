// MESH_INTERFACE → The IP certificate — the renewal step is a pure function
// of the certificate and the time: `renew` at half the lifetime, `serve` until
// then (every `nextCheckMs` capped at `notAfter`), `stop-wss` at `notAfter`
// whatever else, and after a failure `serve` until `lastFailureMs +
// CERT_RETRY_MS` before trying again.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import {
  acmeSource,
  renewAtMs,
  renewalStep,
  type IpCertificate,
} from '../src/node/acme.js';
import { CERT_RETRY_MS } from '../src/protocols.js';

const H = 3_600_000;

function cert(notBefore: number, notAfter: number): IpCertificate {
  return { certPem: '', keyPem: '', notBefore, notAfter };
}

describe('acme — renewAtMs and renewalStep', () => {
  it('renewal at half the lifetime', () => {
    // MESH_INTERFACE → The IP certificate — "renews it at half its lifetime,
    // `notBefore + (notAfter − notBefore) / 2`".
    expect(renewAtMs({ notBefore: 0, notAfter: 160 * H })).toBe(80 * H);
  });

  it('serve before, renew after', () => {
    const c = cert(0, 160 * H);
    expect(renewalStep(c, 79 * H, null)).toEqual({
      act: 'serve',
      nextCheckMs: 80 * H,
    });
    expect(renewalStep(c, 80 * H, null)).toEqual({ act: 'renew' });
  });

  it('a failed renewal retries hourly and keeps serving', () => {
    // MESH_INTERFACE → The IP certificate — "A failed renewal is retried
    // every `CERT_RETRY_MS` while the current certificate serves".
    const c = cert(0, 160 * H);
    expect(renewalStep(c, 90 * H, 89.5 * H)).toEqual({
      act: 'serve',
      nextCheckMs: 89.5 * H + CERT_RETRY_MS,
    });
    expect(renewalStep(c, 90.5 * H, 89.5 * H)).toEqual({ act: 'renew' });
  });

  it('a retry never runs past notAfter', () => {
    // 159.4 h + CERT_RETRY_MS (1 h) = 160.4 h; capped at notAfter = 160 h.
    const c = cert(0, 160 * H);
    const step = renewalStep(c, 159.5 * H, 159.4 * H);
    expect(step.act).toBe('serve');
    expect((step as { nextCheckMs: number }).nextCheckMs).toBe(160 * H);
  });

  it('the listener stops at notAfter', () => {
    // MESH_INTERFACE → The IP certificate — "At `notAfter` the WebSocket
    // listener stops", whatever the failure state.
    const c = cert(0, 160 * H);
    expect(renewalStep(c, 160 * H, null)).toEqual({ act: 'stop-wss' });
    expect(renewalStep(c, 160 * H, 159.5 * H)).toEqual({ act: 'stop-wss' });
  });
});

// A self-signed PEM pair for `acmeSource.current()` to parse — generated
// at the test's start-up so the file is a real X.509 that `X509Certificate`
// reads back without a trust anchor.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

async function selfSignedPair(): Promise<{ certPem: string; keyPem: string }> {
  const keys = await x509.cryptoProvider.get().subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=127.0.0.1',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: 'ip', value: '127.0.0.1' },
      ]),
    ],
  });
  const pkcs8 = await x509.cryptoProvider.get().subtle.exportKey(
    'pkcs8',
    keys.privateKey,
  );
  const keyPem =
    '-----BEGIN PRIVATE KEY-----\n' +
    Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g)!.join('\n') +
    '\n-----END PRIVATE KEY-----\n';
  return { certPem: cert.toString('pem'), keyPem };
}

describe('acme — acmeSource reads the state directory', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it.fails('a leftover temp file beside a good certificate file is ignored', async () => {
    // MESH_INTERFACE → The IP certificate — "The certificate and its key
    // live under `<stateDir>/acme/`". A crash between writes leaves a temp
    // name that the next start must not treat as the current certificate.
    // The implementation writes `<stateDir>/acme/wss-cert.json` atomically
    // through `tempname + rename`.
    const stateDir = mkdtempSync(join(tmpdir(), 'mesh-acme-'));
    dirs.push(stateDir);
    const acmeDir = join(stateDir, 'acme');
    mkdirSync(acmeDir, { recursive: true });
    const good = await selfSignedPair();
    writeFileSync(join(acmeDir, 'wss-cert.json'), JSON.stringify(good));
    // A leftover temp file from a prior crashed write.
    writeFileSync(
      join(acmeDir, 'wss-cert.json.tmp.deadbeef'),
      '{"bogus":true}',
    );
    const src = acmeSource({
      directoryUrl: 'http://127.0.0.1:0/',
      ip: '127.0.0.1',
      stateDir,
    });
    const got = await src.current();
    expect(got).not.toBeNull();
    expect(got!.certPem).toBe(good.certPem);
    expect(got!.keyPem).toBe(good.keyPem);
    // The notBefore/notAfter are read from the certificate itself.
    const parsed = new X509Certificate(good.certPem);
    expect(got!.notBefore).toBe(new Date(parsed.validFrom).getTime());
    expect(got!.notAfter).toBe(new Date(parsed.validTo).getTime());
  });
});
