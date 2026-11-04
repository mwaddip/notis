// NET_INTERFACE → The mesh — a `NetNode` running a public mesh,
// shaped for the PoC's client-side cases. The mesh endpoint forwards
// each GET and POST to `upstream.base`, which lets the client-side
// cases keep the chain harness and hostile-upstream stubs they held
// against `startMeshNode`. The node answers `net`'s reader handshake
// itself with `NODE_CAPABILITIES`, so cases need no handshake
// responder on the side.
//
// `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by
// IP"` — these cases never exercise STUN, so `stun: null` keeps
// `STUN_PORT` (3478) unbound and files never race one another under
// vitest's forks pool.

import type { Libp2p } from '@libp2p/interface';
import { generateKeyPair, profileFor, MAGIC_DEVNET } from '@dagsocial/types';
import type { KeyPair, NetworkType } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';
import { NetNode } from '@dagsocial/net';
import type { NetConfig, NetValidators, MeshConfig } from '@dagsocial/net';
import { notisIdFromPeerId } from '@dagsocial/net/browser';

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

export interface NetMeshNode {
  readonly node: NetNode;
  readonly id: string;
  readonly webrtcAddr: string;
  readonly libp2p: Libp2p;
  stop(): Promise<void>;
}

export interface NetMeshNodeOptions {
  readonly upstream: string;
  readonly stateDir: string;
  readonly network?: NetworkType;
  readonly listen?: readonly string[];
  readonly nodeKey?: KeyPair;
}

/**
 * Start a `NetNode` whose mesh is a public role forwarding to
 * `options.upstream` — the shape the PoC's client-side cases drive
 * against. The returned `webrtcAddr` is the first `/webrtc-direct/`
 * multiaddr `getMultiaddrs` returns, with the node's `/p2p/<peerId>`
 * trailing.
 */
export async function startNetPublicMesh(options: NetMeshNodeOptions): Promise<NetMeshNode> {
  const network: NetworkType = options.network ?? 'devnet';
  const profile = profileFor(network);
  const nodeKey = options.nodeKey ?? generateKeyPair();
  const listen = options.listen ?? ['/ip4/127.0.0.1/udp/0/webrtc-direct'];
  const meshConfig: MeshConfig = {
    role: 'public',
    network,
    listen: [...listen],
    stateDir: options.stateDir,
    httpBase: options.upstream,
    stun: null,
  };
  const config: NetConfig = {
    nodeKey,
    magic: profile.magic === MAGIC_DEVNET ? MAGIC_DEVNET : profile.magic,
    protocolVersionSchedule: profile.protocolVersionSchedule,
    orderingBlockPowTargetFloorBits: profile.orderingBlockPowTargetFloorBits,
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 10,
    maxReaders: 100,
    minPeers: 3,
    peerDbCap: 1_000,
    outboundRedialCooldownMs: 60_000,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3_600_000,
    penaltyDecayIntervalMs: 120_000,
    syncRequestTimeoutMs: 10_000,
    mesh: meshConfig,
  };
  const node = new NetNode(config, validators);
  await node.start();
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  const addrs = libp2p.getMultiaddrs().map((a) => a.toString());
  const webrtcAddr = addrs.find((a) => a.includes('/webrtc-direct/'));
  if (webrtcAddr === undefined) {
    await node.stop();
    throw new Error(`no WebRTC-direct listen address: ${JSON.stringify(addrs)}`);
  }
  const id = notisIdFromPeerId(libp2p.peerId);
  return {
    node,
    id,
    webrtcAddr,
    libp2p,
    stop: () => node.stop(),
  };
}
