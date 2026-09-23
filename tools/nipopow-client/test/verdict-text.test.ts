import { describe, it, expect } from 'vitest';
import { capped, fetchJson } from '../src/http.js';
import { resolveTip } from '../src/tip.js';
import { fetchListing, proveFigures } from '../src/boxes.js';
import type { Listing } from '../src/boxes.js';
import { proveName } from '../src/names.js';
import type { HttpFetch } from '../src/http.js';
import {
  buildAvlWithInsertions,
  boxInsertion,
  recordInsertion,
  avlProofJson,
  hexToBytes,
  jsonResponse,
  makeAnchor,
  devnetProfile,
} from './helpers.js';
import { computeCandidateBoxId, identityRecordKey } from '@dagsocial/types';
import type { AnyBoxCandidate, IdentityRecord, TxId, UserId } from '@dagsocial/types';

// A verdict names at most 120 characters of any one node-supplied string, and
// the data a status is decided on is never cut: each site where node text
// enters a verdict is handed a string of 10 000 characters.

const LONG = 'Z'.repeat(10_000);
const NAMED = `${'Z'.repeat(120)}…`;

const USER_HEX = 'ab'.repeat(32);
const USER_BYTES = hexToBytes(USER_HEX) as UserId;
const RECORD_KEY = identityRecordKey(USER_BYTES);
const TXID = 'cd'.repeat(32) as TxId;
const SUFFIX_H = 100;
const TIP_H = 119;

const RECORD: IdentityRecord = {
  lastActivityBlock: 50,
  lastDecayBlock: 50,
  invitedAtBlock: 10,
  lifetimeLikesReceived: 3n,
  memberSinceBlock: 20,
  memberBar: 5,
  memberVouches: 2,
  memberLikes: 1n,
  invitesUsed: 0,
};

const CANDIDATE: AnyBoxCandidate = { boxType: 'karma', value: 100n, createdAtBlock: 1, owner: USER_BYTES };
const BOX_ID = computeCandidateBoxId(CANDIDATE, TXID, 0);
const AVL = buildAvlWithInsertions([boxInsertion(CANDIDATE, TXID, 0), recordInsertion(USER_BYTES, RECORD)]);
const ANCHOR = makeAnchor(TIP_H, AVL.digest, SUFFIX_H, AVL.digest);

// An honest node over AVL, the proof route answering otherwise where a test says so.
function node(proof?: (key: string) => Response | undefined): HttpFetch {
  return async (url: string) => {
    const u = new URL(url);
    const proofMatch = u.pathname.match(/^\/api\/v1\/proof\/(.+)$/);
    if (proofMatch) {
      const key = proofMatch[1]!;
      const answer = proof?.(key);
      if (answer) return answer;
      const entry = AVL.entries.get(key);
      if (!entry) return jsonResponse(404, { error: 'height not available' });
      const at = Number(u.searchParams.get('atHeight'));
      return jsonResponse(200, avlProofJson(key, at, AVL.digest, entry.proof, key === RECORD_KEY ? 'record' : 'box', null));
    }
    if (u.pathname === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
    return jsonResponse(404, { error: 'not found' });
  };
}

// An answer whose body is the text given, as a node's error page is.
function textResponse(status: number, text: string): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

function prove(karma: unknown[], fetch: HttpFetch) {
  const listing: Listing = {
    karma: { boxes: karma as Listing['karma']['boxes'], height: TIP_H, effective: '0' },
    credits: { boxes: [] },
  };
  return proveFigures('http://a', USER_HEX, listing, ANCHOR, devnetProfile(), fetch);
}

describe('capped — the node text a verdict names', () => {
  it('a string of 120 characters is named whole', () => {
    expect(capped('Z'.repeat(120))).toBe('Z'.repeat(120));
  });

  it('a longer string is named by its first 120 characters and …', () => {
    expect(capped(LONG)).toBe(NAMED);
  });

  it('a surrogate pair across the cut is left out whole, never split', () => {
    expect(capped(`${'Z'.repeat(119)}\u{1F600}${'Z'.repeat(10)}`)).toBe(`${'Z'.repeat(119)}…`);
  });

  it('a surrogate pair ending at the cut is kept whole', () => {
    expect(capped(`${'Z'.repeat(118)}\u{1F600}${'Z'.repeat(10)}`)).toBe(`${'Z'.repeat(118)}\u{1F600}…`);
  });
});

describe('fetchJson — a body that will not parse', () => {
  it('a 200 whose body will not parse names it capped', async () => {
    const res = await fetchJson(async () => textResponse(200, LONG), 'http://node');
    expect(res).toEqual({ ok: false, status: 200, body: `unparseable body: ${NAMED}` });
  });
});

describe('fetchListing — a failed page names its cursor capped, and the request carries it whole', () => {
  it.each([
    ['karma', 'HTTP 500'],
    ['karma', 'malformed page'],
    ['credits', 'HTTP 500'],
    ['credits', 'malformed page'],
  ])('a following %s page ending in %s', async (route, failure) => {
    const cursors: (string | null)[] = [];
    const fetch: HttpFetch = async (url: string) => {
      const u = new URL(url);
      if (u.pathname === `/karma/${USER_HEX}` && route === 'credits') return jsonResponse(404, { error: 'not found' });
      if (u.pathname !== `/${route}/${USER_HEX}`) return jsonResponse(404, { error: 'not found' });
      if (!u.searchParams.has('after')) return jsonResponse(200, { boxes: [], next: LONG, height: 1, effective: '0' });
      cursors.push(u.searchParams.get('after'));
      return failure === 'HTTP 500' ? textResponse(500, 'internal') : jsonResponse(200, null);
    };
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result).toEqual({ ok: false, reason: `GET /${route}/${USER_HEX}?after=${NAMED}: ${failure}` });
    expect(cursors).toEqual([LONG]);
  });
});

describe('proveFigures — a verdict caps the node text it names', () => {
  it('a box proof answering 500 with a body of 10 000 characters', async () => {
    const result = await prove(
      [{ boxId: BOX_ID, value: '100' }],
      node((key) => (key === BOX_ID ? textResponse(500, LONG) : undefined)),
    );
    expect(result.boxes[0]!.status).toBe('no-proof');
    expect(result.boxes[0]!.verdict).toBe(`no proof at suffixHead: HTTP 500: ${NAMED}`);
  });

  it('a box proof whose transport fails with a message of 10 000 characters', async () => {
    const result = await prove(
      [{ boxId: BOX_ID, value: '100' }],
      node((key) => {
        if (key === BOX_ID) throw new TypeError(LONG);
        return undefined;
      }),
    );
    expect(result.boxes[0]!.status).toBe('no-proof');
    expect(result.boxes[0]!.verdict).toBe(`no proof at suffixHead: transport failure: ${NAMED}`);
  });

  it('a listed boxId of 10 000 characters — the verdict caps it, the box keeps it whole', async () => {
    const result = await prove([{ boxId: LONG, value: '5' }], node());
    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toBe(`unproven: the listed boxId is not 64 hex: '${NAMED}'`);
    expect(result.boxes[0]!.boxId).toBe(LONG);
  });

  it('a real box listed at a value of 10 000 digits', async () => {
    const result = await prove([{ boxId: BOX_ID, value: '9'.repeat(10_000) }], node());
    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toBe(
      `unproven at suffixHead: candidate value 100 does not match listing ${'9'.repeat(120)}…`,
    );
  });
});

describe('proveName — a verdict caps the node text it names', () => {
  it('the lookup answering 500 with a body of 10 000 characters', async () => {
    const fetch: HttpFetch = async () => textResponse(500, LONG);
    const result = await proveName('http://a', { key: USER_HEX, name: 'Bob' }, ANCHOR, fetch);
    expect(result.status).toBe('no-proof');
    expect(result.verdict).toBe(`no answer to the lookup: HTTP 500: ${NAMED}`);
  });

  it('the lookup whose transport fails with a message of 10 000 characters', async () => {
    const fetch: HttpFetch = async () => { throw new TypeError(LONG); };
    const result = await proveName('http://a', { key: USER_HEX, name: 'Bob' }, ANCHOR, fetch);
    expect(result.status).toBe('no-proof');
    expect(result.verdict).toBe(`no answer to the lookup: transport failure: ${NAMED}`);
  });
});

describe('resolveTip — a refusal caps the node text it names, and the code reads the whole body', () => {
  it('a proof route answering 500 with a body of 10 000 characters', async () => {
    const fetch: HttpFetch = async () => textResponse(500, LONG);
    const result = await resolveTip(['http://a'], 6, 6, devnetProfile(), () => 0, fetch);
    expect(result.nodes[0]!.refuseCode).toBe('http');
    expect(result.nodes[0]!.refuseReason).toBe(`HTTP 500: ${NAMED}`);
  });

  it('a proof route whose transport fails with a message of 10 000 characters', async () => {
    const fetch: HttpFetch = async () => { throw new TypeError(LONG); };
    const result = await resolveTip(['http://a'], 6, 6, devnetProfile(), () => 0, fetch);
    expect(result.nodes[0]!.refuseCode).toBe('unreachable');
    expect(result.nodes[0]!.refuseReason).toBe(`unreachable: ${NAMED}`);
  });

  it("a 404 whose `chain too short` body runs past 120 characters is too-short still", async () => {
    const body = JSON.stringify({ error: 'chain too short', detail: LONG });
    const fetch: HttpFetch = async () => textResponse(404, body);
    const result = await resolveTip(['http://a'], 6, 6, devnetProfile(), () => 0, fetch);
    expect(result.nodes[0]!.refuseCode).toBe('too-short');
    expect(result.nodes[0]!.refuseReason).toBe(`HTTP 404: ${body.slice(0, 120)}…`);
  });
});
