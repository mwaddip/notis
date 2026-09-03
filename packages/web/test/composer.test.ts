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

describe('composer — the foot', () => {
  it('shows the price in mono and holds post disabled until affordability is read', () => {
    const { ctrl } = open({ price: 5 });
    const karma = ctrl.el.querySelector('.karma')!;
    expect(karma.querySelector('.n')?.textContent).toBe('5');
    expect(karma.textContent).toContain('karma');
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
    expect(ctrl.el.querySelector('.karma')?.textContent).toBe('not enough karma to post right now');
  });

  it('the byte budget is silent under 240 bytes, then counts down, then over in clay', () => {
    const { ctrl, ta } = open();
    ctrl.setAffordable(true);
    const budget = ctrl.el.querySelector('.budget')!;
    type(ta, 'a'.repeat(100));
    expect(budget.textContent).toBe('');
    type(ta, 'a'.repeat(240));
    expect(budget.textContent).toBe('60 left');
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
