import { el } from '../dom';

// The content grammar a card renders — WEB_INTERFACE → Content. A closed
// recogniser, markdown's constructs and no library: parseContent is DOM-free and
// carries the block rules; renderContent builds nodes with el and text nodes, so
// no HTML string exists at any point and text is text by construction — an angle
// bracket is a character and raw HTML is its literal text.

/** One run of a line's text. This commit recognises no inline — every run is
 *  text; links, emphasis and images join the union in the later commits the
 *  contract's marker covers (WEB_INTERFACE → Content). */
export type Inline = { kind: 'text'; text: string };

/** A block of content. A title line is one scanned line; a paragraph is a run of
 *  lines, each a line break from the last (WEB_INTERFACE → Content → "The grammar"). */
export type Block =
  | { kind: 'title'; inlines: Inline[] }
  | { kind: 'paragraph'; lines: Inline[][] };

// One to six #, a space, then text — any level renders the same; #word without
// the space is text (WEB_INTERFACE → Content).
const TITLE = /^#{1,6} +(.+)$/;

/** A line's inlines. This commit: the whole line is one text run. */
function parseInlines(text: string): Inline[] {
  return text.length > 0 ? [{ kind: 'text', text }] : [];
}

/** Split content into blocks (WEB_INTERFACE → Content → "The grammar"). The text
 *  splits on \n; a line is blank when empty or whitespace only, and blank lines
 *  at either end are dropped. A paragraph is a run of consecutive non-blank,
 *  non-title lines; a blank line ends it, and a title line ends the paragraph
 *  before it and starts none after it. */
export function parseContent(text: string): Block[] {
  const blocks: Block[] = [];
  let para: Inline[][] | null = null;
  const flush = (): void => {
    if (para) {
      blocks.push({ kind: 'paragraph', lines: para });
      para = null;
    }
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const m = TITLE.exec(line);
    if (m) {
      flush();
      blocks.push({ kind: 'title', inlines: parseInlines(m[1]!) });
      continue;
    }
    (para ??= []).push(parseInlines(line));
  }
  flush();
  return blocks;
}

/** What renderContent needs to build a card's content (WEB_INTERFACE → Content). */
export interface RenderContentOpts {
  postId: string;
}

function renderInline(inline: Inline): Node {
  return document.createTextNode(inline.text);
}

function renderInlinesInto(inlines: Inline[], parent: HTMLElement): void {
  for (const inline of inlines) parent.appendChild(renderInline(inline));
}

/** A paragraph's lines, each a line break from the last. */
function paragraphNode(lines: Inline[][]): HTMLElement {
  const p = el('div', 'card-para');
  lines.forEach((line, i) => {
    if (i > 0) p.appendChild(el('br'));
    renderInlinesInto(line, p);
  });
  return p;
}

function renderBlock(block: Block): HTMLElement {
  if (block.kind === 'title') {
    // A block one step up the card's type — 17px, weight 600 (WEB_INTERFACE → Content).
    const h = el('div', 'card-title');
    renderInlinesInto(block.inlines, h);
    return h;
  }
  return paragraphNode(block.lines);
}

/** Build a card's content element, keeping the class `card-content` so every
 *  existing count and query holds (WEB_INTERFACE → Content). */
export function renderContent(blocks: Block[], _opts: RenderContentOpts): HTMLElement {
  const wrap = el('div', 'card-content');
  for (const block of blocks) wrap.appendChild(renderBlock(block));
  return wrap;
}
