// `MESH_INTERFACE → NAT → "A public node announces its listen addresses from the start"`
// — the options-level guard. A public node's `addresses.announce` is
// every listen address with a concrete port: the plain `listenAddrs`
// and every `mesh.listen` entry, `/tcp/0` and `/udp/0` dropped;
// `mesh.announce` replaces the auto-default; a private config carries
// no announce. The live guard reads `meshIdentity().multiaddrs` right
// after `start()`: a public node on a WebRTC-direct listen holds a
// `/webrtc-direct/certhash/` address at once, libp2p 3.5's listener
// splicing the certhash onto the announced entry
// (`@libp2p/webrtc@7.0.2/src/private-to-public/listener.ts`
// `updateAnnounceAddrs`).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@dagsocial/types';
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

import { NetNode, type NetValidators } from '../../src/index.js';
import { effectiveAnnounce } from '../../src/mesh/libp2p-options.js';
import type { MeshConfig } from '../../src/mesh/config.js';
import { makeConfig } from '../helpers.js';

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

const baseMesh = {
  network: 'devnet' as const,
  stateDir: '/tmp/unused',
  httpBase: () => 'http://127.0.0.1:0',
  stun: null,
} as const;

describe('mesh — public announce', () => {
  it('a public node on all-concrete ports announces every listen entry verbatim', () => {
    const mesh: MeshConfig = {
      ...baseMesh,
      role: 'public',
      listen: ['/ip4/11.100.0.11/udp/4001/webrtc-direct', '/ip4/11.100.0.11/tcp/4002'],
    };
    const listen = ['/ip4/11.100.0.11/tcp/9100', ...mesh.listen];
    expect(effectiveAnnounce(listen, mesh)).toEqual({
      announce: [
        '/ip4/11.100.0.11/tcp/9100',
        '/ip4/11.100.0.11/udp/4001/webrtc-direct',
        '/ip4/11.100.0.11/tcp/4002',
      ],
    });
  });

  it('mesh.announce replaces the auto-default', () => {
    const mesh: MeshConfig = {
      ...baseMesh,
      role: 'public',
      listen: ['/ip4/11.100.0.11/udp/4001/webrtc-direct'],
      announce: ['/ip4/203.0.113.4/udp/4001/webrtc-direct'],
    };
    const listen = ['/ip4/11.100.0.11/tcp/9100', ...mesh.listen];
    expect(effectiveAnnounce(listen, mesh)).toEqual({
      announce: ['/ip4/203.0.113.4/udp/4001/webrtc-direct'],
    });
  });

  it('a port-0 listen beside a concrete entry shifts to appendAnnounce of the concrete alone', () => {
    const mesh: MeshConfig = {
      ...baseMesh,
      role: 'public',
      listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct', '/ip4/11.100.0.11/tcp/4002'],
    };
    const listen = ['/ip4/127.0.0.1/tcp/0', ...mesh.listen];
    expect(effectiveAnnounce(listen, mesh)).toEqual({
      appendAnnounce: ['/ip4/11.100.0.11/tcp/4002'],
    });
  });

  it('a configuration with every entry on port 0 answers undefined — transport addresses carry the announce', () => {
    const mesh: MeshConfig = {
      ...baseMesh,
      role: 'public',
      listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    };
    const listen = ['/ip4/127.0.0.1/tcp/0', ...mesh.listen];
    expect(effectiveAnnounce(listen, mesh)).toBeUndefined();
  });

  it('a private config carries no announce', () => {
    const mesh: MeshConfig = {
      ...baseMesh,
      role: 'private',
      listen: ['/ip4/11.100.0.11/udp/4001/webrtc-direct'],
    };
    const listen = ['/ip4/11.100.0.11/tcp/9100', ...mesh.listen];
    expect(effectiveAnnounce(listen, mesh)).toBeUndefined();
  });
});

describe('mesh — public announce (live)', () => {
  let nodes: NetNode[] = [];
  let dirs: string[] = [];
  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    nodes = []; dirs = [];
  });

  it('meshIdentity().multiaddrs holds a /webrtc-direct/certhash/ address immediately after start()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-announce-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: {
        role: 'public',
        network: 'devnet',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
        stateDir: dir,
        httpBase: () => 'http://127.0.0.1:0',
        stun: null,
      },
    }), validators);
    await node.start();
    nodes.push(node);
    const id = node.meshIdentity();
    expect(id).not.toBeNull();
    const hasWebrtcDirectCerthash = id!.multiaddrs.some(
      (a) => /\/webrtc-direct\/certhash\//.test(a),
    );
    expect(hasWebrtcDirectCerthash).toBe(true);
  }, 30_000);

  // `MESH_INTERFACE → NAT → "A public node announces its listen
  // addresses from the start"` — every listen address at the port it
  // bound, port 0 included. A node whose TCP and WebRTC-direct listens
  // are both on port 0 holds both bound ports in `meshIdentity().multiaddrs`.
  it('a public node on tcp/0 and webrtc-direct udp/0 announces both at their bound ports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-announce-00-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: {
        role: 'public',
        network: 'devnet',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
        stateDir: dir,
        httpBase: () => 'http://127.0.0.1:0',
        stun: null,
      },
    }), validators);
    await node.start();
    nodes.push(node);
    const mas = node.meshIdentity()!.multiaddrs;
    const tcpBound = mas.find((a) => /\/ip4\/127\.0\.0\.1\/tcp\/\d+/.test(a) && !/\/webrtc/.test(a));
    const webrtcBound = mas.find((a) => /\/ip4\/127\.0\.0\.1\/udp\/\d+\/webrtc-direct\/certhash\//.test(a));
    expect(tcpBound).toBeDefined();
    expect(webrtcBound).toBeDefined();
    // Both ports are non-zero (the kernel picked them at bind).
    expect(/\/tcp\/0(?:\/|$)/.test(tcpBound!)).toBe(false);
    expect(/\/udp\/0\/webrtc-direct/.test(webrtcBound!)).toBe(false);
  }, 30_000);

  // `MESH_INTERFACE → NAT → "A public node announces its listen
  // addresses from the start"` — after a restart that keeps the state
  // directory, the operator pins the WebRTC-direct port to the first
  // start's bound one; TCP stays on port 0. Both bound ports are
  // announced on the restarted node.
  it('a public node restarted with webrtc-direct pinned and tcp/0 announces both at their bound ports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-announce-pin-'));
    dirs.push(dir);
    const key = generateKeyPair();

    const first = new NetNode(makeConfig({
      nodeKey: key,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: {
        role: 'public',
        network: 'devnet',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
        stateDir: dir,
        httpBase: () => 'http://127.0.0.1:0',
        stun: null,
      },
    }), validators);
    await first.start();
    const firstWebrtc = first.meshIdentity()!.multiaddrs
      .find((a) => /\/udp\/\d+\/webrtc-direct\/certhash\//.test(a))!;
    const firstPortMatch = /\/udp\/(\d+)\/webrtc-direct/.exec(firstWebrtc);
    const pinnedPort = Number.parseInt(firstPortMatch![1]!, 10);
    await first.stop();

    const second = new NetNode(makeConfig({
      nodeKey: key,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: {
        role: 'public',
        network: 'devnet',
        listen: [`/ip4/127.0.0.1/udp/${pinnedPort}/webrtc-direct`],
        stateDir: dir,
        httpBase: () => 'http://127.0.0.1:0',
        stun: null,
      },
    }), validators);
    await second.start();
    nodes.push(second);
    const mas = second.meshIdentity()!.multiaddrs;
    const tcpBound = mas.find((a) => /\/ip4\/127\.0\.0\.1\/tcp\/\d+/.test(a) && !/\/webrtc/.test(a));
    const webrtcBound = mas.find((a) => /\/ip4\/127\.0\.0\.1\/udp\/\d+\/webrtc-direct\/certhash\//.test(a));
    expect(tcpBound).toBeDefined();
    expect(webrtcBound).toBeDefined();
    // The webrtc-direct port is the pinned one; the TCP port is the
    // kernel's choice at the restart.
    expect(webrtcBound).toMatch(new RegExp(`/udp/${pinnedPort}/webrtc-direct/certhash/`));
    expect(/\/tcp\/0(?:\/|$)/.test(tcpBound!)).toBe(false);
  }, 60_000);

  // `MESH_INTERFACE → NAT → "A public node announces its listen
  // addresses from the start"` — a concrete TCP port beside a
  // webrtc-direct listen on udp/0 announces both at their bound ports.
  it('a public node on tcp/<concrete> + webrtc-direct udp/0 announces both at their bound ports', async () => {
    // Bind a TCP socket to find a free port, then release it — the
    // kernel usually hands the same port back on the next listen; a
    // rare collision would retry here if it mattered.
    const { createServer } = await import('node:net');
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const tcpPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-announce-mixed-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: `/ip4/127.0.0.1/tcp/${tcpPort}`,
      mesh: {
        role: 'public',
        network: 'devnet',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
        stateDir: dir,
        httpBase: () => 'http://127.0.0.1:0',
        stun: null,
      },
    }), validators);
    await node.start();
    nodes.push(node);
    const mas = node.meshIdentity()!.multiaddrs;
    const tcpBound = mas.find((a) => a.includes(`/ip4/127.0.0.1/tcp/${tcpPort}`) && !/\/webrtc/.test(a));
    const webrtcBound = mas.find((a) => /\/ip4\/127\.0\.0\.1\/udp\/\d+\/webrtc-direct\/certhash\//.test(a));
    expect(tcpBound).toBeDefined();
    expect(webrtcBound).toBeDefined();
    expect(/\/udp\/0\/webrtc-direct/.test(webrtcBound!)).toBe(false);
  }, 30_000);
});
