// MESH_INTERFACE → The IP certificate — a public node that opts in to the
// secure WebSocket fallback obtains a certificate for its own bare IP over
// ACME (`http-01`, port 80 of the IP) and renews it at half its lifetime.
// `renewalStep` is the pure state transition the renewal timer drives.
// Node-only: `acmeSource` reads and writes a file and runs an HTTP server
// for the challenge (`MESH_INTERFACE → Place in the workspace`).

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import acme from 'acme-client';
import { CERT_RETRY_MS } from '../protocols.js';

export interface IpCertificate {
  readonly certPem: string;
  readonly keyPem: string;
  readonly notBefore: number;
  readonly notAfter: number;
}

export interface CertificateSource {
  current(): Promise<IpCertificate | null>;
  obtain(): Promise<IpCertificate>;
}

export type RenewalStep =
  | { readonly act: 'serve'; readonly nextCheckMs: number }
  | { readonly act: 'renew' }
  | { readonly act: 'stop-wss' };

/**
 * MESH_INTERFACE → The IP certificate — "renews it at half its lifetime,
 * `notBefore + (notAfter − notBefore) / 2`".
 */
export function renewAtMs(
  c: Pick<IpCertificate, 'notBefore' | 'notAfter'>,
): number {
  return c.notBefore + (c.notAfter - c.notBefore) / 2;
}

/**
 * MESH_INTERFACE → The IP certificate — the renewal timer's state transition.
 * `stop-wss` wins at or past `notAfter`; a pending failure holds the renewer
 * at `serve` until `lastFailureMs + CERT_RETRY_MS`; otherwise `renew` at or
 * past the half-life, and `serve` before it. Every `serve.nextCheckMs` is
 * capped at `notAfter`, so a retry never schedules a check past the stop.
 */
export function renewalStep(
  c: IpCertificate,
  nowMs: number,
  lastFailureMs: number | null,
): RenewalStep {
  if (nowMs >= c.notAfter) return { act: 'stop-wss' };
  const notAfter = c.notAfter;
  if (lastFailureMs !== null) {
    const retryAt = lastFailureMs + CERT_RETRY_MS;
    if (nowMs >= retryAt) return { act: 'renew' };
    return { act: 'serve', nextCheckMs: Math.min(retryAt, notAfter) };
  }
  const renewAt = renewAtMs(c);
  if (nowMs >= renewAt) return { act: 'renew' };
  return { act: 'serve', nextCheckMs: Math.min(renewAt, notAfter) };
}

const ACCOUNT_KEY_FILE = 'account.key';
const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';

/**
 * MESH_INTERFACE → The IP certificate — the ACME driver: an account key,
 * the certificate and its key under `<stateDir>/acme/`, the two keys mode
 * `0600`. `current()` reads what the directory holds, `obtain()` runs the
 * ACME order against the given directory for the `ip` identifier under the
 * `shortlived` profile, answers `http-01` on `challengePort` (default 80) of
 * the node's IP, and writes the result before resolving.
 */
export function acmeSource(o: {
  directoryUrl: string;
  ip: string;
  stateDir: string;
  challengePort?: number;
}): CertificateSource {
  const acmeDir = join(o.stateDir, 'acme');
  const challengePort = o.challengePort ?? 80;

  return {
    async current(): Promise<IpCertificate | null> {
      try {
        const [certPem, keyPem] = await Promise.all([
          readFile(join(acmeDir, CERT_FILE), 'utf8'),
          readFile(join(acmeDir, KEY_FILE), 'utf8'),
        ]);
        const parsed = new X509Certificate(certPem);
        return {
          certPem,
          keyPem,
          notBefore: new Date(parsed.validFrom).getTime(),
          notAfter: new Date(parsed.validTo).getTime(),
        };
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return null;
        throw err;
      }
    },

    async obtain(): Promise<IpCertificate> {
      await mkdir(acmeDir, { recursive: true });

      // Account key: created on first `obtain`, reused thereafter. Mode
      // 0600 on both private keys (`MESH_INTERFACE → The IP certificate`).
      let accountKeyPem: Buffer;
      try {
        accountKeyPem = await readFile(join(acmeDir, ACCOUNT_KEY_FILE));
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
        accountKeyPem = await acme.crypto.createPrivateKey();
        await writeFile(join(acmeDir, ACCOUNT_KEY_FILE), accountKeyPem, {
          mode: 0o600,
          flag: 'wx',
        });
      }

      const client = new acme.Client({
        directoryUrl: o.directoryUrl,
        accountKey: accountKeyPem,
      });

      // `createAccount` is idempotent on `acme-client`: a known account key
      // returns the existing account URL. `termsOfServiceAgreed: true` is
      // required by RFC 8555 §7.3 and is standard for ACME v2.
      await client.createAccount({ termsOfServiceAgreed: true });

      // `acme-client` passes the payload through to the ACME `newOrder`
      // POST verbatim; the `ip` identifier type (RFC 8738) and the ACME
      // profiles extension's `profile` field ride along to a Pebble or
      // Let's Encrypt server that supports them. `shortlived` is the
      // profile the IP certificate rides.
      const order = await client.createOrder({
        identifiers: [{ type: 'ip', value: o.ip }],
        profile: 'shortlived',
      } as unknown as Parameters<typeof client.createOrder>[0]);

      const authorizations = await client.getAuthorizations(order);

      // One in-process HTTP server on the challenge port answers every
      // `GET /.well-known/acme-challenge/<token>` from the ACME server
      // for the duration of the order. A single server covers every
      // authorization's challenge.
      const tokens = new Map<string, string>();
      const challengeServer = createServer((req, res) => {
        const prefix = '/.well-known/acme-challenge/';
        if (req.method === 'GET' && req.url?.startsWith(prefix)) {
          const token = req.url.slice(prefix.length);
          const keyAuth = tokens.get(token);
          if (keyAuth !== undefined) {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end(keyAuth);
            return;
          }
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error): void => reject(e);
        challengeServer.once('error', onErr);
        challengeServer.listen(challengePort, () => {
          challengeServer.off('error', onErr);
          resolve();
        });
      });

      try {
        for (const authz of authorizations) {
          const challenge = authz.challenges.find((c) => c.type === 'http-01');
          if (!challenge) {
            throw new Error(`no http-01 challenge for ${authz.identifier.value}`);
          }
          const keyAuth = await client.getChallengeKeyAuthorization(challenge);
          tokens.set(challenge.token, keyAuth);
          await client.verifyChallenge(authz, challenge);
          await client.completeChallenge(challenge);
          await client.waitForValidStatus(challenge);
        }

        // The CSR carries an iPAddress SAN: `acme-client`'s `createCsr`
        // reads `altNames` with `net.isIP` and emits `ip` or `dns`
        // accordingly, so passing the bare IP yields the right SAN.
        const [keyPem, csr] = await acme.crypto.createCsr({
          altNames: [o.ip],
        });
        const certPem = await client.finalizeOrder(order, csr).then((o2) =>
          client.getCertificate(o2),
        );

        await writeFile(join(acmeDir, KEY_FILE), keyPem, {
          mode: 0o600,
          flag: 'w',
        });
        await writeFile(join(acmeDir, CERT_FILE), certPem, { flag: 'w' });
        // `writeFile` with `flag: 'w'` keeps the existing file's mode on
        // overwrite; a renewal must still land on mode 0600 for the key.
        await chmod(join(acmeDir, KEY_FILE), 0o600);

        const parsed = new X509Certificate(certPem);
        return {
          certPem,
          keyPem: keyPem.toString('utf8'),
          notBefore: new Date(parsed.validFrom).getTime(),
          notAfter: new Date(parsed.validTo).getTime(),
        };
      } finally {
        await new Promise<void>((resolve) => {
          challengeServer.close(() => resolve());
        });
      }
    },
  };
}
