import { describe, it, expect } from 'vitest';
import {
  IDENTITY_RECORD_TAG,
  NETWORK_RECORD_TAG,
  NAME_RECORD_TAG,
  HOLDER_RECORD_TAG,
  POST_RECORD_TAG,
  LIKE_MARKER_TAG,
  INDEX_MARKER_TAG,
  VOUCH_PAIR_TAG,
  CAST_COUNT_TAG,
  LIKE_MARKER,
  INDEX_MARKER,
} from '../src/index.js';

describe('tree record tags (TYPES_INTERFACE → Layout — tree records)', () => {
  it('the nine tags, in the contract order, are 0x80 through 0x88, each one more than the last', () => {
    const tags = [
      IDENTITY_RECORD_TAG,
      NETWORK_RECORD_TAG,
      NAME_RECORD_TAG,
      HOLDER_RECORD_TAG,
      POST_RECORD_TAG,
      LIKE_MARKER_TAG,
      INDEX_MARKER_TAG,
      VOUCH_PAIR_TAG,
      CAST_COUNT_TAG,
    ];
    expect(tags).toEqual([0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88]);
    for (let i = 1; i < tags.length; i++) expect(tags[i]).toBe(tags[i - 1]! + 1);
  });

  it('LIKE_MARKER and INDEX_MARKER are their tags as one byte', () => {
    expect(LIKE_MARKER).toEqual(Uint8Array.of(LIKE_MARKER_TAG));
    expect(INDEX_MARKER).toEqual(Uint8Array.of(INDEX_MARKER_TAG));
  });
});
