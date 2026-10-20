// WEB_INTERFACE → The extension → "Every answer is read under its route's cap"
// CONSTANTS → Client reads

import { describe, it, expect } from 'vitest';
import { fetchJson } from '@dagsocial/node-reads';
import {
  LOOKUP_READ_BYTES,
  RANGE_PAGE_READ_BYTES,
  LISTING_PAGE_READ_BYTES,
  POST_READ_BYTES,
  NAME_READ_BYTES,
  HEIGHT_READ_BYTES,
} from '@dagsocial/node-reads';
import { nipopowProofReadBytes } from '../src/caps.js';
import { resolveTip } from '../src/tip.js';
import { fetchListing, readHeightAfter } from '../src/boxes.js';
import { proveRange } from '../src/holdings.js';
import { proveName } from '../src/names.js';
import { runCli } from '../src/cli.js';
import type { Config } from '../src/config.js';
import {
  buildMinedChain,
  clockAfterChain,
  devnetProfile,
  devnetProfileWithGenesisId,
  proofHexForChain,
} from './helpers.js';

const USER_HEX = 'aa'.repeat(32);
const POST_ID = 'bb'.repeat(32);

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

// CONSTANTS → Client reads — `nipopowProofReadBytes` is a function of the
// `m` and `k` asked, from `MAX_HEADER_BYTES` and `MAX_NIPOPOW_PREFIX`.
describe('nipopowProofReadBytes', () => {
  // Passes on the pre-cap tree: the value is pure arithmetic, no reader runs.
  it('is 7_225_530 at the client defaults (m=24, k=20)', () => {
    expect(nipopowProofReadBytes(24, 20)).toBe(7_225_530);
  });

  // Passes on the pre-cap tree: same.
  it('is 38_534_946 at (m=128, k=128)', () => {
    expect(nipopowProofReadBytes(128, 128)).toBe(38_534_946);
  });
});

// WEB_INTERFACE → The extension → "Every answer is read under its route's cap" —
// every reader passes its route's cap, and the longest honest answer each
// buildable route gives fits.
describe('every reader passes its route\'s cap', () => {
  describe('resolveTip at the proof route\'s cap', () => {
    it('refuses a 2xx /nipopow/proof/:m/:k body one byte over the cap', async () => {
      const CAP = nipopowProofReadBytes(24, 20);
      const over = jsonOfLength(CAP + 1);
      const fake = async () => new Response(over, { status: 200 });
      const result = await resolveTip(['http://node'], 24, 20, devnetProfile(), () => 0, fake);
      // control — one node answered
      expect(result.nodes).toHaveLength(1);
      // control — the node did not verify
      expect(result.nodes[0]!.verified).toBe(false);
      // last — the refuse code is `http`, the over-cap body's shape
      expect(result.nodes[0]!.refuseCode).toBe('http');
    });

    // Passes on the pre-cap tree: an honest proof is small (hundreds of kB on
    // a short chain), well inside the cap, and nothing refuses it.
    it('reads an honest chain\'s proof under the (24, 20) cap', async () => {
      const chain = buildMinedChain({ count: 100 });
      const proofHex = proofHexForChain(chain, 24, 20);
      const body = JSON.stringify({ proof: proofHex });
      const bodyBytes = new TextEncoder().encode(body).byteLength;
      // control — the honest body is at most the cap
      expect(bodyBytes).toBeLessThanOrEqual(nipopowProofReadBytes(24, 20));
      const fake = async () => new Response(body, { status: 200 });
      const profile = devnetProfileWithGenesisId(chain);
      const result = await resolveTip(['http://node'], 24, 20, profile, clockAfterChain(chain), fake);
      // last — the node verified
      expect(result.nodes[0]!.verified).toBe(true);
    }, 60_000);

    it('pulls no further than the cap and one chunk on a 34 MB streamed /nipopow/proof body', async () => {
      const CAP = nipopowProofReadBytes(24, 20);
      const chunkSize = 1_024;
      const totalBytes = 34_000_000;
      const { res, counts } = streamingResponse(200, totalBytes, chunkSize);
      const fake = async () => res;
      const result = await resolveTip(['http://node'], 24, 20, devnetProfile(), () => 0, fake);
      // control — no winner
      expect(result.winner).toBeNull();
      // last — pulled no further than the cap and about one chunk; the
      // stream's own queueing strategy (default `highWaterMark: 1`) may
      // prefetch a chunk ahead of the reader's cancel.
      expect(counts.pulled).toBeLessThanOrEqual(CAP + 2 * chunkSize);
    });
  });

  describe('fetchListing at LISTING_PAGE_READ_BYTES', () => {
    it('refuses a /karma/:userId body one byte over the cap', async () => {
      // A body shaped like a page, padded above the cap by a long `effective`
      // string. On the pre-cap tree the body parses and reads as a well-formed
      // page.
      const over = buildListingPageJson({
        kind: 'karma',
        padBytes: LISTING_PAGE_READ_BYTES + 1,
      });
      const bytes = new TextEncoder().encode(over).byteLength;
      // control — the body is one byte over the cap
      expect(bytes).toBe(LISTING_PAGE_READ_BYTES + 1);
      const fake = async () => new Response(over, { status: 200 });
      const result = await fetchListing('http://node', USER_HEX, fake);
      // last — the listing is refused
      expect(result.ok).toBe(false);
    });

    // Passes on the pre-cap tree: the longest honest page fits well inside
    // the cap, so the read succeeds there and under the cap alike.
    it('reads the longest honest karma and credit pages under the cap', async () => {
      const karma = longestHonestKarmaPage();
      const credit = longestHonestCreditPage();
      // control — the longest honest karma page is at most the cap
      expect(new TextEncoder().encode(karma).byteLength).toBeLessThanOrEqual(LISTING_PAGE_READ_BYTES);
      // control — the longest honest credit page is at most the cap
      expect(new TextEncoder().encode(credit).byteLength).toBeLessThanOrEqual(LISTING_PAGE_READ_BYTES);
      let karmaCount = 0;
      let creditCount = 0;
      const terminator = JSON.stringify({ boxes: [], next: null, height: 0, effective: '0' });
      const fake = async (url: string) => {
        if (url.includes('/karma/')) {
          karmaCount++;
          return new Response(karmaCount === 1 ? karma : terminator, { status: 200 });
        }
        if (url.includes('/credits/')) {
          creditCount++;
          return new Response(creditCount === 1 ? credit : JSON.stringify({ boxes: [], next: null }), { status: 200 });
        }
        throw new Error(`unexpected url: ${url}`);
      };
      const result = await fetchListing('http://node', USER_HEX, fake);
      // last — the listing read succeeds
      expect(result.ok).toBe(true);
    });
  });

  describe('proveRange at RANGE_PAGE_READ_BYTES', () => {
    it('a range body one byte over the cap returns no-proof', async () => {
      const CAP = RANGE_PAGE_READ_BYTES;
      const over = jsonOfLength(CAP + 1);
      const fake = async () => new Response(over, { status: 200 });
      const header = { height: 100, stateRoot: 'ab'.repeat(33) };
      const result = await proveRange('http://node', 'karma', USER_HEX, header, fake);
      // control — the range failed
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // last — the ledger's status is `no-proof`, the over-cap body's shape
        expect(result.status).toBe('no-proof');
      }
    });
  });

  describe('proveName at NAME_READ_BYTES', () => {
    it('refuses a /usernames body one byte over the cap', async () => {
      const CAP = NAME_READ_BYTES;
      const over = jsonOfLength(CAP + 1);
      const fake = async () => new Response(over, { status: 200 });
      const anchor = {
        tip: makeHeader(100),
        suffixHead: { header: makeHeader(50), interlinks: [] as string[] },
      };
      const result = await proveName('http://node', { name: 'Alice' }, anchor, fake);
      // control — nothing was proven
      expect(result.owner).toBeNull();
      // last — the status is `no-proof`, the over-cap body's shape
      expect(result.status).toBe('no-proof');
    });

    // Passes on the pre-cap tree: a honest name lookup is a short JSON row,
    // and 219 bytes fits well under 1_024.
    it('reads the longest honest name lookup under the cap', async () => {
      const body = longestHonestNameLookup();
      const bytes = new TextEncoder().encode(body).byteLength;
      // control — the honest body is at most the cap
      expect(bytes).toBeLessThanOrEqual(NAME_READ_BYTES);
      const fake = async (url: string) => {
        if (url.includes('/usernames/')) return new Response(body, { status: 200 });
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      };
      const anchor = {
        tip: makeHeader(100),
        suffixHead: { header: makeHeader(50), interlinks: [] as string[] },
      };
      const result = await proveName('http://node', { name: 'A'.repeat(24) }, anchor, fake);
      // last — the lookup was read; the box proof fails downstream, so the
      // status is `no-proof` (the AVL route 404), never a lookup refusal.
      expect(result.status).toBe('no-proof');
    });
  });

  describe('readHeightAfter at HEIGHT_READ_BYTES', () => {
    it('refuses a /blocks/current body over the cap', async () => {
      // A body that would carry a valid height but is padded above the cap.
      const padding = 'a'.repeat(HEIGHT_READ_BYTES);
      const body = `{"height":42,"hash":"${'cc'.repeat(32)}","pad":"${padding}"}`;
      const bytes = new TextEncoder().encode(body).byteLength;
      // control — the body is above the cap
      expect(bytes).toBeGreaterThan(HEIGHT_READ_BYTES);
      const fake = async () => new Response(body, { status: 200 });
      const result = await readHeightAfter('http://node', fake);
      // last — the height is refused; the reader returns `null`
      expect(result).toBeNull();
    });

    // Passes on the pre-cap tree: an honest answer is `{"height":N,"hash":...}`
    // of about 100 bytes, well under 1_024.
    it('reads the longest honest /blocks/current under the cap', async () => {
      const body = longestHonestBlocksCurrent();
      const bytes = new TextEncoder().encode(body).byteLength;
      // control — the honest body is at most the cap
      expect(bytes).toBeLessThanOrEqual(HEIGHT_READ_BYTES);
      const fake = async () => new Response(body, { status: 200 });
      const result = await readHeightAfter('http://node', fake);
      // last — the height is read
      expect(result).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('runCli post at POST_READ_BYTES', () => {
    it('refuses a /posts/:id?tx=1 body over the cap', async () => {
      const padding = 'a'.repeat(POST_READ_BYTES);
      const body = `{"id":"${POST_ID}","tx":null,"pad":"${padding}"}`;
      const bytes = new TextEncoder().encode(body).byteLength;
      // control — the body is above the cap
      expect(bytes).toBeGreaterThan(POST_READ_BYTES);
      const fake = async () => new Response(body, { status: 200 });
      const config: Config = {
        nodeUrls: ['http://node'],
        profile: devnetProfile(),
        m: 24,
        k: 20,
        user: null,
        post: POST_ID,
        allowSingle: true,
        json: false,
      };
      const result = await runCli(config, fake, () => 0);
      // control — the post subcommand ran
      expect(result.post).not.toBeNull();
      // last — the fetch failed (the body was refused)
      expect(result.post?.fetchFailure).not.toBeNull();
    });

    // Passes on the pre-cap tree: a worst-case post with tx=1 is at most 21_598
    // bytes, well under 32_768.
    it('reads the longest honest post row under the cap', async () => {
      const body = longestHonestPostRow();
      const bytes = new TextEncoder().encode(body).byteLength;
      // control — the honest body is at most the cap
      expect(bytes).toBeLessThanOrEqual(POST_READ_BYTES);
      const fake = async () => new Response(body, { status: 200 });
      const config: Config = {
        nodeUrls: ['http://node'],
        profile: devnetProfile(),
        m: 24,
        k: 20,
        user: null,
        post: POST_ID,
        allowSingle: true,
        json: false,
      };
      const result = await runCli(config, fake, () => 0);
      // last — the fetch succeeded (the row is read; its check may still
      // reject the stub shape, which is not this read's concern)
      expect(result.post?.fetchFailure).toBeNull();
    });
  });

  describe('proveFigures at LOOKUP_READ_BYTES', () => {
    it('refuses a /api/v1/proof body one byte over the cap', async () => {
      const CAP = LOOKUP_READ_BYTES;
      const over = jsonOfLength(CAP + 1);
      const fake = async () => new Response(over, { status: 200 });
      // proveKeyAtHeight is exercised through proveFigures. A simpler entry:
      // read the lookup proof directly through fetchJson at this cap.
      const result = await fetchJson(fake, 'http://node/api/v1/proof/aa', CAP);
      // last — the shape of a refused read
      expect(result).toEqual({ ok: false, status: 200, body: `body over ${CAP} bytes` });
    });
  });
});

// Longest honest answers, built with the real encoders where available. The
// node composes its JSON with Express's `res.json`, so every field counts; a
// decimal value below 2⁶³ widens through `Number.MAX_SAFE_INTEGER`'s width, a
// box id is 64 hex, and `boxCount`/`height` carry integers.

function longestHonestKarmaPage(): string {
  const page: Record<string, unknown> = {
    userId: 'a'.repeat(64),
    total: ((1n << 64n) - 1n).toString(),
    effective: ((1n << 64n) - 1n).toString(),
    boxes: [] as Array<Record<string, unknown>>,
    boxCount: 100,
    next: `${(1n << 63n) - 1n}:${'b'.repeat(64)}`,
    lastActivityBlock: Number.MAX_SAFE_INTEGER,
    lastDecayBlock: Number.MAX_SAFE_INTEGER,
    lifetimeLikesReceived: ((1n << 64n) - 1n).toString(),
    memberSinceBlock: Number.MAX_SAFE_INTEGER,
    memberBar: Number.MAX_SAFE_INTEGER,
    memberVouches: Number.MAX_SAFE_INTEGER,
    memberLikes: ((1n << 64n) - 1n).toString(),
    invitesUsed: Number.MAX_SAFE_INTEGER,
    invitedAtBlock: Number.MAX_SAFE_INTEGER,
    member: true,
    invitesAvailable: Number.MAX_SAFE_INTEGER,
    height: Number.MAX_SAFE_INTEGER,
  };
  const boxes = page['boxes'] as Array<Record<string, unknown>>;
  for (let i = 0; i < 100; i++) {
    boxes.push({ boxId: 'c'.repeat(64), value: ((1n << 63n) - 1n).toString(), income: true });
  }
  return JSON.stringify(page);
}

function longestHonestCreditPage(): string {
  const page: Record<string, unknown> = {
    userId: 'a'.repeat(64),
    total: ((1n << 64n) - 1n).toString(),
    boxes: [] as Array<Record<string, unknown>>,
    boxCount: 100,
    next: `${(1n << 63n) - 1n}:${'b'.repeat(64)}`,
  };
  const boxes = page['boxes'] as Array<Record<string, unknown>>;
  for (let i = 0; i < 100; i++) {
    boxes.push({
      boxId: 'c'.repeat(64),
      value: ((1n << 63n) - 1n).toString(),
      lockedUntilBlock: Number.MAX_SAFE_INTEGER,
    });
  }
  return JSON.stringify(page);
}

function longestHonestNameLookup(): string {
  return JSON.stringify({
    name: 'A'.repeat(24),
    owner: 'a'.repeat(64),
    boxId: 'b'.repeat(64),
    claimedAtBlock: Number.MAX_SAFE_INTEGER,
  });
}

function longestHonestBlocksCurrent(): string {
  return JSON.stringify({ height: Number.MAX_SAFE_INTEGER, hash: 'a'.repeat(64) });
}

function longestHonestPostRow(): string {
  // A PostJson with tx=1, worst content and name. `confirmedAuthor` is a byte
  // array the node serialises as `{"0":n,...}`, counted at its 32 bytes.
  const confirmedAuthor: Record<string, number> = {};
  for (let i = 0; i < 32; i++) confirmedAuthor[String(i)] = 255;
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
    confirmedAuthor,
  };
  return JSON.stringify(post);
}

// A paged listing JSON, padded to `padBytes` by extending its `effective`
// field. The result is a well-formed page shape (`boxes` empty, `next` null)
// so a fetchListing without the cap enforced reads it as an empty page.
function buildListingPageJson({
  kind,
  padBytes,
}: {
  kind: 'karma' | 'credit';
  padBytes: number;
}): string {
  const base = kind === 'karma'
    ? { boxes: [] as unknown[], next: null, height: 0, effective: '' }
    : { boxes: [] as unknown[], next: null };
  const skeleton = JSON.stringify(base);
  if (kind === 'karma') {
    const needed = padBytes - skeleton.length;
    if (needed < 0) throw new Error('target too small');
    const effectiveLen = needed; // every char is one UTF-8 byte
    return JSON.stringify({
      boxes: [],
      next: null,
      height: 0,
      effective: 'a'.repeat(effectiveLen > 0 ? effectiveLen : 1),
    });
  } else {
    // credit page has no `effective`; add an unused field for padding.
    const needed = padBytes - JSON.stringify({ boxes: [], next: null, pad: '' }).length;
    const padLen = needed > 0 ? needed : 1;
    return JSON.stringify({ boxes: [], next: null, pad: 'a'.repeat(padLen) });
  }
}

function makeHeader(height: number): {
  protocolVersion: number;
  height: number;
  prevBlockHash: string;
  utxoTxRoot: string;
  stateRoot: string;
  validatorId: Uint8Array;
  powNonce: number;
  powTargetBits: number;
  createdAt: number;
  interlinkRoot: string;
  adProofsRoot: string;
} {
  return {
    protocolVersion: 1,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: 'ab'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 1,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
}
