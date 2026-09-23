import { describe, it, expect } from 'vitest';
import { capped, fetchJson } from '../src/http.js';
import { resolveTip } from '../src/tip.js';
import { fetchListing, proveFigures } from '../src/boxes.js';
import type { Listing } from '../src/boxes.js';
import { proveName } from '../src/names.js';
import type { NameClaim } from '../src/names.js';
import { textLines } from '../src/text.js';
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
  buildMinedChain,
  clockAfterChain,
  proofHexForChain,
  suffixHeadForChain,
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

// A verdict shows every C0 control, DEL and C1 control a node string carries
// as its \u escape, never raw, and the cap counts the text as shown.

const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// ESC [2K erases the line, CR returns to its start, and CSI is ESC [ as one C1.
const ERASING = '\u001b[2K\rproven at suffixHead\u009b0m';
const ERASING_SHOWN = '\\u001b[2K\\u000dproven at suffixHead\\u009b0m';

describe("capped — a node's control characters as their escapes, never raw", () => {
  it.each([
    ['NUL', '\u0000', '\\u0000'],
    ['TAB', '\t', '\\u0009'],
    ['LF', '\n', '\\u000a'],
    ['CR', '\r', '\\u000d'],
    ['ESC', '\u001b', '\\u001b'],
    ['US, the last C0', '\u001f', '\\u001f'],
    ['DEL', '\u007f', '\\u007f'],
    ['PAD, the first C1', '\u0080', '\\u0080'],
    ['CSI', '\u009b', '\\u009b'],
    ['APC, the last C1', '\u009f', '\\u009f'],
  ])('%s is shown as its escape', (_name, raw, escape) => {
    expect(capped(`a${raw}b`)).toBe(`a${escape}b`);
  });

  it('the characters beside the three ranges are shown as they are', () => {
    expect(capped(' ~\u00a0')).toBe(' ~\u00a0');
  });

  it('a 120-character body of escapes — the text as shown is capped', () => {
    expect(capped('\u001b'.repeat(120))).toBe(`${'\\u001b'.repeat(20)}…`);
  });

  it('an escape across the cut is left out whole, never split', () => {
    expect(capped(`${'Z'.repeat(117)}\u001bZ`)).toBe(`${'Z'.repeat(117)}…`);
  });

  it('an escape ending at the cut is kept whole', () => {
    expect(capped(`${'Z'.repeat(114)}\u001bZ`)).toBe(`${'Z'.repeat(114)}\\u001b…`);
  });
});

describe('a proof route answering 500 with a body carrying ESC [2K, CR and a C1 CSI', () => {
  it('the box verdict holds them as escapes, and no raw control', async () => {
    const result = await prove(
      [{ boxId: BOX_ID, value: '100' }],
      node((key) => (key === BOX_ID ? textResponse(500, ERASING) : undefined)),
    );
    const verdict = result.boxes[0]!.verdict;
    expect(verdict).toBe(`no proof at suffixHead: HTTP 500: ${ERASING_SHOWN}`);
    expect(verdict).not.toMatch(RAW_CONTROL);
  });

  it("the nipopow route's refusal holds them as escapes, and no raw control", async () => {
    const fetch: HttpFetch = async () => textResponse(500, ERASING);
    const result = await resolveTip(['http://a'], 6, 6, devnetProfile(), () => 0, fetch);
    expect(result.nodes[0]!.refuseCode).toBe('http');
    expect(result.nodes[0]!.refuseReason).toBe(`HTTP 500: ${ERASING_SHOWN}`);
    expect(result.nodes[0]!.refuseReason).not.toMatch(RAW_CONTROL);
  });

  it('a plain body is named unchanged', async () => {
    const plain = 'Internal Server Error — naïve 😀';
    const result = await prove(
      [{ boxId: BOX_ID, value: '100' }],
      node((key) => (key === BOX_ID ? textResponse(500, plain) : undefined)),
    );
    expect(result.boxes[0]!.verdict).toBe(`no proof at suffixHead: HTTP 500: ${plain}`);
  });
});

describe('proveName — a proven username box whose name carries ESC [2K and CR', () => {
  // The codec bounds a name's length and checks none of its bytes
  // (TYPES_INTERFACE → Content limits), so a state the tool accepts without
  // validating can commit a name consensus refuses; this test's tree does.
  const HOSTILE_NAME: AnyBoxCandidate = {
    boxType: 'username',
    value: 0n,
    createdAtBlock: 5,
    owner: USER_BYTES,
    name: new TextEncoder().encode('Bob\u001b[2K\r'),
  };
  const HOSTILE_NAME_ID = computeCandidateBoxId(HOSTILE_NAME, TXID, 1);
  const TREE = buildAvlWithInsertions([boxInsertion(HOSTILE_NAME, TXID, 1)]);
  const TREE_ANCHOR = makeAnchor(TIP_H, TREE.digest, SUFFIX_H, TREE.digest);

  // Both lookups name the box; the proof route proves it from TREE.
  const fetch: HttpFetch = async (url: string) => {
    const u = new URL(url);
    if (u.pathname === '/usernames' || u.pathname === '/usernames/Bob') {
      return jsonResponse(200, { name: 'Bob', owner: USER_HEX, boxId: HOSTILE_NAME_ID, claimedAtBlock: 5 });
    }
    const entry = TREE.entries.get(u.pathname.slice('/api/v1/proof/'.length));
    if (!entry) return jsonResponse(404, { error: 'not found' });
    const at = Number(u.searchParams.get('atHeight'));
    return jsonResponse(200, avlProofJson(HOSTILE_NAME_ID, at, TREE.digest, entry.proof, 'box', null));
  };

  const CLAIMS: [string, NameClaim, string][] = [
    ['a label', { key: USER_HEX, name: 'Bob' }, "does not match the label's name 'Bob'"],
    ['a typed handle', { name: 'Bob' }, "is not the typed name 'Bob'"],
  ];

  it.each(CLAIMS)('%s — the refusal names it with its escapes, never raw', async (_kind, claim, tail) => {
    const result = await proveName('http://a', claim, TREE_ANCHOR, fetch);
    expect(result.status).toBe('unproven');
    expect(result.verdict).toBe(`unproven at suffixHead: candidate name 'Bob\\u001b[2K\\u000d' ${tail}`);
    expect(result.verdict).not.toMatch(RAW_CONTROL);
    expect(result.name).toBeNull();
  });
});

describe("textLines — the command line's text of a node that sends a newline, ESC and CR", () => {
  it('its refusal, its listed boxId and its record verdict are one line each, the escapes shown', async () => {
    const M = 6;
    const K = 6;
    const chain = buildMinedChain({ count: M + K + 10, stateRoot: AVL.digest });
    const proofHex = proofHexForChain(chain, M, K);
    const height = chain.headers.length;
    const hostile = 'x\ny\u001b[2Kz\r';
    const shown = 'x\\u000ay\\u001b[2Kz\\u000d';

    // Node a serves the chain and the listing; node b answers every request 500.
    const fetch: HttpFetch = async (url: string) => {
      const u = new URL(url);
      if (u.host !== 'a') return textResponse(500, hostile);
      if (u.pathname === `/nipopow/proof/${M}/${K}`) return jsonResponse(200, { proof: proofHex });
      if (u.pathname === `/karma/${USER_HEX}`) {
        return jsonResponse(200, { boxes: [{ boxId: hostile, value: '5' }], next: null, height, effective: '5' });
      }
      if (u.pathname === `/api/v1/proof/${RECORD_KEY}`) return textResponse(500, hostile);
      if (u.pathname === '/blocks/current') return jsonResponse(200, { height, hash: null });
      return jsonResponse(404, { error: 'not found' });
    };

    // The command line's composition: the tip, then the listing, then the run.
    const tip = await resolveTip(['http://a', 'http://b'], M, K, devnetProfile(), clockAfterChain(chain), fetch);
    const listed = await fetchListing('http://a', USER_HEX, fetch);
    if (!listed.ok) throw new Error(listed.reason);
    const anchor = { tip: tip.tip!, suffixHead: tip.suffixHead! };
    const figures = await proveFigures('http://a', USER_HEX, listed.listing, anchor, devnetProfile(), fetch);

    const lines = textLines(tip, { figures, listing: listed.listing });
    expect(lines).toEqual([
      `tip: height ${height}`,
      `suffixHead: height ${suffixHeadForChain(chain, M, K).header.height}, stateRoot ${AVL.digest}`,
      '  http://a: verified (best)',
      `  http://b: refused — HTTP 500: ${shown}`,
      '',
      `  karma ${shown}: unproven: the listed boxId is not 64 hex: '${shown}'`,
      'karma total (face value at suffixHead): 0',
      'credit total (face value at suffixHead): 0',
      `identity record: no-proof — HTTP 500: ${shown}`,
      `heightAfter: ${height}`,
    ]);
    for (const line of lines) expect(line).not.toMatch(RAW_CONTROL);
  });
});
