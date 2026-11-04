// MESH_INTERFACE → NAT → "A relay that does not answer never stops a private node".
// `failures` counts failed attempts so far; the schedule is
// `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(failures−1))`. Pure. Zero or
// negative count reads 0.

import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from '@libp2p/interface';
import { RETRY_BASE_MS, RETRY_CAP_MS, RELAY_LISTEN_TIMEOUT_MS } from './constants.js';

export function retryIntervalMs(failures: number, base?: number, cap?: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const b = typeof base === 'number' && base > 0 ? base : RETRY_BASE_MS;
  const c = typeof cap === 'number' && cap > 0 ? cap : RETRY_CAP_MS;
  return Math.min(c, b * Math.pow(2, failures - 1));
}

/**
 * `MESH_INTERFACE → NAT → "A relay that does not answer never stops a private node"`
 * — hold a private node's `/p2p-circuit` listen reserved. Each
 * attempt calls `transportManager.listen([addr])` under
 * `RELAY_LISTEN_TIMEOUT_MS`; on success, the circuit listener dials
 * the relay (reusing the TCP connection libp2p already holds through
 * the mesh node's floor dial) and reserves. A reservation that is
 * later removed (`self:peer:update` drops the circuit entry) starts
 * a fresh retry.
 *
 * `components.transportManager` is public on the libp2p instance
 * (`libp2p@3.5.1/src/libp2p.ts:40` "public components"); the typed
 * interface does not expose it, so the cast is unavoidable.
 */
export interface RelayRetry {
  stop(): void;
}

export function startRelayRetry(
  node: Libp2p,
  addrString: string,
  opts: { baseMs: number; capMs: number; listenTimeoutMs?: number },
): RelayRetry {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let reserved = false;

  const addr = multiaddr(addrString);
  const listenTimeoutMs =
    typeof opts.listenTimeoutMs === 'number' && opts.listenTimeoutMs > 0
      ? opts.listenTimeoutMs
      : RELAY_LISTEN_TIMEOUT_MS;

  const hasReservation = (): boolean => {
    const circuitTail = addrString.slice(0, addrString.indexOf('/p2p-circuit'));
    for (const ma of node.getMultiaddrs()) {
      const s = ma.toString();
      if (!s.includes('/p2p-circuit')) continue;
      if (s.startsWith(circuitTail)) return true;
    }
    return false;
  };

  const scheduleRetry = (ms: number): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { void attempt(); }, ms);
  };

  // Each listen attempt runs under its own `RELAY_LISTEN_TIMEOUT_MS`.
  // The circuit relay's reservation completion timeout is 5 s by
  // default, but a multistream negotiation that opens a stream and
  // hangs can stall the listener past that; past the deadline the
  // attempt counts as a failure.
  const attempt = async (): Promise<void> => {
    if (stopped) return;
    if (hasReservation()) {
      reserved = true;
      failures = 0;
      return;
    }
    try {
      const components = (node as unknown as {
        components: { transportManager: { listen(ma: unknown[]): Promise<void> } };
      }).components;
      const listenPromise = components.transportManager.listen([addr]);
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const deadlinePromise = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new Error(`listen deadline (${listenTimeoutMs} ms)`)),
          listenTimeoutMs,
        );
      });
      try {
        await Promise.race([listenPromise, deadlinePromise]);
      } finally {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      }
      // `transportManager.listen` resolves even when the circuit
      // listener's inner connect refused (`transport-manager.ts`'s
      // per-task catch). Check whether a reservation landed.
      if (hasReservation()) {
        reserved = true;
        failures = 0;
        return;
      }
      failures += 1;
      scheduleRetry(retryIntervalMs(failures, opts.baseMs, opts.capMs));
    } catch {
      failures += 1;
      scheduleRetry(retryIntervalMs(failures, opts.baseMs, opts.capMs));
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onPeerUpdate = (_ev: any): void => {
    if (stopped) return;
    const nowReserved = hasReservation();
    if (nowReserved && !reserved) {
      reserved = true;
      failures = 0;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    } else if (!nowReserved && reserved) {
      // Reservation went away: a fresh retry at `failures = 1`.
      reserved = false;
      failures = 0;
      scheduleRetry(0);
    }
  };

  node.addEventListener('self:peer:update', onPeerUpdate);

  // Kick off the first attempt right after start.
  scheduleRetry(0);

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      node.removeEventListener('self:peer:update', onPeerUpdate);
    },
  };
}
