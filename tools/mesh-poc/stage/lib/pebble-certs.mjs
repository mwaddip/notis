// MESH_INTERFACE → The IP certificate — Pebble's v2.8.0 release ships only
// the binary (no sample certs), and even its repo's `localhost` cert does
// not name `10.100.0.21`. The stage generates its own: a self-signed CA
// and a Pebble TLS server certificate signed by it, whose SAN names
// Pebble's bare IP.
//
// `pub1`'s mesh node trusts the stage CA through `NODE_EXTRA_CA_CERTS`.
// Every curl to Pebble passes `--cacert <stage-ca>` instead of `-k`.
//
// @peculiar/x509@2 pulls in tsyringe; `reflect-metadata` must load before
// any of its modules. Keys live under `0o600`, certs under `0o644`.

import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto);

const ECDSA = { name: 'ECDSA', hash: 'SHA-256', namedCurve: 'P-256' };

function foldPem(label, b64) {
  const chunks = b64.match(/.{1,64}/g);
  if (chunks === null) throw new Error('empty PEM body');
  return `-----BEGIN ${label}-----\n${chunks.join('\n')}\n-----END ${label}-----\n`;
}

async function exportPrivateKeyPem(privateKey) {
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', privateKey);
  return foldPem('PRIVATE KEY', Buffer.from(pkcs8).toString('base64'));
}

export async function generateStageCerts({ outDir, pebbleIp }) {
  if (typeof outDir !== 'string' || outDir === '') throw new Error('generateStageCerts: outDir required');
  if (typeof pebbleIp !== 'string' || pebbleIp === '') throw new Error('generateStageCerts: pebbleIp required');

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  // Stage CA: self-signed, long-lived (1 year is enough for a POC), the
  // only CA `pub1` adds to its trust store.
  const caKeys = await webcrypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=mesh-poc stage CA',
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 365 * DAY),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });

  // Pebble TLS server certificate: signed by the stage CA, SAN names the
  // Pebble host's bare IP so pub1's ACME HTTPS client accepts it.
  const serverKeys = await webcrypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const serverCert = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    issuer: caCert.subject,
    subject: `CN=${pebbleIp}`,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 90 * DAY),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    publicKey: serverKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, 0, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: 'ip', value: pebbleIp },
      ]),
    ],
  });

  const caPath = join(outDir, 'stage-ca.pem');
  const caKeyPath = join(outDir, 'stage-ca-key.pem');
  const serverCertPath = join(outDir, 'pebble-server-cert.pem');
  const serverKeyPath = join(outDir, 'pebble-server-key.pem');

  writeFileSync(caPath, caCert.toString('pem'), { mode: 0o644 });
  writeFileSync(caKeyPath, await exportPrivateKeyPem(caKeys.privateKey), { mode: 0o600 });
  writeFileSync(serverCertPath, serverCert.toString('pem'), { mode: 0o644 });
  writeFileSync(serverKeyPath, await exportPrivateKeyPem(serverKeys.privateKey), { mode: 0o600 });

  return { caPath, caKeyPath, serverCertPath, serverKeyPath };
}
