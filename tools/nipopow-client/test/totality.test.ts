import { describe, it, expect } from 'vitest';
import { fetchJson } from '../src/http.js';
import { resolveTip } from '../src/tip.js';
import { fetchListing, proveFigures } from '../src/boxes.js';
import type { Listing } from '../src/boxes.js';
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

// WEB_INTERFACE → The extension → "A run is total" — each test hands the tool
// one answer of another shape than the route's and asserts the status the run
// ends in; a run that throws rejects, and the test fails on it.

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
// A key the tree does not hold — excluded at both heights.
const GONE_ID = 'ee'.repeat(32);

// One tree stands at both heights: the box, the record, an exclusion for GONE_ID.
const AVL = buildAvlWithInsertions(
  [boxInsertion(CANDIDATE, TXID, 0), recordInsertion(USER_BYTES, RECORD)],
  [GONE_ID],
);
const ANCHOR = makeAnchor(TIP_H, AVL.digest, SUFFIX_H, AVL.digest);

interface Routes {
  proof?: (key: string) => Response | undefined;
  blocksCurrent?: () => Response;
}

// An honest node over AVL, a route answering otherwise where a test says so;
// each request's path and query is logged in order.
function node(routes: Routes = {}): { fetch: HttpFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: HttpFetch = async (url: string) => {
    const u = new URL(url);
    calls.push(`${u.pathname}${u.search}`);
    const proofMatch = u.pathname.match(/^\/api\/v1\/proof\/(.+)$/);
    if (proofMatch) {
      const key = proofMatch[1]!;
      const answer = routes.proof?.(key);
      if (answer) return answer;
      const entry = AVL.entries.get(key);
      if (!entry) return jsonResponse(404, { error: 'height not available' });
      const at = Number(u.searchParams.get('atHeight'));
      const kind = entry.value === null ? null : key === RECORD_KEY ? 'record' : 'box';
      return jsonResponse(200, avlProofJson(key, at, AVL.digest, entry.proof, kind, null));
    }
    if (u.pathname === '/blocks/current') {
      return routes.blocksCurrent?.() ?? jsonResponse(200, { height: TIP_H, hash: null });
    }
    return jsonResponse(404, { error: 'not found' });
  };
  return { fetch, calls };
}

// A node answering each path and query `answers` names with its page, and every
// other request with a 404, which ends a listing — a request the tool should not
// make shows in the log, and the paging stops there; each request logged in order.
function pages(answers: Record<string, unknown>): { fetch: HttpFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: HttpFetch = async (url: string) => {
    const u = new URL(url);
    const at = `${u.pathname}${u.search}`;
    calls.push(at);
    const page = answers[at];
    return page === undefined ? jsonResponse(404, { error: 'not found' }) : jsonResponse(200, page);
  };
  return { fetch, calls };
}

// A listing as the caller hands it — entries and height as the node sent them.
function listingOf(karma: unknown[], height: unknown = TIP_H): Listing {
  return {
    karma: { boxes: karma as Listing['karma']['boxes'], height: height as number, effective: '100' },
    credits: { boxes: [] },
  };
}

// A response whose status line arrived and whose body did not.
function cutOff(): Response {
  return {
    ok: true,
    status: 200,
    text: async () => { throw new TypeError('terminated'); },
  } as unknown as Response;
}

function prove(listing: Listing, fetch: HttpFetch) {
  return proveFigures('http://a', USER_HEX, listing, ANCHOR, devnetProfile(), fetch);
}

const GOOD_PROOF = Buffer.from(AVL.entries.get(BOX_ID)!.proof).toString('base64');
const SHORT_PROOF = Buffer.from(AVL.entries.get(BOX_ID)!.proof.slice(0, 10)).toString('base64');

describe('fetchJson', () => {
  it('a body cut off in flight is a transport failure, never a throw', async () => {
    const res = await fetchJson(async () => cutOff(), 'http://node');
    expect(res).toEqual({ ok: false, status: 0, body: 'terminated' });
  });
});

describe('resolveTip', () => {
  it('a proof route answering null refuses the node as invalid, never a throw', async () => {
    const fetch: HttpFetch = async () => jsonResponse(200, null);
    const result = await resolveTip(['http://a'], 6, 6, devnetProfile(), () => 0, fetch);
    expect(result.winner).toBeNull();
    expect(result.nodes[0]!.verified).toBe(false);
    expect(result.nodes[0]!.refuseCode).toBe('invalid');
    expect(result.nodes[0]!.refuseReason).toBe('response missing proof field');
  });
});

describe('fetchListing — a page the paging cannot walk fails the listing, its route named', () => {
  it.each([
    ['a body that is null', null],
    ['a body that is not an object', 'boxes'],
    ['a `boxes` that is not an array', { boxes: 'abc', next: null, height: 1, effective: '0' }],
    ['no `next`', { boxes: [], height: 1, effective: '0' }],
    ['a `next` that is neither a string nor null', { boxes: [], next: 7, height: 1, effective: '0' }],
    ['a `next` that is a lone high surrogate', { boxes: [], next: '\ud800', height: 1, effective: '0' }],
    ['a `next` that carries a lone low surrogate', { boxes: [], next: 'c\udc00', height: 1, effective: '0' }],
  ])('a karma page with %s is a malformed page', async (_shape, body) => {
    const fetch: HttpFetch = async () => jsonResponse(200, body);
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result).toEqual({ ok: false, reason: `GET /karma/${USER_HEX}: malformed page` });
  });

  it('a following page that is malformed fails the listing, its cursor named', async () => {
    const fetch: HttpFetch = async (url: string) => {
      const u = new URL(url);
      if (u.pathname === `/karma/${USER_HEX}` && !u.searchParams.has('after')) {
        return jsonResponse(200, { boxes: [], next: 'c1', height: 1, effective: '0' });
      }
      return jsonResponse(200, null);
    };
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result).toEqual({ ok: false, reason: `GET /karma/${USER_HEX}?after=c1: malformed page` });
  });

  it('a `next` carrying a surrogate pair is well-formed text, followed with the pair encoded', async () => {
    const calls: string[] = [];
    const fetch: HttpFetch = async (url: string) => {
      const u = new URL(url);
      calls.push(`${u.pathname}${u.search}`);
      if (u.pathname === `/karma/${USER_HEX}` && !u.searchParams.has('after')) {
        return jsonResponse(200, { boxes: [], next: 'c\u{1F600}', height: 1, effective: '0' });
      }
      if (u.pathname === `/karma/${USER_HEX}`) return jsonResponse(200, { boxes: [], next: null });
      return jsonResponse(404, { error: 'not found' });
    };
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result.ok).toBe(true);
    expect(calls[1]).toBe(`/karma/${USER_HEX}?after=c%F0%9F%98%80`);
  });

  it('a first page whose `next` is the empty string fails the listing after one request, the route named', async () => {
    const { fetch, calls } = pages({
      [`/karma/${USER_HEX}`]: { boxes: [], next: '', height: 1, effective: '0' },
    });
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result).toEqual({ ok: false, reason: `GET /karma/${USER_HEX}: malformed page` });
    expect(calls).toEqual([`/karma/${USER_HEX}`]);
  });

  it('a following page whose `next` is the empty string fails the listing after two requests, its cursor named', async () => {
    const { fetch, calls } = pages({
      [`/karma/${USER_HEX}`]: { boxes: [], next: 'c1', height: 1, effective: '0' },
      [`/karma/${USER_HEX}?after=c1`]: { boxes: [], next: '' },
    });
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result).toEqual({ ok: false, reason: `GET /karma/${USER_HEX}?after=c1: malformed page` });
    expect(calls).toEqual([`/karma/${USER_HEX}`, `/karma/${USER_HEX}?after=c1`]);
  });

  it('a `next` of one character is a cursor, followed', async () => {
    const { fetch, calls } = pages({
      [`/karma/${USER_HEX}`]: { boxes: [], next: 'c', height: 1, effective: '0' },
      [`/karma/${USER_HEX}?after=c`]: { boxes: [], next: null },
    });
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result).toEqual({
      ok: true,
      listing: { karma: { boxes: [], height: 1, effective: '0' }, credits: { boxes: [] } },
    });
    expect(calls).toEqual([`/karma/${USER_HEX}`, `/karma/${USER_HEX}?after=c`, `/credits/${USER_HEX}`]);
  });

  it('a credits page that is malformed fails the listing, the credits route named', async () => {
    const fetch: HttpFetch = async (url: string) => {
      if (new URL(url).pathname === `/karma/${USER_HEX}`) return jsonResponse(404, { error: 'not found' });
      return jsonResponse(200, { boxes: {}, next: null });
    };
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result).toEqual({ ok: false, reason: `GET /credits/${USER_HEX}: malformed page` });
  });
});

describe('proveFigures — a proof answer of another shape is unproven', () => {
  it.each([
    ['a body that is null', null, 'stateRoot mismatch'],
    ['a body that is an array', [], 'stateRoot mismatch'],
    ['a `proof` that is not a string', { stateRoot: AVL.digest, kind: 'box', proof: 123 }, 'proof rejected'],
    ['no `proof`', { stateRoot: AVL.digest, kind: 'box' }, 'proof rejected'],
    ['a `proof` that is not base64', { stateRoot: AVL.digest, kind: 'box', proof: '!!not*base64@@' }, 'proof rejected'],
    ['an empty `proof`', { stateRoot: AVL.digest, kind: 'box', proof: '' }, 'proof rejected'],
    ['a `proof` cut short', { stateRoot: AVL.digest, kind: 'box', proof: SHORT_PROOF }, 'proof rejected'],
    [
      'a `kind` that refuses conversion to a string',
      { stateRoot: AVL.digest, kind: { toString: 1 }, proof: GOOD_PROOF },
      'node returned kind an object for a box id',
    ],
  ])('a box proof answer with %s is unproven, never a throw', async (_shape, body, verdict) => {
    const { fetch } = node({ proof: (key) => (key === BOX_ID ? jsonResponse(200, body) : undefined) });
    const result = await prove(listingOf([{ boxId: BOX_ID, value: '100' }]), fetch);
    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toBe(`unproven at suffixHead: ${verdict}`);
    expect(result.failed).toBe(true);
  });

  it.each([
    ['a body that is null', null, 'stateRoot mismatch'],
    ['a `proof` that is not a string', { stateRoot: AVL.digest, kind: 'record', proof: false }, 'proof rejected'],
  ])('a record proof answer with %s leaves the record unproven, never a throw', async (_shape, body, verdict) => {
    const { fetch } = node({ proof: (key) => (key === RECORD_KEY ? jsonResponse(200, body) : undefined) });
    const result = await prove(listingOf([]), fetch);
    expect(result.record).toEqual({ status: 'unproven', verdict });
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(true);
  });

  it('a proof answer cut off in flight is no-proof, never a throw', async () => {
    const { fetch } = node({ proof: (key) => (key === BOX_ID ? cutOff() : undefined) });
    const result = await prove(listingOf([{ boxId: BOX_ID, value: '100' }]), fetch);
    expect(result.boxes[0]!.status).toBe('no-proof');
    expect(result.boxes[0]!.verdict).toBe('no proof at suffixHead: transport failure: terminated');
  });
});

describe('proveFigures — /blocks/current of another shape leaves heightAfter unread', () => {
  it.each([
    ['a body that is null', null],
    ['a body that is not an object', 'tip'],
    ['no `height`', { hash: null }],
    ['a `height` that is a string', { height: String(TIP_H), hash: null }],
    ['a `height` that is not an integer', { height: TIP_H + 0.5, hash: null }],
    ['a `height` that is negative', { height: -1, hash: null }],
  ])('/blocks/current answering %s leaves the excluded box unchecked', async (_shape, body) => {
    const { fetch } = node({ blocksCurrent: () => jsonResponse(200, body) });
    const result = await prove(listingOf([{ boxId: GONE_ID, value: '5' }]), fetch);
    expect(result.heightAfter).toBeNull();
    expect(result.boxes[0]!.status).toBe('unchecked');
    expect(result.boxes[0]!.verdict).toBe('unchecked — /blocks/current unavailable');
  });
});

describe('proveFigures — a listed entry that is not a listed box asks for nothing', () => {
  it.each([
    ['a boxId that is not 64 hex', { boxId: 'zz', value: '5' }, "the listed boxId is not 64 hex: 'zz'"],
    ['a boxId of 64 characters that are not hex', { boxId: 'g'.repeat(64), value: '5' }, `the listed boxId is not 64 hex: '${'g'.repeat(64)}'`],
    ['a boxId that is not a string', { boxId: 7, value: '5' }, 'the listed boxId is not 64 hex: a number'],
    ['no boxId', { value: '5' }, 'the listed boxId is not 64 hex: missing'],
    ['an entry that is not an object', null, 'the listed box is not an object: null'],
    ['a value that is not a decimal string', { boxId: BOX_ID, value: 'abc' }, "the listed value is not a decimal integer: 'abc'"],
    ['a value that is a number', { boxId: BOX_ID, value: 100 }, 'the listed value is not a decimal integer: a number'],
  ])('a listed entry with %s is unproven and no proof is asked for it', async (_shape, entry, verdict) => {
    const { fetch, calls } = node();
    const result = await prove(listingOf([entry]), fetch);
    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toBe(`unproven: ${verdict}`);
    expect(result.failed).toBe(true);
    expect(calls).toEqual([`/api/v1/proof/${RECORD_KEY}?atHeight=${SUFFIX_H}`, '/blocks/current']);
  });
});

describe('proveFigures — a listing height that is not a block height values nothing and fails the run', () => {
  it.each([
    ['infinite, as JSON 1e400 parses', Infinity],
    ['a string', String(TIP_H)],
    ['a fraction', TIP_H + 0.5],
    ['negative', -1],
  ])('a listing height that is %s leaves effective null and fails the run, never a throw', async (_shape, height) => {
    const { fetch } = node();
    const result = await prove(listingOf([{ boxId: BOX_ID, value: '100' }], height), fetch);
    expect(result.boxes[0]!.status).toBe('proven');
    expect(result.karma.proven).toBe(100n);
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(true);
  });
});
