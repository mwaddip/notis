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
    blockCreatedAt: null, likeCount: 0, descendantCount: 0, authorVouchCount: 0, likedByViewer: null,
  };
}
const stageText = (flight: Flight): string => card(pending('x'), { flight }).querySelector('.stage')?.textContent ?? '';

function confirmed(author: string): PostJson {
  return {
    id: 'p1', content: 'hello', contentHash: contentHashHex('hello'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorVouchCount: 0, likedByViewer: null,
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

describe('card — the content grammar', () => {
  const withContent = (content: string): PostJson => ({ ...confirmed(PUB), content, contentHash: contentHashHex(content) });

  it('a\\nb\\n\\nc renders one .card-content with two paragraphs, the first with a br', () => {
    const c = card(withContent('a\nb\n\nc'), {});
    const cc = c.querySelectorAll('.card-content');
    expect(cc).toHaveLength(1); // the wrapping element keeps the class
    const paras = cc[0]!.querySelectorAll('.card-para');
    expect(paras).toHaveLength(2);
    expect(paras[0]!.querySelector('br')).not.toBeNull(); // the newline inside the first paragraph
    expect(paras[1]!.querySelector('br')).toBeNull();
    expect(cc[0]!.textContent).toBe('abc'); // a br carries no text
  });

  it('a title line renders as .card-title, text as text', () => {
    const c = card(withContent('# Heading\nbody'), {});
    expect(c.querySelector('.card-title')?.textContent).toBe('Heading');
    expect(c.querySelector('.card-para')?.textContent).toBe('body');
  });

  it('a link card: the words as text, the host <a> with the author href and the four attributes', () => {
    const c = card(withContent('[the words](https://ok.com/a/b)'), {});
    const cc = c.querySelector('.card-content.link-card')!;
    expect(cc.querySelector('.lc-text')?.textContent).toBe('the words');
    const a = cc.querySelector('a.lc-host') as HTMLAnchorElement;
    expect(a.textContent).toBe('ok.com'); // the host, not the words — the only control that opens the target
    expect(a.getAttribute('href')).toBe('https://ok.com/a/b'); // the author's string, not normalised
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(a.getAttribute('title')).toBe('https://ok.com/a/b');
  });

  it('a bare-URL card shows the pathname (nothing when it is /)', () => {
    const path = card(withContent('https://ok.com/a/b'), {}).querySelector('.card-content.link-card')!;
    expect(path.querySelector('.lc-text')?.textContent).toBe('/a/b');
    expect(path.querySelector('a.lc-host')?.textContent).toBe('ok.com');
    const root = card(withContent('https://ok.com'), {}).querySelector('.card-content.link-card')!;
    expect(root.querySelector('.lc-text')).toBeNull();
    expect(root.querySelector('a.lc-host')?.getAttribute('href')).toBe('https://ok.com');
  });

  it('a link inside running text renders inline, not as a link card', () => {
    const c = card(withContent('see [x](https://ok.com) here'), {});
    expect(c.querySelector('.card-content.link-card')).toBeNull();
    const a = c.querySelector('.card-content a') as HTMLAnchorElement;
    expect(a.textContent).toBe('x');
    expect(a.getAttribute('href')).toBe('https://ok.com');
    expect(c.querySelector('.card-content')?.textContent).toBe('see x here');
  });

  it('bold renders <strong>, italic <em>, raw HTML as literal text', () => {
    const c = card(withContent('a **b** *c* <d>'), {});
    expect(c.querySelector('.card-content strong')?.textContent).toBe('b');
    expect(c.querySelector('.card-content em')?.textContent).toBe('c');
    expect(c.querySelector('.card-content')?.textContent).toBe('a b c <d>');
  });
});

describe('card — images', () => {
  const withContent = (content: string): PostJson => ({ ...confirmed(PUB), content, contentHash: contentHashHex(content) });
  const KEY0 = 'p1:0'; // <postId>:<image index in document order>

  it('an image card: the description as the card text, no img before the press, the control names the host', () => {
    const c = card(withContent('![a red circle](https://img.example/pic.png)'), { onExpand: () => {} });
    const cc = c.querySelector('.card-content.link-card')!;
    expect(cc.querySelector('img')).toBeNull(); // no img element before the press
    expect(cc.querySelector('.lc-text')?.textContent).toBe('a red circle');
    const btn = cc.querySelector('.img-show') as HTMLButtonElement;
    expect(btn.textContent).toContain('show image from');
    expect(btn.querySelector('.host')?.textContent).toBe('img.example');
  });

  it('the press swaps in the img (referrerpolicy, the description as alt) and calls onExpand with the key', () => {
    const expanded: string[] = [];
    const c = card(withContent('![a red circle](https://img.example/pic.png)'), { onExpand: (k) => expanded.push(k) });
    (c.querySelector('.img-show') as HTMLButtonElement).click();
    const img = c.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('https://img.example/pic.png');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('alt')).toBe('a red circle'); // the description stays, as the alt
    expect(c.querySelector('.img-show')).toBeNull(); // the control is gone
    expect(expanded).toEqual([KEY0]);
  });

  it('a render with the key in expanded produces the img directly, no control', () => {
    const c = card(withContent('![x](https://img.example/pic.png)'), { expanded: new Set([KEY0]) });
    expect(c.querySelector('img')).not.toBeNull();
    expect(c.querySelector('.img-show')).toBeNull();
  });

  it('an image error says so in place and drops the key through onCollapse', () => {
    const collapsed: string[] = [];
    const c = card(withContent('![x](https://img.example/pic.png)'), { expanded: new Set([KEY0]), onCollapse: (k) => collapsed.push(k) });
    (c.querySelector('img') as HTMLImageElement).dispatchEvent(new Event('error'));
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('.img-failed')?.textContent).toContain('the image did not load from');
    expect(c.querySelector('.img-failed .host')?.textContent).toBe('img.example');
    expect(collapsed).toEqual([KEY0]);
  });

  it('an expanded image with a blank description still carries an alt: image from the host', () => {
    const c = card(withContent('https://img.example/pic.png'), { expanded: new Set([KEY0]) });
    expect((c.querySelector('img') as HTMLImageElement).getAttribute('alt')).toBe('image from img.example');
  });

  it('a bare image URL is an image control; .svg is a bare-URL link', () => {
    expect(card(withContent('https://img.example/pic.PNG'), {}).querySelector('.img-show')).not.toBeNull();
    const svg = card(withContent('https://img.example/pic.svg'), {});
    expect(svg.querySelector('.img-show')).toBeNull();
    expect(svg.querySelector('a.lc-host')).not.toBeNull();
  });

  it('an inline image shows the alt as text then the control, no img before the press', () => {
    const c = card(withContent('look ![cat](https://img.example/c.jpg) here'), { onExpand: () => {} });
    expect(c.querySelector('.card-content.link-card')).toBeNull(); // inline, not a link card
    expect(c.querySelector('img')).toBeNull();
    const cc = c.querySelector('.card-content')!;
    expect(cc.textContent).toContain('look cat show image from');
    expect(cc.querySelector('.img-show .host')?.textContent).toBe('img.example');
  });
});

describe('card — the reply count is the row\'s', () => {
  it('the row\'s descendantCount reads "2 replies" / "1 reply"', () => {
    const two = { ...confirmed(PUB), descendantCount: 2 };
    expect(card(two, { replyCount: two.descendantCount }).querySelector('.replies')?.textContent).toBe('2 replies');
    const one = { ...confirmed(PUB), descendantCount: 1 };
    expect(card(one, { replyCount: one.descendantCount }).querySelector('.replies')?.textContent).toBe('1 reply');
  });

  it('a descendantCount of 0 renders no count line', () => {
    const zero = { ...confirmed(PUB), descendantCount: 0 };
    expect(card(zero, { replyCount: zero.descendantCount }).querySelector('.replies')).toBeNull();
  });

  it('a withdrawn card shows its row\'s count, never ?', () => {
    const tomb = { kind: 'withdrawn' as const, id: 'p1', author: PUB, withdrawnAtHeight: 10, parentRefs: [], descendantCount: 4, authorVouchCount: 0 };
    expect(card(tomb, { replyCount: tomb.descendantCount }).querySelector('.replies')?.textContent).toBe('4 replies');
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

describe('card — the liked state carries you liked this', () => {
  it('the liked span has title and aria-label you liked this', () => {
    const p = { ...confirmed('bb'.repeat(32)), likeCount: 3 };
    const c = card(p, { liked: true, likePending: false });
    const liked = c.querySelector('.liked')!;
    expect(liked.getAttribute('title')).toBe('you liked this');
    expect(liked.getAttribute('aria-label')).toBe('you liked this');
  });
  it('the pending like also carries the label', () => {
    const p = { ...confirmed('bb'.repeat(32)), likeCount: 3 };
    const c = card(p, { liked: true, likePending: true });
    const liked = c.querySelector('.liked')!;
    expect(liked.getAttribute('aria-label')).toBe('you liked this');
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

});

describe('card — the withdraw control', () => {
  const OTHER = 'bb'.repeat(32);
  const ownWithLikes = (): PostJson => ({ ...confirmed(PUB), likeCount: 3 });
  const metaWithdraw = (c: HTMLElement): HTMLButtonElement => c.querySelector('.meta .withdraw-ctl') as HTMLButtonElement;
  const confirmBtn = (c: HTMLElement, text: string): HTMLButtonElement =>
    [...c.querySelector('.card-confirm')!.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

  it('an own confirmed card keeps the like count N liked, the withdraw control after it, no like word', () => {
    const c = card(ownWithLikes(), { you: true, onWithdraw: () => {}, canWithdraw: true, onReply: () => {} });
    expect(metaWithdraw(c)).not.toBeNull();
    const count = c.querySelector('.meta .liked');
    expect(count).not.toBeNull();
    expect(count!.textContent).toContain('3');
    expect(count!.textContent).toContain('liked');
    expect(count!.nextElementSibling).toBe(metaWithdraw(c));
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
    expect(p.querySelector('.withdraw-ctl')).toBeNull();
    const count = p.querySelector('.meta .liked');
    expect(count).not.toBeNull();
    expect(count!.textContent).toContain('liked');
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
    const tomb = { kind: 'withdrawn' as const, id: 'p1', author: PUB, withdrawnAtHeight: 10, parentRefs: [], descendantCount: 0, authorVouchCount: 0 };
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

describe('card — link', () => {
  const URL = 'http://localhost/p/' + 'ab'.repeat(32);

  it('the copy glyph appears after ↩ reply as the meta row\'s last child', () => {
    const c = card(confirmed('bb'.repeat(32)), {
      onReply: () => {},  linkUrl: URL,
    });
    const meta = c.querySelector('.meta')!;
    const linkbtn = meta.querySelector('.linkbtn')!;
    expect(linkbtn).not.toBeNull();
    expect(linkbtn.querySelector('svg')).not.toBeNull();
    expect(meta.lastElementChild).toBe(linkbtn);
  });

  it('absent when no linkUrl is set', () => {
    const c = card(confirmed('bb'.repeat(32)));
    expect(c.querySelector('.linkbtn')).toBeNull();
  });

  it('present on a withdrawn card', () => {
    const c = card(
      { kind: 'withdrawn', id: 'w1', author: 'cc'.repeat(32), withdrawnAtHeight: 5, parentRefs: [], descendantCount: 0, authorVouchCount: 0 },
      { onReply: () => {},  linkUrl: URL },
    );
    expect(c.querySelector('.linkbtn')).toBeTruthy();
  });

  it('copied after a press with the clipboard stubbed', async () => {
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (text: string) => { copied = text; return Promise.resolve(); } },
      writable: true, configurable: true,
    });
    const c = card(confirmed('bb'.repeat(32)), {
      onReply: () => {},  linkUrl: URL,
    });
    document.body.appendChild(c);
    c.querySelector<HTMLButtonElement>('.linkbtn')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(copied).toBe(URL);
    expect(c.querySelector('.linkbtn')!.textContent).toBe('copied');
    c.remove();
  });

  it('the fallback row appears when the clipboard is absent', () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined, writable: true, configurable: true,
    });
    const c = card(confirmed('bb'.repeat(32)), {
      onReply: () => {},  linkUrl: URL,
    });
    document.body.appendChild(c);
    c.querySelector<HTMLButtonElement>('.linkbtn')!.click();
    expect(c.querySelector('.card-link')).toBeTruthy();
    expect(c.querySelector('.linkbtn svg')).not.toBeNull();
    c.remove();
  });
});

describe('card — feed-shaped: like and link without reply or withdraw', () => {
  const OTHER = 'bb'.repeat(32);
  const URL = 'http://localhost/p/' + OTHER;

  it('the link follows the like word on a feed card', () => {
    const c = card({ ...confirmed(OTHER), likeCount: 2 }, { onLike: () => {}, linkUrl: URL });
    const meta = c.querySelector('.meta')!;
    const likeWord = [...meta.querySelectorAll('button')].find((b) => b.textContent === 'like')!;
    const linkbtn = meta.querySelector('.linkbtn')!;
    expect(likeWord).not.toBeNull();
    expect(linkbtn).not.toBeNull();
    const children = [...meta.children];
    expect(children.indexOf(linkbtn)).toBeGreaterThan(children.indexOf(likeWord));
  });

  it('the read-only count N liked and link on the reader\'s own post, no like word', () => {
    const own = { ...confirmed(PUB), likeCount: 5 };
    const c = card(own, { you: true, linkUrl: URL });
    const liked = c.querySelector('.meta .liked');
    expect(liked).not.toBeNull();
    expect(liked!.textContent).toContain('5');
    expect(liked!.textContent).toContain('liked');
    expect(c.querySelector('.linkbtn')).not.toBeNull();
  });

  it('no controls on a pending card', () => {
    const p: PostJson = { ...confirmed(OTHER), status: 'pending', blockHeight: null };
    const c = card(p, {});
    expect(c.querySelector('.likebtn')).toBeNull();
    expect(c.querySelector('.linkbtn')).toBeNull();
  });
});
