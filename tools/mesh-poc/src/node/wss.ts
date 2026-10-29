// MESH_INTERFACE → Transports / The IP certificate — a public node's secure
// WebSocket fallback. `WssOptions` names the TLS WebSocket listener's bind
// address, the certificate source and (for tests) the clock the renewal step
// reads. Node-only: it rides a TLS listener and a certificate file.

import type { CertificateSource } from './acme.js';

export interface WssOptions {
  readonly port: number;
  readonly ip: string;
  readonly source: CertificateSource;
  readonly clock?: () => number;
}
