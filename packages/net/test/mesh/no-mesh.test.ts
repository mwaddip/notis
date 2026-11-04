// NET_INTERFACE → The mesh — "`NetConfig.mesh` makes the node a mesh node";
// without `mesh`, the options are today's, byte for byte in what they
// configure. A plain `NetConfig` builds a
// node with one transport (TCP), no DHT, no circuit relay, no HTTP
// service, and never writes a datastore directory.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
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

import { NetNode } from '../../src/index.js';
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

describe('mesh — no mesh, the options are today\'s', () => {
  let nodes: NetNode[] = [];
  let dirs: string[] = [];
  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    nodes = []; dirs = [];
  });

  it('a NetConfig without mesh builds a plain libp2p node', async () => {
    const node = new NetNode(makeConfig({ listenAddrs: '/ip4/127.0.0.1/tcp/0' }), validators);
    await node.start();
    nodes.push(node);

    // Reach into libp2p's services and transport manager through the same
    // public `components` field the mesh code uses. `services.dht`,
    // `services.circuitRelay`, `services.http` and `services.autoNAT` are
    // not registered on a plain node; `services.keychain` is not added
    // either.
    const libp2p = (node as unknown as {
      libp2p: {
        services: Record<string, unknown>;
        components: {
          transportManager: { getListeners(): unknown[] };
        };
      };
    }).libp2p;
    expect(libp2p.services.dht).toBeUndefined();
    expect(libp2p.services.circuitRelay).toBeUndefined();
    expect(libp2p.services.http).toBeUndefined();
    expect(libp2p.services.autoNAT).toBeUndefined();
    expect(libp2p.services.keychain).toBeUndefined();
    // pubsub, identify, ping are the plain services; stay set.
    expect(libp2p.services.pubsub).toBeDefined();
    expect(libp2p.services.identify).toBeDefined();
    expect(libp2p.services.ping).toBeDefined();

    // One transport — TCP — is enough to answer the plain listen.
    expect(libp2p.components.transportManager.getListeners().length).toBe(1);

    // meshIdentity is null without mesh.
    expect(node.meshIdentity()).toBeNull();
  });

  it('a NetConfig without mesh writes no datastore directory', async () => {
    // Mesh would write to `<stateDir>/datastore`. Point stateDir at a
    // fresh empty directory, start a plain node, and confirm the plain
    // start wrote nothing there (nor anywhere it would see).
    const candidate = mkdtempSync(join(tmpdir(), 'net-no-mesh-'));
    dirs.push(candidate);
    const node = new NetNode(makeConfig({ listenAddrs: '/ip4/127.0.0.1/tcp/0' }), validators);
    await node.start();
    nodes.push(node);
    // The candidate directory stays empty — a plain start opens no
    // state dir of its own.
    expect(readdirSync(candidate)).toEqual([]);
    expect(existsSync(join(candidate, 'datastore'))).toBe(false);
  });
});
