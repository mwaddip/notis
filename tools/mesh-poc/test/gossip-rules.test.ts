import { describe, it, expect } from 'vitest';
import {
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
} from '@dagsocial/types';
import {
  gossipTopics,
  gossipMessageId as netGossipMessageId,
  GOSSIP_SEEN_WINDOW_MS as NET_GOSSIP_SEEN_WINDOW_MS,
} from '@dagsocial/net';
import {
  blockTopic,
  gossipMessageId,
  gossipsubOptions,
  GOSSIP_SEEN_WINDOW_MS,
} from '../src/gossip-rules.js';

// MESH_INTERFACE → Block gossip → "One router, net's rules" — the browser-safe
// code the client runs holds its own copy of the topic name and the message
// id, equal to net's; a change to either here fails the cases.

describe('gossip-rules — equal to net', () => {
  it.fails('blockTopic equals gossipTopics(magic).orderingBlock for every magic', () => {
    expect(blockTopic(MAGIC_MAINNET)).toBe(gossipTopics(MAGIC_MAINNET).orderingBlock);
    expect(blockTopic(MAGIC_TESTNET)).toBe(gossipTopics(MAGIC_TESTNET).orderingBlock);
    expect(blockTopic(MAGIC_DEVNET)).toBe(gossipTopics(MAGIC_DEVNET).orderingBlock);
  });

  it.fails('gossipMessageId equals net\'s over 20 random payloads and both of net\'s topic strings', () => {
    // NET_INTERFACE → Gossip Topics → "A message is named by its bytes" —
    // `hash32(lpUtf8(topic) ‖ data)`. The topic is in the preimage, so a
    // change to either moves the id. Both of net's topic strings are
    // included so a drift that leaves the ordering-block topic alone and
    // moves the tx one still fails here.
    const topics: ReadonlyArray<string> = [
      gossipTopics(MAGIC_DEVNET).orderingBlock,
      gossipTopics(MAGIC_DEVNET).tx,
    ];
    const rng = ((seed: number) => {
      let s = seed >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x1_0000_0000;
      };
    })(0x5eed5eed);
    for (let i = 0; i < 20; i++) {
      const len = Math.floor(rng() * 300) + 1;
      const data = new Uint8Array(len);
      for (let j = 0; j < len; j++) data[j] = Math.floor(rng() * 256);
      for (const t of topics) {
        expect(gossipMessageId(t, data)).toEqual(netGossipMessageId(t, data));
      }
    }
  });

  it.fails('GOSSIP_SEEN_WINDOW_MS equals net\'s', () => {
    expect(GOSSIP_SEEN_WINDOW_MS).toBe(NET_GOSSIP_SEEN_WINDOW_MS);
  });
});

describe('gossipsubOptions carries net\'s rules', () => {
  // Each option set here mirrors the one net sets on its router that bears
  // on a message (NET_INTERFACE → Gossip Topics / Forwarding Rule). A later
  // change to any of them fails the one case naming it.
  it.fails('allowedTopics is [blockTopic(magic)]', () => {
    expect(gossipsubOptions(MAGIC_DEVNET).allowedTopics).toEqual([
      gossipTopics(MAGIC_DEVNET).orderingBlock,
    ]);
  });

  it.fails('globalSignaturePolicy is StrictNoSign', () => {
    expect(gossipsubOptions(MAGIC_DEVNET).globalSignaturePolicy).toBe('StrictNoSign');
  });

  it.fails('seenTTL is GOSSIP_SEEN_WINDOW_MS', () => {
    expect(gossipsubOptions(MAGIC_DEVNET).seenTTL).toBe(GOSSIP_SEEN_WINDOW_MS);
  });

  it.fails('ignoreDuplicatePublishError is true', () => {
    expect(gossipsubOptions(MAGIC_DEVNET).ignoreDuplicatePublishError).toBe(true);
  });

  it.fails('allowPublishToZeroTopicPeers is true', () => {
    expect(gossipsubOptions(MAGIC_DEVNET).allowPublishToZeroTopicPeers).toBe(true);
  });

  it.fails('asyncValidation is true', () => {
    expect(gossipsubOptions(MAGIC_DEVNET).asyncValidation).toBe(true);
  });

  it.fails('fallbackToFloodsub is false', () => {
    expect(gossipsubOptions(MAGIC_DEVNET).fallbackToFloodsub).toBe(false);
  });

  it.fails('msgIdFn is gossipMessageId(topic, data)', () => {
    const opts = gossipsubOptions(MAGIC_DEVNET);
    const topic = gossipTopics(MAGIC_DEVNET).orderingBlock;
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const actual = opts.msgIdFn({ topic, data });
    expect(actual).toEqual(gossipMessageId(topic, data));
  });
});
