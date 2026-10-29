// MESH_INTERFACE → The IP certificate — the renewal step is a pure function
// of the certificate and the time: `renew` at half the lifetime, `serve` until
// then (every `nextCheckMs` capped at `notAfter`), `stop-wss` at `notAfter`
// whatever else, and after a failure `serve` until `lastFailureMs +
// CERT_RETRY_MS` before trying again.

import { describe, expect, it } from 'vitest';
import { renewAtMs, renewalStep, type IpCertificate } from '../src/node/acme.js';
import { CERT_RETRY_MS } from '../src/protocols.js';

const H = 3_600_000;

function cert(notBefore: number, notAfter: number): IpCertificate {
  return { certPem: '', keyPem: '', notBefore, notAfter };
}

describe('acme — renewAtMs and renewalStep', () => {
  it.fails('renewal at half the lifetime', () => {
    // MESH_INTERFACE → The IP certificate — "renews it at half its lifetime,
    // `notBefore + (notAfter − notBefore) / 2`".
    expect(renewAtMs({ notBefore: 0, notAfter: 160 * H })).toBe(80 * H);
  });

  it.fails('serve before, renew after', () => {
    const c = cert(0, 160 * H);
    expect(renewalStep(c, 79 * H, null)).toEqual({
      act: 'serve',
      nextCheckMs: 80 * H,
    });
    expect(renewalStep(c, 80 * H, null)).toEqual({ act: 'renew' });
  });

  it.fails('a failed renewal retries hourly and keeps serving', () => {
    // MESH_INTERFACE → The IP certificate — "A failed renewal is retried
    // every `CERT_RETRY_MS` while the current certificate serves".
    const c = cert(0, 160 * H);
    expect(renewalStep(c, 90 * H, 89.5 * H)).toEqual({
      act: 'serve',
      nextCheckMs: 89.5 * H + CERT_RETRY_MS,
    });
    expect(renewalStep(c, 90.5 * H, 89.5 * H)).toEqual({ act: 'renew' });
  });

  it.fails('a retry never runs past notAfter', () => {
    // 159.4 h + CERT_RETRY_MS (1 h) = 160.4 h; capped at notAfter = 160 h.
    const c = cert(0, 160 * H);
    const step = renewalStep(c, 159.5 * H, 159.4 * H);
    expect(step.act).toBe('serve');
    expect((step as { nextCheckMs: number }).nextCheckMs).toBe(160 * H);
  });

  it.fails('the listener stops at notAfter', () => {
    // MESH_INTERFACE → The IP certificate — "At `notAfter` the WebSocket
    // listener stops", whatever the failure state.
    const c = cert(0, 160 * H);
    expect(renewalStep(c, 160 * H, null)).toEqual({ act: 'stop-wss' });
    expect(renewalStep(c, 160 * H, 159.5 * H)).toEqual({ act: 'stop-wss' });
  });
});
