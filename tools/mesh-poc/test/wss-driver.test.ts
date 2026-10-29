// MESH_INTERFACE → The IP certificate — the renewal driver's behavior
// against a stub libp2p: a long lifetime does not spin the timer; a
// successful `obtain()` whose output is still past the half-life is
// treated as a failure; a cert that arrives after start wires the WSS
// listener via `transportManager.add` and `.listen`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Libp2p, Listener } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import { startWssRenewal } from '../src/node/wss.js';
import type { CertificateSource, IpCertificate } from '../src/node/acme.js';
import { CERT_RETRY_MS } from '../src/protocols.js';

interface MockListener {
  getAddrs(): Multiaddr[];
  close(): Promise<void>;
  closed: boolean;
}

interface MockTransportManager {
  added: unknown[];
  listened: unknown[][];
  listeners: MockListener[];
  getListeners(): Listener[];
  add(t: unknown): void;
  listen(mas: unknown[]): Promise<void>;
}

interface MockEvents {
  dispatched: Array<{ name: string; detail: unknown }>;
  safeDispatchEvent(name: string, event: { detail: unknown }): void;
}

interface MockLibp2p {
  components: {
    events: MockEvents;
    transportManager: MockTransportManager;
  };
}

function makeLibp2p(): MockLibp2p {
  const dispatched: Array<{ name: string; detail: unknown }> = [];
  const listeners: MockListener[] = [];
  return {
    components: {
      events: {
        dispatched,
        safeDispatchEvent(name, event) {
          dispatched.push({ name, detail: event.detail });
        },
      },
      transportManager: {
        added: [],
        listened: [],
        listeners,
        getListeners() {
          return this.listeners as unknown as Listener[];
        },
        add(t) {
          this.added.push(t);
        },
        async listen(mas) {
          this.listened.push(mas);
          // A listener for each `/tls/ws` address — the driver reaches it
          // through `getListeners()` later on `stop-wss`.
          const addrsStr = mas.map((m) => String(m));
          const closedFlag = { v: false };
          const l: MockListener = {
            getAddrs() {
              // Return a stub Multiaddr-shaped object (`toString()` is all
              // the driver reads).
              return addrsStr.map((s) => ({ toString: () => s })) as unknown as Multiaddr[];
            },
            async close() {
              closedFlag.v = true;
              this.closed = true;
            },
            closed: false,
          };
          listeners.push(l);
          void closedFlag;
        },
      },
    },
  };
}

function cert(notBefore: number, notAfter: number): IpCertificate {
  return { certPem: 'C', keyPem: 'K', notBefore, notAfter };
}

describe('wss driver — delay cap, post-obtain throttle, first-cert wiring', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errSpy: any = null;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* capture */
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    errSpy?.mockRestore();
    errSpy = null;
  });

  it.fails('a 5-year lifetime does not spin the timer', async () => {
    // MESH_INTERFACE → The IP certificate — the renewer schedules
    // `setTimeout`; a delay above `2^31 − 1` ms overflows to immediate.
    // Capping every delay keeps the driver quiet far from the half-life.
    const now = 1_000_000_000_000;
    vi.setSystemTime(now);
    const fiveYears = 5 * 365 * 24 * 60 * 60_000;
    let obtains = 0;
    const source: CertificateSource = {
      async current() {
        return null;
      },
      async obtain() {
        obtains++;
        return cert(now, now + fiveYears);
      },
    };
    const libp2p = makeLibp2p() as unknown as Libp2p;
    const renewal = startWssRenewal(libp2p, { ip: '127.0.0.1', port: 0, source }, {
      cert: cert(now, now + fiveYears),
      lastFailureMs: null,
    });
    try {
      // One hour of time: nothing happens — the first `setTimeout` fires
      // at the delay cap, well after an hour.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(obtains).toBe(0);
      expect((libp2p as unknown as MockLibp2p).components.transportManager.added.length).toBe(0);
    } finally {
      renewal.stop();
    }
  });

  it.fails('an obtain that lands past the half-life is treated as a failure', async () => {
    // A clock skew or a CA handing out a half-spent certificate would
    // make the driver loop on obtain. Treat as a failure (one error log,
    // `lastFailureMs` set, so the next try waits `CERT_RETRY_MS`).
    const now = 2_000_000_000_000;
    vi.setSystemTime(now);
    const halfSpent = cert(now - 100_000, now + 60_000); // past the half-life
    let obtains = 0;
    const source: CertificateSource = {
      async current() {
        return halfSpent;
      },
      async obtain() {
        obtains++;
        return halfSpent;
      },
    };
    const libp2p = makeLibp2p() as unknown as Libp2p;
    const renewal = startWssRenewal(libp2p, { ip: '127.0.0.1', port: 0, source }, {
      cert: halfSpent,
      lastFailureMs: null,
    });
    try {
      // Immediate renew tick; then the throttle; obtain is called once.
      await vi.advanceTimersByTimeAsync(100);
      expect(obtains).toBe(1);
      const errors = errSpy!.mock.calls as unknown[][];
      const halfSpentErrors = errors.filter((e) =>
        /half-life|renewal failed/i.test(e.map(String).join(' ')),
      );
      expect(halfSpentErrors.length).toBe(1);
      // Advance up to just under `CERT_RETRY_MS`: no further obtain
      // (lastFailureMs holds the next try off).
      await vi.advanceTimersByTimeAsync(CERT_RETRY_MS - 1_000);
      expect(obtains).toBe(1);
    } finally {
      renewal.stop();
    }
  });

  it.fails('the WSS listener appears when a retry succeeds', async () => {
    // MESH_INTERFACE → The IP certificate — a node starts without the WSS
    // listener when `obtain()` fails at start; the retry wires the
    // listener via `transportManager.add` and `.listen` when a certificate
    // arrives.
    const now = 3_000_000_000_000;
    vi.setSystemTime(now);
    const good = cert(now + 100, now + 10_000_000);
    let obtains = 0;
    const source: CertificateSource = {
      async current() {
        return null;
      },
      async obtain() {
        obtains++;
        if (obtains === 1) throw new Error('ACME down');
        return good;
      },
    };
    const libp2p = makeLibp2p() as unknown as Libp2p;
    const tm = (libp2p as unknown as MockLibp2p).components.transportManager;
    const renewal = startWssRenewal(libp2p, { ip: '127.0.0.1', port: 1234, source }, {
      cert: null,
      lastFailureMs: now,
    });
    try {
      // Before the retry fires: no transport added, no listen call.
      expect(tm.added.length).toBe(0);
      expect(tm.listened.length).toBe(0);

      // Advance CERT_RETRY_MS: retry fires, obtain succeeds, listener goes up.
      await vi.advanceTimersByTimeAsync(CERT_RETRY_MS + 100);
      expect(obtains).toBe(1);
      expect(tm.added.length).toBe(1);
      expect(tm.listened.length).toBe(1);
      expect(String(tm.listened[0]![0])).toContain('/tls/ws');
      expect(String(tm.listened[0]![0])).toContain('127.0.0.1');
      expect(String(tm.listened[0]![0])).toContain('/tcp/1234');
    } finally {
      renewal.stop();
    }
  });
});
