// WEB_INTERFACE → Reading a node's answer
// CONSTANTS → Client reads

import { describe, it, expect } from 'vitest';
import { fetchJson, readCappedJson } from '../src/http.js';
import { POST_BATCH_READ_BYTES } from '../src/caps.js';

// JSON of a given byte length: `{"x":"<padding>"}` with the right amount of
// padding. The padding uses only ASCII `a`, one UTF-8 byte each.
function jsonOfLength(bytes: number): string {
  const prefix = '{"x":"';
  const suffix = '"}';
  const pad = bytes - prefix.length - suffix.length;
  if (pad < 0) throw new Error(`length too small: ${bytes}`);
  return prefix + 'a'.repeat(pad) + suffix;
}

// A streaming `Response` the test can observe: a counter of bytes delivered by
// `pull` and a flag that `cancel` sets. Each chunk is `chunkSize` bytes of ASCII
// `a` until `totalBytes` are delivered.
function streamingResponse(
  status: number,
  totalBytes: number,
  chunkSize: number,
): { res: Response; counts: { pulled: number; cancelled: boolean } } {
  const counts = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counts.pulled >= totalBytes) {
        controller.close();
        return;
      }
      const bytes = Math.min(chunkSize, totalBytes - counts.pulled);
      const chunk = new Uint8Array(bytes).fill(97);
      counts.pulled += bytes;
      controller.enqueue(chunk);
    },
    cancel() {
      counts.cancelled = true;
    },
  });
  return { res: new Response(stream, { status }), counts };
}

// WEB_INTERFACE → Reading a node's answer — the body a reader hands back is
// sized at the source, cancelled once more than the cap has arrived; a body a
// byte over the cap answers as a body that will not parse does.
describe('fetchJson under a byte cap', () => {
  it('reads a body exactly at its cap and refuses one a byte longer', async () => {
    const CAP = 1_024;
    // At the cap — valid JSON exactly CAP bytes.
    const atBody = jsonOfLength(CAP);
    const atFake = async () => new Response(atBody, { status: 200 });
    const atRes = await fetchJson<{ x: string }>(atFake, 'http://node', CAP);
    // control — the at-cap body parses
    expect(atRes.ok).toBe(true);
    // One byte over — the body is refused.
    const overBody = jsonOfLength(CAP + 1);
    const overFake = async () => new Response(overBody, { status: 200 });
    const overRes = await fetchJson(overFake, 'http://node', CAP);
    // last — the shape of a refused read: ok false, the status kept, the body
    // naming the cap.
    expect(overRes).toEqual({ ok: false, status: 200, body: `body over ${CAP} bytes` });
  });

  it('stops pulling the stream once more than the cap has arrived', async () => {
    const CAP = 1_024;
    const chunkSize = 128;
    // A stream that would deliver many times the cap.
    const { res, counts } = streamingResponse(200, CAP * 100, chunkSize);
    const fake = async () => res;
    const result = await fetchJson(fake, 'http://node', CAP);
    // control — the body is refused
    expect(result.ok).toBe(false);
    // last — pulled no further than the cap and about one chunk; the
    // stream's own queueing strategy (default `highWaterMark: 1`) may
    // prefetch a chunk ahead of the reader's cancel, so a tolerance of two
    // chunks holds — the pull stays bounded, not open.
    expect(counts.pulled).toBeLessThanOrEqual(CAP + 2 * chunkSize);
  });

  it('cancels the stream once more than the cap has arrived', async () => {
    const CAP = 1_024;
    const { res, counts } = streamingResponse(200, CAP * 100, 128);
    const fake = async () => res;
    const result = await fetchJson(fake, 'http://node', CAP);
    // control — the body is refused
    expect(result.ok).toBe(false);
    // last — the stream was cancelled
    expect(counts.cancelled).toBe(true);
  });

  it('a non-2xx body over its cap keeps the status', async () => {
    const CAP = 100;
    const body = 'x'.repeat(CAP + 1);
    const fake = async () => new Response(body, { status: 503 });
    const result = await fetchJson(fake, 'http://node', CAP);
    // control — the body is refused
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // control — the status is kept
      expect(result.status).toBe(503);
      // last — the body names the cap
      expect(result.body).toBe(`body over ${CAP} bytes`);
    }
  });
});

describe('readCappedJson at POST_BATCH_READ_BYTES', () => {
  it('refuses a batch body one byte over the cap', async () => {
    const CAP = POST_BATCH_READ_BYTES;
    const over = jsonOfLength(CAP + 1);
    const res = new Response(over, { status: 200 });
    const result = await readCappedJson(res, CAP);
    // last — refused, body names the cap
    expect(result).toEqual({ ok: false, status: 200, body: `body over ${CAP} bytes` });
  });

  // The longest honest batch answer: 100 worst-case post rows with their
  // transaction bytes, each a PostJson of the fields a batch answer carries
  // (no `confirmedAuthor`, which the batch read leaves out —
  // CONSTANTS → Client reads).
  it('reads the longest honest batch answer under the cap', async () => {
    const body = longestHonestBatchAnswer();
    const bytes = new TextEncoder().encode(body).byteLength;
    // control — the honest body is at most the cap
    expect(bytes).toBeLessThanOrEqual(POST_BATCH_READ_BYTES);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, POST_BATCH_READ_BYTES);
    // last — the body parses
    expect(result.ok).toBe(true);
  });
});

function longestHonestBatchAnswer(): string {
  // 100 worst-case PostJson rows with tx bytes, no `confirmedAuthor`.
  const posts: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 100; i++) {
    const post: Record<string, unknown> = {
      id: 'a'.repeat(64),
      txId: 'b'.repeat(64),
      content: '"'.repeat(300),
      contentHash: 'c'.repeat(64),
      author: 'd'.repeat(64),
      parentRefs: ['e'.repeat(64)],
      protocolVersion: Number.MAX_SAFE_INTEGER,
      type: 'profile',
      status: 'confirmed',
      blockHeight: Number.MAX_SAFE_INTEGER,
      blockIndex: Number.MAX_SAFE_INTEGER,
      blockCreatedAt: Number.MAX_SAFE_INTEGER,
      likeCount: Number.MAX_SAFE_INTEGER,
      descendantCount: Number.MAX_SAFE_INTEGER,
      authorName: 'A'.repeat(24),
      likedByViewer: true,
      tx: 'ab'.repeat(10_000),
    };
    posts.push(post);
  }
  return JSON.stringify({ posts });
}
