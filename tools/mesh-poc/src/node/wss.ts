// MESH_INTERFACE → Transports / The IP certificate — a public node's secure
// WebSocket fallback. `WssOptions` names the TLS WebSocket listener's bind
// address, the certificate source and (for tests) the clock the renewal step
// reads. `startWssRenewal` drives the renewal timer against a running
// libp2p host: on `renew` it swaps the certificate in place via
// `certificate:renew`, on `stop-wss` it closes just the WSS listener. The
// node runs it; it is not part of the browser-facing surface.

import type { Libp2p, Listener } from '@libp2p/interface';
import { renewalStep, renewAtMs, type CertificateSource, type IpCertificate } from './acme.js';

export interface WssOptions {
  readonly port: number;
  readonly ip: string;
  readonly source: CertificateSource;
  readonly clock?: () => number;
}

export interface WssRenewal {
  stop(): void;
}

/**
 * MESH_INTERFACE → Place in the workspace / Transports — reach into the
 * libp2p transport manager's listener map to pick out the WSS listener by
 * its address. The field is `public` on the concrete `Libp2pClass` though
 * it is absent from the exported interface, so the type seam is narrowed
 * here instead of leaking an `as any` through every call site.
 */
function wssListenerOf(libp2p: Libp2p): Listener | null {
  const inner = libp2p as unknown as {
    components?: {
      transportManager?: {
        getListeners(): Listener[];
      };
    };
  };
  const listeners = inner.components?.transportManager?.getListeners() ?? [];
  for (const l of listeners) {
    for (const a of l.getAddrs()) {
      if (a.toString().includes('/tls/ws')) return l;
    }
  }
  return null;
}

/**
 * MESH_INTERFACE → The IP certificate — load the certificate the WSS
 * listener starts under. Reads `source.current()`; if null (first start) or
 * past `renewAtMs` (its half-life has gone), calls `source.obtain()` for a
 * fresh one.
 */
export async function initialCertificate(
  opts: WssOptions,
): Promise<IpCertificate> {
  const clock = opts.clock ?? Date.now;
  const existing = await opts.source.current();
  if (existing !== null && clock() < renewAtMs(existing)) return existing;
  return opts.source.obtain();
}

/**
 * MESH_INTERFACE → The IP certificate — drive the renewal timer against a
 * started libp2p host. On `renew` the next certificate is written in place
 * via the `certificate:renew` event, which `@libp2p/websockets@10.1.25`
 * answers by replacing its https server (open TLS connections stay up on
 * the old one; new handshakes see the new certificate). On `stop-wss` the
 * one WSS listener closes while every other transport carries on. A failed
 * `obtain()` is logged once with `console.error` and remembered as
 * `lastFailureMs`; the pure `renewalStep` schedules the next attempt at
 * `lastFailureMs + CERT_RETRY_MS`.
 */
export function startWssRenewal(
  libp2p: Libp2p,
  opts: WssOptions,
  state: { cert: IpCertificate | null; lastFailureMs: number | null },
): WssRenewal {
  // The "no cert at start" state carries a `null` initial cert; the real
  // retry-until-arrival path is wired in the fix commit. Here the no-cert
  // branch is a no-op to keep existing tests isolated from the new API.
  if (state.cert === null) {
    return { stop(): void { /* no-op */ } };
  }
  const clock = opts.clock ?? Date.now;
  let current: IpCertificate = state.cert;
  let lastFailureMs: number | null = state.lastFailureMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const dispatchRenew = (c: IpCertificate): void => {
    // MESH_INTERFACE → Transports — the TLS cert/key are rolled on the
    // listener via the shared libp2p event bus. `TLSCertificate` on
    // `@libp2p/interface` is `{ key, cert }`; the WebSockets listener's
    // `onCertificateRenew` builds a fresh https server with these.
    const inner = libp2p as unknown as {
      components?: {
        events?: {
          safeDispatchEvent(name: string, event: unknown): void;
        };
      };
    };
    inner.components?.events?.safeDispatchEvent('certificate:renew', {
      detail: { cert: c.certPem, key: c.keyPem },
    });
  };

  const stopWss = async (): Promise<void> => {
    const l = wssListenerOf(libp2p);
    if (l !== null) {
      try {
        await l.close();
      } catch {
        /* already closed */
      }
    }
    console.error('wss: listener stopped at notAfter');
  };

  const scheduleNext = (nextCheckMs: number): void => {
    if (stopped) return;
    const delay = Math.max(0, nextCheckMs - clock());
    timer = setTimeout(() => {
      void tick();
    }, delay);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const step = renewalStep(current, clock(), lastFailureMs);
    if (step.act === 'serve') {
      scheduleNext(step.nextCheckMs);
      return;
    }
    if (step.act === 'stop-wss') {
      await stopWss();
      return;
    }
    // `renew` — attempt a new certificate; a failure keeps the current
    // one serving, with one log line and `lastFailureMs` recorded.
    try {
      const next = await opts.source.obtain();
      current = next;
      lastFailureMs = null;
      dispatchRenew(next);
    } catch (e) {
      lastFailureMs = clock();
      console.error(`wss: renewal failed: ${(e as Error).message}`);
    }
    if (stopped) return;
    const after = renewalStep(current, clock(), lastFailureMs);
    if (after.act === 'serve') scheduleNext(after.nextCheckMs);
    else if (after.act === 'stop-wss') await stopWss();
    else scheduleNext(clock());
  };

  // First schedule — a fresh certificate at half the lifetime is well
  // ahead, so the initial check almost always lands on `serve`.
  const step0 = renewalStep(current, clock(), lastFailureMs);
  if (step0.act === 'serve') scheduleNext(step0.nextCheckMs);
  else if (step0.act === 'stop-wss') void stopWss();
  else scheduleNext(clock());

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
