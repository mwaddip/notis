// MESH_INTERFACE → Place in the workspace / Transports / NAT / Discovery /
// The node endpoint — a mesh node is a libp2p host that forwards HTTP over
// libp2p to its own Notis node and runs the Notis Kademlia protocol alone.
// Node-only: TCP, the file-backed datastore and the WebRTC-direct listener's
// native binding keep it out of the browser (`MESH_INTERFACE → Place in the
// workspace`).

import { createLibp2p, type Libp2p } from 'libp2p';
import { FaultTolerance } from '@libp2p/interface';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { kadDHT } from '@libp2p/kad-dht';
import {
  circuitRelayServer,
  circuitRelayTransport,
} from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { autoNATv2 } from '@libp2p/autonat-v2';
import { bootstrap } from '@libp2p/bootstrap';
import { keychain } from '@libp2p/keychain';
import { FsDatastore } from 'datastore-fs';
import { http as httpService, type HTTP } from '@libp2p/http';
import { mkdirSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { join } from 'node:path';
import type { NodeKey } from '../identity.js';
import { dhtProtocol, type NetworkName, RETRY_BASE_MS, RETRY_CAP_MS, RELAY_LISTEN_TIMEOUT_MS } from '../protocols.js';
import { MeshConfigError, assertNoDns } from '../config.js';
import { nodeApiServer } from './api-forward.js';
import { startStunServer } from './stun.js';
import type { IpCertificate } from './acme.js';
import {
  initialCertificate,
  startWssRenewal,
  type WssOptions,
  type WssRenewal,
} from './wss.js';

// MESH_INTERFACE → Transports / Discovery — the DNS and `MeshConfigError`
// rule is browser-safe and shared with the client: a second class or regex
// would make a refusal land in one caller and not the other, so both come
// from one source (`src/config.ts`).
export { MeshConfigError };

/**
 * MESH_INTERFACE → NAT — "A relay that does not answer never stops a
 * private node ... is tried again on the node list's retry cadence
 * (`RETRY_BASE_MS` doubling to `RETRY_CAP_MS`)". `failures` counts
 * failed attempts so far; the schedule is
 * `min(RETRY_CAP_MS, RETRY_BASE_MS * 2^(failures-1))`. Pure. Zero or
 * negative count reads 0.
 */
export function retryIntervalMs(failures: number, base?: number, cap?: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const b = typeof base === 'number' && base > 0 ? base : RETRY_BASE_MS;
  const c = typeof cap === 'number' && cap > 0 ? cap : RETRY_CAP_MS;
  return Math.min(c, b * Math.pow(2, failures - 1));
}

export interface MeshNodeOptions {
  readonly key: NodeKey;
  readonly network: NetworkName;
  readonly role: 'public' | 'private';
  readonly listen: string[];
  readonly announce?: string[];
  readonly bootstrap: string[];
  readonly stateDir: string;
  readonly upstream: string;
  /**
   * MESH_INTERFACE → NAT — a public node runs a STUN server where its
   * operator names an IP and UDP port for one. A private node with STUN
   * set is refused: STUN serves from a public address.
   */
  readonly stun?: { host: string; port: number };
  /**
   * MESH_INTERFACE → Transports / The IP certificate — a public node's
   * secure WebSocket fallback: a TLS WebSocket listener for the node's
   * bare IP, swapped in place at renewal and stopped at `notAfter`. A
   * private node with `wss` set, or `wss.ip` that is not an IP literal,
   * is refused.
   */
  readonly wss?: WssOptions;
  /**
   * MESH_INTERFACE → NAT — "A relay that does not answer never stops a
   * private node ... is tried again on the node list's retry cadence".
   * Private-only; defaults to `protocols.ts`' `RETRY_BASE_MS` and
   * `RETRY_CAP_MS`. Tests inject small values.
   */
  readonly relayRetryBaseMs?: number;
  readonly relayRetryCapMs?: number;
  /**
   * MESH_INTERFACE → NAT — "every STUN server is a mesh node named by
   * IP". A private node's WebRTC transport gathers ICE candidates
   * against the public nodes' STUN by IP; `stunServers` holds the
   * `stun:<ip>:<port>` URLs the stage builds from `MESH_STUN_SERVERS`
   * on its own publics. A hostname is refused (same rule as the
   * client's `assertClientConfig`).
   */
  readonly stunServers?: readonly string[];
}

export interface MeshNode {
  readonly libp2p: Libp2p<{ http: HTTP }>;
  multiaddrs(): string[];
  /**
   * MESH_INTERFACE → Discovery → "A node added by hand" — the mesh
   * node's own transport listeners' listen addresses, flat (not
   * announce-filtered). The private role's `localAddrs` on the
   * identity line is derived from this list through `localAddrsFor`.
   */
  listenerAddrs(): string[];
  stop(): Promise<void>;
}

function assertBootstrapHasPeer(addrs: readonly string[]): void {
  for (const a of addrs) {
    if (!a.includes('/p2p/')) {
      throw new MeshConfigError(`bootstrap address refused: ${a} has no /p2p/ component`);
    }
  }
}

/**
 * MESH_INTERFACE → Discovery — the libp2p `addresses.announce` list a
 * mesh node brings up with. A `public` role with no explicit announce
 * defaults to its CONCRETE-PORT listen addresses: libp2p 3.5's
 * AddressManager otherwise holds a public listen address out of
 * `getAddresses()` until AutoNAT or an observed-address path calls
 * `confirm(ma)` (see `libp2p/src/address-manager/transport-addresses.ts`
 * — `verified` is `!isPrivate(ma)` on first read). An explicit
 * `announce` always passes through. A `private` role has no listen
 * address worth announcing on its own; relay reservations are
 * announced through the relay transport, not here.
 *
 * A listen address with `/udp/0` or `/tcp/0` is excluded from the
 * auto-default: the kernel picks the port at bind, so announcing
 * `/udp/0` is a lie. In production, mesh nodes carry concrete ports
 * (`stage/topology.json` → `pub1.mesh.webrtcPort = 4001`); in tests,
 * loopback is private per isPrivate so the transport-address path
 * reads it as verified anyway.
 *
 * Pure. Returning `undefined` means "no `addresses.announce` key"
 * (libp2p's default behaviour).
 */
export function effectiveAnnounce(
  opts: { role: 'public' | 'private'; listen: readonly string[]; announce?: readonly string[] },
): string[] | undefined {
  if (opts.announce !== undefined && opts.announce.length > 0) return [...opts.announce];
  if (opts.role !== 'public') return undefined;
  // Keep listen addresses with a concrete port; drop `/udp/0`, `/tcp/0`.
  const concrete = opts.listen.filter((a) => !/\/(tcp|udp)\/0(?:\/|$)/.test(a));
  if (concrete.length === 0) return undefined;
  return concrete;
}

export async function startMeshNode(opts: MeshNodeOptions): Promise<MeshNode> {
  // Address validation is first — these are the start-time refusals of
  // `MESH_INTERFACE → Transports` / `→ Discovery`. A rejection here never
  // creates a datastore, so a bad config does not litter the state dir.
  assertNoDns('listen', opts.listen);
  if (opts.announce) assertNoDns('announce', opts.announce);
  assertNoDns('bootstrap', opts.bootstrap);
  assertBootstrapHasPeer(opts.bootstrap);

  // `MESH_INTERFACE → NAT` — STUN serves from a public address. A private
  // node with `stun` set is a config error at start, before any socket or
  // datastore is created.
  if (opts.stun && opts.role === 'private') {
    throw new MeshConfigError('stun refused: a private node does not serve STUN');
  }

  // `MESH_INTERFACE → Transports / The IP certificate` — WSS rides a public
  // node's bare IP; a private role, and a hostname where an IP is required,
  // are refused at start before any socket, datastore or ACME account is
  // touched. Address refusal mirrors the DNS guards above: a hostname is
  // never a legitimate `wss.ip`.
  if (opts.wss && opts.role === 'private') {
    throw new MeshConfigError('wss refused: a private node does not serve WSS');
  }
  if (opts.wss && !isIPv4(opts.wss.ip) && !isIPv6(opts.wss.ip)) {
    throw new MeshConfigError(
      `wss.ip refused: ${JSON.stringify(opts.wss.ip)} is not an IP literal`,
    );
  }

  // `datastore-fs` is a pure-JS filesystem datastore (no native, no WASM) —
  // the one dependency the WebRTC-direct certificate's persistence rides on
  // (`MESH_INTERFACE → Transports` → "The WebRTC-direct certificate
  // persists"). The directory must exist; the datastore does not create it.
  mkdirSync(opts.stateDir, { recursive: true });
  const datastore = new FsDatastore(join(opts.stateDir, 'datastore'));

  const clientMode = opts.role === 'private';
  const listen = [...opts.listen];
  // MESH_INTERFACE → NAT — "A private node ... takes relay reservations
  // on public nodes and is reached through them". libp2p 3.5's
  // circuit-relay listener keys off the listen address's shape
  // (`@libp2p/circuit-relay-v2/src/transport/listener.ts`): a bare
  // `/p2p-circuit` triggers RelayDiscovery (a DHT walk / discovery
  // topology / peer-store scan) whose timing varies, while a
  // `/ip4/.../p2p/<relay-peer>/p2p-circuit` opens a connection to the
  // named relay and reserves on it directly. The caller supplies the
  // specific form, one per public relay it bootstraps from, so no
  // auto-append here.

  const peerDiscovery = opts.bootstrap.length > 0
    ? [bootstrap({ list: [...opts.bootstrap] })]
    : [];

  // `MESH_INTERFACE → The IP certificate` — a WSS listener needs its TLS
  // cert and key at construction time, so the initial certificate is
  // resolved before libp2p starts. `initialCertificate` returns null when
  // `current()` reads nothing (or an expired cert) and `obtain()` fails:
  // the node then starts without the WSS listener and the renewal timer
  // retries every `CERT_RETRY_MS` until a certificate arrives, at which
  // point the renewal driver wires the listener in through
  // `transportManager.add` and `.listen`. The WSS fallback must never
  // take the node down.
  let initialCert: IpCertificate | null = null;
  if (opts.wss) initialCert = await initialCertificate(opts.wss);

  // MESH_INTERFACE → NAT — libp2p 3.5's circuit-relay reservation
  // store (`@libp2p/circuit-relay-v2@4.2.17/src/transport/reservation-store.ts`
  // lines 100-105 "ensure we don't listen on multiple relays
  // simultaneously") runs a PeerQueue of `DEFAULT_RESERVATION_CONCURRENCY = 1`
  // (`src/constants.ts:19`): a second configured relay queues
  // behind the first and a stalled first blocks every other.
  // `reservationConcurrency = <relay count>` lets each named relay
  // run its reservation in parallel. `webRTC()` is the browser's
  // path to a private: a circuit-relay v2 connection is LIMITED
  // (`@libp2p/circuit-relay-v2/src/utils.ts` `LimitTracker`), so
  // the relay carries only the SDP signalling and the data goes
  // direct over WebRTC. `WebRTCPeerListener`
  // (`@libp2p/webrtc@7.0.2/src/private-to-private/listener.ts`
  // lines 41-52) encapsulates `/webrtc` onto every circuit listener
  // address, so a `/webrtc` listen entry on a private node makes
  // it announce `<relay>/p2p-circuit/webrtc/p2p/<self>` as soon as
  // each reservation lands.
  const relayCount = opts.bootstrap.length;
  const stunServers = opts.stunServers ?? [];
  // MESH_INTERFACE → NAT — "Only the relayed WebRTC path uses STUN;
  // WebRTC-direct to a public address needs none". The empty
  // iceServers list disables libp2p's `DEFAULT_ICE_SERVERS` fallback
  // (`@libp2p/webrtc@7.0.2/src/constants.ts:12`); the private role's
  // `webRTC()` keeps the configured mesh-node STUN by IP.
  const transports = [
    tcp(),
    webRTCDirect({ rtcConfiguration: { iceServers: [] } }),
    ...(opts.role === 'private' ? [
      webRTC({
        rtcConfiguration: {
          iceServers: stunServers.map((url) => ({ urls: url })),
        },
      }),
      circuitRelayTransport({
        reservationConcurrency: Math.max(1, relayCount),
      }),
    ] : []),
    ...(opts.wss && initialCert
      ? [
          webSockets({
            https: { cert: initialCert.certPem, key: initialCert.keyPem },
          }),
        ]
      : []),
  ];
  // MESH_INTERFACE → NAT — the `/webrtc` listen on a private role
  // tells the WebRTC listener to publish an address per circuit
  // reservation. The marker has no transport components; the
  // listener encapsulates it on top of circuit addresses the
  // relays confirm.
  if (opts.role === 'private' && !listen.includes('/webrtc')) {
    listen.push('/webrtc');
  }

  if (opts.wss && initialCert) {
    const ipFamily = isIPv6(opts.wss.ip) ? 'ip6' : 'ip4';
    listen.push(`/${ipFamily}/${opts.wss.ip}/tcp/${opts.wss.port}/tls/ws`);
  }

  // `MESH_INTERFACE → Discovery` — Kademlia on `/notis/<network>/kad/1.0.0`
  // alone. The `protocol` option replaces the default `/ipfs/kad/1.0.0` for
  // both the server and the client sides of the handler registration, so a
  // Notis node never answers an IPFS DHT walk.
  // Role-specific services ride on a shared skeleton: the public role adds
  // AutoNAT v2 and the circuit-relay server; the private role adds DCUtR
  // (`MESH_INTERFACE → NAT`).
  const commonServices = {
    identify: identify(),
    ping: ping(),
    http: httpService({ server: nodeApiServer(opts.upstream) }),
    keychain: keychain(),
    dht: kadDHT({ protocol: dhtProtocol(opts.network), clientMode }),
  };

  // MESH_INTERFACE → Discovery — a public mesh node without an explicit
  // announce defaults to its listen list, so libp2p 3.5's address
  // manager returns the listen addresses as verified from the start
  // (`libp2p/src/address-manager/transport-addresses.ts` would otherwise
  // hold a public IP out until AutoNAT confirms). The WebRTC-direct
  // listener splices the /certhash/ onto every announce entry it
  // matches, so the browser gets a dialable address at once.
  const announce = effectiveAnnounce({ role: opts.role, listen, announce: opts.announce });
  // MESH_INTERFACE → NAT — "A `private` node announces its relay
  // reservations alone". libp2p 3.5's `AddressManager` runs its
  // `announceFilter` over every address it would otherwise announce
  // (`libp2p/src/address-manager/index.js` `getAddresses()`:
  // `return this.announceFilter(multiaddrs.map(...))` on the full
  // post-`/p2p/<self>` list). A private node has no listen address
  // worth announcing — only the circuit reservations it holds — so
  // the filter keeps the `/p2p-circuit`-bearing addresses and drops
  // the rest. A public node runs with libp2p's default
  // (identity-passing) filter.
  const addresses = {
    listen,
    ...(announce !== undefined ? { announce } : {}),
    ...(opts.role === 'private'
      ? {
          announceFilter: (mas: Multiaddr[]) =>
            mas.filter((ma) => ma.toString().includes('/p2p-circuit')),
        }
      : {}),
  };
  // MESH_INTERFACE → NAT — "A relay that does not answer never stops
  // a private node ... is tried again on the node list's retry cadence
  // (RETRY_BASE_MS doubling to RETRY_CAP_MS)". libp2p 3.5 awaits every
  // listener at start (`libp2p/src/transport-manager.ts`
  // `Promise.allSettled(tasks)` line 296): a `/p2p-circuit` listen
  // whose reservation never completes holds the whole start forever —
  // `FaultTolerance.NO_FATAL` tolerates a FAILED listen, not one
  // that never returns. So a private node starts on its own
  // (non-circuit) listen addresses alone, and each circuit listen is
  // added AFTER start through `startRelayRetry` below — one
  // `transportManager.listen([addr])` call at a time, under its own
  // deadline. `NO_FATAL` stays set as a defence in depth for the
  // retry calls themselves.
  const initialListen = addresses.listen.filter((a) => !a.includes('/p2p-circuit'));
  const circuitAddrs = addresses.listen.filter((a) => a.includes('/p2p-circuit'));
  const initialAddresses = {
    ...addresses,
    listen: initialListen,
  };
  const common = {
    privateKey: opts.key.privateKey,
    datastore,
    addresses: initialAddresses,
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    ...(opts.role === 'private'
      ? { transportManager: { faultTolerance: FaultTolerance.NO_FATAL } }
      : {}),
  };

  // Two role-specific `createLibp2p` calls — one per shape of the service
  // map — so TypeScript can infer each ServiceFactoryMap unambiguously.
  const node = opts.role === 'public'
    ? await createLibp2p({
        ...common,
        services: {
          ...commonServices,
          autoNAT: autoNATv2(),
          // MESH_INTERFACE → NAT → "A relay carries data" — a public
          // node relays with no circuit limit, so a client reaches a
          // private node that has no direct path through the relay
          // itself. `applyDefaultLimit: false` drops libp2p's default
          // 128 KiB / 2-minute reservation limit; the HOP answer
          // carries no limit, every connection the dialer makes
          // through the relay reads `conn.limits === undefined`, and
          // application streams open without `runOnLimitedConnection`.
          circuitRelay: circuitRelayServer({
            reservations: { applyDefaultLimit: false },
          }),
        },
      })
    : await createLibp2p({
        ...common,
        services: {
          ...commonServices,
          dcutr: dcutr(),
        },
      });

  const typed = node as unknown as Libp2p<{ http: HTTP }>;

  // `MESH_INTERFACE → NAT` — a public node runs a STUN server where its
  // operator names an IP and UDP port for one. Started after libp2p so
  // a failure to bind the UDP socket tears libp2p down before returning.
  let stun: { close(): Promise<void> } | null = null;
  if (opts.stun) {
    try {
      stun = await startStunServer(opts.stun);
    } catch (e) {
      try { await typed.stop(); } catch { /* already stopped */ }
      throw e;
    }
  }

  // `MESH_INTERFACE → The IP certificate` — the renewal timer swaps the
  // listener's certificate in place at half the lifetime and closes the
  // WSS listener at `notAfter`; with no initial certificate it retries
  // `obtain()` every `CERT_RETRY_MS` and wires the listener in on the
  // first successful retry. Started after libp2p because it fires events
  // on the shared bus and may reach into the transport manager.
  let wssRenewal: WssRenewal | null = null;
  if (opts.wss) {
    wssRenewal = startWssRenewal(typed, opts.wss, {
      cert: initialCert,
      lastFailureMs: initialCert === null ? Date.now() : null,
    });
  }

  // MESH_INTERFACE → NAT — "A relay that does not answer never stops a
  // private node ... is tried again on the node list's retry cadence
  // (RETRY_BASE_MS doubling to RETRY_CAP_MS)". Each `/p2p-circuit`
  // listen address is added after start on its own schedule — the
  // initial `createLibp2p` saw none of them, so no reservation stall
  // could have held up start. A reservation that lands and later
  // goes away (`relay:removed`) starts a fresh retry. The retry
  // calls `transportManager.listen([addr])` — the same public code
  // path `@libp2p/circuit-relay-v2`'s own transport uses in `onStop`
  // (`transport/index.ts` line 269). `transportManager` is a public
  // field of the libp2p instance (`libp2p/src/libp2p.ts` line 40
  // `public components`).
  const retries: Array<RelayRetry> = [];
  if (opts.role === 'private') {
    for (const addr of circuitAddrs) {
      retries.push(startRelayRetry(typed, addr, {
        baseMs: opts.relayRetryBaseMs ?? RETRY_BASE_MS,
        capMs: opts.relayRetryCapMs ?? RETRY_CAP_MS,
      }));
    }
  }

  return {
    libp2p: typed,
    multiaddrs: () => typed.getMultiaddrs().map((a) => a.toString()),
    // MESH_INTERFACE → Discovery → "A node added by hand" — the
    // listener-level addresses, not announce-filtered. The
    // WebRTC-direct listener's `getAddrs()` splices `/certhash/` onto
    // its listen address at read time (`@libp2p/webrtc`
    // `private-to-public/listener.ts` `getAddrs()`), so a private
    // node's local WebRTC-direct address lands here with its hash.
    // The reach is the public `components.transportManager` field
    // libp2p 3.5 publishes on the host (`libp2p/src/libp2p.ts` line
    // 40, "public components"), the same seam `startRelayRetry` and
    // `wss.ts` use.
    listenerAddrs: () => {
      const components = (typed as unknown as {
        components: {
          transportManager: {
            getListeners(): Array<{ getAddrs(): Array<{ toString(): string }> }>;
          };
        };
      }).components;
      const out: string[] = [];
      for (const l of components.transportManager.getListeners()) {
        for (const a of l.getAddrs()) out.push(a.toString());
      }
      return out;
    },
    async stop() {
      for (const r of retries) r.stop();
      retries.length = 0;
      if (wssRenewal) {
        wssRenewal.stop();
        wssRenewal = null;
      }
      if (stun) {
        // `startStunServer`'s close is idempotent (fix 7, matching
        // `stream.abort`): a bare call surfaces a surprise instead of
        // swallowing it.
        await stun.close();
        stun = null;
      }
      await typed.stop();
    },
  };
}

interface RelayRetry {
  stop(): void;
}

/**
 * Keep a private node's `/p2p-circuit` listen address reserved. The
 * initial listen may have failed under `FaultTolerance.NO_FATAL`; try
 * again on the schedule `retryIntervalMs(failures)`, each attempt a
 * fresh `transportManager.listen([addr])` call. On success, the
 * circuit listener dials the relay and reserves. A reservation that
 * is later removed (`self:peer:update` drops the circuit entry) kicks
 * off a fresh retry at `failures = 1`.
 */
function startRelayRetry(
  node: Libp2p<{ http: HTTP }>,
  addrString: string,
  opts: { baseMs: number; capMs: number },
): RelayRetry {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let reserved = false;

  const addr = multiaddr(addrString);

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

  // Each listen attempt runs under its own `RELAY_LISTEN_TIMEOUT_MS`
  // (`protocols.ts`, 10 s) — the circuit relay's reservation attempt
  // times out at `DEFAULT_RESERVATION_COMPLETION_TIMEOUT = 5_000` ms,
  // but a multistream negotiation that opens a stream and hangs can
  // stall the listener's promise past that; past the deadline the
  // attempt counts as a failure and `retryIntervalMs` schedules the
  // next one.
  const attempt = async (): Promise<void> => {
    if (stopped) return;
    if (hasReservation()) {
      reserved = true;
      failures = 0;
      // Nothing to do; the self:peer:update listener below triggers
      // the next attempt if the reservation goes away.
      return;
    }
    try {
      // `components.transportManager` is public on the libp2p
      // instance (see the comment above the call site); the typed
      // interface does not expose it, so the cast is unavoidable.
      const components = (node as unknown as { components: { transportManager: { listen(ma: unknown[]): Promise<void> } } }).components;
      const listenPromise = components.transportManager.listen([addr]);
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const deadlinePromise = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new Error(`listen deadline (${RELAY_LISTEN_TIMEOUT_MS} ms)`)),
          RELAY_LISTEN_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([listenPromise, deadlinePromise]);
      } finally {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      }
      // `transportManager.listen` resolves even when the circuit
      // listener's inner connect refused — the task catches each
      // error (`transport-manager.ts`'s per-task catch, line 287).
      // So check post-call whether a reservation lands.
      // The `self:peer:update` listener will flip `reserved` to true
      // when it does; here we schedule another check soon.
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

  const onPeerUpdate = (): void => {
    if (stopped) return;
    const nowReserved = hasReservation();
    if (nowReserved && !reserved) {
      reserved = true;
      failures = 0;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    } else if (!nowReserved && reserved) {
      // The reservation went away (connection dropped, relay
      // removed): a fresh retry at `failures = 1`.
      reserved = false;
      failures = 0;
      scheduleRetry(0);
    }
  };

  node.addEventListener('self:peer:update', onPeerUpdate);

  // Kick off the first check right after start — the initial listen
  // may have succeeded (nothing to do) or failed (retry).
  scheduleRetry(0);

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      node.removeEventListener('self:peer:update', onPeerUpdate);
    },
  };
}
