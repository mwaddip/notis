// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readBoundRow, readWithdrawnRow } from '../src/api/post-row';
import { readLightRows } from '../src/api/light-page';
import { MAX_CONTENT_BYTES } from '@dagsocial/types';
import type { PostJson, WithdrawnJson } from '../src/api/dto';

// The row readers the post check lets through
// (WEB_INTERFACE → The extension → "A checked row is taken field by field",
// → "A row that is not well-formed is not shown and not cached"). Each
// answered row is a fresh object of its type's fields alone — no `tx`, no
// key beyond — and both readers are total: any value in, a row or `null`
// out, never a throw.

const ID_1 = 'ab'.repeat(32);
const ID_2 = 'cd'.repeat(32);
const ID_3 = 'ef'.repeat(32);
const AUTHOR = 'bc'.repeat(32);
const TXID = 'de'.repeat(32);
const CH = '12'.repeat(32);

function postJson(over: Partial<PostJson> = {}): PostJson {
  return {
    id: ID_1,
    content: 'hello',
    contentHash: CH,
    author: AUTHOR,
    parentRefs: [],
    protocolVersion: 1,
    type: 'regular',
    status: 'confirmed',
    blockHeight: 10,
    blockIndex: 0,
    blockCreatedAt: 1_700_000_000_000,
    likeCount: 1,
    descendantCount: 2,
    authorName: 'alice',
    likedByViewer: null,
    txId: TXID,
    ...over,
  };
}

function withdrawn(over: Partial<WithdrawnJson> = {}): WithdrawnJson {
  return {
    kind: 'withdrawn',
    id: ID_1,
    author: AUTHOR,
    withdrawnAtHeight: 500,
    parentRefs: [],
    descendantCount: 0,
    authorName: null,
    txId: TXID,
    ...over,
  };
}

describe('readBoundRow — a well-formed row answers a fresh object of its sixteen fields and no `tx`', () => {
  it('answers the sixteen fields and nothing else', () => {
    const r = readBoundRow(postJson());
    expect(r).not.toBeNull();
    const keys = Object.keys(r as PostJson).sort();
    expect(keys).toEqual([
      'author', 'authorName', 'blockCreatedAt', 'blockHeight', 'blockIndex',
      'content', 'contentHash', 'descendantCount', 'id', 'likeCount',
      'likedByViewer', 'parentRefs', 'protocolVersion', 'status', 'txId', 'type',
    ]);
    expect((r as PostJson).tx).toBeUndefined();
  });

  it('an extra key is not carried', () => {
    const r = readBoundRow({ ...postJson(), surprise: 'ignored', confirmedAuthor: 'x' });
    expect(r).not.toBeNull();
    expect((r as unknown as Record<string, unknown>)['surprise']).toBeUndefined();
    expect((r as unknown as Record<string, unknown>)['confirmedAuthor']).toBeUndefined();
    expect((r as PostJson).tx).toBeUndefined();
  });

  it('a `kind` is not carried', () => {
    const r = readBoundRow({ ...postJson(), kind: 'bound' });
    expect(r).not.toBeNull();
    expect((r as unknown as Record<string, unknown>)['kind']).toBeUndefined();
  });

  it('a `tx` on the input is dropped', () => {
    const r = readBoundRow({ ...postJson(), tx: 'de'.repeat(16) });
    expect(r).not.toBeNull();
    expect((r as PostJson).tx).toBeUndefined();
  });

  it('the row is a fresh object — not the same identity as the input', () => {
    const same = postJson();
    const r = readBoundRow(same);
    expect(r).not.toBe(same);
    // parentRefs is a fresh array too, so mutating the input does not reach
    // the answered row.
    expect(r?.parentRefs).not.toBe(same.parentRefs);
  });

  it('content of null is kept', () => {
    const r = readBoundRow(postJson({ content: null }));
    expect(r?.content).toBeNull();
  });

  it('content of 1 byte is kept', () => {
    const r = readBoundRow(postJson({ content: 'a' }));
    expect(r?.content).toBe('a');
  });

  it(`content of MAX_CONTENT_BYTES bytes is kept`, () => {
    const r = readBoundRow(postJson({ content: 'a'.repeat(MAX_CONTENT_BYTES) }));
    expect(r?.content?.length).toBe(MAX_CONTENT_BYTES);
  });

  it(`100 three-byte characters is kept (300 bytes)`, () => {
    // U+1000 (က) encodes to 3 UTF-8 bytes.
    const three = 'က';
    const r = readBoundRow(postJson({ content: three.repeat(100) }));
    expect(r?.content).not.toBeUndefined();
  });

  it('two parents is refused', () => {
    const r = readBoundRow(postJson({ parentRefs: [ID_2, ID_3] }));
    expect(r).toBeNull();
  });
});

describe('readBoundRow — a malformed field refuses the row', () => {
  const bad: Array<[string, Partial<PostJson>]> = [
    ['a 63-char id', { id: ID_1.slice(0, 63) }],
    ['an upper-case id', { id: ID_1.toUpperCase() }],
    ['an id that is a number', { id: 42 as unknown as string }],
    ['a non-hex txId', { txId: 'gg'.repeat(32) }],
    ['a non-hex contentHash', { contentHash: 'zz'.repeat(32) }],
    ['a non-hex author', { author: '00'.repeat(31) }],
    ['content of 0 bytes', { content: '' }],
    [`content of MAX_CONTENT_BYTES + 1 bytes`, { content: 'a'.repeat(MAX_CONTENT_BYTES + 1) }],
    ['101 three-byte characters is refused (303 bytes)', { content: 'က'.repeat(101) }],
    ['a parent that is a number', { parentRefs: [42] as unknown as string[] }],
    ['a type outside the two', { type: 'weird' as unknown as 'regular' }],
    ['a status outside the two', { status: 'rejected' as unknown as 'confirmed' }],
    ['a negative likeCount', { likeCount: -1 }],
    ['a fractional descendantCount', { descendantCount: 1.5 }],
    ['likeCount a string', { likeCount: '3' as unknown as number }],
    ['likeCount at 2 ** 53', { likeCount: 2 ** 53 }],
    ['a protocolVersion that is negative', { protocolVersion: -1 }],
    ['a blockHeight that is a string', { blockHeight: '10' as unknown as number }],
    ['a name of 25 bytes', { authorName: 'a'.repeat(25) }],
    ['a name with a space', { authorName: 'al ice' }],
    ['likedByViewer a string', { likedByViewer: 'true' as unknown as boolean }],
  ];
  for (const [name, over] of bad) {
    it(`${name} answers null`, () => {
      expect(readBoundRow(postJson(over))).toBeNull();
    });
  }
});

describe('readBoundRow — a non-object value answers null', () => {
  it('null answers null', () => {
    expect(readBoundRow(null)).toBeNull();
  });
  it('an array answers null', () => {
    expect(readBoundRow([postJson()])).toBeNull();
  });
  it('a string answers null', () => {
    expect(readBoundRow('nope')).toBeNull();
  });
  it('undefined answers null', () => {
    expect(readBoundRow(undefined)).toBeNull();
  });
});

describe('readWithdrawnRow — a well-formed row answers a fresh WithdrawnJson of its own fields', () => {
  it('answers the eight fields and nothing else', () => {
    const r = readWithdrawnRow(withdrawn());
    expect(r).not.toBeNull();
    const keys = Object.keys(r as WithdrawnJson).sort();
    expect(keys).toEqual([
      'author', 'authorName', 'descendantCount', 'id', 'kind',
      'parentRefs', 'txId', 'withdrawnAtHeight',
    ]);
  });

  it('an extra key is not carried', () => {
    const r = readWithdrawnRow({ ...withdrawn(), surprise: 'ignored' });
    expect(r).not.toBeNull();
    expect((r as unknown as Record<string, unknown>)['surprise']).toBeUndefined();
  });

  it('the row is a fresh object — not the same identity as the input', () => {
    const same = withdrawn();
    const r = readWithdrawnRow(same);
    expect(r).not.toBe(same);
    expect(r?.parentRefs).not.toBe(same.parentRefs);
  });
});

describe('readWithdrawnRow — a malformed field answers null', () => {
  const bad: Array<[string, Partial<WithdrawnJson>]> = [
    ['an upper-case id', { id: ID_1.toUpperCase() }],
    ['a 63-char id', { id: ID_1.slice(0, 63) }],
    ['a non-hex txId', { txId: 'gg'.repeat(32) }],
    ['a non-hex author', { author: '00'.repeat(31) }],
    ['two parents', { parentRefs: [ID_2, ID_3] }],
    ['a negative withdrawnAtHeight', { withdrawnAtHeight: -1 }],
    ['a fractional descendantCount', { descendantCount: 1.5 }],
    ['a name with a space', { authorName: 'bo b' }],
  ];
  for (const [name, over] of bad) {
    it(`${name} answers null`, () => {
      expect(readWithdrawnRow(withdrawn(over))).toBeNull();
    });
  }
});

describe('readWithdrawnRow — a non-object value answers null', () => {
  it('null answers null', () => { expect(readWithdrawnRow(null)).toBeNull(); });
  it('an array answers null', () => { expect(readWithdrawnRow([withdrawn()])).toBeNull(); });
  it('a string answers null', () => { expect(readWithdrawnRow('nope')).toBeNull(); });
});

describe('readLightRows still answers the row of a well-formed page', () => {
  it('a light row and a withdrawn row read as before', () => {
    const rows = readLightRows([
      {
        kind: 'light', id: ID_1, parentRefs: [], status: 'confirmed',
        blockHeight: 1, blockIndex: 0, blockCreatedAt: 0,
        likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
      },
      withdrawn({ id: ID_2 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('light');
    expect(rows[1]!.kind).toBe('withdrawn');
  });
});
