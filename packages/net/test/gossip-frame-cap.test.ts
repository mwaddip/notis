// NET_INTERFACE → Validation → "A gossip frame is bounded by gossipsub's own
// cap, which holds two blocks at the bound".
//
// gossipsub reads a peer's frames through `it-length-prefixed`'s `decode`
// under `maxDataLength: this.opts.maxInboundDataLength`, which `gossipsubOptions`
// leaves unset — so the router reads at `it-length-prefixed`'s default
// (`MAX_DATA_LENGTH = 4 MiB`, `CONSTANTS → net`). An `IWANT` is answered in one
// frame that carries every message asked for, so two ordering blocks at
// `MAX_ORDERING_BLOCK_BYTES` with the RPC's framing around them must fit
// through both ends of that framing.
import { describe, it, expect } from 'vitest';
import { MAX_ORDERING_BLOCK_BYTES, MAGIC_TESTNET } from '@dagsocial/types';
import { RPC } from '@libp2p/gossipsub/message';
import { encode, decode } from 'it-length-prefixed';
import { gossipTopics } from '../src/gossip-rules.js';
import { gossipsubOptions } from '../src/gossip-rules.js';

describe('gossip frame cap', () => {
  it('gossipsubOptions carries no maxInboundDataLength', () => {
    const options = gossipsubOptions(MAGIC_TESTNET, [
      gossipTopics(MAGIC_TESTNET).orderingBlock,
      gossipTopics(MAGIC_TESTNET).tx,
    ]);
    expect(Object.prototype.hasOwnProperty.call(options, 'maxInboundDataLength')).toBe(false);
    expect((options as unknown as Record<string, unknown>)['maxInboundDataLength']).toBeUndefined();
  });

  it('two blocks at MAX_ORDERING_BLOCK_BYTES ride one gossipsub frame', () => {
    const topic = gossipTopics(MAGIC_TESTNET).orderingBlock;
    const rpcBytes = RPC.encode({
      subscriptions: [],
      messages: [
        { topic, data: new Uint8Array(MAX_ORDERING_BLOCK_BYTES) },
        { topic, data: new Uint8Array(MAX_ORDERING_BLOCK_BYTES) },
      ],
    });

    const options = gossipsubOptions(MAGIC_TESTNET, [topic]);
    const inboundCap = (options as unknown as { maxInboundDataLength?: number }).maxInboundDataLength;

    // The send side (`OutboundStream.push`) frames one RPC under
    // `encode.single`; the read side (`InboundStream`) reads it back under
    // `decode` with `{ maxDataLength: this.opts.maxInboundDataLength }` —
    // `inboundCap` is `undefined` here, so `decode` falls back to
    // `MAX_DATA_LENGTH`.
    const framed = encode.single(rpcBytes);
    const framedBytes = framed.subarray();
    const yielded: Uint8Array[] = [];
    for (const chunk of decode([framedBytes], { maxDataLength: inboundCap })) {
      yielded.push(chunk.subarray());
    }

    expect(yielded).toHaveLength(1);
    expect(yielded[0]!.length).toBe(rpcBytes.length);
    const decoded = RPC.decode(yielded[0]!);
    expect(decoded.messages).toHaveLength(2);
    expect(decoded.messages[0]!.topic).toBe(topic);
    expect(decoded.messages[0]!.data!.length).toBe(MAX_ORDERING_BLOCK_BYTES);
    expect(decoded.messages[1]!.data!.length).toBe(MAX_ORDERING_BLOCK_BYTES);
  });
});
