// The clay line a list — the feed, an author window, a thread — renders at
// its head when its standing reads withheld any `unbound` row (WEB_INTERFACE
// → The extension → "The post check"). Nothing when the count is zero.
//
// The element and its class follow the figures line beneath a figure
// (`view/profile.ts` renders `div.hint.clay` for the full rule's weight);
// the words are the contract's exactly, singular and plural.

import { el } from '../dom';

export function withheldLine(unboundCount: number): HTMLElement | null {
  if (unboundCount <= 0) return null;
  const text = unboundCount === 1
    ? '1 post withheld — it does not match its signature'
    : `${unboundCount} posts withheld — they do not match their signatures`;
  const line = el('div', 'hint clay withheld');
  line.textContent = text;
  return line;
}
