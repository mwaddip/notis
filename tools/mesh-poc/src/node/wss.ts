// MESH_INTERFACE → Transports / The IP certificate — a public node's secure
// WebSocket fallback. `WssOptions` names the TLS WebSocket listener's bind
// address, the certificate source and (for tests) the clock the renewal step
// reads. `startWssRenewal` drives the renewal timer against a running
// libp2p host: with a certificate at start it swaps in place at the
// half-life; with no certificate at start it waits for `obtain()` and then
// wires the WSS listener in through `transportManager.add` and `.listen`;
// at `notAfter` it closes the one WSS listener. The node runs it; it is
// not part of the browser-facing surface.

import { webSockets, type WebSocketsComponents } from '@libp2p/websockets';
import type { Libp2p, Listener } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { isIPv6 } from 'node:net';
import {
  renewalStep,
  type CertificateSource,
  type IpCertificate,
} from './acme.js';
import { CERT_RETRY_MS } from '../protocols.js';

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
 * `setTimeout` fires immediately on a delay above `2^31 − 1` ms (≈24.8
 * days): on a long-lived certificate the renewer would spin against the
 * CA. Cap every schedule at this boundary; `renewalStep` runs again when
 * the capped tick fires and reschedules.
 */
const MAX_TIMEOUT_MS = 0x7fff_ffff;

/**
 * MESH_INTERFACE → Place in the workspace / Transports — reach into the
 * libp2p transport manager's listener map to pick out the WSS listener by
 * its address. The field is `public` on the concrete `Libp2pClass` though
 * it is absent from the exported interface, so the type seam is narrowed
 * here. If either `components.events` or `components.transportManager`
 * is absent the function throws — the driver carries no silent fallback,
 * because a stub `?.` would leave renewal doing nothing while the node
 * reads normal.
 */
interface Libp2pInternals {
  events: {
    safeDispatchEvent(name: string, event: { detail: unknown }): void;
  };
  transportManager: {
    getListeners(): Listener[];
    add(t: unknown): void;
    listen(mas: unknown[]): Promise<void>;
  };
}

function resolveInternals(libp2p: Libp2p): Libp2pInternals {
  const inner = libp2p as unknown as { components?: Partial<Libp2pInternals> };
  const events = inner.components?.events;
  const transportManager = inner.components?.transportManager;
  if (events === undefined || transportManager === undefined) {
    throw new Error(
      'wss: libp2p.components.{events,transportManager} not reachable — a libp2p release moved the surface',
    );
  }
  return { events, transportManager } as Libp2pInternals;
}

function findWssListener(internals: Libp2pInternals): Listener | null {
  for (const l of internals.transportManager.getListeners()) {
    for (const a of l.getAddrs()) {
      if (a.toString().includes('/tls/ws')) return l;
    }
  }
  return null;
}

/**
 * MESH_INTERFACE → The IP certificate — load the certificate the WSS
 * listener starts under. Reads `source.current()`; if it holds a cert still
 * before `notAfter`, that cert serves at start (the renewal timer renews
 * it, even if it is already past the half-life). If `current()` is null or
 * past `notAfter`, calls `source.obtain()`; a failure returns null so the
 * node starts without the WSS listener and the renewer retries. The
 * `clock` option is for tests.
 */
export async function initialCertificate(
  opts: WssOptions,
): Promise<IpCertificate | null> {
  const clock = opts.clock ?? Date.now;
  const existing = await opts.source.current();
  if (existing !== null && clock() < existing.notAfter) return existing;
  try {
    return await opts.source.obtain();
  } catch (e) {
    console.error(`wss: initial obtain failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * MESH_INTERFACE → The IP certificate — drive the renewal timer against a
 * started libp2p host. With a certificate in `state.cert`: the next
 * certificate is written in place via the `certificate:renew` event, which
 * `@libp2p/websockets@10.1.25` answers by replacing its https server (open
 * TLS connections stay up on the old one; new handshakes see the new
 * certificate). On `stop-wss` the one WSS listener closes while every
 * other transport carries on. With `state.cert === null`: the driver waits
 * `CERT_RETRY_MS` since `state.lastFailureMs`, calls `obtain()`, and on
 * success registers `@libp2p/websockets` through `transportManager.add`
 * and `.listen` so the `/tls/ws` listener appears at that moment.
 */
export function startWssRenewal(
  libp2p: Libp2p,
  opts: WssOptions,
  state: { cert: IpCertificate | null; lastFailureMs: number | null },
): WssRenewal {
  const internals = resolveInternals(libp2p);
  const clock = opts.clock ?? Date.now;
  let current: IpCertificate | null = state.cert;
  let lastFailureMs: number | null = state.lastFailureMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const dispatchRenew = (c: IpCertificate): void => {
    internals.events.safeDispatchEvent('certificate:renew', {
      detail: { cert: c.certPem, key: c.keyPem },
    });
  };

  const addFirstListener = async (c: IpCertificate): Promise<void> => {
    const components = (libp2p as unknown as { components: WebSocketsComponents })
      .components;
    const transport = webSockets({
      https: { cert: c.certPem, key: c.keyPem },
    })(components);
    internals.transportManager.add(transport);
    const ipFamily = isIPv6(opts.ip) ? 'ip6' : 'ip4';
    const ma = multiaddr(`/${ipFamily}/${opts.ip}/tcp/${opts.port}/tls/ws`);
    await internals.transportManager.listen([ma]);
    console.error('wss: listener wired after retry succeeded');
  };

  const stopWss = async (): Promise<void> => {
    const l = findWssListener(internals);
    if (l === null) {
      console.error('wss: no listener to stop at notAfter');
      return;
    }
    // `WebSocketListener.close` is public API; it is not expected to
    // throw and a surprise is worth seeing, so no `catch` wraps it.
    await l.close();
    console.error('wss: listener stopped at notAfter');
  };

  const scheduleAt = (nextCheckMs: number): void => {
    if (stopped) return;
    const raw = Math.max(0, nextCheckMs - clock());
    const delay = Math.min(raw, MAX_TIMEOUT_MS);
    timer = setTimeout(() => {
      void tick();
    }, delay);
  };

  const tryObtain = async (): Promise<void> => {
    try {
      const next = await opts.source.obtain();
      // Fix 5: a successful `obtain` whose output renewalStep still
      // answers `renew` for (clock skew, a CA handing out a half-spent
      // certificate) would loop against the CA with no throttle. Treat
      // as a failure: one log, `lastFailureMs` set, next try waits
      // `CERT_RETRY_MS`.
      const after = renewalStep(next, clock(), null);
      if (after.act === 'renew') {
        throw new Error('obtained cert already past the half-life');
      }
      if (current === null) {
        await addFirstListener(next);
      } else {
        dispatchRenew(next);
      }
      current = next;
      lastFailureMs = null;
    } catch (e) {
      lastFailureMs = clock();
      console.error(`wss: renewal failed: ${(e as Error).message}`);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (current === null) {
      // No certificate yet — retry at `lastFailureMs + CERT_RETRY_MS`.
      const nextMs =
        lastFailureMs !== null ? lastFailureMs + CERT_RETRY_MS : clock();
      if (clock() < nextMs) {
        scheduleAt(nextMs);
        return;
      }
      await tryObtain();
      if (stopped) return;
      planNext();
      return;
    }
    const step = renewalStep(current, clock(), lastFailureMs);
    if (step.act === 'serve') {
      scheduleAt(step.nextCheckMs);
      return;
    }
    if (step.act === 'stop-wss') {
      await stopWss();
      return;
    }
    await tryObtain();
    if (stopped) return;
    planNext();
  };

  const planNext = (): void => {
    if (current === null) {
      const nextMs =
        lastFailureMs !== null ? lastFailureMs + CERT_RETRY_MS : clock();
      scheduleAt(nextMs);
      return;
    }
    const step = renewalStep(current, clock(), lastFailureMs);
    if (step.act === 'serve') scheduleAt(step.nextCheckMs);
    else if (step.act === 'stop-wss') void stopWss();
    else scheduleAt(clock());
  };

  planNext();

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
