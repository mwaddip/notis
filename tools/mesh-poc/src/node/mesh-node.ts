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
import { join } from 'node:path';
import type { NodeKey } from '../identity.js';
import { dhtProtocol, type NetworkName } from '../protocols.js';
import { nodeApiServer } from './api-forward.js';

/**
 * MESH_INTERFACE → Transports / Discovery — a start-time refusal: a
 * `/dns4/`, `/dns6/` or `/dnsaddr/` component in a `listen`, `announce` or
 * `bootstrap` address, or a `bootstrap` address without a `/p2p/` component.
 */
export class MeshConfigError extends Error {
  override readonly name = 'MeshConfigError';
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
   * MESH_INTERFACE → NAT — a public node runs a STUN server on UDP port
   * `STUN_PORT` of its own IP. A private node with STUN set is refused:
   * STUN serves from a public address.
   */
  readonly stun?: { host: string; port: number };
}

export interface MeshNode {
  readonly libp2p: Libp2p<{ http: HTTP }>;
  multiaddrs(): string[];
  stop(): Promise<void>;
}

const DNS_RE = /\/dns4\/|\/dns6\/|\/dnsaddr\//;

function assertNoDns(label: string, addrs: readonly string[]): void {
  for (const a of addrs) {
    if (DNS_RE.test(a)) {
      throw new MeshConfigError(`${label} address refused: ${a} carries a DNS component`);
    }
  }
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

  const transports = [
    tcp(),
    webRTCDirect(),
    ...(opts.role === 'private' ? [circuitRelayTransport()] : []),
  ];

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

  return {
    libp2p: typed,
    multiaddrs: () => typed.getMultiaddrs().map((a) => a.toString()),
    async stop() {
      await typed.stop();
    },
  };
}
