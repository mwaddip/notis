// AVLTREE_INTERFACE → The depth guard — "verifyAvlLookup, passed through, is
// not guarded; its caller bounds it by the engine's own count": a lookup
// proof whose node count exceeds the engine's bound at the digest's declared
// height is refused by the decode before any descent (null from
// verifyAvlLookup). The single-key lookup lives in proveKeyAtHeight
// (src/boxes.ts), reached by proveBoxAtHeight (names, at suffixHead and at
// tip) and proveRecordAtHeight (figures' identity record).

import { describe, it, expect } from 'vitest';
import { label, newInternal, newLabel, newLeaf } from '@dagsocial/avltree';
import type { AvlNode } from '@dagsocial/avltree';
import { TREE_KEY_LENGTH, bytesToHex, boxKey, hexToBytes } from '@dagsocial/types';
import { proveName } from '../src/names.js';
import type { HttpFetch } from '../src/http.js';
import { jsonResponse, makeAnchor, buildAvlExclusionProof, boxProofKeyHex } from './helpers.js';

// A proof whose decoded tree stands > 512 nodes under a digest declaring 255
// is over the engine's bound at `maxNumOperations: 1, maxDeletes: 0`: a tree
// of height 255 with one lookup takes at most 2·255+1 = 511 interior+leaf
// nodes plus one slack. 600 ≥ 512 and sits well under the lookup route's
// byte cap (CONSTANTS → Light client reads — LOOKUP_READ_BYTES).
const SPINE_DEPTH = 600;
const SPINE_HEIGHT_BYTE = 0xff;

// Build the packed proof of a left-only spine of `depth` internal nodes over a
// single leaf whose key is `lookupKey` so the walk reaches a leaf whose key
// matches: `LEAF, (LABEL, INTERNAL(balance=0)) × depth, END_OF_TREE,
// directionBytes = ceil(depth/8) × 0xff`. Mirrors poc-deep-tree.mjs
// (`__REPO__/packages/avltree/dist/index.js`'s `label`, `newLeaf`,
// `newInternal`, `newLabel`), with the engine's own node constructors
// building the honest-shaped digest.
function buildSpineProof(depth: number, lookupKey: Uint8Array): Uint8Array {
  const nextKey = new Uint8Array(TREE_KEY_LENGTH).fill(0xfe);
  const value = new Uint8Array([0x07]);
  const stub = new Uint8Array(32).fill(0x55);
  const dirBytes = Math.ceil(depth / 8);
  const total = 1 + TREE_KEY_LENGTH + TREE_KEY_LENGTH + 4 + value.length
    + depth * 34
    + 1
    + dirBytes;
  const out = new Uint8Array(total);
  let i = 0;
  out[i++] = 0x02;
  out.set(lookupKey, i); i += TREE_KEY_LENGTH;
  out.set(nextKey, i); i += TREE_KEY_LENGTH;
  // 4-byte big-endian value length.
  out[i++] = 0; out[i++] = 0; out[i++] = 0; out[i++] = value.length;
  out.set(value, i); i += value.length;
  for (let d = 0; d < depth; d++) {
    out[i++] = 0x03;
    out.set(stub, i); i += 32;
    out[i++] = 0x00;
  }
  out[i++] = 0x04;
  for (let d = 0; d < dirBytes; d++) out[i++] = 0xff;
  return out;
}

function buildSpineDigest(depth: number, lookupKey: Uint8Array, heightByte: number): Uint8Array {
  const nextKey = new Uint8Array(TREE_KEY_LENGTH).fill(0xfe);
  const value = new Uint8Array([0x07]);
  const stub = new Uint8Array(32).fill(0x55);
  let root: AvlNode = newLeaf(lookupKey, value, nextKey);
  for (let d = 0; d < depth; d++) {
    root = newInternal(root, newLabel(stub), 0);
  }
  const digest = new Uint8Array(33);
  digest.set(label(root), 0);
  digest[32] = heightByte;
  return digest;
}

const KEY_HEX = 'ab'.repeat(32);
const LABEL_NAME = 'alice';
const BOX_ID = '11'.repeat(32);

describe('proveName — a deep lookup proof at the tip reads unproven, with no throw', () => {
  it('a 600-node spine proof under a tip whose stateRoot declares height 255 is refused through the engine', async () => {
    const lookupKey = boxKey(hexToBytes(BOX_ID));

    const spineProof = buildSpineProof(SPINE_DEPTH, lookupKey);
    const spineDigest = buildSpineDigest(SPINE_DEPTH, lookupKey, SPINE_HEIGHT_BYTE);
    const tipStateRootHex = bytesToHex(spineDigest);

    // The suffixHead reads as excluded through an empty-tree exclusion proof.
    // That answer is well-formed under the empty digest, so proveName goes on
    // to the tip read where the deep proof stands.
    const empty = buildAvlExclusionProof([], BOX_ID);
    const suffixStateRootHex = empty.digest;
    const emptyProofBase64 = Buffer.from(empty.proof).toString('base64');

    const spineProofBase64 = Buffer.from(spineProof).toString('base64');
    const lookupKeyHex = boxProofKeyHex(BOX_ID);
    const calls: string[] = [];
    const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
      const u = new URL(reqUrl);
      calls.push(`${u.pathname}${u.search}`);
      if (u.pathname === '/usernames' && u.searchParams.get('owner') === KEY_HEX) {
        return jsonResponse(200, { boxId: BOX_ID, owner: KEY_HEX, name: LABEL_NAME });
      }
      const keyMatch = u.pathname.match(/^\/api\/v1\/proof\/([0-9a-f]+)$/);
      if (keyMatch && keyMatch[1] === lookupKeyHex) {
        const atHeight = Number(u.searchParams.get('atHeight'));
        if (atHeight === SUFFIX_H) {
          return jsonResponse(200, {
            key: lookupKeyHex, atHeight, stateRoot: suffixStateRootHex,
            proof: emptyProofBase64, kind: 'box', value: null,
          });
        }
        if (atHeight === TIP_H) {
          return jsonResponse(200, {
            key: lookupKeyHex, atHeight, stateRoot: tipStateRootHex,
            proof: spineProofBase64, kind: 'box', value: null,
          });
        }
      }
      return jsonResponse(404, { error: 'not found' });
    };

    const anchor = makeAnchor(TIP_H, tipStateRootHex, SUFFIX_H, suffixStateRootHex);

    const result = await proveName('http://a', { key: KEY_HEX, name: LABEL_NAME }, anchor, fetch);

    // Control: the spine proof decoded holds more nodes than the engine takes
    // at the digest's declared height.
    expect(spineProof.length).toBeGreaterThan(SPINE_DEPTH * 34);
    // Control: the digest's last byte is the declared tree height, 255.
    expect(spineDigest[32]).toBe(SPINE_HEIGHT_BYTE);
    // Control: the suffixHead's lookup route was asked.
    expect(calls.some((c) => c.includes(`atHeight=${SUFFIX_H}`))).toBe(true);
    // Control: the tipHeight's lookup route was asked.
    expect(calls.some((c) => c.includes(`atHeight=${TIP_H}`))).toBe(true);
    // The run ends in a status, never a throw.
    expect(result.status).toBe('unproven');
    // The engine's decode refused: the verdict names the refused proof, never
    // the leaf's would-be value failing to decode.
    expect(result.verdict).toContain('proof rejected');
  });
});

const SUFFIX_H = 100;
const TIP_H = 119;
