import { describe, it, expect } from 'vitest';
import { fetchJson } from '../src/http.js';
import { resolveTip } from '../src/tip.js';
import { fetchListing, proveFigures } from '../src/boxes.js';
import type { Listing } from '../src/boxes.js';
import type { HttpFetch } from '../src/http.js';
import {
  buildHoldingsFixture,
  devnetProfile,
  hexToBytes,
  jsonResponse,
  karmaBoxFor,
  makeAnchor,
  twoHeightNode,
} from './helpers.js';
import { identityKey } from '@dagsocial/types';
import type { IdentityRecord, UserId } from '@dagsocial/types';

// WEB_INTERFACE → The extension → "A run is total" — each test hands the tool
// one answer of another shape than the route's and asserts the status the run
// ends in; a run that throws rejects, and the test fails on it.

const USER_HEX = 'ab'.repeat(32);
const USER_BYTES = hexToBytes(USER_HEX) as UserId;
const RECORD_KEY_BYTES = identityKey(USER_BYTES);
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

const KARMA = karmaBoxFor(USER_BYTES, 100n, 1);
const FIXTURE = buildHoldingsFixture({
  boxes: [KARMA],
  records: [{ identityId: USER_BYTES, record: RECORD }],
});
const ANCHOR = makeAnchor(TIP_H, FIXTURE.stateRoot, SUFFIX_H, FIXTURE.stateRoot);

interface Routes {
  range?: (kind: string, atHeight: number) => Response | undefined;
  recordKey?: (atHeight: number) => Response | undefined;
  blocksCurrent?: () => Response;
}

// An honest node over FIXTURE, with any route the test overrides. The route
// handlers are called BEFORE the honest default serves — a test override wins.
function node(routes: Routes = {}): { fetch: HttpFetch; calls: string[] } {
  const base = twoHeightNode({ suffix: FIXTURE, suffixHeight: SUFFIX_H, tip: FIXTURE, tipHeight: TIP_H, heightAfter: TIP_H });
  const calls: string[] = [];
  const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
    const u = new URL(reqUrl);
    calls.push(`${u.pathname}${u.search}`);
    const rangeMatch = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/[0-9a-f]{64}$/);
    if (rangeMatch) {
      const atHeight = Number(u.searchParams.get('atHeight'));
      const override = routes.range?.(rangeMatch[1]!, atHeight);
      if (override) return override;
    }
    const keyMatch = u.pathname.match(/^\/api\/v1\/proof\/([0-9a-f]+)$/);
    if (keyMatch) {
      const atHeight = Number(u.searchParams.get('atHeight'));
      const override = routes.recordKey?.(atHeight);
      if (override) return override;
    }
    if (u.pathname === '/blocks/current') {
      const override = routes.blocksCurrent?.();
      if (override) return override;
    }
    return base.fetch(reqUrl);
  };
  return { fetch, calls };
}

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

function listingOf(karma: unknown[], height: unknown = TIP_H): Listing {
  return {
    karma: { boxes: karma as Listing['karma']['boxes'], height: height as number, effective: '100' },
    credits: null,
  };
}

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

describe('proveFigures — a range answer of another shape ends the ledger in a status, never a throw', () => {
  const base = { stateRoot: FIXTURE.stateRoot, from: null, limit: 256, proof: '' };

  it.each([
    ['a body that is null', null, 'unproven'],
    ['a body that is an array', [], 'unproven'],
    ['a `stateRoot` the header does not match', { ...base, stateRoot: '00'.repeat(33) }, 'unproven'],
    ['a `proof` that is not a string', { ...base, proof: 123 }, 'unproven'],
    ['no `proof`', { stateRoot: FIXTURE.stateRoot, from: null, limit: 256 }, 'unproven'],
    ['a `proof` that is not base64', { ...base, proof: '!!not*base64@@' }, 'unproven'],
    ['a `limit` of 0', { ...base, limit: 0 }, 'unproven'],
    ['a `limit` of 257', { ...base, limit: 257 }, 'unproven'],
    ['a `limit` of 1.5', { ...base, limit: 1.5 }, 'unproven'],
    ['a `limit` as a string', { ...base, limit: '100' }, 'unproven'],
  ])('a karma range answer with %s fails the listed box as %s, never a throw', async (_shape, body, status) => {
    const n = node({ range: (kind, h) => (kind === 'karma' && h === SUFFIX_H) ? jsonResponse(200, body) : undefined });
    const result = await prove(listingOf([{ boxId: KARMA.id!, value: '100' }]), n.fetch);
    expect(result.boxes[0]!.status).toBe(status);
    expect(result.karma.holdings).toBe('unproven');
    expect(result.failed).toBe(true);
  });

  it('a range answer cut off in flight is no-proof, never a throw', async () => {
    const n = node({ range: (kind, h) => (kind === 'karma' && h === SUFFIX_H) ? cutOff() : undefined });
    const result = await prove(listingOf([{ boxId: KARMA.id!, value: '100' }]), n.fetch);
    expect(result.boxes[0]!.status).toBe('no-proof');
    expect(result.karma.holdings).toBe('no-proof');
  });
});

describe('proveFigures — a record proof answer of another shape leaves the record unproven', () => {
  it.each([
    ['a body that is null', null, 'stateRoot mismatch'],
    ['a `proof` that is not a string', { stateRoot: FIXTURE.stateRoot, kind: 'record', proof: false }, 'proof rejected'],
  ])('a record proof answer with %s leaves the record unproven, never a throw', async (_shape, body, verdict) => {
    const n = node({ recordKey: (h) => h === SUFFIX_H ? jsonResponse(200, body) : undefined });
    const result = await prove(listingOf([]), n.fetch);
    expect(result.record).toEqual({ status: 'unproven', verdict });
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(true);
  });

  it('a record proof answer cut off in flight is no-proof, never a throw', async () => {
    const n = node({ recordKey: (h) => h === SUFFIX_H ? cutOff() : undefined });
    const result = await prove(listingOf([]), n.fetch);
    expect(result.record.status).toBe('no-proof');
    if (result.record.status === 'no-proof') {
      expect(result.record.verdict).toContain('transport failure');
    }
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
    const absentBoxId = 'ee'.repeat(32);
    // The box is excluded at both heights (FIXTURE holds KARMA, not this id),
    // and /blocks/current gives nothing readable: the box is unchecked.
    const n = node({ blocksCurrent: () => jsonResponse(200, body) });
    const result = await prove(listingOf([{ boxId: absentBoxId, value: '5' }]), n.fetch);
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
    ['a value that is not a decimal string', { boxId: KARMA.id!, value: 'abc' }, "the listed value is not a decimal integer: 'abc'"],
    ['a value that is a number', { boxId: KARMA.id!, value: 100 }, 'the listed value is not a decimal integer: a number'],
  ])('a listed entry with %s is unproven, and no per-key proof request is made for it', async (_shape, entry, verdict) => {
    const n = node();
    const result = await prove(listingOf([entry]), n.fetch);
    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toBe(`unproven: ${verdict}`);
    expect(result.failed).toBe(true);
    // No per-box key proof is ever asked — the only /api/v1/proof call is for
    // the identity record. The ranges are still read, since they are not keyed
    // on the entry's id.
    const keyCalls = n.calls.filter((c) => c.startsWith('/api/v1/proof/'));
    const recordHex = Buffer.from(RECORD_KEY_BYTES).toString('hex');
    expect(keyCalls).toEqual([`/api/v1/proof/${recordHex}?atHeight=${SUFFIX_H}`]);
  });
});

describe('proveFigures — a listing height that is not a block height values nothing and fails the run', () => {
  it.each([
    ['infinite, as JSON 1e400 parses', Infinity],
    ['a string', String(TIP_H)],
    ['a fraction', TIP_H + 0.5],
    ['negative', -1],
  ])('a listing height that is %s leaves effective null and fails the run, never a throw', async (_shape, height) => {
    const n = node();
    const result = await prove(listingOf([{ boxId: KARMA.id!, value: '100' }], height), n.fetch);
    expect(result.boxes[0]!.status).toBe('proven');
    expect(result.karma.proven).toBe(100n);
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(true);
  });
});

