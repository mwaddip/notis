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
    (c.querySelector('.who .vmark') as HTMLElement).click();
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
    (c.querySelector('.who .vmark') as HTMLElement).click();
    expect(c.querySelector('.card-unlock')).toBeNull();
    expect(vouched).toEqual([AUTHOR]);
  });
});

describe('card — the withdraw control', () => {
  const OTHER = 'bb'.repeat(32);
  const ownWithLikes = (): PostJson => ({ ...confirmed(PUB), likeCount: 3 });
  const metaWithdraw = (c: HTMLElement): HTMLButtonElement => c.querySelector('.meta .withdraw-ctl') as HTMLButtonElement;
  const confirmBtn = (c: HTMLElement, text: string): HTMLButtonElement =>
    [...c.querySelector('.card-confirm')!.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

  it('an own confirmed card keeps the read-only like count, the withdraw control after it, no like button', () => {
    const c = card(ownWithLikes(), { you: true, onWithdraw: () => {}, canWithdraw: true, onReply: () => {} });
    expect(metaWithdraw(c)).not.toBeNull();
    // No like BUTTON — the self-like is withheld — but the read-only count stays.
    expect(c.querySelector('.likebtn')).toBeNull();
    const count = c.querySelector('.meta .like');
    expect(count).not.toBeNull();
    expect(count!.textContent).toContain('3');
    // The withdraw control follows the count.
    expect(count!.nextElementSibling).toBe(metaWithdraw(c));
    // · you stays a span, and reply follows.
    expect(c.querySelector('.you')?.textContent).toBe('· you');
    expect(c.querySelector('.meta .reply-ctl')).not.toBeNull();
  });

  it('a press mounts the confirm row after the meta: the sentence, withdraw and keep, focus on keep', () => {
    const c = card(confirmed(PUB), { you: true, onWithdraw: () => {}, canWithdraw: true });
    document.body.appendChild(c); // focus() needs the node in the document
    metaWithdraw(c).click();
    const row = c.querySelector('.card-confirm');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.q')?.textContent).toBe('withdraw this post? the content goes; the replies stay.');
    expect([...row!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['withdraw', 'keep']);
    // One row, mounted right after the meta.
    expect(c.querySelector('.meta')!.nextElementSibling).toBe(row);
    expect(document.activeElement?.textContent).toBe('keep');
    // A second press opens no second row.
    metaWithdraw(c).click();
    expect(c.querySelectorAll('.card-confirm')).toHaveLength(1);
    c.remove();
  });

  it('keep removes the row and signs nothing; the confirm withdraw calls onWithdraw', () => {
    const withdrawn: string[] = [];
    const c = card(confirmed(PUB), { you: true, onWithdraw: (id) => withdrawn.push(id), canWithdraw: true });
    document.body.appendChild(c);
    metaWithdraw(c).click();
    confirmBtn(c, 'keep').click();
    expect(c.querySelector('.card-confirm')).toBeNull();
    expect(withdrawn).toEqual([]);
    // Press again, and this time confirm.
    metaWithdraw(c).click();
    confirmBtn(c, 'withdraw').click();
    expect(withdrawn).toEqual(['p1']);
    c.remove();
  });

  it('locked: the confirm withdraw mounts the unlock form in the row\'s place, then withdraws', async () => {
    const unlocked: string[] = [];
    const withdrawn: string[] = [];
    const c = card(confirmed(PUB), {
      you: true, onWithdraw: (id) => withdrawn.push(id), canWithdraw: true,
      locked: true, ownKey: PUB, onUnlock: async (p) => { unlocked.push(p); },
    });
    document.body.appendChild(c);
    metaWithdraw(c).click();
    confirmBtn(c, 'withdraw').click();
    expect(c.querySelector('.card-confirm')).toBeNull(); // the confirm made way for the unlock
    const form = c.querySelector('.card-unlock form.pf') as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(withdrawn).toHaveLength(0); // nothing signed yet
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(unlocked).toEqual(['pw']);
    expect(withdrawn).toEqual(['p1']);
    c.remove();
  });

  it('canWithdraw false renders the button disabled with the reason as the title', () => {
    const c = card(confirmed(PUB), { you: true, onWithdraw: () => {}, canWithdraw: false });
    const wb = metaWithdraw(c);
    expect(wb.disabled).toBe(true);
    expect(wb.title).toBe('needs one karma box to sign with; this key has none');
    // A disabled control opens no confirm row.
    document.body.appendChild(c);
    wb.click();
    expect(c.querySelector('.card-confirm')).toBeNull();
    c.remove();
  });

  it("withdraw 'pending' renders the stage line submitted, the like count staying beside it; an expired flight the sentence and try again", () => {
    const p = card(ownWithLikes(), { you: true, withdraw: 'pending' });
    expect(p.querySelector('.stage')?.textContent).toBe('submitted');
    expect(p.querySelector('.withdraw-ctl')).toBeNull(); // the flight replaces the button, not the count
    // The count stays beside the stage line.
    const count = p.querySelector('.meta .like');
    expect(count).not.toBeNull();
    expect(count!.nextElementSibling).toBe(p.querySelector('.stage'));
    const onTryAgain = vi.fn();
    const e = card(confirmed(PUB), { you: true, withdraw: { stage: 'expired', expiresAtHeight: 7000, onTryAgain } });
    const text = e.querySelector('.stage')!.textContent!;
    expect(text).toContain('no block took this by height');
    expect(text).toContain('7,000');
    [...e.querySelectorAll('button')].find((b) => b.textContent === 'try again')!.click();
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });

  it('no withdraw control on another\'s card, a pending card, or a withdrawn card', () => {
    expect(card(confirmed(OTHER), { onLike: () => {} }).querySelector('.withdraw-ctl')).toBeNull();
    expect(card(pending('x'), { you: true, onWithdraw: () => {}, canWithdraw: true }).querySelector('.withdraw-ctl')).toBeNull();
    const tomb = { kind: 'withdrawn' as const, id: 'p1', author: PUB, withdrawnAtHeight: 10, parentRefs: [] };
    expect(card(tomb, { you: true, onWithdraw: () => {}, canWithdraw: true }).querySelector('.withdraw-ctl')).toBeNull();
  });

  it('the word delete appears nowhere on the control or its confirm row', () => {
    const c = card(confirmed(PUB), { you: true, onWithdraw: () => {}, canWithdraw: true });
    document.body.appendChild(c);
    metaWithdraw(c).click();
    expect(c.textContent!.toLowerCase()).not.toContain('delete');
    // aria-labels and titles too, not only visible text.
    for (const b of c.querySelectorAll('button')) {
      expect((b.getAttribute('aria-label') ?? '').toLowerCase()).not.toContain('delete');
      expect((b.title ?? '').toLowerCase()).not.toContain('delete');
    }
    c.remove();
  });
});
