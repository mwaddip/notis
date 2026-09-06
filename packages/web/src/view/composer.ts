import { MAX_CONTENT_BYTES } from '@dagsocial/types';
import { el } from '../dom';
import { gateUrl } from './content';
import { unlockForm } from './passphrase';

// The composer — a self-contained widget the App holds and reuses across a
// region rebuild rather than recreating, so the caret and selection survive
// (WEB_INTERFACE → The write surface). Typing never asks the App to render: the
// draft lives in the fields and only the byte counter and the post button are
// touched, so the element the App re-parents already carries the text.
//
// A type control at the foot's left switches the body between the textarea and
// two one-line fields for a link or an image; compose() is the one place the
// content is assembled, so the counter, the submission and the post-unlock re-read
// all see the same string (WEB_INTERFACE → Content → "The type control").

const encoder = new TextEncoder();

type PostType = 'text' | 'link' | 'image';

export interface ComposerController {
  el: HTMLElement;
  focus(): void;
  /** The composed content — re-read after a deferred unlock, since the reader may
   *  have edited it while the unlock form was open (WEB_INTERFACE → The identity
   *  module). It is compose(), never a raw field, so the App never bypasses the
   *  one assembly point. */
  text(): string;
  /** Affordability is read once when the composer opens; until it is known, post
   *  is held disabled so the reader cannot spend a rejection to learn it. */
  setAffordable(affordable: boolean): void;
  /** The affordability read failed — the foot says so and post stays disabled,
   *  rather than a disabled button with no reason. */
  setKarmaError(message: string): void;
  /** The key is locked: the unlock form takes the foot, below the counter;
   *  success continues the flight, Esc returns to editing with the draft intact
   *  (WEB_INTERFACE → The identity module). */
  showUnlock(pubKeyHex: string, onSubmit: (passphrase: string) => Promise<void>): void;
}

export interface ComposerOpts {
  isReply: boolean;
  price: number; // POST_PRICE_THREAD (5) or POST_PRICE_REPLY (3)
  depth?: number; // indentation inside a thread
  onSubmit: (text: string) => void;
  onClose: () => void;
}

/** Backslash-escape `\`, `[` and `]` in a description so its markdown form parses
 *  back with the description as the link or image text (WEB_INTERFACE → Content). */
function escapeDesc(s: string): string {
  return s.replace(/[\\[\]]/g, (c) => '\\' + c);
}

export function makeComposer(opts: ComposerOpts): ComposerController {
  let discarding = false;
  let affordable: boolean | null = null; // null → not yet read
  let karmaError: string | null = null; // a foot message when the read fails
  let type: PostType = 'text'; // default every open; the choice is not remembered

  const box = el('div', 'composer' + (opts.depth ? ' depth-' + Math.min(opts.depth, 3) : ''));
  const body = el('div', 'composer-body');
  box.appendChild(body);

  // The three drafts, each kept while the composer lives so a type switch loses
  // none (WEB_INTERFACE → Content → "The type control").
  const ta = el('textarea', 'composer-text') as HTMLTextAreaElement;
  ta.setAttribute('aria-label', opts.isReply ? 'your reply' : 'your new post');

  const urlInput = el('input', 'composer-url') as HTMLInputElement;
  urlInput.setAttribute('type', 'text');
  urlInput.setAttribute('inputmode', 'url');
  urlInput.setAttribute('autocomplete', 'url');
  urlInput.setAttribute('autocapitalize', 'off');
  urlInput.setAttribute('spellcheck', 'false');
  urlInput.setAttribute('aria-label', 'the address');
  urlInput.setAttribute('placeholder', 'https://');

  const descInput = el('input', 'composer-desc') as HTMLInputElement;
  descInput.setAttribute('type', 'text');
  descInput.setAttribute('aria-label', 'a description');
  descInput.setAttribute('placeholder', 'what it is');

  const typeSelect = el('select', 'composer-type') as HTMLSelectElement;
  typeSelect.setAttribute('aria-label', 'post type');
  for (const t of ['text', 'link', 'image'] as const) {
    const o = el('option', null, t) as HTMLOptionElement;
    o.value = t;
    typeSelect.appendChild(o);
  }

  const budget = el('span', 'budget');
  const karma = el('span', 'karma');
  const postBtn = el('button', 'btn btn-primary', 'post') as HTMLButtonElement;
  const cancelBtn = el('button', 'btn btn-ghost', 'cancel');
  cancelBtn.setAttribute('aria-label', 'discard this draft');

  const foot = el('div', 'composer-foot');
  box.appendChild(foot);

  /** The one assembly point: the content the counter measures and the submission
   *  carries (WEB_INTERFACE → Content → "The type control"). */
  function compose(): string {
    if (type === 'text') return ta.value.trim();
    const url = urlInput.value.trim();
    const desc = descInput.value.trim();
    if (type === 'link') return desc === '' ? url : `[${escapeDesc(desc)}](${url})`;
    return desc === '' ? `![](${url})` : `![${escapeDesc(desc)}](${url})`;
  }

  function focusField(): void {
    if (type === 'text') ta.focus();
    else urlInput.focus();
  }

  /** Fill the body for the current type, keeping every draft (detached elements
   *  hold their value). */
  function showBody(): void {
    body.textContent = '';
    if (type === 'text') body.appendChild(ta);
    else {
      body.appendChild(urlInput);
      body.appendChild(descInput);
    }
  }

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

  /** Post is enabled when affordable, the composed content fits, and — text — the
   *  draft holds a non-whitespace character, or — link and image — the URL passes
   *  the gate (WEB_INTERFACE → Content → "The type control"). */
  function canPost(): boolean {
    if (affordable !== true) return false;
    if (encoder.encode(compose()).length > MAX_CONTENT_BYTES) return false;
    if (type === 'text') return /\S/.test(ta.value);
    return gateUrl(urlInput.value.trim()) !== null;
  }

  function sync(): void {
    const n = encoder.encode(compose()).length; // UTF-8 bytes, not characters — one emoji is four
    const left = MAX_CONTENT_BYTES - n;
    budget.textContent = left < 0 ? `${-left} over` : `${left} left`; // N left from the first frame
    budget.classList.toggle('over', left < 0);
    drawKarma();
    postBtn.disabled = !canPost();
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
        focusField();
      });
      foot.appendChild(dis);
      foot.appendChild(keep);
      (keep as HTMLButtonElement).focus();
      return;
    }
    // select → budget → spacer → karma → post → cancel is the DOM and tab order.
    foot.appendChild(typeSelect);
    foot.appendChild(budget);
    foot.appendChild(el('span', 'spacer'));
    foot.appendChild(karma);
    foot.appendChild(postBtn);
    foot.appendChild(cancelBtn);
    sync();
  }

  /** Any draft holds something — asked at cancel because a type switch keeps them
   *  all (WEB_INTERFACE → Content → "The type control"). */
  function hasDraft(): boolean {
    return /\S/.test(ta.value) || urlInput.value.trim() !== '' || descInput.value.trim() !== '';
  }

  function cancel(): void {
    if (!hasDraft()) {
      opts.onClose();
      return;
    }
    discarding = true;
    drawFoot();
  }

  function doPost(): void {
    // One submit path for the button and the shortcut, carrying its own guards
    // rather than leaning on the disabled attribute the keyboard route never sees.
    if (discarding || !canPost()) return;
    opts.onSubmit(compose());
  }

  ta.addEventListener('input', () => sync());
  urlInput.addEventListener('input', () => sync());
  descInput.addEventListener('input', () => sync());
  typeSelect.addEventListener('change', () => {
    type = typeSelect.value as PostType;
    showBody();
    focusField();
    sync();
  });
  postBtn.addEventListener('click', doPost);
  cancelBtn.addEventListener('click', cancel);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // Ctrl+Enter and Cmd+Enter both — a one-platform shortcut is one half the
      // readers conclude is broken. The box-level listener covers the inputs too.
      e.preventDefault();
      doPost();
    }
  });

  showBody();
  drawFoot();

  return {
    el: box,
    focus: () => focusField(),
    text: () => compose(),
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
    showUnlock: (pubKeyHex: string, onSubmit: (passphrase: string) => Promise<void>) => {
      // The drafts in the body are untouched; only the foot changes. Esc or cancel
      // restores the foot and returns focus to the current type's field.
      foot.textContent = '';
      foot.appendChild(el('span', 'ask', 'your key is locked — unlock to post'));
      foot.appendChild(
        unlockForm(pubKeyHex, onSubmit, () => {
          drawFoot();
          focusField();
        }),
      );
    },
  };
}
