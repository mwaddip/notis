import { describe, it, expect } from 'vitest';
import { availableInvites } from '@dagsocial/consensus';
import { identityRecord } from './helpers.js';

// CONSENSUS_INTERFACE → What it holds → "Who may invite, and how many, is one
// function". `availableInvites(record, bar)` answers `'no-record'`, `'root'`,
// `'none'` or a number, and `bar` is called once for a member alone.

describe('availableInvites answers one of four kinds, bar called for a member alone', () => {
  function bar(fixed: number): { bar: () => number; calls: () => number } {
    let calls = 0;
    return {
      bar: () => {
        calls++;
        return fixed;
      },
      calls: () => calls,
    };
  }

  it('a key with no record answers no-record, bar not called', () => {
    const b = bar(1);
    expect(availableInvites(null, b.bar)).toBe('no-record');
    expect(b.calls()).toBe(0);
  });

  it('a root answers root, bar not called', () => {
    const b = bar(1);
    const root = identityRecord({ memberSinceBlock: 1 });
    expect(availableInvites(root, b.bar)).toBe('root');
    expect(b.calls()).toBe(0);
  });

  it('a non-member resident answers none, bar not called', () => {
    const b = bar(1);
    const resident = identityRecord({ memberSinceBlock: 0 });
    expect(availableInvites(resident, b.bar)).toBe('none');
    expect(b.calls()).toBe(0);
  });

  it('a member answers floor(vouches / bar) - used, bar called once', () => {
    const b = bar(3);
    const member = identityRecord({
      memberSinceBlock: 1,
      memberBar: 3,
      memberVouches: 7,
      invitesUsed: 1,
    });
    // floor(7 / 3) - 1 = 2 - 1 = 1
    expect(availableInvites(member, b.bar)).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it('a member whose budget is spent answers 0 or negative, bar called once', () => {
    const b = bar(4);
    const member = identityRecord({
      memberSinceBlock: 1,
      memberBar: 1,
      memberVouches: 7,
      invitesUsed: 2,
    });
    // floor(7 / 4) - 2 = 1 - 2 = -1
    expect(availableInvites(member, b.bar)).toBe(-1);
    expect(b.calls()).toBe(1);
  });
});
