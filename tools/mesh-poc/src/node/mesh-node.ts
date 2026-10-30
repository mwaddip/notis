// MESH_INTERFACE → Place in the workspace / Transports / NAT / Discovery /
// The node endpoint — a mesh node is a libp2p host that forwards HTTP over
// libp2p to its own Notis node and runs the Notis Kademlia protocol alone.
// Node-only: TCP, the file-backed datastore and the WebRTC-direct listener's
// native binding keep it out of the browser (`MESH_INTERFACE → Place in the
// workspace`).

import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { webRTCDirect } from '@libp2p/webrtc';
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
import { dhtProtocol, type NetworkName } from '../protocols.js';
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
   * MESH_INTERFACE → NAT — a public node runs a STUN server on UDP port
   * `STUN_PORT` of its own IP. A private node with STUN set is refused:
   * STUN serves from a public address.
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
}

export interface MeshNode {
  readonly libp2p: Libp2p<{ http: HTTP }>;
  multiaddrs(): string[];
  stop(): Promise<void>;
}

function assertBootstrapHasPeer(addrs: readonly string[]): void {
  for (const a of addrs) {
    if (!a.includes('/p2p/')) {
      throw new MeshConfigError(`bootstrap address refused: ${a} has no /p2p/ component`);
    }
  }
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
  // A private node accepts circuit-relay reservations on `/p2p-circuit`
  // (`MESH_INTERFACE → NAT`); listening on it is cheap when no relay is
  // configured and makes the role's capability explicit.
  if (opts.role === 'private') listen.push('/p2p-circuit');

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

  const transports = [
    tcp(),
    webRTCDirect(),
    ...(opts.role === 'private' ? [circuitRelayTransport()] : []),
    ...(opts.wss && initialCert
      ? [
          webSockets({
            https: { cert: initialCert.certPem, key: initialCert.keyPem },
          }),
        ]
      : []),
  ];

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

  const addresses = {
    listen,
    ...(opts.announce ? { announce: [...opts.announce] } : {}),
  };
  const common = {
    privateKey: opts.key.privateKey,
    datastore,
    addresses,
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
  };

  // Two role-specific `createLibp2p` calls — one per shape of the service
  // map — so TypeScript can infer each ServiceFactoryMap unambiguously.
  const node = opts.role === 'public'
    ? await createLibp2p({
        ...common,
        services: {
          ...commonServices,
          autoNAT: autoNATv2(),
          circuitRelay: circuitRelayServer(),
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

  // `MESH_INTERFACE → NAT` — a public node runs a STUN server on UDP
  // port `STUN_PORT` of its own IP. Started after libp2p so a failure
  // to bind the UDP socket tears libp2p down before returning.
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

  return {
    libp2p: typed,
    multiaddrs: () => typed.getMultiaddrs().map((a) => a.toString()),
    async stop() {
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
