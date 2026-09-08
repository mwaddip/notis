import { describe, it, expect } from 'vitest';
import { decideMove, type ScreenEntry } from '../src/history';

const eq = (a: string, b: string): boolean => a === b;

const boot: ScreenEntry = { member: 'feed', prev: null, depth: 0 };
const pushed: ScreenEntry = { member: 'A', prev: 'feed', depth: 1 };
const deep: ScreenEntry = { member: 'B', prev: 'A', depth: 2 };

describe('decideMove — tap × (same | prev | other)', () => {
  it('same screen → none', () => {
    expect(decideMove(pushed, 'A', eq, 'tap')).toEqual({ kind: 'none' });
  });

  it('prev screen → back', () => {
    expect(decideMove(pushed, 'feed', eq, 'tap')).toEqual({ kind: 'back' });
  });

  it('other screen → push', () => {
    const r = decideMove(pushed, 'C', eq, 'tap');
    expect(r.kind).toBe('push');
    if (r.kind === 'push') {
      expect(r.entry).toEqual({ member: 'C', prev: 'A', depth: 2 });
    }
  });
});

describe('decideMove — swipe × (same | prev | other)', () => {
  it('same screen → none', () => {
    expect(decideMove(pushed, 'A', eq, 'swipe')).toEqual({ kind: 'none' });
  });

  it('prev screen → back', () => {
    expect(decideMove(pushed, 'feed', eq, 'swipe')).toEqual({ kind: 'back' });
  });

  it('other screen → none (a swipe elsewhere is not history)', () => {
    expect(decideMove(pushed, 'C', eq, 'swipe')).toEqual({ kind: 'none' });
  });
});

describe('decideMove — depth-0 guard', () => {
  it('depth 0 with matching prev: tap → push, swipe → none', () => {
    const atBoot: ScreenEntry = { member: 'A', prev: 'feed', depth: 0 };
    const tap = decideMove(atBoot, 'feed', eq, 'tap');
    expect(tap.kind).toBe('push');
    if (tap.kind === 'push') {
      expect(tap.entry).toEqual({ member: 'feed', prev: 'A', depth: 1 });
    }
    expect(decideMove(atBoot, 'feed', eq, 'swipe')).toEqual({ kind: 'none' });
  });
});

describe('decideMove — null and boot current', () => {
  it('null current → none', () => {
    expect(decideMove(null, 'A', eq, 'tap')).toEqual({ kind: 'none' });
    expect(decideMove(null, 'A', eq, 'swipe')).toEqual({ kind: 'none' });
  });

  it('boot entry same screen → none', () => {
    expect(decideMove(boot, 'feed', eq, 'tap')).toEqual({ kind: 'none' });
  });
});

describe('decideMove — deep entries', () => {
  it('back from depth 2 lands on prev', () => {
    expect(decideMove(deep, 'A', eq, 'tap')).toEqual({ kind: 'back' });
    expect(decideMove(deep, 'A', eq, 'swipe')).toEqual({ kind: 'back' });
  });

  it('push from depth 2 to other', () => {
    const r = decideMove(deep, 'D', eq, 'tap');
    expect(r.kind).toBe('push');
    if (r.kind === 'push') {
      expect(r.entry).toEqual({ member: 'D', prev: 'B', depth: 3 });
    }
  });
});
