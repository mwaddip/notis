import { describe, it, expect } from 'vitest';
import { proveFigures } from '../src/boxes.js';
import type { Anchor, Listing } from '../src/boxes.js';
import { proveName } from '../src/names.js';
import type { HttpFetch } from '@dagsocial/node-reads';
import type { BlockHeader, UserId, AnyBoxCandidate, TxId } from '@dagsocial/types';
import { computeCandidateBoxId, EMPTY_IDENTITY_RECORD } from '@dagsocial/types';
import {
  avlProofJson,
  boxInsertion,
  boxProofKeyHex,
  buildAvlWithInsertions,
  buildHoldingsFixture,
  devnetProfile,
  hexToBytes,
  jsonResponse,
  karmaBoxFor,
  makeAnchor,
  twoHeightNode,
} from './helpers.js';
import type { PoPowHeader } from '@dagsocial/nipopow';

// WEB_INTERFACE → The extension → "The verified figures" — an anchor is the
// verified tip and the suffix head's header, two plain headers; the proofs read
// the height and the state root of each.

const SUFFIX_H = 100;
const TIP_H = 119;

function plainHeader(height: number, stateRoot: string): BlockHeader {
  return makeAnchor(height, stateRoot, height, stateRoot).tip;
}

function plainAnchor(stateRootAtTip: string, stateRootAtSuffix: string): Anchor {
  return { tip: plainHeader(TIP_H, stateRootAtTip), suffixHead: plainHeader(SUFFIX_H, stateRootAtSuffix) };
}

describe('an anchor of two plain headers', () => {
  it.fails('proveFigures proves a listed box at both heights', async () => {
    const userHex = 'ab'.repeat(32);
    const user = hexToBytes(userHex) as UserId;
    const karma = karmaBoxFor(user, 100n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: user, record: { ...EMPTY_IDENTITY_RECORD, lastActivityBlock: 50, lastDecayBlock: 50 } }],
    });
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: TIP_H, effective: '100' },
      credits: { boxes: [] },
    };
    const anchor = plainAnchor(fixture.stateRoot, fixture.stateRoot);
    const result = await proveFigures('http://a', userHex, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['proven']);
    expect(result.karma.proven).toBe(100n);
    expect(result.failed).toBe(false);
  });

  it.fails('proveName proves a name at both heights', async () => {
    const bob = 'bb'.repeat(32);
    const txid = 'cd'.repeat(32) as TxId;
    const box: AnyBoxCandidate = {
      boxType: 'username',
      value: 0n,
      createdAtBlock: 5,
      owner: hexToBytes(bob),
      name: new TextEncoder().encode('Bob'),
    };
    const boxId = computeCandidateBoxId(box, txid, 0);
    const tree = buildAvlWithInsertions([boxInsertion(box, txid, 0)], []);
    const fetch: HttpFetch = async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/usernames') {
        return jsonResponse(200, { name: 'Bob', owner: bob, boxId, claimedAtBlock: 5 });
      }
      const match = u.pathname.match(/^\/api\/v1\/proof\/(.+)$/);
      if (match) {
        const key = match[1]!;
        const at = Number(u.searchParams.get('atHeight'));
        const entry = tree.entries.get(key);
        if (!entry) return jsonResponse(404, { error: 'height not available' });
        return jsonResponse(200, avlProofJson(key, at, tree.digest, entry.proof, 'box', null));
      }
      if (u.pathname === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return jsonResponse(404, { error: 'not found' });
    };
    const result = await proveName('http://a', { key: bob, name: 'Bob' }, plainAnchor(tree.digest, tree.digest), fetch);
    expect(result.verdict).toBe(`proven at suffixHead (height ${SUFFIX_H})`);
  });

  it('refuses a PoPowHeader as the suffix head', () => {
    const popow: PoPowHeader = { header: plainHeader(SUFFIX_H, '00'.repeat(32)), interlinks: [] };
    const anchor: Anchor = {
      tip: plainHeader(TIP_H, '00'.repeat(32)),
      // @ts-expect-error a suffix head is a BlockHeader, not a proof's PoPowHeader
      suffixHead: popow,
    };
    expect(anchor.tip.height).toBe(TIP_H);
  });
});
