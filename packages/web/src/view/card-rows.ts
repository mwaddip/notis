import { el } from '../dom';
import { unlockFormParts } from './passphrase';

// The rows the reader opens under a card's meta row — the unlock form a locked
// like or withdraw asks for, the withdraw question, and the link held as text
// (WEB_INTERFACE → What the feed reads, and what a card shows for it →
// "A row the reader opened under a card outlasts a redraw of its list").
// A builder answers the row and the control its opener gives the focus once
// the row is attached. Every handler is the opener's: a row reads nothing of
// the render that drew the card it stands under.

/** The unlock form in a row — a correct passphrase runs `onSubmit` (the loader
 *  of the seed), then `onProceed` (the write the row was opened for); Esc and
 *  `cancel` run `onCancel` (WEB_INTERFACE → The identity module). */
export function buildUnlockRow(args: {
  pubKeyHex: string;
  onSubmit: (passphrase: string) => Promise<void>;
  onProceed: () => void;
  onCancel: () => void;
}): { row: HTMLElement; field: HTMLInputElement } {
  const row = el('div', 'card-unlock');
  const { form, field } = unlockFormParts(
    args.pubKeyHex,
    async (p) => {
      await args.onSubmit(p);
      args.onProceed();
    },
    args.onCancel,
  );
  row.appendChild(form);
  return { row, field };
}

/** The withdraw question — "withdraw this post? the content goes; the replies
 *  stay." with `withdraw` (`onYes`) and `keep` (`onKeep`, Esc too); the focus
 *  is `keep`'s, the choice that changes nothing. Never says "deleted"
 *  (WEB_INTERFACE → The withdraw control, → The withdrawn state). */
export function buildConfirmRow(args: {
  onYes: () => void;
  onKeep: () => void;
}): { row: HTMLElement; keep: HTMLButtonElement } {
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
  return { row, keep };
}

/** The link held as text to copy by hand — the row a refused clipboard write
 *  opens (WEB_INTERFACE → Links). */
export function buildLinkFallbackRow(url: string): HTMLElement {
  const row = el('div', 'card-link');
  const span = el('span', 'hex');
  span.textContent = url;
  row.appendChild(span);
  row.appendChild(el('span', null, ' — copy it by hand'));
  return row;
}
