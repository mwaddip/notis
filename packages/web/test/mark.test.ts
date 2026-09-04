// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { card, displayMark } from '../src/view/card';
import type { Mark } from '../src/view/card';
import type { PostJson } from '../src/api/dto';
import { contentHashHex } from '../src/integrity';

// The vouch mark's four states by node identity (WEB_INTERFACE → The identity
// display): + muted, ✓ ink, a pending muted ✓, a disabled mark carrying its
// reason. Its state is glyph and ink weight — the aria-labels, the title (the
// count, or the reason on a disabled one), and never a word.

const PUB = 'aa'.repeat(32);
const AUTHOR = 'bb'.repeat(32);

function confirmed(author: string): PostJson {
  return {
    id: 'p1', content: 'hello', contentHash: contentHashHex('hello'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, likedByViewer: null,
  };
}
function markEl(mark: Mark | null): HTMLElement | null {
  const c = card(confirmed(AUTHOR), { mark, onAuthor: () => {}, onVouch: () => {} });
  return c.querySelector('.who .vmark');
}

describe('the vouch mark — states by node identity', () => {
  it('a + mark: a button, the count as title, the vouch aria, the + glyph', () => {
    const m = markEl({ state: 'plus', count: 3 })!;
    expect(m.tagName).toBe('BUTTON');
    expect(m.classList.contains('plus')).toBe(true);
    expect(m.getAttribute('title')).toBe('3 vouches');
    expect(m.getAttribute('aria-label')).toBe('vouch for this author — stakes 1 karma');
    expect(m.querySelector('.g')?.textContent).toBe('+');
  });

  it('the title is the count and nothing else — 1 vouch, no vouches, empty until it lands', () => {
    expect(markEl({ state: 'plus', count: 1 })!.getAttribute('title')).toBe('1 vouch');
    expect(markEl({ state: 'plus', count: 0 })!.getAttribute('title')).toBe('no vouches');
    // The mark renders before its count arrives; a null count leaves no title.
    expect(markEl({ state: 'plus', count: null })!.hasAttribute('title')).toBe(false);
  });

  it('a ✓ mark: the two-stroke SVG check, the open-window aria, ink weight', () => {
    const m = markEl({ state: 'check', count: 2 })!;
    expect(m.classList.contains('check')).toBe(true);
    expect(m.classList.contains('pending')).toBe(false);
    // The self-hosted faces lack U+2713, so the check is an inline SVG, never a glyph.
    expect(m.querySelector('svg.ck path')).not.toBeNull();
    expect(m.textContent).not.toContain('✓');
    expect(m.getAttribute('aria-label')).toBe('you vouched for this author — open their window');
  });

  it('a pending mark: the muted ✓, still the SVG check', () => {
    const m = markEl({ state: 'pending', count: 1 })!;
    expect(m.classList.contains('check')).toBe(true);
    expect(m.classList.contains('pending')).toBe(true);
    expect(m.querySelector('svg.ck path')).not.toBeNull();
  });

  it('a disabled mark: the reason as title AND aria, not clickable, not the count', () => {
    const reason = 'your stake from an unvouch is held until block 6,100';
    const m = markEl({ state: 'disabled', count: 5, reason }) as HTMLButtonElement;
    expect(m.disabled).toBe(true);
    expect(m.getAttribute('title')).toBe(reason);
    expect(m.getAttribute('aria-label')).toBe(reason);
    expect(m.getAttribute('title')).not.toContain('vouches');
  });

  it('a + press vouches at once — onVouch, no confirmation; a ✓ press opens the author window', () => {
    const vouched: string[] = [];
    const plus = card(confirmed(AUTHOR), { mark: { state: 'plus', count: 0 }, onVouch: (k) => vouched.push(k), onAuthor: () => {} });
    (plus.querySelector('.who .vmark') as HTMLElement).click();
    expect(vouched).toEqual([AUTHOR]);

    const opened: string[] = [];
    const check = card(confirmed(AUTHOR), { mark: { state: 'check', count: 1 }, onAuthor: (k) => opened.push(k), onVouch: () => {} });
    (check.querySelector('.who .vmark') as HTMLElement).click();
    expect(opened).toEqual([AUTHOR]);
  });

  it('the mark is absent with no opt, and · you is exclusive with it', () => {
    expect(card(confirmed(AUTHOR), { onAuthor: () => {} }).querySelector('.vmark')).toBeNull();
    // · you wins over a mark on the reader's own card.
    const own = card(confirmed(PUB), { you: true, mark: { state: 'plus', count: 0 }, onAuthor: () => {} });
    expect(own.querySelector('.vmark')).toBeNull();
    expect(own.querySelector('.you')?.textContent).toBe('· you');
  });

  it('the mark is never a word — the visible content is + or the SVG, never text like "vouch"', () => {
    // The mutation "render `vouch`" would put a word in the mark and redden this.
    for (const state of ['plus', 'check', 'pending', 'disabled'] as const) {
      const m = markEl({ state, count: 1, reason: 'r' })!;
      const text = (m.textContent ?? '').trim();
      expect(text === '' || text === '+').toBe(true);
      expect(text.toLowerCase()).not.toContain('vouch');
    }
  });
});

describe('displayMark — the title bar, display only', () => {
  it('renders the ✓ for check and pending, nothing otherwise, and is never + or a control', () => {
    const check = displayMark({ state: 'check', count: 3 })!;
    expect(check.tagName).toBe('SPAN'); // not a button — a control cannot nest in the bar's focus label
    expect(check.classList.contains('display')).toBe(true);
    expect(check.querySelector('svg.ck path')).not.toBeNull();

    const pending = displayMark({ state: 'pending', count: 1 })!;
    expect(pending.classList.contains('pending')).toBe(true);
    expect(pending.querySelector('svg.ck path')).not.toBeNull();

    // + and disabled and absent all render nothing on the bar — never a +.
    expect(displayMark({ state: 'plus', count: 0 })).toBeNull();
    expect(displayMark({ state: 'disabled', count: 0, reason: 'x' })).toBeNull();
    expect(displayMark(null)).toBeNull();
  });
});
