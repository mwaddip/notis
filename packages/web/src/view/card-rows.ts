import { el } from '../dom';
import { unlockForm } from './passphrase';

// Rows the reader opens under a card's meta row — the unlock form a locked
// like or withdraw asks for, the withdraw question, and the link held as text
// (WEB_INTERFACE → What the feed reads, and what a card shows for it →
// "A row the reader opened under a card outlasts a redraw of its list").
// Each constructor is pure — the row element is handed back to a holder, and
// its handlers close over nothing of the render that opened it: a redraw of
// the list draws the card with the same row beneath it, and the row's
// controls act on the card as it stands at the press.

/** The unlock form in a row — a correct passphrase runs `onSubmit` (the loader
 *  of the seed), then `onProceed` (the write the row was in service of); Esc
 *  runs `onCancel`. The caller holds the row and ends it (WEB_INTERFACE →
 *  "A row the reader opened under a card outlasts a redraw of its list"). */
export function buildUnlockRow(args: {
  pubKeyHex: string;
  onSubmit: (passphrase: string) => Promise<void>;
  onProceed: () => void;
  onCancel: () => void;
}): HTMLElement {
  const row = el('div', 'card-unlock');
  row.appendChild(
    unlockForm(
      args.pubKeyHex,
      async (p) => {
        await args.onSubmit(p);
        args.onProceed();
      },
      args.onCancel,
    ),
  );
  return row;
}

/** The withdraw question — "withdraw this post? the content goes; the replies
 *  stay." with `withdraw` and `keep`, focus on `keep`; Esc runs `onKeep`. The
 *  row's `withdraw` is `onYes` — at the press the caller reads the lock live
 *  and takes the right path (WEB_INTERFACE → The withdraw control). */
export function buildConfirmRow(args: {
  onYes: () => void;
  onKeep: () => void;
}): HTMLElement {
  const row = el('div', 'card-confirm');
  row.appendChild(el('div', 'q', 'withdraw this post? the content goes; the replies stay.'));
  const actions = el('div', 'actions');
  const yes = el('button', 'word', 'withdraw') as HTMLButtonElement;
  yes.setAttribute('aria-label', 'withdraw this post now');
  const keep = el('button', 'word', 'keep') as HTMLButtonElement;
  keep.setAttribute('aria-label', 'keep this post');
  yes.addEventListener('click', () => args.onYes());
  keep.addEventListener('click', () => args.onKeep());
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') args.onKeep();
  });
  actions.append(yes, keep);
  row.appendChild(actions);
  // Focus on keep, the non-destructive choice (WEB_INTERFACE → The withdraw
  // control). Deferred so the caller can attach the row before focus lands.
  requestAnimationFrame(() => keep.focus());
  return row;
}

/** The link held as text to copy by hand — the row the clipboard refusal
 *  mounts (WEB_INTERFACE → Links). Content is the url and ` — copy it by
 *  hand`. */
export function buildLinkFallbackRow(url: string): HTMLElement {
  const row = el('div', 'card-link');
  const span = el('span', 'hex');
  span.textContent = url;
  row.appendChild(span);
  row.appendChild(el('span', null, ' — copy it by hand'));
  return row;
}
