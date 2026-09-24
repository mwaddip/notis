import { el } from '../dom';
import { namePair } from '../model/name-verdict';

// A handle that reads a name check carries its pair, so a check's result lands
// on the handles standing for that pair where they stand — the class alone,
// with nothing rendered again: every other node, a scroll, a composer's text
// and focus, a selection, hold (WEB_INTERFACE → The identity display, → The
// extension → "The verified names"; HOUSE_STYLE → Motion). The author window's
// line comes and goes with the window's render, never with a result
// (WEB_INTERFACE → The author window).

/** The clay line beneath the author window's `name` row handle (WEB_INTERFACE →
 *  The author window) — the figures' line element. */
export function nameLine(): HTMLElement {
  return el('div', 'hint clay', "this node's answer for this name did not verify");
}

/** Mark a rendered handle with the pair it reads — the key and the name its
 *  site asks the check for. */
export function markHandle(handle: HTMLElement, key: string, name: string): void {
  handle.dataset.namePair = namePair(key, name);
}

/** Land a pair's clay on every handle marked with it under the roots: the class
 *  toggled in place, and nothing else touched. */
export function landNameClay(roots: readonly ParentNode[], pair: string, clay: boolean): void {
  for (const root of roots) {
    for (const handle of root.querySelectorAll<HTMLElement>('[data-name-pair]')) {
      if (handle.dataset.namePair === pair) handle.classList.toggle('clay', clay);
    }
  }
}
