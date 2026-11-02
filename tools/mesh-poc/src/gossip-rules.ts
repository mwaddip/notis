// AHEAD OF CODE — stub, filled by this unit.

export function blockTopic(_magic: number): string {
  return 'stub';
}

export function gossipMessageId(_topic: string, _data: Uint8Array): Uint8Array {
  return new Uint8Array([0xff]);
}

export const GOSSIP_SEEN_WINDOW_MS = 0;

export interface GossipsubOptionsShape {
  globalSignaturePolicy: string;
  msgIdFn: (m: { topic: string; data: Uint8Array }) => Uint8Array;
  seenTTL: number;
  ignoreDuplicatePublishError: boolean;
  allowedTopics: string[];
  allowPublishToZeroTopicPeers: boolean;
  asyncValidation: boolean;
  fallbackToFloodsub: boolean;
}

export function gossipsubOptions(_magic: number): GossipsubOptionsShape {
  return {
    globalSignaturePolicy: 'StrictSign',
    msgIdFn: () => new Uint8Array([0x00]),
    seenTTL: 1,
    ignoreDuplicatePublishError: false,
    allowedTopics: [],
    allowPublishToZeroTopicPeers: false,
    asyncValidation: false,
    fallbackToFloodsub: true,
  };
}
