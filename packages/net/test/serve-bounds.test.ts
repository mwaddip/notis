import { describe, it, expect } from 'vitest';
import { MAX_BLOCK_BODY_BYTES } from '@dagsocial/types';
import { MAX_SERVE_BODY_BYTES, MAX_STREAM_BYTES } from '../src/msg-guards.js';

// ---------------------------------------------------------------------------
// The ordering invariant (NET_INTERFACE → Validation (and untrusted-input
// safety)):
//
//     MAX_BLOCK_BODY_BYTES  <  MAX_SERVE_BODY_BYTES  <  MAX_STREAM_BYTES
//
// The relation is the rule, and it is the point of the whole unit: a single
// legal block always fits inside a response a requester will accept, and a
// multi-block response truncates instead of overflowing that requester's stream
// cap.
//
// The three constants live in two packages — the lowest is `@dagsocial/types`'
// consensus bound, the upper two are this package's — so each can be moved
// without the other's compiler ever seeing it. Invert either pair and a block
// becomes valid but unservable: consensus accepts it, it propagates by gossip,
// and no peer syncing from history can fetch it. That is a consensus-visible
// split produced entirely by two numbers moving independently, which is what
// reading all three in one place is for.
// ---------------------------------------------------------------------------

describe('serve bounds stand in a fixed order', () => {
  it('a single legal block fits inside one response', () => {
    expect(MAX_BLOCK_BODY_BYTES).toBeLessThan(MAX_SERVE_BODY_BYTES);
  });

  it('a full response fits inside the requester\'s stream cap', () => {
    expect(MAX_SERVE_BODY_BYTES).toBeLessThan(MAX_STREAM_BYTES);
  });
});
