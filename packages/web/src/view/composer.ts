import { MAX_CONTENT_BYTES } from '@dagsocial/types';
import { el } from '../dom';

// The composer — a self-contained widget the App holds and reuses across a
// region rebuild rather than recreating, so the caret and selection survive
// (WEB_INTERFACE → The write surface). Typing never asks the App to render: the
// draft lives in the textarea and only the byte budget and the post button are
// touched, so the element the App re-parents already carries the text.

const encoder = new TextEncoder();
const BUDGET_QUIET = 240; // silent until it matters — an input that stops accepting characters makes the reader guess why

export interface ComposerController {
  el: HTMLElement;
  focus(): void;
  /** Affordability is read once when the composer opens; until it is known, post
   *  is held disabled so the reader cannot spend a rejection to learn it. */
  setAffordable(affordable: boolean): void;
  /** The affordability read failed — the foot says so and post stays disabled,
   *  rather than a disabled button with no reason. */
  setKarmaError(message: string): void;
}

export interface ComposerOpts {
  isReply: boolean;
  price: number; // POST_PRICE_THREAD (5) or POST_PRICE_REPLY (3)
  depth?: number; // indentation inside a thread
  onSubmit: (text: string) => void;
  onClose: () => void;
}

export function makeComposer(opts: ComposerOpts): ComposerController {
  let discarding = false;
  let affordable: boolean | null = null; // null → not yet read
  let karmaError: string | null = null; // a foot message when the read fails

  const box = el('div', 'composer' + (opts.depth ? ' depth-' + Math.min(opts.depth, 3) : ''));

  const ta = el('textarea', 'composer-text') as HTMLTextAreaElement;
  ta.setAttribute('aria-label', opts.isReply ? 'your reply' : 'your new post');
  box.appendChild(ta);

  const budget = el('span', 'budget');
  const karma = el('span', 'karma');
  const postBtn = el('button', 'btn btn-primary', 'post') as HTMLButtonElement;
  const cancelBtn = el('button', 'btn btn-ghost', 'cancel');
  cancelBtn.setAttribute('aria-label', 'discard this draft');

  const foot = el('div', 'composer-foot');
  box.appendChild(foot);

  const text = (): string => ta.value;

  function drawKarma(): void {
    karma.textContent = '';
    // Say what happens, not what went wrong (HOUSE_STYLE → Voice).
    const message =
      karmaError ?? (affordable === false ? (opts.isReply ? 'not enough karma to reply right now' : 'not enough karma to post right now') : null);
    if (message !== null) {
      karma.classList.add('short');
      karma.textContent = message;
      return;
    }
    // The price in mono — the one balance-shaped number on the reading surface,
    // and only while spending it.
    karma.classList.remove('short');
    karma.appendChild(el('span', 'n', String(opts.price)));
    karma.appendChild(document.createTextNode(' karma'));
  }

  function sync(): void {
    const n = encoder.encode(text()).length;
    const left = MAX_CONTENT_BYTES - n; // UTF-8 bytes, not characters — one emoji is four
    const over = left < 0;
    budget.textContent = n >= BUDGET_QUIET ? (over ? `${-left} over` : `${left} left`) : '';
    budget.classList.toggle('over', over);
    drawKarma();
    postBtn.disabled = over || !/\S/.test(text()) || affordable !== true;
  }

  function drawFoot(): void {
    foot.textContent = '';
    if (discarding) {
      // In place, not a dialog: the house style has no dialog treatment, and
      // replacing the row means nothing resizes.
      foot.appendChild(el('span', 'ask', opts.isReply ? 'discard this reply?' : 'discard this post?'));
      foot.appendChild(el('span', 'spacer'));
      const dis = el('button', 'btn btn-ghost', 'discard');
      dis.addEventListener('click', () => opts.onClose());
      // keep writing is primary and takes focus, so a reflexive second Esc cannot
      // destroy the draft.
      const keep = el('button', 'btn btn-primary keep', 'keep writing');
      keep.addEventListener('click', () => {
        discarding = false;
        drawFoot();
        ta.focus();
      });
      foot.appendChild(dis);
      foot.appendChild(keep);
      (keep as HTMLButtonElement).focus();
      return;
    }
    // textarea → post → cancel is the DOM order and the tab order both.
    foot.appendChild(budget);
    foot.appendChild(el('span', 'spacer'));
    foot.appendChild(karma);
    foot.appendChild(postBtn);
    foot.appendChild(cancelBtn);
    sync();
  }

  function cancel(): void {
    // Whitespace alone is not content — an empty composer just closes.
    if (!/\S/.test(text())) {
      opts.onClose();
      return;
    }
    discarding = true;
    drawFoot();
  }

  function doPost(): void {
    // One submit path for the button and the shortcut, carrying its own guards
    // rather than leaning on the disabled attribute the keyboard route never sees.
    if (discarding || affordable !== true) return;
    const t = text();
    if (!/\S/.test(t) || encoder.encode(t).length > MAX_CONTENT_BYTES) return;
    opts.onSubmit(t.trim());
  }

  ta.addEventListener('input', () => sync());
  postBtn.addEventListener('click', doPost);
  cancelBtn.addEventListener('click', cancel);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // Ctrl+Enter and Cmd+Enter both — a one-platform shortcut is one half the
      // readers conclude is broken.
      e.preventDefault();
      doPost();
    }
  });

  drawFoot();

  return {
    el: box,
    focus: () => ta.focus(),
    setAffordable: (a: boolean) => {
      affordable = a;
      karmaError = null;
      if (!discarding) sync();
    },
    setKarmaError: (message: string) => {
      karmaError = message;
      affordable = false; // post disabled — affordability is unknown
      if (!discarding) sync();
    },
  };
}
