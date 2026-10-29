// MESH_INTERFACE → The IP certificate — a public node that opts in to the
// secure WebSocket fallback obtains a certificate for its own bare IP over
// ACME (`http-01`, port 80 of the IP), and renews it at half its lifetime
// with a `CERT_RETRY_MS` wait between failed attempts. `renewalStep` is the
// pure state transition the renewal timer drives. Node-only: `acmeSource`
// reads and writes a file.

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

export function renewAtMs(
  _c: Pick<IpCertificate, 'notBefore' | 'notAfter'>,
): number {
  throw new Error('renewAtMs not implemented');
}

export function renewalStep(
  _c: IpCertificate,
  _nowMs: number,
  _lastFailureMs: number | null,
): RenewalStep {
  throw new Error('renewalStep not implemented');
}

export function acmeSource(_o: {
  directoryUrl: string;
  ip: string;
  stateDir: string;
  challengePort?: number;
}): CertificateSource {
  throw new Error('acmeSource not implemented');
}
