// NET_INTERFACE → The mesh — the start-time refusals a `MeshConfig`
// meets, before any socket opens or state directory is written to.
// Each refusal is `MeshConfigError` and names what is not built yet
// (private role, wss) or the setting the operator passed (listen
// without /webrtc-direct, a DNS announce).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { NetNode, MeshConfigError } from '../../src/index.js';
import type { NetValidators } from '../../src/index.js';
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

describe('mesh — start-time refusals', () => {
  let dirs: string[] = [];
  let nodes: NetNode[] = [];

  afterEach(async () => {
    for (const n of nodes) {
      try { await n.stop(); } catch { /* already stopped */ }
    }
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    nodes = []; dirs = [];
  });

  function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'net-mesh-refusals-'));
    dirs.push(d);
    return d;
  }

  async function expectMeshConfigError(start: () => Promise<NetNode>): Promise<MeshConfigError> {
    let started: NetNode | null = null;
    let thrown: unknown;
    try {
      started = await start();
    } catch (e) {
      thrown = e;
    } finally {
      if (started !== null) {
        nodes.push(started);
      }
    }
    expect(thrown).toBeInstanceOf(MeshConfigError);
    return thrown as MeshConfigError;
  }

  it("refuses role: 'private' naming the later run's subject", async () => {
    const dir = freshDir();
    const err = await expectMeshConfigError(async () => {
      const n = new NetNode(makeConfig({
        mesh: {
          role: 'private',
          network: 'devnet',
          listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
          stateDir: dir,
          httpBase: 'http://127.0.0.1:0',
        },
      }), validators);
      await n.start();
      return n;
    });
    expect(err.message).toMatch(/private/);
  });

  it('refuses mesh.wss naming the later run\'s subject', async () => {
    const dir = freshDir();
    const err = await expectMeshConfigError(async () => {
      const n = new NetNode(makeConfig({
        mesh: {
          role: 'public',
          network: 'devnet',
          listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
          stateDir: dir,
          httpBase: 'http://127.0.0.1:0',
          wss: { ip: '192.0.2.1', port: 443, acmeDirectory: '', challengePort: 80 },
        },
      }), validators);
      await n.start();
      return n;
    });
    expect(err.message).toMatch(/wss|WebSocket/i);
  });

  it('refuses a public listen with no /webrtc-direct', async () => {
    const dir = freshDir();
    const err = await expectMeshConfigError(async () => {
      const n = new NetNode(makeConfig({
        mesh: {
          role: 'public',
          network: 'devnet',
          listen: ['/ip4/127.0.0.1/tcp/0'],
          stateDir: dir,
          httpBase: 'http://127.0.0.1:0',
        },
      }), validators);
      await n.start();
      return n;
    });
    expect(err.message).toMatch(/webrtc-direct/);
  });

  it('refuses a DNS mesh.listen address', async () => {
    const dir = freshDir();
    const err = await expectMeshConfigError(async () => {
      const n = new NetNode(makeConfig({
        mesh: {
          role: 'public',
          network: 'devnet',
          listen: ['/dns4/example.com/udp/4001/webrtc-direct'],
          stateDir: dir,
          httpBase: 'http://127.0.0.1:0',
        },
      }), validators);
      await n.start();
      return n;
    });
    expect(err.message).toMatch(/DNS/);
  });

  it('refuses a DNS mesh.announce address', async () => {
    const dir = freshDir();
    const err = await expectMeshConfigError(async () => {
      const n = new NetNode(makeConfig({
        mesh: {
          role: 'public',
          network: 'devnet',
          listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
          announce: ['/dnsaddr/example.com/tcp/1'],
          stateDir: dir,
          httpBase: 'http://127.0.0.1:0',
        },
      }), validators);
      await n.start();
      return n;
    });
    expect(err.message).toMatch(/DNS/);
  });

  // MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by
  // IP" — a `stun.host` that is neither IPv4 nor IPv6 literal is
  // refused at start.
  it('refuses a mesh.stun.host that is not an IP literal', async () => {
    const dir = freshDir();
    const err = await expectMeshConfigError(async () => {
      const n = new NetNode(makeConfig({
        mesh: {
          role: 'public',
          network: 'devnet',
          listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
          stateDir: dir,
          httpBase: 'http://127.0.0.1:0',
          stun: { host: 'stun.example.com', port: 3478 },
        },
      }), validators);
      await n.start();
      return n;
    });
    expect(err.message).toMatch(/stun\.host/);
  });

  // MESH_INTERFACE → NAT — a `stun.port` outside the 0..65535 range
  // is refused at start.
  it('refuses a mesh.stun.port out of the 0..65535 range', async () => {
    const dir = freshDir();
    const err = await expectMeshConfigError(async () => {
      const n = new NetNode(makeConfig({
        mesh: {
          role: 'public',
          network: 'devnet',
          listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
          stateDir: dir,
          httpBase: 'http://127.0.0.1:0',
          stun: { host: '127.0.0.1', port: 70_000 },
        },
      }), validators);
      await n.start();
      return n;
    });
    expect(err.message).toMatch(/stun\.port/);
  });

  // MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists"
  // — "A state directory whose certificate cannot be read stops the node
  // at start ... and is left as it is, as a key file of another form is".
  // A refusal reads the directory but writes nothing; `start` throws
  // before any socket opens, so the directory is empty after.
  it('leaves the state directory as it was on a refusal', async () => {
    const dir = freshDir();
    await expectMeshConfigError(async () => {
      const n = new NetNode(makeConfig({
        mesh: {
          role: 'private',
          network: 'devnet',
          listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
          stateDir: dir,
          httpBase: 'http://127.0.0.1:0',
        },
      }), validators);
      await n.start();
      return n;
    });
    // A refusal before any datastore open leaves the directory empty.
    expect(readdirSync(dir)).toEqual([]);
  });
});
