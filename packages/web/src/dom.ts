// Small imperative-DOM helpers. The client keeps the prototype's vanilla DOM
// (spec → §0 ruling 2); these are the primitives every renderer is built from.

export function el(tag: string, cls?: string | null, txt?: string | null): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

/** A muted line whose leading number is the only part in mono, in both surfaces. */
export function reportNode(text: string): HTMLElement {
  const rep = el('div', 'report');
  const m = text.match(/^(\d+)(.*)$/);
  if (m) {
    rep.appendChild(el('span', 'n', m[1]));
    rep.appendChild(document.createTextNode(m[2]!));
  } else {
    rep.textContent = text;
  }
  return rep;
}

/** First `n` hex characters of a key or id, with an ellipsis. Mono is the
 *  caller's job — this only trims. */
export function shortHex(hex: string, n: number): string {
  return hex.length > n ? hex.slice(0, n) + '…' : hex;
}

/** Save a scrollable element's position, run a mutation that rebuilds it, then
 *  restore the position — the prototype rebuilt on every change and restored
 *  neither scroll nor selection (spec → §5.1). */
export function preservingScroll(node: HTMLElement, mutate: () => void): void {
  const top = node.scrollTop;
  const left = node.scrollLeft;
  mutate();
  node.scrollTop = top;
  node.scrollLeft = left;
}
