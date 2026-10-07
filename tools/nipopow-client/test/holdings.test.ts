import { describe, it, expect } from 'vitest';
import type { BatchAVLProver } from '@dagsocial/avltree';
import { hexToBytes } from '@dagsocial/types';
import type { AnyBox, UserId } from '@dagsocial/types';
import type { HoldingKind } from '@dagsocial/consensus';
import { proveRange } from '../src/holdings.js';
import type { HttpFetch } from '../src/http.js';
import {
  buildHoldingsFixture,
  creditBoxFor,
  jsonResponse,
  karmaBoxFor,
  rangeAnswerFromProver,
} from './helpers.js';

// `proveRange` (NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range
// route"; CONSENSUS_INTERFACE → The holdings page). Each test wires a
// `httpFetch` that answers `GET /api/v1/range/<kind>/<owner>?atHeight=N&
// from=K&limit=L` from a real `BatchAVLProver` — what the node's route does.
// Every lookup replays through `verifierSession` on the answered proof: a
// malformed body, a non-base64 proof or a limit outside `[1, 256]` is
// `unproven`; an answer whose `stateRoot` is not the header's is `stale`;
// a transport failure or a non-2xx is `no-proof`.

const OWNER_HEX = 'ab'.repeat(32);
const OWNER = hexToBytes(OWNER_HEX) as UserId;
const OTHER_OWNER_HEX = 'cd'.repeat(32);

interface Routed {
  fetch: HttpFetch;
  calls: string[];
}

/**
 * A fetch that answers the range route from `prover` and anything else with
 * a 404. The route runs `holdingsPage` over a recording session, then
 * `generateProof()` — exactly what the node's route does. The handler
 * decodes the query params, performs the proof call, and returns the JSON.
 * `calls` is the list of request URLs for assertions.
 */
function nodeFromProver(opts: {
  url: string;
  prover: BatchAVLProver;
  stateRoot: string;
  atHeightDefault: number;
}): Routed {
  const calls: string[] = [];
  const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
    const u = new URL(reqUrl);
    calls.push(`${u.pathname}${u.search}`);
    const match = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/([0-9a-f]{64})$/);
    if (!match) return jsonResponse(404, { error: 'not found' });
    const kind = match[1] as HoldingKind;
    const ownerHex = match[2]!;
    const atHeight = Number(u.searchParams.get('atHeight') ?? opts.atHeightDefault);
    const limitRaw = u.searchParams.get('limit');
    const limit = limitRaw === null ? 256 : Number(limitRaw);
    const fromHex = u.searchParams.get('from');
    const from = fromHex === null ? null : hexToBytes(fromHex);
    return jsonResponse(
      200,
      rangeAnswerFromProver(
        opts.prover,
        opts.stateRoot,
        atHeight,
        kind,
        hexToBytes(ownerHex) as UserId,
        from,
        limit,
      ),
    );
  };
  return { fetch, calls };
}

const HEIGHT = 100;

describe('proveRange — a kind\'s whole range at one height', () => {
  it('an owner holding nothing answers ok with no box in one request', async () => {
    const { prover, stateRoot } = buildHoldingsFixture({ boxes: [] });
    const { fetch, calls } = nodeFromProver({ url: 'http://a', prover, stateRoot, atHeightDefault: HEIGHT });

    const result = await proveRange('http://a', 'credit', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch);
    expect(result).toEqual({ ok: true, boxes: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`/api/v1/range/credit/${OWNER_HEX}?atHeight=${HEIGHT}&limit=256`);
  });

  it('answers every box of a kind for an owner', async () => {
    const boxes: AnyBox[] = [
      karmaBoxFor(OWNER, 10n, 1),
      karmaBoxFor(OWNER, 20n, 2),
      karmaBoxFor(OWNER, 30n, 3),
    ];
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    const { fetch } = nodeFromProver({ url: 'http://a', prover, stateRoot, atHeightDefault: HEIGHT });

    const result = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Set(result.boxes.map((b) => b.id!))).toEqual(new Set(boxes.map((b) => b.id!)));
      for (const b of result.boxes) expect(b.boxType).toBe('karma');
    }
  });

  it('a 600-box credit range is read in three requests, each carrying the previous proof\'s `next` as `from`', async () => {
    const boxes: AnyBox[] = [];
    for (let i = 0; i < 600; i++) boxes.push(creditBoxFor(OWNER, 1n + BigInt(i), i + 1));
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    const { fetch, calls } = nodeFromProver({ url: 'http://a', prover, stateRoot, atHeightDefault: HEIGHT });

    const result = await proveRange('http://a', 'credit', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.boxes.length).toBe(600);
    }
    // 600 / 256 = 3 pages
    expect(calls).toHaveLength(3);
    // The first request carries no `from`; later requests do.
    expect(calls[0]).not.toContain('from=');
    expect(calls[1]).toContain('from=');
    expect(calls[2]).toContain('from=');
  });
});

describe("proveRange — a stateRoot other than the header's is stale, read before the proof", () => {
  it("a header stateRoot other than the answer's is stale, with the node named as answering another block", async () => {
    const { prover, stateRoot } = buildHoldingsFixture({ boxes: [karmaBoxFor(OWNER, 5n, 1)] });
    const differentRoot = '00'.repeat(33);
    // A fetch that answers the real proof but under the ANSWER's stateRoot.
    // The client's header has a DIFFERENT stateRoot — so the mismatch is on
    // the first check (before the proof is read).
    const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
      const u = new URL(reqUrl);
      const match = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/([0-9a-f]{64})$/);
      if (!match) return jsonResponse(404, { error: 'not found' });
      // Build a legitimate proof — but we pass this answer to a client that
      // asked under `differentRoot`, so the client refuses on root mismatch.
      const kind = match[1] as HoldingKind;
      return jsonResponse(
        200,
        rangeAnswerFromProver(prover, stateRoot, HEIGHT, kind, OWNER, null, 256),
      );
    };

    const result = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot: differentRoot }, fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe('stale');
      expect(result.verdict).toContain(`height ${HEIGHT}`);
    }
  });

  it("a stateRoot other than the header's is read before the proof: the stale verdict wins over a non-base64 proof", async () => {
    // The answer carries both a wrong `stateRoot` AND a non-base64 `proof`.
    // The root check runs before the proof decode, so the status is `stale`,
    // not `unproven`. This pins the order of the two checks: a reader of a
    // `stale` result cannot have run the proof decoder.
    const differentRoot = '00'.repeat(33);
    const answerRoot = 'aa'.repeat(33);
    const fetch: HttpFetch = async () => jsonResponse(200, {
      stateRoot: answerRoot,
      from: null,
      limit: 256,
      proof: '!!not*base64@@',
    });
    const result = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot: differentRoot }, fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe('stale');
      expect(result.verdict).not.toContain('proof rejected');
    }
  });
});

describe('proveRange — a body of another shape is unproven', () => {
  const base = { stateRoot: '00'.repeat(33), from: null, limit: 256, proof: '' };

  async function askWith(body: unknown) {
    const fetch: HttpFetch = async () => jsonResponse(200, body);
    return proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot: '00'.repeat(33) }, fetch);
  }

  it('a body that is null', async () => {
    const r = await askWith(null);
    expect(r).toEqual({ ok: false, status: 'unproven', verdict: 'page body is not an object: null' });
  });

  it('a body that is an array', async () => {
    const r = await askWith([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('unproven');
  });

  // The page's `stateRoot` is checked for shape before it is compared to the
  // header's: a `stale` ledger is a well-formed root that is not the header's;
  // every other shape is `unproven` (WEB_INTERFACE → The extension → "The
  // verified figures" — "A run is total").
  it('a body with no stateRoot (empty object)', async () => {
    const r = await askWith({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('unproven');
      expect(r.verdict).toContain('stateRoot');
    }
  });

  it('a body with an `error` field alone (no stateRoot)', async () => {
    const r = await askWith({ error: 'internal' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('unproven');
      expect(r.verdict).toContain('stateRoot');
    }
  });

  it('a stateRoot that is a number', async () => {
    const r = await askWith({ ...base, stateRoot: 7 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('unproven');
      expect(r.verdict).toContain('stateRoot');
    }
  });

  it('a stateRoot that is null', async () => {
    const r = await askWith({ ...base, stateRoot: null });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('unproven');
      expect(r.verdict).toContain('stateRoot');
    }
  });

  it('a stateRoot that is a hex string of the wrong length', async () => {
    const r = await askWith({ ...base, stateRoot: '00'.repeat(32) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('unproven');
      expect(r.verdict).toContain('stateRoot');
    }
  });

  it('a `proof` that is not a string', async () => {
    const r = await askWith({ ...base, proof: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('unproven');
      expect(r.verdict).toContain('proof must be a string');
    }
  });

  it('a `proof` that is not base64', async () => {
    const r = await askWith({ ...base, proof: '!!not*base64@@' });
    expect(r).toEqual({ ok: false, status: 'unproven', verdict: 'proof rejected' });
  });

  it.each([
    ['limit 0', 0],
    ['limit 257', 257],
    ['limit 1.5', 1.5],
    ['limit as a string', '100'],
  ])('%s is unproven, no proof decode runs', async (_name, limit) => {
    const r = await askWith({ ...base, limit });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('unproven');
      expect(r.verdict).toContain('limit');
    }
  });
});

describe('proveRange — a proof made for one thing, replayed for another, is unproven', () => {
  function proofForOwnerKind(ownerForProof: UserId, kindForProof: HoldingKind): { stateRoot: string; proofAnswer: unknown } {
    const boxes: AnyBox[] = [karmaBoxFor(ownerForProof, 10n, 1), creditBoxFor(ownerForProof, 20n, 2)];
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    const proofAnswer = rangeAnswerFromProver(prover, stateRoot, HEIGHT, kindForProof, ownerForProof, null, 256);
    return { stateRoot, proofAnswer };
  }

  it('a proof with one byte altered is unproven', async () => {
    const { stateRoot, proofAnswer } = proofForOwnerKind(OWNER, 'karma');
    const asRecord = proofAnswer as { proof: string };
    const bytes = Buffer.from(asRecord.proof, 'base64');
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0x01;
    const tampered = { ...asRecord, proof: bytes.toString('base64') };

    const fetch: HttpFetch = async () => jsonResponse(200, tampered);
    const r = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('unproven');
  });

  it('a proof made for another owner is unproven', async () => {
    // Build the proof under OWNER's state, but the client asks for OTHER_OWNER's karma.
    const { stateRoot, proofAnswer } = proofForOwnerKind(OWNER, 'karma');
    const fetch: HttpFetch = async () => jsonResponse(200, proofAnswer);
    const r = await proveRange('http://a', 'karma', OTHER_OWNER_HEX, { height: HEIGHT, stateRoot }, fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('unproven');
  });

  it('a proof made for another `from` is unproven', async () => {
    const boxes: AnyBox[] = [];
    for (let i = 0; i < 3; i++) boxes.push(karmaBoxFor(OWNER, 1n + BigInt(i), i + 1));
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    // The server answers the first-page proof (made for `from=null, limit=2`)
    // whatever the client sends. On the second request the client has walked
    // past the proof's starting key, and the replay refuses the mismatch.
    const first = rangeAnswerFromProver(prover, stateRoot, HEIGHT, 'karma', OWNER, null, 2);
    const fetch: HttpFetch = async () => jsonResponse(200, first);
    const r = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe('unproven');
  });
});

describe('proveRange — a node whose limit is below the cap still serves', () => {
  it('a node answering limit:100 is read to the end in pages of 100', async () => {
    const boxes: AnyBox[] = [];
    for (let i = 0; i < 250; i++) boxes.push(karmaBoxFor(OWNER, 1n + BigInt(i), i + 1));
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    const calls: string[] = [];
    const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
      const u = new URL(reqUrl);
      calls.push(`${u.pathname}${u.search}`);
      const atHeight = Number(u.searchParams.get('atHeight') ?? HEIGHT);
      const fromHex = u.searchParams.get('from');
      const from = fromHex === null ? null : hexToBytes(fromHex);
      // The node serves at a cap of 100 whatever the client asked.
      return jsonResponse(200, rangeAnswerFromProver(prover, stateRoot, atHeight, 'karma', OWNER, from, 100));
    };

    const r = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.boxes.length).toBe(250);
    // 250 / 100 = 3 pages (100 + 100 + 50).
    expect(calls).toHaveLength(3);
  });
});

describe('proveRange — a transport failure or non-2xx is no-proof for the whole range', () => {
  it('a 404 on the first page is no-proof, no box answered', async () => {
    const fetch: HttpFetch = async () => jsonResponse(404, { error: 'height not available' });
    const r = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot: '00'.repeat(33) }, fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('no-proof');
      expect(r.verdict).toContain('HTTP 404');
    }
  });

  it('a 404 on the third page is no-proof, no box answered (not even from the first two)', async () => {
    const boxes: AnyBox[] = [];
    for (let i = 0; i < 250; i++) boxes.push(karmaBoxFor(OWNER, 1n + BigInt(i), i + 1));
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    let callNumber = 0;
    const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
      callNumber++;
      const u = new URL(reqUrl);
      const atHeight = Number(u.searchParams.get('atHeight') ?? HEIGHT);
      const fromHex = u.searchParams.get('from');
      const from = fromHex === null ? null : hexToBytes(fromHex);
      if (callNumber === 3) return jsonResponse(404, { error: 'height not available' });
      return jsonResponse(200, rangeAnswerFromProver(prover, stateRoot, atHeight, 'karma', OWNER, from, 100));
    };

    const r = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('no-proof');
      expect(r.verdict).toContain('HTTP 404');
    }
  });

  it('a transport failure is no-proof', async () => {
    const fetch: HttpFetch = async () => { throw new TypeError('ECONNREFUSED'); };
    const r = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot: '00'.repeat(33) }, fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('no-proof');
      expect(r.verdict).toContain('transport failure');
    }
  });

  it('a 500 is no-proof', async () => {
    const fetch: HttpFetch = async () => jsonResponse(500, { error: 'internal' });
    const r = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot: '00'.repeat(33) }, fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe('no-proof');
      expect(r.verdict).toContain('HTTP 500');
    }
  });
});

