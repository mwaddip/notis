// MESH_INTERFACE → The client's node list → "The secure WebSocket is
// the fallback" — the client gives libp2p its own address order:
// WebRTC-direct, then WebRTC signalled over a relay, then the secure
// WebSocket, then any other address. A node listing both a
// WebRTC-direct and a secure WebSocket address is reached over
// WebRTC-direct; libp2p's dial queue dials the sorted list one
// address at a time, so the first that connects wins.
//
// This file is the one client-side case ported out of
// `wss.test.ts` — the mesh service is `@dagsocial/net`'s `NetNode`
// with a public mesh that carries both a WebRTC-direct listen
// address and a WSS one. The remaining `wss.test.ts` cases are
// node-side and stay against `startMeshNode` until `src/node/` goes.

// Trust the test's self-signed certificate — the test owns both ends. Set
// before any libp2p/websockets import so the native WebSocket's undici agent
// picks it up at module load.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// @peculiar/x509@2.x pulls in tsyringe, which needs the Reflect polyfill
// loaded before any of its modules.
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
import { generateKeyPair, profileFor, MAGIC_DEVNET } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import type { Libp2p } from '@libp2p/interface';
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
import { startMeshClient, type MeshClient } from '../src/client/mesh-client.js';
import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';

// `@peculiar/x509` takes an optional `Crypto` as its second argument;
// Node 20+ exposes WebCrypto on `node:crypto.webcrypto`. Setting the
// global provider would break `@libp2p/webrtc`'s own cert generation
// — the keyPair the webrtc transport makes under its `@peculiar/webcrypto`
// instance is refused by Node's webcrypto `exportKey` as "not a
// CryptoKey". Passing `webcrypto` explicitly here keeps the global
// provider as `@libp2p/webrtc` sets it.
const TEST_X509_CRYPTO = webcrypto as unknown as Crypto;

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

interface Stub {
  srv: Server;
  base: string;
}

async function makeStub(): Promise<Stub> {
  const srv = createServer((req, res) => {
    if (req.url === '/blocks/current') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height: 1, hash: 'ab'.repeat(32) }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}

interface IpCertificate {
  certPem: string;
  keyPem: string;
  notBefore: number;
  notAfter: number;
}

/**
 * A self-signed certificate for `127.0.0.1`, valid between `notBefore` and
 * `notAfter`. Used by the fake `CertificateSource` to drive the WSS listener
 * without an ACME server.
 */
async function makeSelfSigned(
  notBefore: number,
  notAfter: number,
): Promise<IpCertificate> {
  const keys = await TEST_X509_CRYPTO.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  );
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: Math.floor(Math.random() * 1e12).toString(16),
      name: 'CN=127.0.0.1',
      notBefore: new Date(notBefore),
      notAfter: new Date(notAfter),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      keys,
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          { type: 'ip', value: '127.0.0.1' },
        ]),
      ],
    },
    TEST_X509_CRYPTO,
  );
  const pkcs8 = await TEST_X509_CRYPTO.subtle.exportKey(
    'pkcs8',
    keys.privateKey,
  );
  const keyPem =
    '-----BEGIN PRIVATE KEY-----\n' +
    Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g)!.join('\n') +
    '\n-----END PRIVATE KEY-----\n';
  const certPem = cert.toString('pem');
  return { certPem, keyPem, notBefore, notAfter };
}

/**
 * Start a `NetNode` with a public mesh carrying both a WebRTC-direct
 * listen and the WSS fallback. The `certificateSource` factory is the
 * seam the test seats its self-signed `IpCertificate` through
 * (`NET_INTERFACE → The mesh`); the `acmeDirectory` and
 * `challengePort` fields on `mesh.wss` are present for the schema's
 * sake and unused while the source is injected.
 */
async function startDualListenNode(
  upstream: string,
  stateDir: string,
  cert: IpCertificate,
): Promise<{ node: NetNode; libp2p: Libp2p; id: string; webrtcAddr: string; wsAddr: string }> {
  const profile = profileFor('devnet' as NetworkType);
  const meshConfig: MeshConfig = {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct', '/ip4/127.0.0.1/tcp/0'],
    stateDir,
    httpBase: upstream,
    stun: null,
    wss: { ip: '127.0.0.1', port: 0, acmeDirectory: 'about:blank', challengePort: 0 },
  };
  const config: NetConfig = {
    nodeKey: generateKeyPair(),
    magic: MAGIC_DEVNET,
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
  const node = new NetNode(
    config,
    validators,
    undefined,
    () => ({
      async current() { return cert; },
      async obtain() { return cert; },
    }),
  );
  await node.start();
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  // The WSS listener binds after `start` resolves; getMultiaddrs may
  // not yet include `/tls/ws` on the first read. Poll briefly.
  let wsAddr: string | undefined;
  for (let i = 0; i < 100; i++) {
    const addrs = libp2p.getMultiaddrs().map((a) => a.toString());
    wsAddr = addrs.find((a) => a.includes('/tls/ws'));
    if (wsAddr !== undefined) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const addrs = libp2p.getMultiaddrs().map((a) => a.toString());
  const webrtcAddr = addrs.find((a) => a.includes('/webrtc-direct/'));
  if (webrtcAddr === undefined) {
    await node.stop();
    throw new Error(`no WebRTC-direct listen address: ${JSON.stringify(addrs)}`);
  }
  if (wsAddr === undefined) {
    await node.stop();
    throw new Error(`no /tls/ws listen address: ${JSON.stringify(addrs)}`);
  }
  return {
    node,
    libp2p,
    id: notisIdFromPeerId(libp2p.peerId),
    webrtcAddr,
    wsAddr,
  };
}

describe('wss — client reaches a dual-listen node', () => {
  const nodes: NetNode[] = [];
  const stubs: Stub[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const n of nodes.splice(0)) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const s of stubs.splice(0)) { s.srv.close(); }
    for (const d of dirs.splice(0)) { rmSync(d, { recursive: true, force: true }); }
  });

  it('a client reaches a dual-listen node (webrtc-direct + wss) over webrtc-direct', async () => {
    const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
    const meshClients: MeshClient[] = [];
    try {
      const stub = await makeStub(); stubs.push(stub);
      const dir = mkdtempSync(join(tmpdir(), 'mesh-wss-dual-')); dirs.push(dir);
      const cert = await makeSelfSigned(Date.now(), Date.now() + 60_000);
      const server = await startDualListenNode(stub.base, dir, cert); nodes.push(server.node);

      // Anchor lists wss first, webrtc-direct second — the client's own
      // sorter puts webrtc-direct first whatever the input order is.
      // libp2p's default sorter would have put wss ahead.
      const fakeResolve: typeof import('@dagsocial/nipopow-client').resolveTip
        = async (urls) => {
          const resultNodes: NodeTipResult[] = urls.map((url, i) => ({
            url,
            verified: true,
            proof: { prefix: [], suffixHead: {}, suffixTail: [] } as unknown as NodeTipResult['proof'],
            verifyResult: null,
            refuseReason: null,
            refuseCode: null,
            behind: i === 0 ? 0 : 1,
            genesisHash: 'f'.repeat(64),
          }));
          const out: TipResult = {
            winner: resultNodes[0] ?? null,
            winnerIndex: resultNodes.length > 0 ? 0 : -1,
            nodes: resultNodes,
            tip: null,
            suffixHead: null,
            splits: [],
          };
          return out;
        };
      const client = await startMeshClient({
        anchors: [{ notisId: server.id, addrs: [server.wsAddr, server.webrtcAddr] }],
        network: 'devnet',
        profile: PROFILE,
        resolve: fakeResolve,
      });
      meshClients.push(client);
      await client.check();
      const s = client.state();
      expect(s.nodeId).toBe(server.id);
      expect(s.transport, 'webrtc-direct was first in the one sort order').toBe('webrtc-direct');
      expect(s.path).toBe('direct');
    } finally {
      // Each client is stopped once here; a throw from `stop()` fails
      // the case.
      for (const c of meshClients) await c.stop();
    }
  }, 60_000);
});
