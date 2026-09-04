// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { card } from '../src/view/card';
import type { PostJson } from '../src/api/dto';
import type { Flight } from '../src/view/card';
import { contentHashHex } from '../src/integrity';

// The stage line's copy — two stages then one of three endings. The endings say
// what happened, never a status code (HOUSE_STYLE → Voice).

const PUB = 'aa'.repeat(32);
function pending(content: string): PostJson {
  return {
    id: 'local1', content, contentHash: contentHashHex(content), author: PUB, parentRefs: [],
    protocolVersion: 0, type: 'regular', status: 'pending', blockHeight: null, blockIndex: null,
    blockCreatedAt: null, likeCount: 0, likedByViewer: null,
  };
}
const stageText = (flight: Flight): string => card(pending('x'), { flight }).querySelector('.stage')?.textContent ?? '';

function confirmed(author: string): PostJson {
  return {
    id: 'p1', content: 'hello', contentHash: contentHashHex('hello'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, likedByViewer: null,
  };
}

describe('card — the stage line', () => {
  it('reads submitting…, then submitted', () => {
    expect(stageText({ stage: 'submitting' })).toContain('submitting');
    expect(stageText({ stage: 'submitted' })).toBe('submitted');
  });

  it('an expired card reads "by height N" — the entry is eligible at N, purged once the tip passes it', () => {
    const onTryAgain = vi.fn();
    const c = card(pending('x'), { flight: { stage: 'expired', expiresAtHeight: 6335, onTryAgain } });
    const text = c.querySelector('.stage')!.textContent!;
    expect(text).toContain('no block took this by height');
    expect(text).not.toContain('before height');
    expect(text).toContain('6,335');
    [...c.querySelectorAll('button')].find((b) => b.textContent === 'try again')!.click();
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });

  it('a rejected card reads the node reason, never a status code', () => {
    expect(stageText({ stage: 'rejected', reason: 'the node is full right now.' })).toBe('the node is full right now.');
  });
});

describe('card — · you', () => {
  it('marks the reader\'s own card with · you after the prefix, and no other', () => {
    const own = card(confirmed(PUB), { you: true });
    expect(own.querySelector('.you')?.textContent).toBe('· you');
    expect(card(confirmed('bb'.repeat(32)), { you: false }).querySelector('.you')).toBeNull();
    expect(card(confirmed(PUB)).querySelector('.you')).toBeNull(); // no opt → no mark
  });
});

describe('card — a locked like', () => {
  it('shows the unlock form under the meta on the press, then the like proceeds', async () => {
    const unlocked: string[] = [];
    const liked: string[] = [];
    const c = card(confirmed('bb'.repeat(32)), {
      onLike: (id) => liked.push(id),
      locked: true,
      ownKey: PUB,
      onUnlock: async (p) => { unlocked.push(p); },
    });
    [...c.querySelectorAll('button')].find((b) => b.textContent === 'like')!.click();
    const form = c.querySelector('.card-unlock form.pf') as HTMLFormElement;
    expect(form).not.toBeNull(); // the unlock form appeared under the meta
    expect(liked).toHaveLength(0); // the like has not fired yet
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(unlocked).toEqual(['pw']); // the seed was unlocked
    expect(liked).toEqual(['p1']); // and the like proceeded
  });

  it('an unlocked like fires at once — no unlock form', () => {
    const liked: string[] = [];
    const c = card(confirmed('bb'.repeat(32)), { onLike: (id) => liked.push(id), locked: false, ownKey: PUB, onUnlock: async () => {} });
    [...c.querySelectorAll('button')].find((b) => b.textContent === 'like')!.click();
    expect(c.querySelector('.card-unlock')).toBeNull();
    expect(liked).toEqual(['p1']);
  });
});

describe('card — the author prefix and a locked vouch', () => {
  const AUTHOR = 'bb'.repeat(32);

  it('the card prefix is a button that opens the author window', () => {
    const opened: string[] = [];
    const c = card(confirmed(AUTHOR), { onAuthor: (k) => opened.push(k) });
    const btn = c.querySelector('.who .hex') as HTMLElement;
    expect(btn.tagName).toBe('BUTTON'); // a ghost button, not text — opening a window spends nothing
    expect(btn.getAttribute('aria-label')).toBe('open this author');
    btn.click();
    expect(opened).toEqual([AUTHOR]);
  });

  it('with no onAuthor the prefix stays text', () => {
    const btn = card(confirmed(AUTHOR)).querySelector('.who .hex') as HTMLElement;
    expect(btn.tagName).toBe('SPAN');
  });

  it('a locked vouch shows the unlock form under the meta on the press, then the vouch proceeds', async () => {
    const unlocked: string[] = [];
    const vouched: string[] = [];
    const c = card(confirmed(AUTHOR), {
      mark: { state: 'plus', count: 0 },
      onVouch: (k) => vouched.push(k),
      onAuthor: () => {},
      locked: true,
      ownKey: PUB,
      onUnlock: async (p) => { unlocked.push(p); },
    });
    (c.querySelector('.who .mark') as HTMLElement).click();
    const form = c.querySelector('.card-unlock form.pf') as HTMLFormElement;
    expect(form).not.toBeNull(); // the unlock form appeared under the meta, not by the mark up top
    expect(vouched).toHaveLength(0); // the vouch has not fired yet
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(unlocked).toEqual(['pw']);
    expect(vouched).toEqual([AUTHOR]);
  });

  it('an unlocked vouch fires at once — no unlock form', () => {
    const vouched: string[] = [];
    const c = card(confirmed(AUTHOR), { mark: { state: 'plus', count: 0 }, onVouch: (k) => vouched.push(k), onAuthor: () => {}, locked: false, ownKey: PUB, onUnlock: async () => {} });
    (c.querySelector('.who .mark') as HTMLElement).click();
    expect(c.querySelector('.card-unlock')).toBeNull();
    expect(vouched).toEqual([AUTHOR]);
  });
});
