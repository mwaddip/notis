// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { card, cardLink, mountRow, submissionToPost } from '../src/view/card';
import { buildUnlockRow, buildConfirmRow, buildLinkFallbackRow } from '../src/view/card-rows';
import type { LightJson, PostJson } from '../src/api/dto';
import type { CardRow, Flight } from '../src/view/card';
import { contentHashHex } from '../src/integrity';

const appCss = readFileSync(resolve(process.cwd(), 'src/style/app.css'), 'utf8');

// The stage line's copy — two stages then one of three endings. The endings say
// what happened, never a status code (HOUSE_STYLE → Voice).

const PUB = 'aa'.repeat(32);
function pending(content: string): PostJson {
  return {
    id: 'local1', content, contentHash: contentHashHex(content), author: PUB, parentRefs: [],
    protocolVersion: 0, type: 'regular', status: 'pending', blockHeight: null, blockIndex: null,
    blockCreatedAt: null, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
  };
}
const stageText = (flight: Flight): string => card(pending('x'), { flight }).querySelector('.stage')?.textContent ?? '';

function confirmed(author: string): PostJson {
  return {
    id: 'p1', content: 'hello', contentHash: contentHashHex('hello'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
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
    const tomb = { kind: 'withdrawn' as const, id: 'p1', author: PUB, withdrawnAtHeight: 10, parentRefs: [], descendantCount: 4, authorName: null, txId: 'aa'.repeat(32) };
    expect(card(tomb, { replyCount: tomb.descendantCount }).querySelector('.replies')?.textContent).toBe('4 replies');
  });
});

// WEB_INTERFACE → What the feed reads, and what a card shows for it →
// "A row's controls act on the card as it stands at the press" — the card
// reads no lock and mounts no row: a press is handed on with the post and the
// control pressed.
describe('card — like', () => {
  it('a press hands on the post and the control pressed; the card mounts no row', () => {
    const liked: Array<[string, HTMLElement]> = [];
    const c = card(confirmed('bb'.repeat(32)), { onLike: (id, control) => liked.push([id, control]) });
    const likeBtn = [...c.querySelectorAll('button')].find((b) => b.textContent === 'like')!;
    likeBtn.click();
    expect(liked).toEqual([['p1', likeBtn]]);
    expect(c.querySelector('.card-unlock')).toBeNull();
  });

  it('buildUnlockRow — submit unlocks then proceeds; cancel and Esc cancel; the field is the passphrase field', async () => {
    const unlocked: string[] = [];
    const proceeded: string[] = [];
    const cancelled: string[] = [];
    const { row, field } = buildUnlockRow({
      pubKeyHex: PUB,
      onSubmit: async (p) => { unlocked.push(p); },
      onProceed: () => { proceeded.push('.'); },
      onCancel: () => { cancelled.push('.'); },
    });
    expect(row.classList.contains('card-unlock')).toBe(true);
    expect(field).toBe(row.querySelector('input[type="password"]'));
    field.value = 'pw';
    (row.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(unlocked).toEqual(['pw']);
    expect(proceeded).toEqual(['.']);
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'cancel')!.click();
    expect(cancelled).toEqual(['.']);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancelled).toEqual(['.', '.']);
  });

  it('buildUnlockRow — a refused passphrase proceeds to nothing', async () => {
    const proceeded: string[] = [];
    const { row, field } = buildUnlockRow({
      pubKeyHex: PUB,
      onSubmit: async () => { throw new Error('that passphrase does not open this identity.'); },
      onProceed: () => { proceeded.push('.'); },
      onCancel: () => {},
    });
    document.body.appendChild(row);
    field.value = 'wrong';
    (row.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(proceeded).toEqual([]);
    expect(row.querySelector('.pf-refusal')?.textContent).toBe('that passphrase does not open this identity.');
    row.remove();
  });
});

// WEB_INTERFACE → What the feed reads, and what a card shows for it →
// "Opening a row and ending one redraw nothing else".
describe('card — a row goes in under the card a control stands in', () => {
  const rowOf = (control: CardRow['control']): CardRow => ({ control, el: document.createElement('div') });

  it('mountRow puts the unlock form or the question directly beneath the meta row, the link row beneath that, and replaces no node', () => {
    const c = card(confirmed('bb'.repeat(32)), { onLike: () => {} });
    document.body.appendChild(c);
    const body = c.querySelector('.card-body')!;
    const before = [...body.children];
    const likeBtn = [...c.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === 'like')!;
    const link = rowOf('link');
    expect(mountRow(likeBtn, link)).toBe(true);
    expect([...body.children]).toEqual([...before, link.el]);
    // A row already under the card names the same card.
    const ask = rowOf('like');
    expect(mountRow(link.el, ask)).toBe(true);
    expect(c.querySelector('.meta')!.nextElementSibling).toBe(ask.el);
    expect([...body.children]).toEqual([...before, ask.el, link.el]);
    c.remove();
  });

  it('mountRow answers false for a control that stands in no card on screen', () => {
    const c = card(confirmed('bb'.repeat(32)), { onLike: () => {} });
    const likeBtn = [...c.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === 'like')!;
    const row = rowOf('like');
    expect(mountRow(likeBtn, row)).toBe(false); // the card is not in the document
    expect(row.el.parentElement).toBeNull();
    const loose = document.createElement('button');
    document.body.appendChild(loose);
    expect(mountRow(loose, row)).toBe(false); // in the document, in no card
    loose.remove();
  });
});

// WEB_INTERFACE → What the feed reads, and what a card shows for it →
// "A row the reader opened under a card outlasts a redraw of its list" — a
// card stands over a held row while it offers the control the row was opened
// from.
describe('card — a card stands over the rows whose control it offers', () => {
  const OTHER = 'bb'.repeat(32);
  const link = { url: 'http://localhost/p/x', refused: (): void => {} };
  const rows = (): { like: CardRow; withdraw: CardRow; link: CardRow; all: CardRow[] } => {
    const like: CardRow = { control: 'like', el: document.createElement('div') };
    const withdraw: CardRow = { control: 'withdraw', el: document.createElement('div') };
    const linkRow: CardRow = { control: 'link', el: document.createElement('div') };
    return { like, withdraw, link: linkRow, all: [like, withdraw, linkRow] };
  };
  const under = (c: HTMLElement): Element[] => {
    const kids = [...c.querySelector('.card-body')!.children];
    return kids.slice(kids.indexOf(c.querySelector('.meta')!) + 1);
  };

  it('another\'s card with like and the copy glyph: the like row beneath the meta row, the link row beneath it, no withdraw row', () => {
    const r = rows();
    const c = card(confirmed(OTHER), { onLike: () => {}, link, rows: r.all });
    expect(under(c)).toEqual([r.like.el, r.link.el]);
    expect(r.withdraw.el.parentElement).toBeNull();
  });

  it('a card with the reader\'s like on it offers no like: the like row is not drawn, the link row is', () => {
    const r = rows();
    const c = card(confirmed(OTHER), { liked: true, likePending: true, link, rows: r.all });
    expect(under(c)).toEqual([r.link.el]);
  });

  it('the reader\'s own card: the withdraw row while withdraw can be pressed, none while it is disabled or in flight', () => {
    const offered = rows();
    expect(under(card(confirmed(PUB), { onWithdraw: () => {}, canWithdraw: true, rows: offered.all }))).toEqual([offered.withdraw.el]);
    const disabled = rows();
    expect(under(card(confirmed(PUB), { onWithdraw: () => {}, canWithdraw: false, rows: disabled.all }))).toEqual([]);
    const flying = rows();
    expect(under(card(confirmed(PUB), { onWithdraw: () => {}, canWithdraw: true, withdraw: 'pending', rows: flying.all }))).toEqual([]);
  });

  it('a withdrawn card keeps its copy glyph and so its link row, and no other', () => {
    const r = rows();
    const tomb = { kind: 'withdrawn' as const, id: 'p1', author: OTHER, withdrawnAtHeight: 10, parentRefs: [], descendantCount: 0, authorName: null, txId: 'aa'.repeat(32) };
    expect(under(card(tomb, { link, rows: r.all }))).toEqual([r.link.el]);
    const bare = rows();
    expect(under(card(tomb, { rows: bare.all }))).toEqual([]);
  });

  it('a pending card and a slot offer no control and draw no row', () => {
    const r = rows();
    const p: PostJson = { ...confirmed(OTHER), status: 'pending', blockHeight: null };
    expect(under(card(p, { onLike: () => {}, link, rows: r.all }))).toEqual([]);
    const slot: LightJson = {
      kind: 'light', id: 'p1', parentRefs: [], status: 'confirmed', blockHeight: 1, blockIndex: 0, blockCreatedAt: 0,
      likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    };
    expect(under(card(slot, { rows: r.all }))).toEqual([]);
  });

  it('cardLink carries the URL and hands a refusal on with the list, the post and the control', () => {
    const refused: unknown[] = [];
    const opt = cardLink('feed', 'p1', { linkUrl: (id) => 'http://localhost/p/' + id }, {
      linkRefused: (list, postId, url, control) => { refused.push([list, postId, url, control]); },
    });
    expect(opt.url).toBe('http://localhost/p/p1');
    const glyph = document.createElement('button');
    opt.refused(glyph);
    expect(refused).toEqual([['feed', 'p1', 'http://localhost/p/p1', glyph]]);
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

describe('card — the handle where a row carries a name', () => {
  const AUTHOR = 'bb'.repeat(32);
  const named = (name: string): PostJson => ({ ...confirmed(AUTHOR), authorName: name });

  it('the who row shows the handle @Name as a .handle button when onAuthor is present', () => {
    const opened: string[] = [];
    const c = card(named('Alice'), { onAuthor: (k) => opened.push(k) });
    const btn = c.querySelector('.who .handle') as HTMLElement;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toBe('@Alice');
    expect(btn.classList.contains('authorbtn')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('open this author');
    btn.click();
    expect(opened).toEqual([AUTHOR]);
  });

  it('the who row shows the handle as a .handle span when no onAuthor', () => {
    const c = card(named('Bob'));
    const span = c.querySelector('.who .handle') as HTMLElement;
    expect(span.tagName).toBe('SPAN');
    expect(span.textContent).toBe('@Bob');
    expect(c.querySelector('.who .hex')).toBeNull();
  });

  it('no authorName falls back to the hex prefix', () => {
    const c = card(confirmed(AUTHOR), { onAuthor: () => {} });
    expect(c.querySelector('.who .hex')).not.toBeNull();
    expect(c.querySelector('.who .handle')).toBeNull();
  });

  it('the submission card carries the reader\'s own name when passed', () => {
    const sub = { localKey: 'lk', content: 'hi', parentId: null, author: PUB, contentHash: contentHashHex('hi'), stage: 'submitting' as const, txId: null, postId: null, blockHeight: null, expiresAtHeight: null, reason: null };
    const p = submissionToPost(sub, 'MyName');
    expect(p.authorName).toBe('MyName');
    const pNone = submissionToPost(sub);
    expect(pNone.authorName).toBeNull();
  });

  it('the .who .handle button computes font-weight 600 and ink under the stylesheet', () => {
    const style = document.createElement('style');
    style.textContent = appCss;
    document.head.appendChild(style);
    const c = card({ ...confirmed('bb'.repeat(32)), authorName: 'Test' }, { onAuthor: () => {} });
    document.body.appendChild(c);
    const btn = c.querySelector('.who .handle.authorbtn') as HTMLElement;
    const s = window.getComputedStyle(btn);
    expect(s.fontWeight).toBe('600');
    expect(s.color).toBe('#2A2419');
    document.body.removeChild(c);
    document.head.removeChild(style);
  });
});

// WEB_INTERFACE → The withdraw control — the card's `withdraw` hands its press
// on with the post and the control pressed; the question's own words and
// controls are the row builder's, and its opening under the card, the focus on
// `keep` and its endings are the App's (app-card-rows.test.ts).
describe('card — the withdraw control', () => {
  const OTHER = 'bb'.repeat(32);
  const ownWithLikes = (): PostJson => ({ ...confirmed(PUB), likeCount: 3 });
  const metaWithdraw = (c: HTMLElement): HTMLButtonElement => c.querySelector('.meta .withdraw-ctl') as HTMLButtonElement;

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

  it('a press hands on the post and the control pressed; the card mounts no row', () => {
    const asked: Array<[string, HTMLElement]> = [];
    const c = card(confirmed(PUB), { you: true, onWithdraw: (id, control) => { asked.push([id, control]); }, canWithdraw: true });
    document.body.appendChild(c);
    metaWithdraw(c).click();
    expect(asked).toEqual([['p1', metaWithdraw(c)]]);
    expect(c.querySelector('.card-confirm')).toBeNull();
    c.remove();
  });

  it('canWithdraw false renders the button disabled with the reason as the title', () => {
    const asked: string[] = [];
    const c = card(confirmed(PUB), { you: true, onWithdraw: (id) => { asked.push(id); }, canWithdraw: false });
    const wb = metaWithdraw(c);
    expect(wb.disabled).toBe(true);
    expect(wb.title).toBe('needs one rep box to sign with; this key has none');
    document.body.appendChild(c);
    wb.click();
    expect(asked).toEqual([]);
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
    const tomb = { kind: 'withdrawn' as const, id: 'p1', author: PUB, withdrawnAtHeight: 10, parentRefs: [], descendantCount: 0, authorName: null, txId: 'aa'.repeat(32) };
    expect(card(tomb, { you: true, onWithdraw: () => {}, canWithdraw: true }).querySelector('.withdraw-ctl')).toBeNull();
  });

  it('buildConfirmRow — the sentence, withdraw and keep; keep and Esc run onKeep, withdraw runs onYes', () => {
    const yes: string[] = [];
    const kept: string[] = [];
    const { row, keep } = buildConfirmRow({
      onYes: () => { yes.push('.'); },
      onKeep: () => { kept.push('.'); },
    });
    expect(row.classList.contains('card-confirm')).toBe(true);
    expect(row.querySelector('.q')?.textContent).toBe('withdraw this post? the content goes; the replies stay.');
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['withdraw', 'keep']);
    expect(keep).toBe([...row.querySelectorAll('button')].find((b) => b.textContent === 'keep'));
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'withdraw')!.click();
    expect(yes).toEqual(['.']);
    keep.click();
    expect(kept).toEqual(['.']);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(kept).toEqual(['.', '.']);
  });

  it('the word delete appears nowhere on the control or in the confirm row builder', () => {
    const c = card(confirmed(PUB), { you: true, onWithdraw: () => {}, canWithdraw: true });
    for (const b of c.querySelectorAll('button')) {
      expect((b.getAttribute('aria-label') ?? '').toLowerCase()).not.toContain('delete');
      expect((b.title ?? '').toLowerCase()).not.toContain('delete');
    }
    const { row } = buildConfirmRow({ onYes: () => {}, onKeep: () => {} });
    expect(row.textContent!.toLowerCase()).not.toContain('delete');
    for (const b of row.querySelectorAll('button')) {
      expect((b.getAttribute('aria-label') ?? '').toLowerCase()).not.toContain('delete');
    }
  });
});

describe('card — link', () => {
  const URL = 'http://localhost/p/' + 'ab'.repeat(32);
  const link = { url: URL, refused: (): void => {} };

  it('the copy glyph appears after ↩ reply as the meta row\'s last child', () => {
    const c = card(confirmed('bb'.repeat(32)), {
      onReply: () => {},  link,
    });
    const meta = c.querySelector('.meta')!;
    const linkbtn = meta.querySelector('.linkbtn')!;
    expect(linkbtn).not.toBeNull();
    expect(linkbtn.querySelector('svg')).not.toBeNull();
    expect(meta.lastElementChild).toBe(linkbtn);
  });

  it('absent when no link is set', () => {
    const c = card(confirmed('bb'.repeat(32)));
    expect(c.querySelector('.linkbtn')).toBeNull();
  });

  it('present on a withdrawn card', () => {
    const c = card(
      { kind: 'withdrawn', id: 'w1', author: 'cc'.repeat(32), withdrawnAtHeight: 5, parentRefs: [], descendantCount: 0, authorName: null, txId: 'aa'.repeat(32) },
      { onReply: () => {},  link },
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
      onReply: () => {},  link,
    });
    document.body.appendChild(c);
    c.querySelector<HTMLButtonElement>('.linkbtn')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(copied).toBe(URL);
    expect(c.querySelector('.linkbtn')!.textContent).toBe('copied');
    c.remove();
  });

  it('where the clipboard is absent the press is handed on with the glyph; the card mounts no row and the glyph stays', () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined, writable: true, configurable: true,
    });
    const asked: HTMLElement[] = [];
    const c = card(confirmed('bb'.repeat(32)), {
      onReply: () => {},
      link: { url: URL, refused: (control) => { asked.push(control); } },
    });
    document.body.appendChild(c);
    const glyph = c.querySelector<HTMLButtonElement>('.linkbtn')!;
    glyph.click();
    expect(asked).toEqual([glyph]);
    expect(c.querySelector('.card-link')).toBeNull();
    expect(c.querySelector('.linkbtn svg')).not.toBeNull();
    c.remove();
  });

  it('a refused clipboard write hands the press on the same way', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('refused')) },
      writable: true, configurable: true,
    });
    const asked: HTMLElement[] = [];
    const c = card(confirmed('bb'.repeat(32)), {
      link: { url: URL, refused: (control) => { asked.push(control); } },
    });
    document.body.appendChild(c);
    const glyph = c.querySelector<HTMLButtonElement>('.linkbtn')!;
    glyph.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([glyph]);
    c.remove();
  });

  it('buildLinkFallbackRow renders the url as text with the copy-by-hand suffix', () => {
    const row = buildLinkFallbackRow(URL);
    expect(row.classList.contains('card-link')).toBe(true);
    expect(row.querySelector('.hex')?.textContent).toBe(URL);
    expect(row.textContent).toContain(' — copy it by hand');
  });
});

describe('card — feed-shaped: like and link without reply or withdraw', () => {
  const OTHER = 'bb'.repeat(32);
  const link = { url: 'http://localhost/p/' + OTHER, refused: (): void => {} };

  it('the link follows the like word on a feed card', () => {
    const c = card({ ...confirmed(OTHER), likeCount: 2 }, { onLike: () => {}, link });
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
    const c = card(own, { you: true, link });
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

describe('card — a handle the chain does not back is clay', () => {
  // WEB_INTERFACE → The identity display — in the extension a handle the chain
  // does not back is clay: the text alone, the same control and handler, the
  // same face, weight and size (→ The extension → "The verified names").
  const AUTHOR = 'bb'.repeat(32);
  const named = (name: string): PostJson => ({ ...confirmed(AUTHOR), authorName: name });
  const clayFor = (key: string, name: string) => (k: string, n: string): boolean => k === key && n === name;

  it('a clay pair: the who row\'s button carries clay beside what it carries — the same control, label and handler', () => {
    const opened: string[] = [];
    const c = card(named('Alice'), { onAuthor: (k) => opened.push(k), nameClay: clayFor(AUTHOR, 'Alice') });
    const btn = c.querySelector('.who .handle') as HTMLElement;
    expect(btn.tagName).toBe('BUTTON');
    expect([...btn.classList]).toEqual(['handle', 'authorbtn', 'clay']);
    expect(btn.textContent).toBe('@Alice');
    expect(btn.getAttribute('aria-label')).toBe('open this author');
    btn.click();
    expect(opened).toEqual([AUTHOR]);
  });

  it('an ink pair renders as today — the button\'s classes are handle authorbtn alone', () => {
    const c = card(named('Alice'), { onAuthor: () => {}, nameClay: () => false });
    expect([...(c.querySelector('.who .handle') as HTMLElement).classList]).toEqual(['handle', 'authorbtn']);
    const none = card(named('Alice'), { onAuthor: () => {} });
    expect([...(none.querySelector('.who .handle') as HTMLElement).classList]).toEqual(['handle', 'authorbtn']);
  });

  it('the predicate is asked with the row\'s key and name, as the row carries them', () => {
    const asked: Array<[string, string]> = [];
    card({ ...named('MiXed_1'), author: AUTHOR.toUpperCase() }, { onAuthor: () => {}, nameClay: (k, n) => { asked.push([k, n]); return false; } });
    expect(asked).toEqual([[AUTHOR.toUpperCase(), 'MiXed_1']]);
  });

  it('the span a card shows with no author control goes clay too, and an ink pair\'s span stays handle alone', () => {
    const clay = card(named('Bob'), { nameClay: clayFor(AUTHOR, 'Bob') }).querySelector('.who .handle') as HTMLElement;
    expect(clay.tagName).toBe('SPAN');
    expect([...clay.classList]).toEqual(['handle', 'clay']);
    expect(clay.textContent).toBe('@Bob');
    const ink = card(named('Bob'), { nameClay: clayFor(AUTHOR, 'bob') }).querySelector('.who .handle') as HTMLElement;
    expect([...ink.classList]).toEqual(['handle']);
  });

  it('the withdrawn card\'s who row reads the same predicate', () => {
    const tomb = { kind: 'withdrawn' as const, id: 'p1', author: AUTHOR, withdrawnAtHeight: 10, parentRefs: [], descendantCount: 0, authorName: 'Alice', txId: 'aa'.repeat(32) };
    const clay = card(tomb, { onAuthor: () => {}, nameClay: clayFor(AUTHOR, 'Alice') });
    expect(clay.querySelector('.who .handle.clay')?.textContent).toBe('@Alice');
    const ink = card(tomb, { onAuthor: () => {}, nameClay: () => false });
    expect(ink.querySelector('.who .handle')).not.toBeNull();
    expect(ink.querySelector('.clay')).toBeNull();
  });

  it('a row with no name shows the prefix and never asks — a prefix is never clay', () => {
    const asked = vi.fn(() => true);
    const c = card(confirmed(AUTHOR), { onAuthor: () => {}, nameClay: asked });
    expect(asked).not.toHaveBeenCalled();
    expect(c.querySelector('.who .hex')).not.toBeNull();
    expect(c.querySelector('.clay')).toBeNull();
  });

  it('under the stylesheet a clay handle computes clay at the handle\'s own weight and size, an ink one beside it ink, and an open card\'s fade still applies', () => {
    const style = document.createElement('style');
    style.textContent = appCss;
    document.head.appendChild(style);
    const clay = card(named('Alice'), { onAuthor: () => {}, nameClay: () => true });
    const ink = card(named('Alice'), { onAuthor: () => {}, nameClay: () => false });
    const open = card(named('Alice'), { open: true, onAuthor: () => {}, nameClay: () => true });
    const span = card(named('Alice'), { nameClay: () => true });
    document.body.append(clay, ink, open, span);
    try {
      const c = window.getComputedStyle(clay.querySelector('.who .handle') as HTMLElement);
      expect(c.color).toBe('#9A4A2F');
      expect(c.fontWeight).toBe('600');
      expect(c.fontSize).toBe('13px');
      expect(window.getComputedStyle(ink.querySelector('.who .handle') as HTMLElement).color).toBe('#2A2419');
      const o = window.getComputedStyle(open.querySelector('.who .handle') as HTMLElement);
      expect(o.color).toBe('#9A4A2F');
      expect(o.opacity).toBe('.75');
      expect(window.getComputedStyle(span.querySelector('.who .handle') as HTMLElement).color).toBe('#9A4A2F');
      // Bistre — the token's dark value (HOUSE_STYLE → Colour).
      document.documentElement.setAttribute('data-t', 'dark');
      expect(window.getComputedStyle(clay.querySelector('.who .handle') as HTMLElement).color).toBe('#CC7658');
      expect(window.getComputedStyle(ink.querySelector('.who .handle') as HTMLElement).color).toBe('#E9E1CF');
    } finally {
      document.documentElement.removeAttribute('data-t');
      for (const n of [clay, ink, open, span]) n.remove();
      document.head.removeChild(style);
    }
  });
});

// ---------------------------------------------------------------------------
// Slot — the row a reader that lacks the post holds against its id. The handle
// when the row names one, the time, the counts — all in `inkMute`, with no
// text, no key and no control (WEB_INTERFACE → The extension → "The light
// read", HOUSE_STYLE → Motion → "A slot holds a post's place").
// ---------------------------------------------------------------------------

const SLOT_ID = 'ab'.repeat(32);

function slotRow(over: Partial<LightJson> = {}): LightJson {
  return {
    kind: 'light', id: SLOT_ID, parentRefs: [], status: 'confirmed',
    blockHeight: 100, blockIndex: 0, blockCreatedAt: 1_700_000_000_000,
    likeCount: 3, descendantCount: 2, authorName: 'alice', likedByViewer: null,
    ...over,
  };
}

describe("card — a slot's shell carries .card.slot and data-post-id", () => {
  it('the shell has the slot class, no identity button and no control button', () => {
    const c = card(slotRow());
    expect(c.classList.contains('card')).toBe(true);
    expect(c.classList.contains('slot')).toBe(true);
    expect(c.dataset['postId']).toBe(SLOT_ID);
    // No button anywhere inside a slot — the row acts on nothing.
    expect(c.querySelector('button')).toBeNull();
    // The inert strip reserves the band — no control.
    const s = c.querySelector('.strip')!;
    expect(s.classList.contains('inert')).toBe(true);
    expect(s.tagName).toBe('DIV');
  });

  it('the depth class matches the depth opt', () => {
    const c = card(slotRow(), { depth: 2 });
    expect(c.classList.contains('depth-2')).toBe(true);
  });
});

describe("card — a slot's who row carries the handle as a plain span, no · you, no data-name-pair", () => {
  it('a slot with a name shows @Name as a .handle span, never a button', () => {
    const c = card(slotRow({ authorName: 'alice' }));
    const h = c.querySelector('.who .handle')!;
    expect(h.tagName).toBe('SPAN');
    expect(h.textContent).toBe('@alice');
    expect(h.hasAttribute('data-name-pair')).toBe(false);
    expect(c.querySelector('.who .authorbtn')).toBeNull();
    expect(c.querySelector('.who .hex')).toBeNull();
    expect(c.querySelector('.who .you')).toBeNull();
  });

  it('a slot without a name shows no handle and no key prefix', () => {
    const c = card(slotRow({ authorName: null }));
    expect(c.querySelector('.who .handle')).toBeNull();
    expect(c.querySelector('.who .hex')).toBeNull();
  });

  it('the time renders when blockCreatedAt is not null; a pending slot shows no time', () => {
    const confirmed = card(slotRow({ blockCreatedAt: 1_700_000_000_000 }));
    expect(confirmed.querySelector('.who .when')).not.toBeNull();
    const pendingSlot = card(slotRow({ status: 'pending', blockHeight: null, blockIndex: null, blockCreatedAt: null }));
    expect(pendingSlot.querySelector('.who .when')).toBeNull();
  });
});

describe("card — a slot's body carries an empty .slot-text and a meta row with the counts", () => {
  it('a .slot-text block stands in the text\'s place, with no words in it', () => {
    const c = card(slotRow());
    const text = c.querySelector('.slot-text')!;
    expect(text).not.toBeNull();
    expect(text.textContent).toBe('');
  });

  it('the meta row shows the reply and like counts, in muted ink, with no control', () => {
    const c = card(slotRow({ likeCount: 3, descendantCount: 2 }));
    const meta = c.querySelector('.meta')!;
    expect(meta.querySelector('.replies .n')!.textContent).toBe('2');
    expect(meta.querySelector('.liked .n')!.textContent).toBe('3');
    expect(meta.querySelector('button')).toBeNull();
    expect(meta.querySelector('.reply-ctl')).toBeNull();
    expect(meta.querySelector('.withdraw-ctl')).toBeNull();
    expect(meta.querySelector('.linkbtn')).toBeNull();
  });

  it('zero counts render no reply and no like line', () => {
    const c = card(slotRow({ likeCount: 0, descendantCount: 0 }));
    const meta = c.querySelector('.meta')!;
    expect(meta.querySelector('.replies')).toBeNull();
    expect(meta.querySelector('.liked')).toBeNull();
  });
});

