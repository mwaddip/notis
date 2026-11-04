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
  httpBase: 'http://127.0.0.1:0',
  stun: null,
} as const;

describe('mesh — public announce', () => {
  it('a public node announces every listen address with a concrete port', () => {
    const mesh: MeshConfig = {
      ...baseMesh,
      role: 'public',
      listen: ['/ip4/11.100.0.11/udp/4001/webrtc-direct', '/ip4/11.100.0.11/tcp/4002'],
    };
    const listen = ['/ip4/11.100.0.11/tcp/9100', ...mesh.listen];
    expect(effectiveAnnounce(listen, mesh)).toEqual([
      '/ip4/11.100.0.11/tcp/9100',
      '/ip4/11.100.0.11/udp/4001/webrtc-direct',
      '/ip4/11.100.0.11/tcp/4002',
    ]);
  });

  it('mesh.announce replaces the auto-default', () => {
    const mesh: MeshConfig = {
      ...baseMesh,
      role: 'public',
      listen: ['/ip4/11.100.0.11/udp/4001/webrtc-direct'],
      announce: ['/ip4/203.0.113.4/udp/4001/webrtc-direct'],
    };
    const listen = ['/ip4/11.100.0.11/tcp/9100', ...mesh.listen];
    expect(effectiveAnnounce(listen, mesh)).toEqual([
      '/ip4/203.0.113.4/udp/4001/webrtc-direct',
    ]);
  });

  it('a /udp/0 or /tcp/0 listen is dropped from the auto-default', () => {
    const mesh: MeshConfig = {
      ...baseMesh,
      role: 'public',
      listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct', '/ip4/11.100.0.11/tcp/4002'],
    };
    const listen = ['/ip4/127.0.0.1/tcp/0', ...mesh.listen];
    expect(effectiveAnnounce(listen, mesh)).toEqual([
      '/ip4/11.100.0.11/tcp/4002',
    ]);
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
        httpBase: 'http://127.0.0.1:0',
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
});
