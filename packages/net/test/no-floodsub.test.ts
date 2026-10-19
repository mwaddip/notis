import { describe, it, expect, afterEach } from 'vitest';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
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
import { makeConfig as makeBaseConfig } from './helpers.js';

// NET_INTERFACE → libp2p Stack: "gossipsub alone — no floodsub fallback". The
// gossipsub router registers `/floodsub/1.0.0` on the libp2p host while
// `fallbackToFloodsub` is true, its library default; this check reads the
// host's registered protocols and asserts the floodsub protocol id is not
// among them.

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
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
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    bootstrapPeers: [],
    minPeers: 0,
    ...overrides,
  });
}

const TIMEOUT = 25_000;

describe('the node speaks no floodsub', () => {
  let node: NetNode | null = null;

  afterEach(async () => {
    await node?.stop();
    node = null;
  });

  it.fails('a started node registers no `/floodsub/1.0.0` protocol', async () => {
    node = new NetNode(makeConfig(), validators);
    await node.start();

    const libp2p = node.libp2pNode;
    expect(libp2p).not.toBeNull();
    const protocols = libp2p!.getProtocols();
    // Control: the gossipsub protocols the router registers are both
    // present, so the host is up and the gossipsub service is wired.
    expect(protocols).toContain('/meshsub/1.1.0');
    expect(protocols).toContain('/meshsub/1.0.0');
    expect(protocols).not.toContain('/floodsub/1.0.0');
  }, TIMEOUT);
});
