import { el } from '../dom';
import { namePair } from '../model/name-verdict';

// A handle that reads a name check carries its pair, so a check's result lands
// on the handles standing for that pair where they stand — the class alone,
// and the author window's line beside its handle — with nothing rendered again:
// every other node, a scroll, a composer's text and focus, a selection, hold
// (WEB_INTERFACE → The identity display, → The extension → "The verified names";
// HOUSE_STYLE → Motion).

/** The clay line beneath the author window's `name` row handle (WEB_INTERFACE →
 *  The author window) — the figures' line element. */
export function nameLine(): HTMLElement {
  return el('div', 'hint clay', "this node's answer for this name did not verify");
}

/** Mark a rendered handle with the pair it reads — the key and the name its
 *  site asks the check for. `carriesLine` marks the one handle a clay line
 *  follows, the author window's `name` row. */
export function markHandle(handle: HTMLElement, key: string, name: string, carriesLine = false): void {
  handle.dataset.namePair = namePair(key, name);
  if (carriesLine) handle.dataset.nameLine = '';
}

/** Land a pair's clay on every handle marked with it under the roots: the class
 *  toggled in place, and the line inserted beside the handle that carries one,
 *  or removed from beside it. Nothing else is touched. */
export function landNameClay(roots: readonly ParentNode[], pair: string, clay: boolean): void {
  for (const root of roots) {
    for (const handle of root.querySelectorAll<HTMLElement>('[data-name-pair]')) {
      if (handle.dataset.namePair !== pair) continue;
      handle.classList.toggle('clay', clay);
      if (handle.dataset.nameLine === undefined) continue;
      const next = handle.nextElementSibling;
      const lined = next !== null && next.matches('.hint.clay');
      if (clay && !lined) handle.after(nameLine());
      if (!clay && lined) next.remove();
    }
  }
}
