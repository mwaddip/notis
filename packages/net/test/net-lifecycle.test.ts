import { describe, it, expect, afterEach } from 'vitest';
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
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import type { PeerStorage } from '../src/peerdb.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

// ---------------------------------------------------------------------------
// NET_INTERFACE → API → Node Lifecycle
//
// "A stopped node starts again whole": the next start() registers both
// protocols on the libp2p node it creates. "A start that throws stops what it
// started": the libp2p node and the sync machine come down before the error
// leaves it.
// ---------------------------------------------------------------------------

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

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    // Loopback keeps the suite confined to this host.
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    // A short request deadline keeps the restart path from parking a reader
    // on the default when the protocol has not been re-registered.
    syncRequestTimeoutMs: 2_000,
    ...overrides,
  });
}

// Generous bound for two TCP nodes shaking hands.
const TIMEOUT = 25_000;

describe('a stopped node starts again whole', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  it('A stops and starts; B reads headers from A instead of throwing', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    // The stop and the next start both have to complete without throwing.
    await nodeA.stop();
    await nodeA.start();

    const addrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    expect(addrs.length).toBeGreaterThan(0);

    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrs[0]!.toString()] }), validators);
    await nodeB.start();
    // Let the dial, encryption, muxing and whatever handshake path exists on
    // A complete. Three seconds covers the whole exchange on this host.
    await new Promise((r) => setTimeout(r, 3_000));

    // B dials A's sync protocol. A node that re-registered the protocol on
    // the new libp2p answers; one that did not fails multistream selection
    // and throws. `.catch(err => err)` captures either, so the last line is
    // the one the rule flips.
    const result = await nodeB.requestHeaders(['ff'.repeat(32)], nodeA.peerId()).catch((err: unknown) => err);
    expect(result instanceof Error).toBe(false);
  }, TIMEOUT);
});

describe('a start that throws leaves nothing listening', () => {
  it('a loadAll that throws leaves no libp2p node behind the error', async () => {
    // PeerDb's constructor reads `storage.loadAll()` inside start(), after the
    // libp2p node has been created. A throw here reproduces the state the rule
    // is written against: the node is created, nothing after it tears it down.
    const storage: PeerStorage = {
      loadAll: () => { throw new Error('loadAll bombs'); },
      put: () => {},
      delete: () => {},
    };
    const net = new NetNode(makeConfig(), validators, storage);

    await expect(net.start()).rejects.toThrow('loadAll bombs');

    // The field is private; a cast reaches it the way the handler harness in
    // sync-stream-handler.test.ts reaches `libp2p` and `peerMgr` — the shape
    // of the private surface is this package's own, and asserting on it is
    // what keeps start()'s cleanup visible to a test. Comparing to `null`
    // inside the expect() keeps the libp2p object out of vitest's pretty
    // printer, which otherwise reads a defined `$$typeof` getter off its
    // components bag and crashes before the assertion itself prints.
    const internals = net as unknown as { libp2p: unknown; syncMachine: unknown };
    expect(internals.syncMachine === null).toBe(true);
    expect(internals.libp2p === null).toBe(true);
  }, TIMEOUT);
});
