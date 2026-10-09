// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isFull, isLight, isWithdrawn } from '../src/api/dto';
import type { FeedRow, LightJson, PostJson, WithdrawnJson } from '../src/api/dto';

// The three guards partition every FeedRow — full, withdrawn, light — so a
// site that reads a PostJson field answers each arm with what the arm names
// (WEB_INTERFACE → The extension → "The light read").

const ID = '00'.repeat(32);

const full: PostJson = {
  id: ID, content: 'hi', contentHash: '11'.repeat(32), author: '22'.repeat(32),
  parentRefs: [], protocolVersion: 1, type: 'regular', status: 'confirmed',
  blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 0,
  authorName: null, likedByViewer: null, txId: '33'.repeat(32),
};

const withdrawn: WithdrawnJson = {
  kind: 'withdrawn', id: ID, author: '22'.repeat(32), withdrawnAtHeight: 2,
  parentRefs: [], descendantCount: 0, authorName: null, txId: '33'.repeat(32),
};

const light: LightJson = {
  kind: 'light', id: ID, parentRefs: [], status: 'confirmed',
  blockHeight: 1, blockIndex: 0, blockCreatedAt: 0,
  likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
};

const rows: FeedRow[] = [full, withdrawn, light];

describe('isFull answers true for a PostJson alone', () => {
  it('matches full, refuses withdrawn and light', () => {
    expect(rows.filter(isFull)).toEqual([full]);
  });
});

describe('isWithdrawn answers true for a WithdrawnJson alone', () => {
  it('matches withdrawn, refuses full and light', () => {
    expect(rows.filter(isWithdrawn)).toEqual([withdrawn]);
  });
});

describe('isLight answers true for a LightJson alone', () => {
  it('matches light, refuses full and withdrawn', () => {
    expect(rows.filter(isLight)).toEqual([light]);
  });
});
