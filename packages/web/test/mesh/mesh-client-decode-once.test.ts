// MESH_INTERFACE → Block gossip → "A block is checked before it is
// forwarded, and never applied" / NET_INTERFACE → Inbound Processing
// → "A gossiped message is decoded once": the validator keeps the
// value it decoded against the message object, the listener reads
// that value, and a delivery with no value against it is this node's
// bug — logged, delivered to no handler, no peer penalised.
//
// A partial `vi.mock` of `@dagsocial/types` wraps `decodeOrderingBlock`
// so a case can count its calls on the delivery path; the mock is
// scoped to this file so no other case sees it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopicValidatorResult } from '@libp2p/gossipsub';
import type { PeerId } from '@libp2p/interface';
import {
  decodeOrderingBlock,
  encodeOrderingBlock,
  generateKeyPair,
  profileFor,
} from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import {
  encodeNipopowProof,
  proveWithReader,
} from '@dagsocial/nipopow';
import type { NipopowProof } from '@dagsocial/nipopow';
import { DEFAULT_M, DEFAULT_K } from '@dagsocial/nipopow-client';
import type { NodeTipResult, TipResult, resolveTip } from '@dagsocial/nipopow-client';
import { blockHash } from '@dagsocial/validation';
import { gossipTopics, nodeKeyFromKeyPair, peerIdFromNotisId } from '@dagsocial/net/browser';
import type { HttpFetch } from '@dagsocial/node-reads';

import {
  buildMinedChain,
  makeReader,
} from '../../../nipopow/test/helpers.js';
import { makeBlockAt } from '../../../net/test/helpers/devnet-block.js';
import { startMeshClient } from '../../src/mesh/mesh-client.js';
import type { MeshClient } from '../../src/mesh/mesh-client.js';

vi.mock('@dagsocial/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dagsocial/types')>();
  return {
    ...actual,
    decodeOrderingBlock: vi.fn(actual.decodeOrderingBlock),
  };
});

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const M = DEFAULT_M;
const K = DEFAULT_K;
const MK = M + K;
const NOW = 100_000_000;

type ResolveFn = typeof resolveTip;

function proofOf(count: number): NipopowProof {
  return proveWithReader(makeReader(buildMinedChain({ count })), { m: M, k: K });
}

function tipOf(count: number): { height: number; hash: string } {
  const chain = buildMinedChain({ count });
  const tip = chain.headers[chain.headers.length - 1]!;
  const hash = blockHash(tip);
  if (hash === null) throw new Error('unhashable tip');
  return { height: tip.height, hash };
}

function makeHttpFetch(tips: Map<string, { height: number; hash: string }>): HttpFetch {
  return async (url: string) => {
    for (const [base, tip] of tips) {
      if (url === `${base}/blocks/current`) {
        return new Response(JSON.stringify(tip), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith(`${base}/blocks/`)) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('nowhere', { status: 404 });
  };
}

function makeResolve(proofs: Map<string, NipopowProof>): ResolveFn {
  return async (nodeUrls) => {
    const nodes: NodeTipResult[] = [];
    for (const url of nodeUrls) {
      const proof = proofs.get(url);
      nodes.push({
        url,
        verified: proof !== undefined,
        proof: proof ?? null,
        verifyResult: null,
        refuseReason: proof !== undefined ? null : 'unreachable',
        refuseCode: proof !== undefined ? null : 'unreachable',
        behind: null,
        genesisHash: null,
      });
    }
    const out: TipResult = {
      winner: null,
      winnerIndex: -1,
      nodes,
      tip: null,
      suffixHead: null,
      splits: [],
    };
    return out;
  };
}

function keyPair(): { notisId: string } {
  return { notisId: nodeKeyFromKeyPair(generateKeyPair()).notisId };
}

interface PubsubStub {
  topicValidators: Map<
    string,
    (peer: PeerId, msg: { topic: string; data: Uint8Array }) => Promise<number> | number
  >;
  reportMessageValidationResult: (a: string, b: string, c: number) => void;
  dispatchEvent: (ev: Event) => void;
}

describe('mesh-client — a gossiped message is decoded once', () => {
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    vi.mocked(decodeOrderingBlock).mockClear();
  });

  it.fails('an accepted block moves the client\'s chain decoded once', async () => {
    // Memory seats the chain at MK. A mined, signed block extending
    // the seated tip is handed to the client's own registered topic
    // validator and then to the `gossipsub:message` event with the
    // same message object. The chain extends to MK + 1, and
    // `decodeOrderingBlock` is not called on the delivery path:
    // NET_INTERFACE → Inbound Processing →
    // "A gossiped message is decoded once".
    const keptProof = proofOf(MK);
    const tipHeader = buildMinedChain({ count: MK }).headers[MK - 1]!;
    const parentHash = blockHash(tipHeader);
    if (parentHash === null) throw new Error('unhashable parent');
    const extraBlock = makeBlockAt(MK + 1, 1, {
      prevBlockHash: parentHash,
      powTargetBits: 3072,
      createdAt: tipHeader.createdAt + 60_000,
    });

    const yId = keyPair().notisId;
    const tips = new Map<string, { height: number; hash: string }>();
    const yBase = 'http://127.0.0.1:1';
    tips.set(yBase, tipOf(MK));
    const proofs = new Map<string, NipopowProof>([[yBase, keptProof]]);
    const client = await startMeshClient({
      firstContact: [{ notisId: yId, addrs: [], api: yBase }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answered: [] },
      wallClock: () => NOW,
      httpFetch: makeHttpFetch(tips),
      resolve: makeResolve(proofs),
    });
    clients.push(client);

    // The first check seats `state.tip` from the chain so the baseline
    // comparison reads the seated height.
    await client.check();
    expect(client.state().tip?.height).toBe(MK);
    vi.mocked(decodeOrderingBlock).mockClear();

    const pubsub = (client.libp2p as unknown as { services: { pubsub: PubsubStub } }).services.pubsub;
    pubsub.reportMessageValidationResult = () => { /* stub */ };
    const topic = gossipTopics(PROFILE.magic).orderingBlock;
    const msg = { topic, data: encodeOrderingBlock(extraBlock) };
    const validator = pubsub.topicValidators.get(topic)!;
    const relayPeer = peerIdFromNotisId(keyPair().notisId);
    const verdict = await validator(relayPeer, msg);
    expect(verdict).toBe(TopicValidatorResult.Accept);
    pubsub.dispatchEvent(new CustomEvent('gossipsub:message', {
      detail: {
        msg,
        msgId: 'decode-once-msg-id',
        propagationSource: { toString: () => 'fake-peer' },
      },
    }));

    // Control: the chain extended to MK + 1.
    expect(client.state().tip?.height).toBe(MK + 1);
    // The rule: no second decode on delivery.
    expect(vi.mocked(decodeOrderingBlock).mock.calls.length).toBe(0);
  }, 30_000);

  it.fails('an accepted message with no value kept moves nothing and is logged', async () => {
    // A `gossipsub:message` is fired with a message object the client's
    // validator never saw, carrying a block that would pass
    // `BlockCheck`. The listener reads no value against the object,
    // logs the fault, and the chain does not move
    // (NET_INTERFACE → Inbound Processing →
    // "A gossiped message is decoded once").
    const keptProof = proofOf(MK);
    const tipHeader = buildMinedChain({ count: MK }).headers[MK - 1]!;
    const parentHash = blockHash(tipHeader);
    if (parentHash === null) throw new Error('unhashable parent');
    const extraBlock = makeBlockAt(MK + 1, 1, {
      prevBlockHash: parentHash,
      powTargetBits: 3072,
      createdAt: tipHeader.createdAt + 60_000,
    });

    const yId = keyPair().notisId;
    const tips = new Map<string, { height: number; hash: string }>();
    const yBase = 'http://127.0.0.1:1';
    tips.set(yBase, tipOf(MK));
    const proofs = new Map<string, NipopowProof>([[yBase, keptProof]]);
    const logs: string[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: yId, addrs: [], api: yBase }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answered: [] },
      wallClock: () => NOW,
      httpFetch: makeHttpFetch(tips),
      resolve: makeResolve(proofs),
      log: (line) => logs.push(line),
    });
    clients.push(client);

    await client.check();
    expect(client.state().tip?.height).toBe(MK);
    const entriesBefore = client.state().nodes.map((e) => ({ id: e.notisId, status: e.status }));

    const pubsub = (client.libp2p as unknown as { services: { pubsub: PubsubStub } }).services.pubsub;
    pubsub.reportMessageValidationResult = () => { /* stub */ };
    const topic = gossipTopics(PROFILE.magic).orderingBlock;
    const msg = { topic, data: encodeOrderingBlock(extraBlock) };
    // Hand the message object straight to the delivery event — the
    // validator never saw this object.
    pubsub.dispatchEvent(new CustomEvent('gossipsub:message', {
      detail: {
        msg,
        msgId: 'no-value-msg-id',
        propagationSource: { toString: () => 'fake-peer' },
      },
    }));

    // The chain is held where it stood.
    expect(client.state().tip?.height).toBe(MK);
    const entriesAfter = client.state().nodes.map((e) => ({ id: e.notisId, status: e.status }));
    expect(entriesAfter).toEqual(entriesBefore);
    // The fault reached the log sink.
    expect(logs.some((line) => line.includes('[mesh-client]'))).toBe(true);
  }, 30_000);
});
