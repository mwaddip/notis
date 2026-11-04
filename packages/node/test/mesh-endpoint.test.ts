// NODE_INTERFACE → Configuration → "The node's mesh endpoint forwards
// to its own public listener" — the mesh node answers HTTP over
// libp2p by forwarding to `http://127.0.0.1:<PORT>`
// (`MESH_INTERFACE → The node endpoint`). The reader dials the node
// over WebRTC-direct, runs `readerHandshake` on an open connection
// and reads through `meshFetchOverConnection`; every answer's status,
// `content-type` and body bytes equal the direct HTTP answer's.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { multiaddr } from '@multiformats/multiaddr';
import type { Connection } from '@libp2p/interface';
import {
  generateKeyPair,
  PROTOCOL_VERSION,
  MAX_BLOCK_BODY_BYTES,
  profileFor,
} from '@dagsocial/types';
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
import { NetNode, MAGIC_TESTNET } from '@dagsocial/net';
import type { MeshConfig, NetValidators } from '@dagsocial/net';
// `@dagsocial/net/browser` is the browser entry, a second barrel
// beside the node one; vitest's workspace alias resolves the main
// package name only, so this import points at `net`'s own source. Net
// builds both barrels (ARCHITECTURE → "Build and test resolution").
import {
  nodeKeyFromKeyPair,
  readerHandshake,
  readerLibp2pOptions,
  meshFetchOverConnection,
  meshBaseUrl,
} from '../../net/src/browser.js';
import { initDb, getDb, closeDb } from '../src/store/db.js';
import { createApp, listenPublic, HTTP_BODY_MAX_BYTES } from '../src/server.js';
import { makeTestConfig } from './helpers.js';

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

async function webrtcDirectAddrOf(node: NetNode): Promise<string> {
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  for (let i = 0; i < 400; i++) {
    const match = libp2p
      .getMultiaddrs()
      .map((m) => m.toString())
      .find((s) => /\/webrtc-direct\/certhash\//.test(s));
    if (match !== undefined) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('node has no WebRTC-direct listen address');
}

describe(`NODE_INTERFACE → Configuration → "The node's mesh endpoint forwards to its own public listener"`, () => {
  let server: Server | null = null;
  let node: NetNode | null = null;
  let reader: Libp2p | null = null;
  let dir: string | null = null;
  let baseUrl = '';
  let notisId = '';
  let conn: Connection | null = null;

  beforeEach(async () => {
    initDb(':memory:');
    // A seeded member row so `/status` admits — mirrors
    // server.test.ts's one-member bootstrap.
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const cfg = makeTestConfig({
      port: 0,
      dbPath: ':memory:',
      networkType: 'testnet',
      profile: profileFor('testnet'),
      nodeRole: 'server',
      blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
      orderingBlockPowTargetBits: 3072,
      bootstrapPeers: [],
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      maxPeers: 50,
      mesh: null,
    });
    const app = createApp(cfg);
    server = listenPublic(app, 0);
    await new Promise<void>((r) => server!.once('listening', r));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    dir = mkdtempSync(join(tmpdir(), 'node-mesh-endpoint-'));
    const nodeKey = generateKeyPair();
    const mesh: MeshConfig = {
      role: 'public',
      network: 'testnet',
      listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
      stateDir: dir,
      httpBase: baseUrl,
      stun: null,
    };
    node = new NetNode(
      {
        nodeKey,
        magic: MAGIC_TESTNET,
        protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
        orderingBlockPowTargetFloorBits: 2304,
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
        mesh,
      },
      validators,
    );
    await node.start();
    notisId = nodeKeyFromKeyPair(nodeKey).notisId;

    reader = await createLibp2p(readerLibp2pOptions({
      privateKey: nodeKeyFromKeyPair(generateKeyPair()).privateKey,
      magic: MAGIC_TESTNET,
      network: 'testnet',
      iceServers: () => [],
      denyDialMultiaddr: () => false,
    }));

    const webrtcAddr = await webrtcDirectAddrOf(node);
    conn = await reader.dial(multiaddr(webrtcAddr));
    const result = await readerHandshake(conn, {
      magic: MAGIC_TESTNET,
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'mesh-endpoint-test',
      chainHeight: 0,
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
  }, 60_000);

  afterEach(async () => {
    try { await reader?.stop(); } catch { /* already stopped */ }
    try { await node?.stop(); } catch { /* already stopped */ }
    await new Promise<void>((r) => { server?.close(() => r()); });
    closeDb();
    if (dir !== null) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }
    server = null; node = null; reader = null; dir = null; conn = null;
  });

  function pick(id: string): Connection | null {
    return id === notisId ? conn : null;
  }

  it('GET /blocks/current — the mesh answer equals the direct answer', async () => {
    const fetchMesh = meshFetchOverConnection(pick);
    const meshRes = await fetchMesh(`${meshBaseUrl(notisId)}/blocks/current`);
    const directRes = await fetch(`${baseUrl}/blocks/current`);
    expect(meshRes.status).toBe(directRes.status);
    expect(meshRes.headers.get('content-type')).toBe(directRes.headers.get('content-type'));
    const meshBuf = new Uint8Array(await meshRes.arrayBuffer());
    const directBuf = new Uint8Array(await directRes.arrayBuffer());
    expect(Buffer.compare(Buffer.from(meshBuf), Buffer.from(directBuf))).toBe(0);
  }, 60_000);

  it('POST /likes — a body the node refuses: mesh answer equals direct answer', async () => {
    const fetchMesh = meshFetchOverConnection(pick);
    // A bare `{}` the likes route refuses as missing fields — the
    // answer's status and body are the parser's/route's, which the
    // mesh forwards byte for byte.
    const bodyBytes = new TextEncoder().encode('{}');
    const meshRes = await fetchMesh(`${meshBaseUrl(notisId)}/likes`, {
      method: 'POST',
      body: new Blob([bodyBytes], { type: 'application/json' }),
    });
    const directRes = await fetch(`${baseUrl}/likes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyBytes,
    });
    expect(meshRes.status).toBe(directRes.status);
    expect(meshRes.headers.get('content-type')).toBe(directRes.headers.get('content-type'));
    expect(await meshRes.text()).toBe(await directRes.text());
  }, 60_000);

  it('POST over HTTP_BODY_MAX_BYTES — the parser answers 413: mesh answer equals direct answer', async () => {
    const fetchMesh = meshFetchOverConnection(pick);
    // One byte over the limit; the body need not be valid JSON — the
    // parser refuses at the limit, before any route reads it
    // (NODE_INTERFACE → HTTP API → "A body the parser refuses is the
    // client's error").
    const bodyBytes = new Uint8Array(HTTP_BODY_MAX_BYTES + 1);
    const meshRes = await fetchMesh(`${meshBaseUrl(notisId)}/likes`, {
      method: 'POST',
      body: new Blob([bodyBytes], { type: 'application/json' }),
    });
    const directRes = await fetch(`${baseUrl}/likes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyBytes,
    });
    expect(meshRes.status).toBe(directRes.status);
    expect(meshRes.headers.get('content-type')).toBe(directRes.headers.get('content-type'));
    expect(await meshRes.text()).toBe(await directRes.text());
  }, 60_000);

  it('POST with no content-type — mesh answer equals direct answer', async () => {
    const fetchMesh = meshFetchOverConnection(pick);
    // `@libp2p/http-fetch`'s `normalizeContent` leaves a `Blob` whose
    // type is `''` without setting a content-type on the upstream
    // request, matching a direct fetch that passes no header.
    const bodyBytes = new TextEncoder().encode('{}');
    const meshRes = await fetchMesh(`${meshBaseUrl(notisId)}/likes`, {
      method: 'POST',
      body: new Blob([bodyBytes]),
    });
    const directRes = await fetch(`${baseUrl}/likes`, {
      method: 'POST',
      body: bodyBytes,
    });
    expect(meshRes.status).toBe(directRes.status);
    expect(meshRes.headers.get('content-type')).toBe(directRes.headers.get('content-type'));
    expect(await meshRes.text()).toBe(await directRes.text());
  }, 60_000);

  it('GET /admin/health — mesh answer equals direct answer', async () => {
    // `/admin/health` is the admin app's route; the public app the
    // mesh forwards to does not mount `/admin`, so direct and mesh
    // both reach the public app's 404 (NODE_INTERFACE → The public
    // server; the admin listener is a second server at
    // `ADMIN_BIND_ADDRESS`).
    const fetchMesh = meshFetchOverConnection(pick);
    const meshRes = await fetchMesh(`${meshBaseUrl(notisId)}/admin/health`);
    const directRes = await fetch(`${baseUrl}/admin/health`);
    expect(meshRes.status).toBe(directRes.status);
    expect(meshRes.headers.get('content-type')).toBe(directRes.headers.get('content-type'));
    expect(await meshRes.text()).toBe(await directRes.text());
  }, 60_000);
});
