// MESH_INTERFACE → The IP certificate — the stage's own CA and the Pebble
// server certificate that CA signs. Pebble's TLS is served under the server
// cert whose SAN names the Pebble host's IP; `pub1`'s mesh node trusts the
// stage CA through `NODE_EXTRA_CA_CERTS`. The release tarball holds the
// Pebble binary and nothing else, so the stage has to produce these two.

// @peculiar/x509@2 pulls in tsyringe; the Reflect polyfill must load before
// any of its modules.
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
import { generateStageCerts } from '../stage/lib/pebble-certs.mjs';

// @peculiar/x509 reads a WebCrypto provider at module scope; set it once
// here so every parser call below has one.
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

describe('stage/lib/pebble-certs.mjs', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mesh-certs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it.fails('generates stage-ca.pem, pebble-server-cert.pem and pebble-server-key.pem', async () => {
    const paths = await generateStageCerts({ outDir: dir, pebbleIp: '10.100.0.21' });
    expect(existsSync(paths.caPath), paths.caPath).toBe(true);
    expect(existsSync(paths.serverCertPath), paths.serverCertPath).toBe(true);
    expect(existsSync(paths.serverKeyPath), paths.serverKeyPath).toBe(true);
    expect(readFileSync(paths.caPath, 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
    expect(readFileSync(paths.serverCertPath, 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
    expect(readFileSync(paths.serverKeyPath, 'utf8')).toContain('-----BEGIN PRIVATE KEY-----');
  }, 20_000);

  it.fails('the server cert carries the IP in its SubjectAlternativeName', async () => {
    const paths = await generateStageCerts({ outDir: dir, pebbleIp: '10.100.0.21' });
    const certPem = readFileSync(paths.serverCertPath, 'utf8');
    const cert = new x509.X509Certificate(certPem);
    const san = cert.getExtension(x509.SubjectAlternativeNameExtension) as x509.SubjectAlternativeNameExtension | null;
    expect(san, 'the server cert has a SubjectAlternativeName extension').not.toBeNull();
    const names = san!.names.toJSON();
    const ipNames = names.filter((n) => n.type === 'ip').map((n) => n.value);
    expect(ipNames, `IP SANs: ${JSON.stringify(ipNames)}`).toContain('10.100.0.21');
  }, 20_000);

  it.fails('the server cert chains to the stage CA', async () => {
    const paths = await generateStageCerts({ outDir: dir, pebbleIp: '10.100.0.21' });
    const ca = new x509.X509Certificate(readFileSync(paths.caPath, 'utf8'));
    const server = new x509.X509Certificate(readFileSync(paths.serverCertPath, 'utf8'));
    expect(server.issuer, `server issuer is CA subject: ${server.issuer} vs ${ca.subject}`).toBe(ca.subject);
    // Verify the signature over the server cert using the CA's public key.
    const ok = await server.verify({ publicKey: await ca.publicKey.export(x509.cryptoProvider.get()) });
    expect(ok, 'server cert verifies under CA public key').toBe(true);
  }, 20_000);
});
