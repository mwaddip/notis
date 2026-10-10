// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { makeComposer, type ComposerController } from '../src/view/composer';

// The composer widget manages its own byte budget, affordability and discard ask.
// It is driven here directly, the way the App holds and reuses it.

function open(over: Partial<Parameters<typeof makeComposer>[0]> = {}): {
  ctrl: ComposerController;
  ta: HTMLTextAreaElement;
  onSubmit: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const ctrl = makeComposer({ isReply: false, price: 5, onSubmit, onClose, ...over });
  document.body.append(ctrl.el);
  const ta = ctrl.el.querySelector('textarea') as HTMLTextAreaElement;
  return { ctrl, ta, onSubmit, onClose };
}
function type(ta: HTMLTextAreaElement, text: string): void {
  ta.value = text;
  ta.dispatchEvent(new Event('input'));
}
const postBtn = (el: HTMLElement): HTMLButtonElement => [...el.querySelectorAll('button')].find((b) => b.textContent === 'post') as HTMLButtonElement;
const select = (el: HTMLElement): HTMLSelectElement => el.querySelector('select.composer-type') as HTMLSelectElement;
const urlIn = (el: HTMLElement): HTMLInputElement => el.querySelector('input.composer-url') as HTMLInputElement;
const descIn = (el: HTMLElement): HTMLInputElement => el.querySelector('input.composer-desc') as HTMLInputElement;
function setType(el: HTMLElement, t: string): void {
  const s = select(el);
  s.value = t;
  s.dispatchEvent(new Event('change'));
}
function typeInput(inp: HTMLInputElement, v: string): void {
  inp.value = v;
  inp.dispatchEvent(new Event('input'));
}

describe('composer — the foot', () => {
  it('shows the price in mono and holds post disabled until affordability is read', () => {
    const { ctrl } = open({ price: 5 });
    const karma = ctrl.el.querySelector('.karma')!;
    expect(karma.querySelector('.n')?.textContent).toBe('5');
    expect(karma.textContent).toContain('rep');
    // affordable unknown → post disabled even with content.
    const ta = ctrl.el.querySelector('textarea') as HTMLTextAreaElement;
    type(ta, 'hello');
    expect(postBtn(ctrl.el).disabled).toBe(true);
  });

  it('enables post once affordable and there is content; disables it when unaffordable', () => {
    const { ctrl, ta } = open();
    ctrl.setAffordable(true);
    expect(postBtn(ctrl.el).disabled).toBe(true); // no content yet
    type(ta, 'a real post');
    expect(postBtn(ctrl.el).disabled).toBe(false);
    ctrl.setAffordable(false);
    expect(postBtn(ctrl.el).disabled).toBe(true);
    expect(ctrl.el.querySelector('.karma')?.textContent).toBe('not enough rep to post right now');
  });

  it('a failed affordability read shows a reason in the foot, post disabled, and clears on a later read', () => {
    const { ctrl, ta } = open();
    type(ta, 'a real post');
    ctrl.setKarmaError("can't read your rep right now");
    expect(ctrl.el.querySelector('.karma')?.textContent).toBe("can't read your rep right now");
    expect(postBtn(ctrl.el).disabled).toBe(true);
    ctrl.setAffordable(true);
    expect(ctrl.el.querySelector('.karma')?.textContent).toContain('rep');
    expect(ctrl.el.querySelector('.karma .n')?.textContent).toBe('5');
    expect(postBtn(ctrl.el).disabled).toBe(false);
  });

  it('the byte counter reads N left from the moment it opens, then over in clay', () => {
    const { ctrl, ta } = open();
    const budget = ctrl.el.querySelector('.budget')!;
    expect(budget.textContent).toBe('300 left'); // from the first frame, an empty composer
    ctrl.setAffordable(true);
    type(ta, 'a'.repeat(100));
    expect(budget.textContent).toBe('200 left');
    expect(budget.classList.contains('over')).toBe(false);
    type(ta, 'a'.repeat(301));
    expect(budget.textContent).toBe('1 over');
    expect(budget.classList.contains('over')).toBe(true);
    expect(postBtn(ctrl.el).disabled).toBe(true); // over-length disables post
  });

  it('counts UTF-8 bytes, not characters — one emoji is four', () => {
    const { ctrl, ta } = open();
    ctrl.setAffordable(true);
    // 296 ASCII + one 4-byte emoji = 300 bytes exactly → "0 left", not over.
    type(ta, 'a'.repeat(296) + '😀');
    const budget = ctrl.el.querySelector('.budget')!;
    expect(budget.textContent).toBe('0 left');
    expect(postBtn(ctrl.el).disabled).toBe(false);
  });
});

describe('composer — submit and discard', () => {
  it('post submits the trimmed text when affordable', () => {
    const { ctrl, ta, onSubmit } = open();
    ctrl.setAffordable(true);
    type(ta, '  a thread  ');
    postBtn(ctrl.el).click();
    expect(onSubmit).toHaveBeenCalledWith('a thread');
  });

  it('Ctrl+Enter submits along the same guarded path', () => {
    const { ctrl, ta, onSubmit } = open();
    ctrl.setAffordable(true);
    type(ta, 'via the keyboard');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith('via the keyboard');
  });

  it('cancel on an empty composer closes it; on a written one it asks first', () => {
    const { ctrl, onClose } = open();
    // Empty → straight close.
    const cancel = [...ctrl.el.querySelectorAll('button')].find((b) => b.textContent === 'cancel')!;
    cancel.click();
    expect(onClose).toHaveBeenCalledTimes(1);

    // Written → the in-place discard ask, keep writing is primary.
    const w = open();
    type(w.ta, 'some words');
    [...w.ctrl.el.querySelectorAll('button')].find((b) => b.textContent === 'cancel')!.click();
    expect(w.ctrl.el.querySelector('.ask')?.textContent).toBe('discard this post?');
    expect(w.onClose).not.toHaveBeenCalled();
    // keep writing dismisses the ask without discarding.
    [...w.ctrl.el.querySelectorAll('button')].find((b) => b.textContent === 'keep writing')!.click();
    expect(w.ctrl.el.querySelector('.ask')).toBeNull();
    // discard closes.
    [...w.ctrl.el.querySelectorAll('button')].find((b) => b.textContent === 'cancel')!.click();
    [...w.ctrl.el.querySelectorAll('button')].find((b) => b.textContent === 'discard')!.click();
    expect(w.onClose).toHaveBeenCalledTimes(1);
  });

  it('a reply asks "discard this reply?"', () => {
    const { ctrl, ta } = open({ isReply: true, price: 3 });
    type(ta, 'a reply');
    [...ctrl.el.querySelectorAll('button')].find((b) => b.textContent === 'cancel')!.click();
    expect(ctrl.el.querySelector('.ask')?.textContent).toBe('discard this reply?');
  });
});

// WEB_INTERFACE → The workspace → "A window's body stands while the window is
// open": the unlock form in the foot ends at an unlock made anywhere, the foot
// returning with its field emptied and the drafts as they were; Esc in the
// form cancels it and nothing else.
describe('composer — the unlock form in the foot', () => {
  const KEY = 'ab'.repeat(32);
  const footOf = (el: HTMLElement): HTMLElement => el.querySelector('.composer-foot') as HTMLElement;
  const passOf = (el: HTMLElement): HTMLInputElement => footOf(el).querySelector('input[type="password"]') as HTMLInputElement;

  it('showUnlock puts the unlock form in the foot under its line, the draft untouched', () => {
    const { ctrl, ta } = open();
    ctrl.setAffordable(true);
    type(ta, 'a draft');
    ctrl.showUnlock(KEY, async () => {});
    expect(footOf(ctrl.el).querySelector('.ask')?.textContent).toBe('your key is locked — unlock to post');
    expect(passOf(ctrl.el)).not.toBeNull();
    expect(postBtn(ctrl.el)).toBeUndefined();
    expect(ta.value).toBe('a draft');
  });

  it('endUnlock returns the foot, empties the form\'s field and leaves every draft; with no form standing it changes nothing', () => {
    const { ctrl, ta } = open();
    ctrl.setAffordable(true);
    type(ta, 'a draft');
    setType(ctrl.el, 'link');
    typeInput(urlIn(ctrl.el), 'https://example.test');
    ctrl.showUnlock(KEY, async () => {});
    const pass = passOf(ctrl.el);
    pass.value = 'half';

    ctrl.endUnlock();
    expect(pass.isConnected).toBe(false);
    expect(pass.value).toBe('');
    expect(footOf(ctrl.el).querySelector('form')).toBeNull();
    expect(footOf(ctrl.el).querySelector('.ask')).toBeNull();
    expect([...footOf(ctrl.el).querySelectorAll('button')].map((b) => b.textContent)).toEqual(['post', 'cancel']);
    expect(postBtn(ctrl.el).disabled).toBe(false);
    expect(urlIn(ctrl.el).value).toBe('https://example.test');
    setType(ctrl.el, 'text');
    expect((ctrl.el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('a draft');

    const foot = [...footOf(ctrl.el).childNodes];
    ctrl.endUnlock();
    expect([...footOf(ctrl.el).childNodes]).toEqual(foot);
  });

  it('the form\'s cancel ends it, its field emptied, and the foot returns with the focus in the draft', () => {
    const { ctrl, ta } = open();
    ctrl.setAffordable(true);
    type(ta, 'a draft');
    ctrl.showUnlock(KEY, async () => {});
    const pass = passOf(ctrl.el);
    pass.value = 'half';
    ([...footOf(ctrl.el).querySelectorAll('button')].find((b) => b.textContent === 'cancel') as HTMLButtonElement).click();
    expect(pass.value).toBe('');
    expect(footOf(ctrl.el).querySelector('form')).toBeNull();
    expect(postBtn(ctrl.el)).not.toBeUndefined();
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe('a draft');
  });

  it('Esc in the form cancels it and nothing else: its field emptied, the foot back, the focus in the draft, no question asked and the composer open; Esc in the draft is the composer\'s own and asks', () => {
    const { ctrl, ta, onClose } = open();
    ctrl.setAffordable(true);
    type(ta, 'a draft');
    ctrl.showUnlock(KEY, async () => {});
    const pass = passOf(ctrl.el);
    pass.value = 'half';
    pass.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(pass.isConnected).toBe(false);
    expect(pass.value).toBe('');
    expect(footOf(ctrl.el).querySelector('.ask')).toBeNull();
    expect([...footOf(ctrl.el).querySelectorAll('button')].map((b) => b.textContent)).toEqual(['post', 'cancel']);
    expect(onClose).not.toHaveBeenCalled();
    expect(ta.value).toBe('a draft');
    expect(document.activeElement).toBe(ta);

    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(footOf(ctrl.el).querySelector('.ask')?.textContent).toBe('discard this post?');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc in the form over a draft since emptied leaves the composer open, the foot back', () => {
    const { ctrl, ta, onClose } = open();
    ctrl.setAffordable(true);
    type(ta, 'a draft');
    ctrl.showUnlock(KEY, async () => {});
    type(ta, '');
    passOf(ctrl.el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(footOf(ctrl.el).querySelector('form')).toBeNull();
    expect([...footOf(ctrl.el).querySelectorAll('button')].map((b) => b.textContent)).toEqual(['post', 'cancel']);
  });

  it('a second showUnlock ends the form standing, its field emptied, and stands one form', () => {
    const { ctrl } = open();
    ctrl.showUnlock(KEY, async () => {});
    const first = passOf(ctrl.el);
    first.value = 'half';
    ctrl.showUnlock(KEY, async () => {});
    expect(first.isConnected).toBe(false);
    expect(first.value).toBe('');
    expect(footOf(ctrl.el).querySelectorAll('form')).toHaveLength(1);
  });
});

describe('composer — the type control', () => {
  it('the select is first in the foot, with text, link, image', () => {
    const { ctrl } = open();
    expect(ctrl.el.querySelector('.composer-foot')!.firstElementChild).toBe(select(ctrl.el));
    expect([...select(ctrl.el).options].map((o) => o.value)).toEqual(['text', 'link', 'image']);
  });

  it('link swaps the textarea for two inputs; image shows the same two; text restores the textarea', () => {
    const { ctrl } = open();
    expect(ctrl.el.querySelector('textarea')).not.toBeNull();
    setType(ctrl.el, 'link');
    expect(ctrl.el.querySelector('textarea')).toBeNull();
    expect(urlIn(ctrl.el)).not.toBeNull();
    expect(descIn(ctrl.el)).not.toBeNull();
    setType(ctrl.el, 'image');
    expect(urlIn(ctrl.el)).not.toBeNull();
    expect(descIn(ctrl.el)).not.toBeNull();
    setType(ctrl.el, 'text');
    expect(ctrl.el.querySelector('textarea')).not.toBeNull();
    expect(ctrl.el.querySelector('input.composer-url')).toBeNull();
  });

  it('compose(): [d](u), a bare url on a blank description, ![d](u), ![](u), with the escapes', () => {
    const { ctrl } = open();
    setType(ctrl.el, 'link');
    typeInput(urlIn(ctrl.el), 'https://ok.com');
    typeInput(descIn(ctrl.el), 'the docs');
    expect(ctrl.text()).toBe('[the docs](https://ok.com)');
    typeInput(descIn(ctrl.el), '');
    expect(ctrl.text()).toBe('https://ok.com'); // a bare url on a blank description
    setType(ctrl.el, 'image');
    typeInput(descIn(ctrl.el), 'a cat');
    expect(ctrl.text()).toBe('![a cat](https://ok.com)');
    typeInput(descIn(ctrl.el), '');
    expect(ctrl.text()).toBe('![](https://ok.com)');
    // the escapes — \ [ ] in the description are backslash-escaped
    setType(ctrl.el, 'link');
    typeInput(descIn(ctrl.el), 'a [b] \\c');
    expect(ctrl.text()).toBe('[a \\[b\\] \\\\c](https://ok.com)');
  });

  it('the counter counts the composed bytes', () => {
    const { ctrl } = open();
    setType(ctrl.el, 'link');
    const budget = ctrl.el.querySelector('.budget')!;
    typeInput(urlIn(ctrl.el), 'https://ok.com');
    expect(budget.textContent).toBe(`${300 - 'https://ok.com'.length} left`);
    typeInput(descIn(ctrl.el), 'x'); // composed [x](https://ok.com)
    expect(budget.textContent).toBe(`${300 - '[x](https://ok.com)'.length} left`);
  });

  it('post is held while the URL fails the gate and enabled once it passes', () => {
    const { ctrl } = open();
    ctrl.setAffordable(true);
    setType(ctrl.el, 'link');
    typeInput(urlIn(ctrl.el), 'not a url');
    expect(postBtn(ctrl.el).disabled).toBe(true);
    typeInput(urlIn(ctrl.el), 'ftp://x.com'); // wrong scheme
    expect(postBtn(ctrl.el).disabled).toBe(true);
    typeInput(urlIn(ctrl.el), 'https://ok.com');
    expect(postBtn(ctrl.el).disabled).toBe(false);
  });

  it('switching back to text restores the textarea draft, and the link draft survives too', () => {
    const { ctrl, ta } = open();
    type(ta, 'my draft');
    setType(ctrl.el, 'link');
    typeInput(urlIn(ctrl.el), 'https://ok.com');
    setType(ctrl.el, 'text');
    expect((ctrl.el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('my draft');
    setType(ctrl.el, 'link');
    expect(urlIn(ctrl.el).value).toBe('https://ok.com');
  });

  it('text() returns the composed content, and post carries it', () => {
    const { ctrl, onSubmit } = open();
    ctrl.setAffordable(true);
    setType(ctrl.el, 'link');
    typeInput(urlIn(ctrl.el), 'https://ok.com');
    typeInput(descIn(ctrl.el), 'docs');
    expect(ctrl.text()).toBe('[docs](https://ok.com)');
    postBtn(ctrl.el).click();
    expect(onSubmit).toHaveBeenCalledWith('[docs](https://ok.com)');
  });

  it('cancel asks on a link draft', () => {
    const { ctrl, onClose } = open();
    setType(ctrl.el, 'link');
    typeInput(urlIn(ctrl.el), 'https://ok.com');
    [...ctrl.el.querySelectorAll('button')].find((b) => b.textContent === 'cancel')!.click();
    expect(ctrl.el.querySelector('.ask')?.textContent).toBe('discard this post?');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter from the url input submits', () => {
    const { ctrl, onSubmit } = open();
    ctrl.setAffordable(true);
    setType(ctrl.el, 'link');
    typeInput(urlIn(ctrl.el), 'https://ok.com');
    urlIn(ctrl.el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith('https://ok.com');
  });

  it('the reply composer carries the select', () => {
    const { ctrl } = open({ isReply: true, price: 3 });
    expect(select(ctrl.el)).not.toBeNull();
  });
});
