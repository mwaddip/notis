import { describe, it, expect } from 'vitest';
import { proveFigures, fetchListing, proveBoxes } from '../src/boxes.js';
import type { Listing } from '../src/boxes.js';
import {
  buildAvlWithInsertions,
  boxInsertion,
  recordInsertion,
  hexToBytes,
  jsonResponse,
  makeAnchor,
  devnetProfile,
} from './helpers.js';
import {
  computeCandidateBoxId,
  identityRecordKey,
} from '@dagsocial/types';
import type {
  AnyBoxCandidate,
  IdentityRecord,
  TxId,
  UserId,
} from '@dagsocial/types';
import type { HttpFetch } from '../src/http.js';

// The user hex we prove against. The candidate's `owner` is these same 32
// bytes, so the tool's owner check accepts the box (WEB_INTERFACE → The
// extension → "The verified figures").
const USER_HEX = 'ab'.repeat(32);
const USER_BYTES = hexToBytes(USER_HEX) as UserId;
const RECORD_KEY = identityRecordKey(USER_BYTES);

const FAKE_TXID = 'cd'.repeat(32) as TxId;

// Two heights used across the tests. `heightAfter === TIP_H` for `absent`;
// `TIP_H + 1` for `unchecked (a block landed since)`.
const SUFFIX_H = 100;
const TIP_H = 119;

function karmaCandidate(value: bigint, owner: Uint8Array = USER_BYTES): AnyBoxCandidate {
  return {
    boxType: 'karma' as const,
    value,
    createdAtBlock: 1,
    owner,
  };
}

function creditCandidate(value: bigint, owner: Uint8Array = USER_BYTES, lockedUntilBlock?: number): AnyBoxCandidate {
  return {
    boxType: 'credit' as const,
    value,
    createdAtBlock: 1,
    owner,
    lockedUntilBlock,
  };
}

const NEVER_ACTIVE_RECORD: IdentityRecord = {
  lastActivityBlock: 0,
  lastDecayBlock: 0,
  invitedAtBlock: 0,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 0,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
};

// A stub that dispatches by URL path, returning a JSON response. Anything not
// covered is a 404.
type PathStub = (path: string, query: URLSearchParams) => Response | undefined;
function makeFetch(stub: PathStub): HttpFetch {
  return async (url: string): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname;
    const res = stub(path, u.searchParams);
    if (res) return res;
    return jsonResponse(404, { error: 'not found' });
  };
}

// A one-page karma reply — the shape the /karma/:userId route serves.
function karmaPage(
  boxes: { boxId: string; value: string | number }[],
  opts: { height?: number; effective?: string; next?: string | null } = {},
): unknown {
  return {
    userId: USER_HEX,
    total: '0',
    effective: opts.effective ?? '0',
    boxes: boxes.map(b => ({ boxId: b.boxId, value: String(b.value) })),
    next: opts.next ?? null,
    height: opts.height ?? SUFFIX_H,
  };
}

function creditPage(
  boxes: { boxId: string; value: string | number; lockedUntilBlock?: number }[],
  opts: { next?: string | null } = {},
): unknown {
  return {
    userId: USER_HEX,
    total: '0',
    boxes: boxes.map(b => ({
      boxId: b.boxId,
      value: String(b.value),
      ...(b.lockedUntilBlock !== undefined ? { lockedUntilBlock: b.lockedUntilBlock } : {}),
    })),
    next: opts.next ?? null,
  };
}

// The record's clocks read back from the proof — a stale, no-activity clock so
// `effectiveKarma` short-circuits to the face total for records the tests use.
const RECORD_STANDING: IdentityRecord = {
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

describe('proveFigures — every status once, titled by its rule', () => {
  it('a listed karma box the chain holds — proven', async () => {
    const cand = karmaCandidate(100n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        const e = avl.entries.get(boxId)!;
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '100' }], height: SUFFIX_H, effective: '100' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.failed).toBe(false);
    expect(result.boxes.length).toBe(1);
    expect(result.boxes[0]!.status).toBe('proven');
    expect(result.boxes[0]!.value).toBe(100n);
    expect(result.karma.proven).toBe(100n);
    expect(result.record.status).toBe('proven');
    expect(result.heightAfter).toBe(TIP_H);
  });

  it('young — excluded at suffixHead, included at tip', async () => {
    const cand = karmaCandidate(25n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);

    // Suffix AVL: no box, has record (records always exist for the tests).
    // Tip AVL: box present.
    const suffixAvl = buildAvlWithInsertions(
      [recordInsertion(USER_BYTES, RECORD_STANDING)],
      [boxId],
    );
    const tipAvl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, tipAvl.digest, SUFFIX_H, suffixAvl.digest);

    const httpFetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${boxId}`) {
        if (at === SUFFIX_H) {
          const e = suffixAvl.entries.get(boxId)!;
          return jsonResponse(200, {
            boxId, atHeight: at, stateRoot: suffixAvl.digest,
            proof: Buffer.from(e.proof).toString('base64'),
            kind: null, value: null,
          });
        }
        if (at === TIP_H) {
          const e = tipAvl.entries.get(boxId)!;
          return jsonResponse(200, {
            boxId, atHeight: at, stateRoot: tipAvl.digest,
            proof: Buffer.from(e.proof).toString('base64'),
            kind: 'box', value: null,
          });
        }
      }
      if (path === `/api/v1/proof/${RECORD_KEY}` && at === SUFFIX_H) {
        const e = suffixAvl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '25' }], height: TIP_H, effective: '25' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.failed).toBe(false);
    expect(result.boxes[0]!.status).toBe('young');
    expect(result.boxes[0]!.value).toBe(25n);
    expect(result.karma.proven).toBe(0n);
    expect(result.karma.young).toBe(25n);
  });

  it('absent — excluded at both heights and heightAfter === tip.height', async () => {
    const absentKey = 'bb'.repeat(32);
    const suffixAvl = buildAvlWithInsertions(
      [recordInsertion(USER_BYTES, RECORD_STANDING)],
      [absentKey],
    );
    const tipAvl = buildAvlWithInsertions(
      [recordInsertion(USER_BYTES, RECORD_STANDING)],
      [absentKey],
    );
    const anchor = makeAnchor(TIP_H, tipAvl.digest, SUFFIX_H, suffixAvl.digest);

    const httpFetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${absentKey}`) {
        const src = at === SUFFIX_H ? suffixAvl : tipAvl;
        const e = src.entries.get(absentKey)!;
        return jsonResponse(200, {
          boxId: absentKey, atHeight: at, stateRoot: src.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: null, value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = suffixAvl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId: absentKey, value: '50' }], height: TIP_H, effective: '50' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('absent');
    expect(result.karma.absent).toBe(50n);
    expect(result.karma.proven).toBe(0n);
    expect(result.failed).toBe(true);
  });

  it('unchecked — excluded at both, heightAfter > tip (a block landed since)', async () => {
    const absentKey = 'bc'.repeat(32);
    const suffixAvl = buildAvlWithInsertions(
      [recordInsertion(USER_BYTES, RECORD_STANDING)],
      [absentKey],
    );
    const tipAvl = suffixAvl;
    const anchor = makeAnchor(TIP_H, tipAvl.digest, SUFFIX_H, suffixAvl.digest);

    const httpFetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${absentKey}`) {
        const e = suffixAvl.entries.get(absentKey)!;
        return jsonResponse(200, {
          boxId: absentKey, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: null, value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = suffixAvl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H + 1, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId: absentKey, value: '9' }], height: TIP_H, effective: '9' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unchecked');
    expect(result.karma.unchecked).toBe(9n);
    expect(result.failed).toBe(false);
    expect(result.heightAfter).toBe(TIP_H + 1);
  });

  it('unchecked — excluded at both, /blocks/current fails (undecided reads as unchecked)', async () => {
    const absentKey = 'bd'.repeat(32);
    const suffixAvl = buildAvlWithInsertions(
      [recordInsertion(USER_BYTES, RECORD_STANDING)],
      [absentKey],
    );
    const anchor = makeAnchor(TIP_H, suffixAvl.digest, SUFFIX_H, suffixAvl.digest);

    const httpFetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${absentKey}`) {
        const e = suffixAvl.entries.get(absentKey)!;
        return jsonResponse(200, {
          boxId: absentKey, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: null, value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = suffixAvl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(503, { error: 'service unavailable' });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId: absentKey, value: '4' }], height: TIP_H, effective: '4' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unchecked');
    expect(result.heightAfter).toBeNull();
    expect(result.failed).toBe(false);
  });

  it('unchecked — heightAfter < tip.height (a fallen height, a reorg)', async () => {
    const absentKey = 'be'.repeat(32);
    const suffixAvl = buildAvlWithInsertions(
      [recordInsertion(USER_BYTES, RECORD_STANDING)],
      [absentKey],
    );
    const anchor = makeAnchor(TIP_H, suffixAvl.digest, SUFFIX_H, suffixAvl.digest);

    const httpFetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${absentKey}`) {
        const e = suffixAvl.entries.get(absentKey)!;
        return jsonResponse(200, {
          boxId: absentKey, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: null, value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = suffixAvl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H - 3, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId: absentKey, value: '7' }], height: TIP_H, effective: '7' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unchecked');
    expect(result.heightAfter).toBe(TIP_H - 3);
    expect(result.failed).toBe(false);
  });

  it('unproven — stateRoot mismatch at suffixHead', async () => {
    const cand = karmaCandidate(30n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        const e = avl.entries.get(boxId)!;
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: '01'.repeat(32),
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '30' }], height: TIP_H, effective: '30' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toContain('stateRoot mismatch');
    expect(result.failed).toBe(true);
  });

  it('unproven — a tampered proof (proof rejected)', async () => {
    const cand = karmaCandidate(30n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);
    const entry = avl.entries.get(boxId)!;
    const tampered = Uint8Array.from(entry.proof);
    if (tampered.length > 2) tampered[2] = (tampered[2] ?? 0) ^ 0xff;

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(tampered).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '30' }], height: TIP_H, effective: '30' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toContain('proof rejected');
    expect(result.failed).toBe(true);
  });

  it('unproven — value does not hash to the key', async () => {
    const { boxRecordBytes } = await import('@dagsocial/types');
    const cand = karmaCandidate(50n);
    const fakeKey = 'aa'.repeat(32);
    // A tree with (fakeKey → box-record-bytes-for-`cand`): verifyAvlLookup
    // succeeds, but `computeCandidateBoxId` of the decoded value is `cand`'s
    // real id, not fakeKey.
    const avlReal = buildAvlWithInsertions([
      { keyHex: fakeKey, valueBytes: boxRecordBytes(cand, FAKE_TXID, 0) },
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avlReal.digest, SUFFIX_H, avlReal.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${fakeKey}`) {
        const e = avlReal.entries.get(fakeKey)!;
        return jsonResponse(200, {
          boxId: fakeKey, atHeight: SUFFIX_H, stateRoot: avlReal.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avlReal.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avlReal.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId: fakeKey, value: '50' }], height: TIP_H, effective: '50' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toContain('value does not hash to the key');
    expect(result.failed).toBe(true);
  });

  it('unproven — kind: record for a box id (a finding)', async () => {
    const cand = karmaCandidate(20n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(new Uint8Array(0)).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '20' }], height: TIP_H, effective: '20' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toContain("'record'");
    expect(result.failed).toBe(true);
  });

  it('unproven — kind: network for a box id (a finding)', async () => {
    const cand = karmaCandidate(20n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(new Uint8Array(0)).toString('base64'),
          kind: 'network', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '20' }], height: TIP_H, effective: '20' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toContain("'network'");
    expect(result.failed).toBe(true);
  });

  it("unproven — owner is another key's (a real box, proven present, wrong holder)", async () => {
    // A box whose candidate names a DIFFERENT owner but is listed under our user.
    const otherOwner = new Uint8Array(32).fill(0x33);
    const cand = karmaCandidate(11n, otherOwner);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        const e = avl.entries.get(boxId)!;
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '11' }], height: TIP_H, effective: '11' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toContain('owner');
    expect(result.failed).toBe(true);
  });

  it('unproven — a credit box listed under karma (type mismatch)', async () => {
    const cand = creditCandidate(42n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        const e = avl.entries.get(boxId)!;
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    // Listed under karma, but the candidate is a credit box.
    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '42' }], height: TIP_H, effective: '42' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toContain('boxType');
    expect(result.failed).toBe(true);
  });

  it('no-proof — a 404 at suffixHead is a heads-up, not a failure', async () => {
    const cand = karmaCandidate(50n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([recordInsertion(USER_BYTES, RECORD_STANDING)]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        return jsonResponse(404, { error: 'height not available' });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '50' }], height: TIP_H, effective: '50' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('no-proof');
    expect(result.failed).toBe(false);
  });

  it('no-proof — a 404 at tip for a young box (excluded at suffixHead, no proof at tip)', async () => {
    const cand = karmaCandidate(3n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    // Excluded at suffixHead (exclusion proof against suffix root).
    const suffixAvl = buildAvlWithInsertions(
      [recordInsertion(USER_BYTES, RECORD_STANDING)],
      [boxId],
    );
    const anchor = makeAnchor(TIP_H, suffixAvl.digest, SUFFIX_H, suffixAvl.digest);

    const httpFetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${boxId}`) {
        if (at === SUFFIX_H) {
          const e = suffixAvl.entries.get(boxId)!;
          return jsonResponse(200, {
            boxId, atHeight: at, stateRoot: suffixAvl.digest,
            proof: Buffer.from(e.proof).toString('base64'),
            kind: null, value: null,
          });
        }
        return jsonResponse(404, { error: 'height not available' });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = suffixAvl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '3' }], height: TIP_H, effective: '3' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('no-proof');
    expect(result.failed).toBe(false);
  });
});

// NODE_INTERFACE → AVL+ State Root — the proof blob is base64; the decode
// through `atob` is total, so a lying node's malformed blob is a refused
// proof (unproven, `proof rejected`) at every one of `atob`'s two throwing
// cases, and a well-formed blob still round-trips against the node's own
// `Buffer.from(_, 'base64')` encoding.
describe('proveFigures — the AVL proof blob decode is total', () => {
  it('unproven — a proof blob with a character outside the base64 alphabet', async () => {
    const cand = karmaCandidate(30n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: 'abc$def=',
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '30' }], height: TIP_H, effective: '30' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toContain('proof rejected');
    expect(result.failed).toBe(true);
  });

  it('unproven — a proof blob whose length atob refuses', async () => {
    const cand = karmaCandidate(30n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          // Five characters, all in the base64 alphabet: length mod 4 === 1,
          // the one length `atob` refuses outright.
          proof: 'abcde',
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '30' }], height: TIP_H, effective: '30' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('unproven');
    expect(result.boxes[0]!.verdict).toContain('proof rejected');
    expect(result.failed).toBe(true);
  });

  it('proven — a well-formed blob round-trips against Buffer.from(_, "base64")', async () => {
    const cand = karmaCandidate(30n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        const e = avl.entries.get(boxId)!;
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '30' }], height: TIP_H, effective: '30' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.boxes[0]!.status).toBe('proven');
    expect(result.boxes[0]!.value).toBe(30n);
    expect(result.failed).toBe(false);
  });
});

describe('proveFigures — the identity record', () => {
  it('proven — the clocks read back exactly', async () => {
    const avl = buildAvlWithInsertions([recordInsertion(USER_BYTES, RECORD_STANDING)]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.record.status).toBe('proven');
    if (result.record.status === 'proven') {
      expect(result.record.record).toEqual(RECORD_STANDING);
    }
    expect(result.karma.effective).toBe(0n);
  });

  it('absent — the record exclusion, valued as the null-record path', async () => {
    // A tree with no record — proof at RECORD_KEY is an exclusion.
    const avl = buildAvlWithInsertions([], [RECORD_KEY]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: null, value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.record.status).toBe('absent');
    // effective is effectiveKarma(0, null, height, cfg) — the same call the node makes.
    expect(result.karma.effective).toBe(0n);
  });

  it('unproven — a flipped byte on the record proof leaves effective null', async () => {
    const avl = buildAvlWithInsertions([recordInsertion(USER_BYTES, RECORD_STANDING)]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        const flipped = Uint8Array.from(e.proof);
        if (flipped.length > 2) flipped[2] = (flipped[2] ?? 0) ^ 0xff;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: avl.digest,
          proof: Buffer.from(flipped).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.record.status).toBe('unproven');
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(true);
  });

  it('no-proof — a 404 on the record leaves effective null and does not fail', async () => {
    const anchor = makeAnchor(TIP_H, '00'.repeat(32), SUFFIX_H, '00'.repeat(32));

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        return jsonResponse(404, { error: 'height not available' });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    expect(result.record.status).toBe('no-proof');
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(false);
  });
});

describe('proveFigures — effective karma', () => {
  it('proven face + proven record at listing.height — equal to a direct effectiveKarma call', async () => {
    const { effectiveKarma, decayCfgFor } = await import('@dagsocial/types');
    const cand = karmaCandidate(200n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const listingHeight = 300;
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        const e = avl.entries.get(boxId)!;
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '200' }], height: listingHeight, effective: '200' },
      credits: { boxes: [] },
    };
    const profile = devnetProfile();
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, profile, httpFetch);

    const expected = effectiveKarma(200n, RECORD_STANDING, listingHeight, decayCfgFor(profile));
    expect(result.karma.effective).toBe(expected);
  });

  it('decay applies — a stale record whose valuation is below face', async () => {
    const { effectiveKarma, decayCfgFor, KARMA_DECAY_AMOUNT } = await import('@dagsocial/types');
    const profile = devnetProfile();
    // The profile's own thresholds — height chosen so decay actually applies.
    const listingHeight = profile.karmaStaleThresholdBlocks + 3 * profile.karmaDecayIntervalBlocks + 1;
    const staleRecord: IdentityRecord = {
      ...NEVER_ACTIVE_RECORD,
      lastActivityBlock: 1,
      lastDecayBlock: 1,
    };

    const cand = karmaCandidate(1000n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, staleRecord),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${boxId}`) {
        const e = avl.entries.get(boxId)!;
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '1000' }], height: listingHeight, effective: '999' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, profile, httpFetch);

    const expected = effectiveKarma(1000n, staleRecord, listingHeight, decayCfgFor(profile));
    expect(result.karma.effective).toBe(expected);
    expect(result.karma.effective).toBeLessThan(1000n);
    // Sanity: it moved by decayAmount at least once.
    expect(1000n - result.karma.effective!).toBeGreaterThanOrEqual(KARMA_DECAY_AMOUNT);
  });
});

describe('the run order is the rule', () => {
  it('suffixHead proofs → record → tip proofs → /blocks/current', async () => {
    // A tree with one karma box excluded at suffixHead but included at tip —
    // exercises step 1 (an exclusion), step 2 (the record), step 3 (the young
    // check), step 4 (/blocks/current).
    const cand = karmaCandidate(7n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const suffixAvl = buildAvlWithInsertions(
      [recordInsertion(USER_BYTES, RECORD_STANDING)],
      [boxId],
    );
    const tipAvl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, tipAvl.digest, SUFFIX_H, suffixAvl.digest);

    const calls: { path: string; atHeight: number | null }[] = [];
    const httpFetch: HttpFetch = async (url: string) => {
      const u = new URL(url);
      calls.push({
        path: u.pathname,
        atHeight: u.searchParams.get('atHeight') ? Number(u.searchParams.get('atHeight')) : null,
      });
      const at = Number(u.searchParams.get('atHeight'));
      if (u.pathname === `/api/v1/proof/${boxId}`) {
        if (at === SUFFIX_H) {
          const e = suffixAvl.entries.get(boxId)!;
          return jsonResponse(200, {
            boxId, atHeight: at, stateRoot: suffixAvl.digest,
            proof: Buffer.from(e.proof).toString('base64'),
            kind: null, value: null,
          });
        }
        const e = tipAvl.entries.get(boxId)!;
        return jsonResponse(200, {
          boxId, atHeight: at, stateRoot: tipAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (u.pathname === `/api/v1/proof/${RECORD_KEY}`) {
        const e = suffixAvl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: at, stateRoot: suffixAvl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (u.pathname === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return jsonResponse(404, { error: 'not found' });
    };

    const listing: Listing = {
      karma: { boxes: [{ boxId, value: '7' }], height: TIP_H, effective: '7' },
      credits: { boxes: [] },
    };
    await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), httpFetch);

    // Expected order (paths):
    //   1. /api/v1/proof/<boxId>?atHeight=SUFFIX_H
    //   2. /api/v1/proof/<recordKey>?atHeight=SUFFIX_H
    //   3. /api/v1/proof/<boxId>?atHeight=TIP_H
    //   4. /blocks/current
    expect(calls.length).toBe(4);
    expect(calls[0]).toEqual({ path: `/api/v1/proof/${boxId}`, atHeight: SUFFIX_H });
    expect(calls[1]).toEqual({ path: `/api/v1/proof/${RECORD_KEY}`, atHeight: SUFFIX_H });
    expect(calls[2]).toEqual({ path: `/api/v1/proof/${boxId}`, atHeight: TIP_H });
    expect(calls[3]).toEqual({ path: '/blocks/current', atHeight: null });
  });
});

describe('fetchListing — paged reads', () => {
  it('three karma pages followed to the end — height and effective from the first page', async () => {
    const httpFetch = makeFetch((path, q) => {
      if (path !== `/karma/${USER_HEX}`) return undefined;
      const after = q.get('after');
      if (after === null) {
        return jsonResponse(200, karmaPage(
          [{ boxId: 'a1'.repeat(32), value: '10' }],
          { height: 555, effective: '30', next: 'cursor-1' },
        ));
      }
      if (after === 'cursor-1') {
        return jsonResponse(200, karmaPage(
          [{ boxId: 'a2'.repeat(32), value: '10' }],
          { height: 999, effective: 'wrong', next: 'cursor-2' },
        ));
      }
      if (after === 'cursor-2') {
        return jsonResponse(200, karmaPage(
          [{ boxId: 'a3'.repeat(32), value: '10' }],
          { height: 999, effective: 'wrong', next: null },
        ));
      }
      return undefined;
    });

    const result = await fetchListing('http://a', USER_HEX, httpFetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.listing.karma.boxes.length).toBe(3);
      expect(result.listing.karma.height).toBe(555);
      expect(result.listing.karma.effective).toBe('30');
    }
  });

  it('two credit pages followed to the end', async () => {
    const httpFetch = makeFetch((path, q) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(404, { error: 'not found' });
      if (path !== `/credits/${USER_HEX}`) return undefined;
      const after = q.get('after');
      if (after === null) {
        return jsonResponse(200, creditPage(
          [{ boxId: 'c1'.repeat(32), value: '5' }],
          { next: 'cursor-c1' },
        ));
      }
      if (after === 'cursor-c1') {
        return jsonResponse(200, creditPage(
          [{ boxId: 'c2'.repeat(32), value: '5', lockedUntilBlock: 42 }],
          { next: null },
        ));
      }
      return undefined;
    });

    const result = await fetchListing('http://a', USER_HEX, httpFetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.listing.credits.boxes.length).toBe(2);
      expect(result.listing.credits.boxes[1]!.lockedUntilBlock).toBe(42);
    }
  });

  it('a 404 on karma is an empty listing (an identity the node has never seen)', async () => {
    const httpFetch = makeFetch((path) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(404, { error: 'not found' });
      if (path === `/credits/${USER_HEX}`) return jsonResponse(404, { error: 'not found' });
      return undefined;
    });

    const result = await fetchListing('http://a', USER_HEX, httpFetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.listing.karma.boxes.length).toBe(0);
      expect(result.listing.karma.height).toBe(0);
      expect(result.listing.karma.effective).toBe('0');
      expect(result.listing.credits.boxes.length).toBe(0);
    }
  });

  it('a 500 on karma names the route', async () => {
    const httpFetch = makeFetch((path) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(500, { error: 'internal' });
      return undefined;
    });
    const result = await fetchListing('http://a', USER_HEX, httpFetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('karma');
      expect(result.reason).toContain('500');
    }
  });

  it('a 500 on credits names the route', async () => {
    const httpFetch = makeFetch((path) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(404, { error: 'not found' });
      if (path === `/credits/${USER_HEX}`) return jsonResponse(500, { error: 'internal' });
      return undefined;
    });
    const result = await fetchListing('http://a', USER_HEX, httpFetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('credits');
      expect(result.reason).toContain('500');
    }
  });
});

describe('proveBoxes — composes fetchListing and proveFigures', () => {
  it('a listing followed by a proven karma box', async () => {
    const cand = karmaCandidate(15n);
    const boxId = computeCandidateBoxId(cand, FAKE_TXID, 0);
    const avl = buildAvlWithInsertions([
      boxInsertion(cand, FAKE_TXID, 0),
      recordInsertion(USER_BYTES, RECORD_STANDING),
    ]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);

    const httpFetch = makeFetch((path) => {
      if (path === `/karma/${USER_HEX}`) {
        return jsonResponse(200, karmaPage(
          [{ boxId, value: '15' }],
          { height: SUFFIX_H, effective: '15' },
        ));
      }
      if (path === `/credits/${USER_HEX}`) {
        return jsonResponse(200, creditPage([]));
      }
      if (path === `/api/v1/proof/${boxId}`) {
        const e = avl.entries.get(boxId)!;
        return jsonResponse(200, {
          boxId, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'box', value: null,
        });
      }
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, {
          boxId: RECORD_KEY, atHeight: SUFFIX_H, stateRoot: avl.digest,
          proof: Buffer.from(e.proof).toString('base64'),
          kind: 'record', value: null,
        });
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });

    const result = await proveBoxes('http://a', USER_HEX, anchor, devnetProfile(), httpFetch);
    expect(result.failed).toBe(false);
    expect(result.boxes[0]!.status).toBe('proven');
    expect(result.karma.proven).toBe(15n);
  });

  it('a listing failure lands as failed:true with no boxes', async () => {
    const anchor = makeAnchor(TIP_H, '00'.repeat(32), SUFFIX_H, '00'.repeat(32));
    const httpFetch = makeFetch((path) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(500, { error: 'internal' });
      return undefined;
    });
    const result = await proveBoxes('http://a', USER_HEX, anchor, devnetProfile(), httpFetch);
    expect(result.failed).toBe(true);
    expect(result.boxes.length).toBe(0);
  });
});
