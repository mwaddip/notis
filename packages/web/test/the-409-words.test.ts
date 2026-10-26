// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { _rejectionCopiesForTests } from '../src/app';
import type { Rejection } from '../src/api/write';

// WEB_INTERFACE → The wallet → "A rejection's words follow the node's
// message, never its status alone": the pool's box conflict reads *that
// rep is still tied up in a spend that has not landed.* on every rep
// surface. A like the node already holds reads *you have already liked
// this post* only from the node's own words. A withdraw of a post the
// node already holds pending does not read the box-conflict sentence.

const BOX_ID = '77'.repeat(32);
const BOX_CONFLICT: Rejection = {
  status: 409,
  message: `Input ${BOX_ID} is already spent by a pending transaction`,
};
const BOX_CONFLICT_LINE = 'that rep is still tied up in a spend that has not landed.';

describe('the pool\'s box conflict reads the floor sentence on every rep surface', () => {
  it('post reads the box-conflict sentence', () => {
    expect(_rejectionCopiesForTests.post(BOX_CONFLICT)).toBe(BOX_CONFLICT_LINE);
  });

  it('like reads the box-conflict sentence', () => {
    expect(_rejectionCopiesForTests.like(BOX_CONFLICT)).toBe(BOX_CONFLICT_LINE);
  });

  it('vouch reads the box-conflict sentence', () => {
    expect(_rejectionCopiesForTests.vouch(BOX_CONFLICT)).toBe(BOX_CONFLICT_LINE);
  });

  it('invite reads the box-conflict sentence', () => {
    expect(_rejectionCopiesForTests.invite(BOX_CONFLICT)).toBe(BOX_CONFLICT_LINE);
  });

  it('withdraw reads the box-conflict sentence', () => {
    expect(_rejectionCopiesForTests.withdraw(BOX_CONFLICT)).toBe(BOX_CONFLICT_LINE);
  });

  it('a claim reads the box-conflict sentence', () => {
    // The claim and the burn share `usernameRejectionCopy`; both routes read
    // the box-conflict words first (WEB_INTERFACE → The username row).
    expect(_rejectionCopiesForTests.username(BOX_CONFLICT)).toBe(BOX_CONFLICT_LINE);
  });
});

describe('a like the node already holds reads from the node\'s own words', () => {
  it('like answered 400 Already liked this post reads *you have already liked this post*', () => {
    const alreadyLiked: Rejection = { status: 400, message: 'Already liked this post' };
    expect(_rejectionCopiesForTests.like(alreadyLiked)).toBe('you have already liked this post');
  });
});

describe('a withdraw of a post the node already holds pending does not read the box-conflict sentence', () => {
  it('withdraw answered 409 "A withdrawal of this post is already pending" reads a line other than the box-conflict sentence', () => {
    const alreadyPending: Rejection = {
      status: 409,
      message: 'A withdrawal of this post is already pending',
    };
    expect(_rejectionCopiesForTests.withdraw(alreadyPending)).not.toBe(BOX_CONFLICT_LINE);
  });
});
