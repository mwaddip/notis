import { describe, it, expect } from 'vitest';
import { proveName } from '../src/names.js';
import type { NameClaim, NameResult } from '../src/names.js';
import type { HttpFetch } from '../src/http.js';
import {
  buildAvlWithInsertions,
  boxInsertion,
  avlProofJson,
  hexToBytes,
  jsonResponse,
  makeAnchor,
} from './helpers.js';
import { computeCandidateBoxId } from '@dagsocial/types';
import type { AnyBoxCandidate, TxId } from '@dagsocial/types';

// WEB_INTERFACE → The extension → "The verified names" — every test runs a
// check against a node stubbed here and trees built here; no test talks to a
// real node.

const BOB = 'bb'.repeat(32);
const EVE = 'ee'.repeat(32);
const TXID = 'cd'.repeat(32) as TxId;
const SUFFIX_H = 100;
const TIP_H = 119;

function usernameBox(ownerHex: string, name: string, createdAtBlock = 5): AnyBoxCandidate {
  return {
    boxType: 'username',
    value: 0n,
    createdAtBlock,
    owner: hexToBytes(ownerHex),
    name: new TextEncoder().encode(name),
  };
}

// The tree holds more names than a chain would let it — each test's answer
// points at the one box the test is about.
const BOB_NAME = usernameBox(BOB, 'Bob');
const BOB_LOWER = usernameBox(BOB, 'bob');
const BOB_OTHER = usernameBox(BOB, 'Robert');
const EVE_BOB = usernameBox(EVE, 'Bob');
const EVE_OWN = usernameBox(EVE, 'eve');
const BOB_KARMA: AnyBoxCandidate = { boxType: 'karma', value: 50n, createdAtBlock: 5, owner: hexToBytes(BOB) };
const BOB_YOUNG = usernameBox(BOB, 'Bob', 110);

const BOB_NAME_ID = computeCandidateBoxId(BOB_NAME, TXID, 0);
const BOB_LOWER_ID = computeCandidateBoxId(BOB_LOWER, TXID, 1);
const BOB_OTHER_ID = computeCandidateBoxId(BOB_OTHER, TXID, 2);
const EVE_BOB_ID = computeCandidateBoxId(EVE_BOB, TXID, 3);
const EVE_OWN_ID = computeCandidateBoxId(EVE_OWN, TXID, 4);
const BOB_KARMA_ID = computeCandidateBoxId(BOB_KARMA, TXID, 5);
const BOB_YOUNG_ID = computeCandidateBoxId(BOB_YOUNG, TXID, 6);
// A key the tree does not hold — excluded at both heights.
const GONE_ID = 'ab'.repeat(32);

const HELD = [
  boxInsertion(BOB_NAME, TXID, 0),
  boxInsertion(BOB_LOWER, TXID, 1),
  boxInsertion(BOB_OTHER, TXID, 2),
  boxInsertion(EVE_BOB, TXID, 3),
  boxInsertion(EVE_OWN, TXID, 4),
  boxInsertion(BOB_KARMA, TXID, 5),
];
// suffixHead's state; the tip's adds BOB_YOUNG.
const SUFFIX = buildAvlWithInsertions(HELD, [BOB_YOUNG_ID, GONE_ID]);
const TIP = buildAvlWithInsertions([...HELD, boxInsertion(BOB_YOUNG, TXID, 6)], [GONE_ID]);
const ANCHOR = makeAnchor(TIP_H, TIP.digest, SUFFIX_H, SUFFIX.digest);

// The two /usernames routes' answer (NODE_INTERFACE → Usernames).
function answer(name: string, owner: string, boxId: string): unknown {
  return { name, owner, boxId, claimedAtBlock: 5 };
}

interface Routes {
  // owner hex → the /usernames?owner= answer; absent → 404
  byOwner?: Record<string, unknown>;
  // canonical name → the /usernames/:name answer; absent → 404
  byName?: Record<string, unknown>;
  lookup?: () => Response | undefined;
  proof?: (key: string, atHeight: number) => Response | undefined;
  blocksCurrent?: () => Response;
}

// A node over SUFFIX and TIP, each height's proofs from its own tree; each
// request's path and query is logged in order.
function node(routes: Routes = {}): { fetch: HttpFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: HttpFetch = async (url: string) => {
    const u = new URL(url);
    calls.push(`${u.pathname}${u.search}`);
    if (u.pathname === '/usernames' || u.pathname.startsWith('/usernames/')) {
      const override = routes.lookup?.();
      if (override) return override;
      if (u.pathname === '/usernames') {
        const found = routes.byOwner?.[u.searchParams.get('owner') ?? ''];
        return found === undefined ? jsonResponse(404, { error: 'Identity holds no name' }) : jsonResponse(200, found);
      }
      let typed = decodeURIComponent(u.pathname.slice('/usernames/'.length));
      if (typed.startsWith('@')) typed = typed.slice(1);
      const found = routes.byName?.[typed.toLowerCase()];
      return found === undefined ? jsonResponse(404, { error: 'Name not held' }) : jsonResponse(200, found);
    }
    const proofMatch = u.pathname.match(/^\/api\/v1\/proof\/(.+)$/);
    if (proofMatch) {
      const key = proofMatch[1]!;
      const at = Number(u.searchParams.get('atHeight'));
      const override = routes.proof?.(key, at);
      if (override) return override;
      const tree = at === SUFFIX_H ? SUFFIX : TIP;
      const entry = tree.entries.get(key);
      if (!entry) return jsonResponse(404, { error: 'height not available' });
      return jsonResponse(200, avlProofJson(key, at, tree.digest, entry.proof, entry.value === null ? null : 'box', null));
    }
    if (u.pathname === '/blocks/current') {
      return routes.blocksCurrent?.() ?? jsonResponse(200, { height: TIP_H, hash: null });
    }
    return jsonResponse(404, { error: 'not found' });
  };
  return { fetch, calls };
}

function check(claim: NameClaim, fetch: HttpFetch): Promise<NameResult> {
  return proveName('http://a', claim, ANCHOR, fetch);
}

const LABEL: NameClaim = { key: BOB, name: 'Bob' };
const ownerLookup = (key: string) => `/usernames?owner=${key}`;
const proofAt = (id: string, height: number) => `/api/v1/proof/${id}?atHeight=${height}`;

// A response whose status line arrived and whose body did not.
function cutOff(): Response {
  return {
    ok: true,
    status: 200,
    text: async () => { throw new TypeError('terminated'); },
  } as unknown as Response;
}

describe('proveName — a label: this key carries this name', () => {
  it('proven — the box at suffixHead, its owner the key and its name the label\'s byte for byte', async () => {
    const { fetch } = node({ byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) } });
    expect(await check(LABEL, fetch)).toEqual({
      status: 'proven', owner: BOB, name: 'Bob', boxId: BOB_NAME_ID, heightAfter: null,
      verdict: `proven at suffixHead (height ${SUFFIX_H})`,
    });
  });

  it('young — excluded at suffixHead, included at tip, every check holding', async () => {
    const { fetch } = node({ byOwner: { [BOB]: answer('Bob', BOB, BOB_YOUNG_ID) } });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('young');
    expect(result.owner).toBe(BOB);
    expect(result.name).toBe('Bob');
    expect(result.verdict).toBe(`young — proven at tip (height ${TIP_H}), excluded at suffixHead`);
  });

  it('absent — excluded at both and heightAfter equal to the tip: the node points at a box the chain does not hold', async () => {
    const { fetch } = node({ byOwner: { [BOB]: answer('Bob', BOB, GONE_ID) } });
    const result = await check(LABEL, fetch);
    expect(result).toEqual({
      status: 'absent', owner: null, name: null, boxId: GONE_ID, heightAfter: TIP_H,
      verdict: `absent — the node points at a box the chain does not hold at height ${TIP_H}`,
    });
  });

  it.each([
    ['a block landed since', () => jsonResponse(200, { height: TIP_H + 1, hash: null }), TIP_H + 1],
    ['/blocks/current failed', () => jsonResponse(503, { error: 'unavailable' }), null],
    ['the node\'s height fell', () => jsonResponse(200, { height: TIP_H - 3, hash: null }), TIP_H - 3],
  ])('unchecked — excluded at both, %s', async (_why, blocksCurrent, heightAfter) => {
    const { fetch } = node({ byOwner: { [BOB]: answer('Bob', BOB, GONE_ID) }, blocksCurrent });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('unchecked');
    expect(result.heightAfter).toBe(heightAfter);
    expect(result.owner).toBeNull();
  });

  it('none — the owner read answered 404', async () => {
    const { fetch, calls } = node();
    expect(await check(LABEL, fetch)).toEqual({
      status: 'none', owner: null, name: null, boxId: null, heightAfter: null,
      verdict: 'none — the node answers that this key holds no name',
    });
    expect(calls).toEqual([ownerLookup(BOB)]);
  });

  it('no-proof — the owner read answered 500', async () => {
    const { fetch } = node({ lookup: () => jsonResponse(500, { error: 'internal' }) });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('no-proof');
    expect(result.boxId).toBeNull();
    expect(result.verdict).toContain('HTTP 500');
  });

  it('no-proof — the owner read unreachable', async () => {
    const { fetch: honest } = node({ byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) } });
    const fetch: HttpFetch = async (url, init) => {
      if (new URL(url).pathname === '/usernames') throw new TypeError('fetch failed');
      return honest(url, init);
    };
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('no-proof');
    expect(result.verdict).toBe('no answer to the lookup: transport failure: fetch failed');
  });

  it('no-proof — a 404 on the box\'s proof', async () => {
    const { fetch } = node({
      byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) },
      proof: () => jsonResponse(404, { error: 'height not available' }),
    });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('no-proof');
    expect(result.boxId).toBe(BOB_NAME_ID);
    expect(result.verdict).toContain('no proof at suffixHead: HTTP 404');
  });

  it.each([
    ['another key\'s real username box (the owner)', EVE_BOB_ID, `candidate owner '${EVE}' does not match the label's key '${BOB}'`],
    ['the right owner with the name in another case (Bob shown, bob committed)', BOB_LOWER_ID, "candidate name 'bob' does not match the label's name 'Bob'"],
    ['the right owner with another name', BOB_OTHER_ID, "candidate name 'Robert' does not match the label's name 'Bob'"],
    ['a karma box named by the answer (the type)', BOB_KARMA_ID, "candidate boxType 'karma' is not username"],
  ])('unproven — %s', async (_lie, boxId, refusal) => {
    const { fetch } = node({ byOwner: { [BOB]: answer('Bob', BOB, boxId) } });
    expect(await check(LABEL, fetch)).toEqual({
      status: 'unproven', owner: null, name: null, boxId, heightAfter: null,
      verdict: `unproven at suffixHead: ${refusal}`,
    });
  });

  it('unproven — a stateRoot other than the header\'s', async () => {
    const entry = SUFFIX.entries.get(BOB_NAME_ID)!;
    const { fetch } = node({
      byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) },
      proof: (key, at) => jsonResponse(200, avlProofJson(key, at, '01'.repeat(33), entry.proof, 'box', null)),
    });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('unproven');
    expect(result.verdict).toBe('unproven at suffixHead: stateRoot mismatch');
  });

  it('unproven — a tampered proof', async () => {
    const tampered = Uint8Array.from(SUFFIX.entries.get(BOB_NAME_ID)!.proof);
    tampered[2] = (tampered[2] ?? 0) ^ 0xff;
    const { fetch } = node({
      byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) },
      proof: (key, at) => jsonResponse(200, avlProofJson(key, at, SUFFIX.digest, tampered, 'box', null)),
    });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('unproven');
    expect(result.verdict).toBe('unproven at suffixHead: proof rejected');
  });

  it('unproven — kind: \'record\' for the box id', async () => {
    const entry = SUFFIX.entries.get(BOB_NAME_ID)!;
    const { fetch } = node({
      byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) },
      proof: (key, at) => jsonResponse(200, avlProofJson(key, at, SUFFIX.digest, entry.proof, 'record', null)),
    });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('unproven');
    expect(result.verdict).toBe("unproven at suffixHead: node returned kind 'record' for a box id");
  });

  it('unproven — a boxId in the answer that is not 64 hex, no proof asked', async () => {
    const { fetch, calls } = node({ byOwner: { [BOB]: answer('Bob', BOB, 'xyz') } });
    expect(await check(LABEL, fetch)).toEqual({
      status: 'unproven', owner: null, name: null, boxId: null, heightAfter: null,
      verdict: "unproven: the lookup's boxId is not 64 hex: 'xyz'",
    });
    expect(calls).toEqual([ownerLookup(BOB)]);
  });

  it('a boxId answered in uppercase hex is the same box — ids compare lowercased', async () => {
    const { fetch, calls } = node({ byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID.toUpperCase()) } });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('proven');
    expect(result.boxId).toBe(BOB_NAME_ID);
    expect(calls[1]).toBe(proofAt(BOB_NAME_ID, SUFFIX_H));
  });

  it('a label key in uppercase hex is the same key — asked and compared lowercased', async () => {
    const { fetch, calls } = node({ byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) } });
    const result = await check({ key: BOB.toUpperCase(), name: 'Bob' }, fetch);
    expect(result.status).toBe('proven');
    expect(result.owner).toBe(BOB);
    expect(calls[0]).toBe(ownerLookup(BOB));
  });

  it.each([
    ['a key that is not 64 hex', { key: 'zz', name: 'Bob' }, "the label's key is not 64 hex: 'zz'"],
    ['a key carrying a lone surrogate', { key: `\ud800${'b'.repeat(63)}`, name: 'Bob' }, "the label's key is not 64 hex:"],
    ['a name that is not a well-formed name', { key: BOB, name: 'B@b' }, "the label's name is not a well-formed name: 'B@b'"],
    ['a name longer than a name can be', { key: BOB, name: 'B'.repeat(25) }, "the label's name is not a well-formed name:"],
    ['a name that is not a string', { key: BOB, name: 7 as unknown as string }, "the label's name is not a well-formed name: a number"],
  ])('unproven — a label with %s asks the node nothing', async (_shape, claim, verdict) => {
    const { fetch, calls } = node({ byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) } });
    const result = await check(claim, fetch);
    expect(result.status).toBe('unproven');
    expect(result.boxId).toBeNull();
    expect(result.verdict).toContain(`unproven: ${verdict}`);
    expect(calls).toEqual([]);
  });
});

describe('proveName — a typed handle: who holds this name', () => {
  it('proven — the typed name in another case than the committed one; the result carries the committed name', async () => {
    const { fetch, calls } = node({ byName: { bob: answer('Bob', BOB, BOB_NAME_ID) } });
    expect(await check({ name: 'BOB' }, fetch)).toEqual({
      status: 'proven', owner: BOB, name: 'Bob', boxId: BOB_NAME_ID, heightAfter: null,
      verdict: `proven at suffixHead (height ${SUFFIX_H})`,
    });
    expect(calls[0]).toBe('/usernames/BOB');
  });

  it('unproven — the answer\'s owner is not the box\'s owner: the lie that steals', async () => {
    const { fetch } = node({ byName: { bob: answer('Bob', EVE, BOB_NAME_ID) } });
    expect(await check({ name: 'bob' }, fetch)).toEqual({
      status: 'unproven', owner: null, name: null, boxId: BOB_NAME_ID, heightAfter: null,
      verdict: `unproven at suffixHead: candidate owner '${BOB}' does not match the lookup's owner '${EVE}'`,
    });
  });

  it('unproven — the answer\'s owner and box agree, but the box carries another name', async () => {
    const { fetch } = node({ byName: { bob: answer('Bob', EVE, EVE_OWN_ID) } });
    const result = await check({ name: 'bob' }, fetch);
    expect(result.status).toBe('unproven');
    expect(result.owner).toBeNull();
    expect(result.verdict).toBe("unproven at suffixHead: candidate name 'eve' is not the typed name 'bob'");
  });

  it('the answer\'s own name is never read — the result carries the proven one', async () => {
    const { fetch } = node({ byName: { bob: answer('Mallory', BOB, BOB_NAME_ID) } });
    const result = await check({ name: 'bob' }, fetch);
    expect(result.status).toBe('proven');
    expect(result.name).toBe('Bob');
  });

  it('none — the name\'s 404', async () => {
    const { fetch, calls } = node();
    expect(await check({ name: 'bob' }, fetch)).toEqual({
      status: 'none', owner: null, name: null, boxId: null, heightAfter: null,
      verdict: "none — the node answers that no one holds 'bob'",
    });
    expect(calls).toEqual(['/usernames/bob']);
  });

  it.each([
    ['a character no name can hold', 'b@d', "none — no one holds 'b@d': it is not a well-formed name"],
    ['nothing', '', "none — no one holds '': it is not a well-formed name"],
    ['more bytes than a name can be', 'b'.repeat(25), `none — no one holds '${'b'.repeat(25)}': it is not a well-formed name`],
    ['a lone surrogate', '\ud800', "none — no one holds '\ud800': it is not a well-formed name"],
    ['a name that is not a string', 7 as unknown as string, 'none — no one holds a number: it is not a well-formed name'],
  ])('none — a typed handle that is %s asks the node nothing', async (_shape, name, verdict) => {
    const { fetch, calls } = node({ byName: { bob: answer('Bob', BOB, BOB_NAME_ID) } });
    const result = await check({ name }, fetch);
    expect(result).toEqual({ status: 'none', owner: null, name: null, boxId: null, heightAfter: null, verdict });
    expect(calls).toEqual([]);
  });
});

describe('proveName — the order is the rule', () => {
  it('the lookup, then suffixHead, then tip, then /blocks/current', async () => {
    const { fetch, calls } = node({ byOwner: { [BOB]: answer('Bob', BOB, GONE_ID) } });
    await check(LABEL, fetch);
    expect(calls).toEqual([
      ownerLookup(BOB),
      proofAt(GONE_ID, SUFFIX_H),
      proofAt(GONE_ID, TIP_H),
      '/blocks/current',
    ]);
  });

  it.each([
    ['proven', BOB_NAME_ID, undefined, [ownerLookup(BOB), proofAt(BOB_NAME_ID, SUFFIX_H)]],
    ['young', BOB_YOUNG_ID, undefined, [ownerLookup(BOB), proofAt(BOB_YOUNG_ID, SUFFIX_H), proofAt(BOB_YOUNG_ID, TIP_H)]],
    ['unproven at suffixHead', BOB_OTHER_ID, undefined, [ownerLookup(BOB), proofAt(BOB_OTHER_ID, SUFFIX_H)]],
    [
      'no-proof at tip',
      BOB_YOUNG_ID,
      (_key: string, at: number) => (at === TIP_H ? jsonResponse(404, { error: 'height not available' }) : undefined),
      [ownerLookup(BOB), proofAt(BOB_YOUNG_ID, SUFFIX_H), proofAt(BOB_YOUNG_ID, TIP_H)],
    ],
  ])('/blocks/current is not read when the check ends %s', async (_status, boxId, proof, expected) => {
    const { fetch, calls } = node({ byOwner: { [BOB]: answer('Bob', BOB, boxId) }, proof });
    await check(LABEL, fetch);
    expect(calls).toEqual(expected);
  });
});

describe('proveName — a check is total: an answer of any shape ends in a status', () => {
  it.each([
    ['a body that is null', null, "unproven: the lookup's boxId is not 64 hex: missing"],
    ['a body that is not an object', 'Bob', "unproven: the lookup's boxId is not 64 hex: missing"],
    ['a boxId that is not a string', { name: 'Bob', owner: BOB, boxId: 7 }, "unproven: the lookup's boxId is not 64 hex: a number"],
    ['a boxId that refuses conversion to a string', { name: 'Bob', owner: BOB, boxId: { toString: 1 } }, "unproven: the lookup's boxId is not 64 hex: an object"],
  ])('a lookup answer with %s is unproven, no proof asked', async (_shape, body, verdict) => {
    const { fetch, calls } = node({ lookup: () => jsonResponse(200, body) });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('unproven');
    expect(result.verdict).toBe(verdict);
    expect(calls).toEqual([ownerLookup(BOB)]);
  });

  it.each([
    ['no owner', { name: 'Bob', boxId: BOB_NAME_ID }, 'missing'],
    ['an owner that is not a string', { name: 'Bob', owner: 7, boxId: BOB_NAME_ID }, 'a number'],
    ['an owner that refuses conversion to a string', { name: 'Bob', owner: { toString: 1 }, boxId: BOB_NAME_ID }, 'an object'],
  ])('a typed handle\'s answer with %s is unproven, never a throw', async (_shape, body, owner) => {
    const { fetch } = node({ byName: { bob: body } });
    const result = await check({ name: 'bob' }, fetch);
    expect(result.status).toBe('unproven');
    expect(result.verdict).toBe(`unproven at suffixHead: candidate owner '${BOB}' does not match the lookup's owner ${owner}`);
  });

  it('a lookup answer cut off in flight is no-proof', async () => {
    const { fetch } = node({ lookup: () => cutOff() });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('no-proof');
    expect(result.verdict).toBe('no answer to the lookup: transport failure: terminated');
  });

  it.each([
    ['a body that is null', null, 'stateRoot mismatch'],
    ['a `proof` that is not a string', { stateRoot: SUFFIX.digest, kind: 'box', proof: 123 }, 'proof rejected'],
    ['no `proof`', { stateRoot: SUFFIX.digest, kind: 'box' }, 'proof rejected'],
    ['a `kind` that refuses conversion to a string', { stateRoot: SUFFIX.digest, kind: { toString: 1 }, proof: '' }, 'node returned kind an object for a box id'],
  ])('a proof answer with %s is unproven', async (_shape, body, verdict) => {
    const { fetch } = node({ byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) }, proof: () => jsonResponse(200, body) });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('unproven');
    expect(result.verdict).toBe(`unproven at suffixHead: ${verdict}`);
  });

  it('a proof answer cut off in flight is no-proof', async () => {
    const { fetch } = node({ byOwner: { [BOB]: answer('Bob', BOB, BOB_NAME_ID) }, proof: () => cutOff() });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('no-proof');
    expect(result.verdict).toBe('no proof at suffixHead: transport failure: terminated');
  });

  it.each([
    ['a body that is null', null],
    ['a body that is not an object', 'tip'],
    ['no `height`', { hash: null }],
    ['a `height` that is a string', { height: String(TIP_H), hash: null }],
    ['a `height` that is not an integer', { height: TIP_H + 0.5, hash: null }],
    ['a `height` that is negative', { height: -1, hash: null }],
  ])('/blocks/current answering %s leaves heightAfter unread — unchecked', async (_shape, body) => {
    const { fetch } = node({ byOwner: { [BOB]: answer('Bob', BOB, GONE_ID) }, blocksCurrent: () => jsonResponse(200, body) });
    const result = await check(LABEL, fetch);
    expect(result.status).toBe('unchecked');
    expect(result.heightAfter).toBeNull();
    expect(result.verdict).toBe('unchecked — /blocks/current unavailable');
  });
});
