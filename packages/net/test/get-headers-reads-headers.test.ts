import { describe, it, expect, afterEach } from 'vitest';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';
import {
  PROTOCOL_VERSION,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  computeUtxoTxRoot,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

// ---------------------------------------------------------------------------
// NET_INTERFACE → Sync Handler Registration:
// `GetHeaders` reads the header-at-height provider and nothing else. One
// height is one header read — a whole-block read there decodes up to 400
// bodies of up to `MAX_BLOCK_BODY_BYTES` for a seven-byte request. Unset,
// `GetHeaders` is answered zero bytes.
// ---------------------------------------------------------------------------

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    syncRequestTimeoutMs: 5_000,
    ...overrides,
  });
}

const TIMEOUT = 25_000;

async function waitConnected(nodeA: NetNode, nodeB: NetNode, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nodeB.getConnectedPeers().includes(nodeA.peerId())
        && nodeA.getConnectedPeers().includes(nodeB.peerId())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('peers did not connect in time');
}

function makeHeader(height: number): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: height,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
}

function makeBlock(height: number): OrderingBlock {
  const utxoTxTree = {
    utxoTxIds: [height.toString(16).padStart(64, '0')],
    utxoTxs: [new Uint8Array(96).fill(height & 0xff)],
  };
  return {
    header: { ...makeHeader(height), utxoTxRoot: computeUtxoTxRoot(utxoTxTree) },
    utxoTxTree,
    validatorSignature: new Uint8Array(64),
  };
}

describe('GetHeaders reads the header provider, not the block provider', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  it('requestHeaders answers from the header provider while the block provider stays uncalled', async () => {
    const expectedHeader = makeHeader(1);
    let blockCalls = 0;

    nodeA = new NetNode(makeConfig(), validators);
    // A block provider that counts calls — the assertion below checks it is
    // never called when GetHeaders runs. (It still answers so the harness's
    // startup paths that may read a block do not blow up.)
    nodeA.setHeadersHandler((h) => { blockCalls++; return h === 1 ? makeBlock(1) : null; });
    // The header provider — the one `GetHeaders` reads.
    nodeA.setHeaderProvider((h) => h === 1 ? expectedHeader : null);
    nodeA.setChainHeightProvider(() => 1);
    await nodeA.start();
    const addr = nodeA.libp2pNode!.getMultiaddrs()[0]!.toString();

    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr] }), validators);
    nodeB.setChainHeightProvider(() => 1);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    // Reset the block-call counter after the handshake and sync-machine
    // startup have had their reads — the assertion is about the GetHeaders
    // arm in particular.
    const blockCallsBefore = blockCalls;
    const headers = await nodeB.requestHeaders(1, 1, nodeA.peerId());
    const blockCallsForQuery = blockCalls - blockCallsBefore;

    // A control: the request answered rather than threw.
    expect(Array.isArray(headers)).toBe(true);
    // A control: the one header the provider has reached the caller.
    expect(headers.length).toBe(1);
    // The rule: the block provider is not what GetHeaders reads.
    expect(blockCallsForQuery).toBe(0);
  }, TIMEOUT);

  it('a node with a block provider and no header provider answers GetHeaders with zero bytes', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    nodeA.setHeadersHandler((h) => h === 1 ? makeBlock(1) : null);
    nodeA.setChainHeightProvider(() => 1);
    await nodeA.start();
    const addr = nodeA.libp2pNode!.getMultiaddrs()[0]!.toString();

    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr] }), validators);
    nodeB.setChainHeightProvider(() => 1);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    const headers = await nodeB.requestHeaders(1, 1, nodeA.peerId());
    // Zero bytes reaches the caller as an empty array (NET_INTERFACE →
    // Sync Handler Registration → "A node that has registered no provider
    // for a query answers it zero bytes").
    expect(headers).toEqual([]);
  }, TIMEOUT);
});
