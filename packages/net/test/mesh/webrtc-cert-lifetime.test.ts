// MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists" —
// `@libp2p/webrtc@7.0.2`'s renewal timer calls `setTimeout(cb, renewTime)`
// with the full `notAfter − threshold − now`. Node clamps a delay past
// 2^31 − 1 ms to 1 ms (`TimeoutOverflowWarning`), so a certificate
// lifespan past ~24.85 days renews at once — and the new certificate,
// carrying the same lifespan, again. A pinned patch re-arms the timer in
// bounded steps until `notAfter − threshold` is within one step, and
// `stop()` clears whichever bounded step is pending.
//
// The transport is built by hand with the two components the cert path
// actually reads — `MemoryDatastore` and `@libp2p/keychain` — and empty
// stubs for `transportManager` / `upgrader`. A full `createLibp2p` would
// bind a UDP port and spin up the muxer and dial manager, none of which
// `start` / `stop` or the renewal timer touches; building the components
// directly keeps the suite focused and tolerant of libp2p internals that
// are not promised.
//
// Timers: cases 1 and 4 use real timers and short real waits. Cases 2
// and 3 use vitest fake timers, each through its own try / finally. The
// mix is deliberate — @libp2p/keychain's error paths run a 200 — 1000 ms
// `randomDelay` to slow brute-force attacks, which never resolves under
// fake timers unless the clock is advanced; each fake-timer test
// pre-populates the webrtc-direct private key under the name the
// transport expects, so `loadOrCreatePrivateKey` hits the success path
// and never enters `randomDelay`.

import { describe, it, expect, vi } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { keychain, type Keychain } from '@libp2p/keychain';
import { webRTCDirect } from '@libp2p/webrtc';
import { MemoryDatastore } from 'datastore-core/memory';
import type { ComponentLogger, PrivateKey } from '@libp2p/interface';

import { WEBRTC_CERT_LIFESPAN_MS } from '../../src/mesh/constants.js';

// Defaults the transport applies when `certificateRenewalThreshold` is not
// set (`@libp2p/webrtc@7.0.2/dist/src/constants.js`): the renewal window
// is one day before `notAfter`.
const DEFAULT_RENEWAL_THRESHOLD_MS = 86_400_000;
// Node's TIMEOUT_MAX — the cap past which `setTimeout` clamps to 1 ms.
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
// The keychain name the transport looks up its ECDSA private key under
// (`DEFAULT_CERTIFICATE_PRIVATE_KEY_NAME` in
// `@libp2p/webrtc@7.0.2/dist/src/constants.js`).
const WEBRTC_KEYCHAIN_NAME = 'webrtc-direct-certificate-private-key';
// `@libp2p/keychain@6.1.10` enforces `pass.length >= 20`.
const KEYCHAIN_PASS = 'test-webrtc-cert-lifetime-keychain-pass';

// A silent `ComponentLogger` stub. The cert path only reads
// `components.logger.forComponent(name)` and then calls the returned
// logger as a function and through `.error` / `.trace`; a real
// `@libp2p/logger` is not a `@dagsocial/net` dependency.
function makeLogger(): ComponentLogger {
  const log = Object.assign(
    (..._: unknown[]): void => {
      /* silent */
    },
    {
      error: (..._: unknown[]): void => {
        /* silent */
      },
      trace: (..._: unknown[]): void => {
        /* silent */
      },
      enabled: false,
    },
  ) as never;
  return { forComponent: () => log } as unknown as ComponentLogger;
}

interface Components {
  peerId: unknown;
  privateKey: PrivateKey;
  logger: ComponentLogger;
  datastore: MemoryDatastore;
  keychain: Keychain;
  transportManager: unknown;
  upgrader: unknown;
  metrics?: unknown;
}

async function makeComponents(datastore: MemoryDatastore, nodeKey: PrivateKey): Promise<Components> {
  const logger = makeLogger();
  const kc = keychain({ pass: KEYCHAIN_PASS })({ datastore, logger });
  return {
    peerId: peerIdFromPrivateKey(nodeKey),
    privateKey: nodeKey,
    logger,
    datastore,
    keychain: kc,
    // The cert path never reads these; the transport constructor only
    // satisfies their type.
    transportManager: {} as unknown,
    upgrader: {} as unknown,
  };
}

// `importKey`'s success path has no `randomDelay`; the next call on the
// same name throws "already exists" so each test uses a fresh datastore.
async function populateWebrtcKeychain(components: Components): Promise<void> {
  const webrtcKey = await generateKeyPair('ECDSA', 'P-256');
  await components.keychain.importKey(WEBRTC_KEYCHAIN_NAME, webrtcKey);
}

interface TransportHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  certificate: { pem: string; certhash: string };
  emitter: {
    addEventListener(
      type: 'certificate:renew',
      listener: (ev: CustomEvent<{ certhash: string }>) => void,
    ): void;
  };
}

function buildTransport(components: Components, lifespan = WEBRTC_CERT_LIFESPAN_MS): TransportHandle {
  // `webRTCDirect(init)(components)` returns
  // `new WebRTCDirectTransport(...)`; its `start` / `stop` / `certificate` /
  // `emitter` are public at runtime even though some are `private` in TS.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return webRTCDirect({ certificateLifespan: lifespan })(components as any) as unknown as TransportHandle;
}

describe('@libp2p/webrtc — the WebRTC-direct certificate renewal timer, patched', () => {
  it(
    '1. a certificate past Node\'s timer limit is not renewed at start',
    async () => {
      // Real timers. Node's own `setTimeout` clamps a delay past
      // 2^31 − 1 ms to 1 ms (`TimeoutOverflowWarning`), so the
      // unpatched renewal fires in ~1 ms of real time — and the new
      // certificate, with the same lifespan, schedules another.
      // 250 ms is enough for a renewal chain to overwrite the
      // original certhash dozens of times. The patched transport's
      // first step is 2^31 − 1 ms of real time, far past 250 ms.
      const ds = new MemoryDatastore();
      const key = await generateKeyPair('Ed25519');
      const components = await makeComponents(ds, key);
      const transport = buildTransport(components);

      const renewEvents: Array<{ certhash: string }> = [];
      transport.emitter.addEventListener('certificate:renew', (ev) => {
        renewEvents.push(ev.detail);
      });

      await transport.start();
      const initialCerthash = transport.certificate.certhash;

      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(renewEvents).toEqual([]);
      expect(transport.certificate.certhash).toBe(initialCerthash);

      await transport.stop();
    },
  );

  it(
    '2. the certificate renews once, at notAfter − renewalThreshold',
    async () => {
      vi.useFakeTimers();
      try {
        const ds = new MemoryDatastore();
        const key = await generateKeyPair('Ed25519');
        const components = await makeComponents(ds, key);
        await populateWebrtcKeychain(components);
        const transport = buildTransport(components);

        const renewEvents: Array<{ certhash: string }> = [];
        transport.emitter.addEventListener('certificate:renew', (ev) => {
          renewEvents.push(ev.detail);
        });

        // Capture the fake clock at start — the cert's `notAfter` is
        // set to `new Date(Date.now() + lifespan)` with milliseconds
        // zeroed, so the renewal target is deterministic in fake
        // time.
        const startTime = Date.now();
        await transport.start();
        const initialCerthash = transport.certificate.certhash;

        const notAfterMs =
          Math.floor((startTime + WEBRTC_CERT_LIFESPAN_MS) / 1000) * 1000;
        const renewAt = notAfterMs - DEFAULT_RENEWAL_THRESHOLD_MS;

        // Cross the renewal point in one long advance. The patched
        // timer re-arms in bounded steps until the last step lands
        // on `renewAt`, then fires once and stops. The unpatched
        // transport clamps every delay to 1 ms under fake timers and
        // its renewal chain never halts inside one advance call —
        // the test's own `testTimeout` catches that.
        await vi.advanceTimersByTimeAsync(renewAt - Date.now() + 1000);

        // The renewal cb kicks off a real-time async chain
        // (`X509CertificateGenerator.createSelfSigned`,
        // `datastore.put`) that outlives `advanceTimersByTimeAsync`.
        // Switch to real timers and give the chain a slice of real
        // time to resolve before observing the event count.
        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(renewEvents).toHaveLength(1);
        expect(transport.certificate.certhash).not.toBe(initialCerthash);

        await transport.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('3. a stored long-lived certificate loads and keeps its hash across a restart', async () => {
    vi.useFakeTimers();
    try {
      const ds = new MemoryDatastore();
      const key = await generateKeyPair('Ed25519');

      const components1 = await makeComponents(ds, key);
      await populateWebrtcKeychain(components1);
      const transport1 = buildTransport(components1);
      await transport1.start();
      const certhash1 = transport1.certificate.certhash;
      await transport1.stop();

      // Same datastore and node key, new transport and keychain
      // instance over the same `pass`. The webrtc-direct private
      // key and the X509 certificate both persist in `ds`, so
      // `loadOrCreatePrivateKey` and `loadCertificate` read back
      // what the first start wrote. No advance between the two
      // starts — the only question the case asks is whether the
      // second start loads the stored cert verbatim.
      const logger2 = makeLogger();
      const kc2 = keychain({ pass: KEYCHAIN_PASS })({ datastore: ds, logger: logger2 });
      const components2: Components = {
        peerId: peerIdFromPrivateKey(key),
        privateKey: key,
        logger: logger2,
        datastore: ds,
        keychain: kc2,
        transportManager: {} as unknown,
        upgrader: {} as unknown,
      };
      const transport2 = buildTransport(components2);
      await transport2.start();
      const certhash2 = transport2.certificate.certhash;

      expect(certhash2).toBe(certhash1);

      await transport2.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('4. stop() leaves no renewal pending', async () => {
    // Real timers. Unpatched: a 1 ms-clamped renewal timer is
    // scheduled during `start()`; `stop()`'s `clearTimeout` kills
    // it before the next tick. Patched: the first bounded step is
    // scheduled at 2^31 − 1 ms; `stop()`'s `clearTimeout` kills it,
    // and because every bounded step reassigns
    // `this.renewCertificateTask` the chain cannot resume on its
    // own. In both the assertion is the same — 300 ms of real time
    // after `stop()` sees no renewal event.
    const ds = new MemoryDatastore();
    const key = await generateKeyPair('Ed25519');
    const components = await makeComponents(ds, key);
    const transport = buildTransport(components);

    const renewEvents: Array<{ certhash: string }> = [];
    transport.emitter.addEventListener('certificate:renew', (ev) => {
      renewEvents.push(ev.detail);
    });

    await transport.start();
    await transport.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(renewEvents).toEqual([]);
  });

  // The constant's ceilings — the lifespan has to fit in X.509
  // GeneralizedTime (year 9999 max; ECMAScript Date's range is wider) and
  // stay past Node's `setTimeout` limit so the patch has something to
  // defend against.
  it('WEBRTC_CERT_LIFESPAN_MS stays within X.509 GeneralizedTime and past Node\'s timer limit', () => {
    const generalizedTimeMaxMs = Date.UTC(9999, 11, 31, 23, 59, 59);
    expect(Date.now() + WEBRTC_CERT_LIFESPAN_MS).toBeLessThan(generalizedTimeMaxMs);
    expect(WEBRTC_CERT_LIFESPAN_MS).toBeGreaterThan(MAX_SET_TIMEOUT_MS);
  });
});
