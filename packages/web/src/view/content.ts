import { el } from '../dom';

// The content grammar a card renders — WEB_INTERFACE → Content. A closed
// recogniser, markdown's constructs and no library: parseContent is DOM-free and
// carries the block and inline rules; renderContent builds nodes with el and text
// nodes, so no HTML string exists at any point and text is text by construction —
// an angle bracket is a character and raw HTML is its literal text.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'link'; url: string; text: string }
  | { kind: 'bareUrl'; url: string }
  | { kind: 'image'; url: string; alt: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] };

/** A block of content. A title line is one scanned line; a paragraph is a run of
 *  lines, each a line break from the last (WEB_INTERFACE → Content → "The grammar"). */
export type Block =
  | { kind: 'title'; inlines: Inline[] }
  | { kind: 'paragraph'; lines: Inline[][] };

// One to six #, a space, then text beginning on a non-space — any level renders
// the same; #word without the space, and a line of #s and spaces alone, are text
// (WEB_INTERFACE → Content).
const TITLE = /^#{1,6} +(\S.*)$/;
// Escape yields the following character as text (WEB_INTERFACE → Content).
const ESCAPABLE = new Set(['\\', '*', '[', ']', '(', ')', '!', '#']);
// A bare URL's trailing punctuation is trimmed (WEB_INTERFACE → Content).
const BARE_TRIM = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);
// A bare URL whose gated path, lowercased, ends in one of these is an image — a
// client table that lives with the grammar (WEB_INTERFACE → Content).
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'];

/** The URL gate — shared by the renderer and the composer (WEB_INTERFACE →
 *  Content → "The URL gate"): the string parses as a URL, its scheme is http or
 *  https, and it holds no whitespace. Returns the parsed URL for its host, or
 *  null when the string fails the gate. */
export function gateUrl(s: string): URL | null {
  if (s === '' || /\s/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
}

function isImageUrl(u: URL): boolean {
  const p = u.pathname.toLowerCase();
  return IMAGE_EXT.some((ext) => p.endsWith(ext));
}

/** The parenthesised span of a link or image, from the `(` after `](`. The URL
 *  runs to its matching `)` — parentheses inside nest by depth — and holds no
 *  whitespace; whitespace before the closer makes the whole construct text, so
 *  this returns null (WEB_INTERFACE → Content). */
function parenSpan(text: string, open: number): { url: string; end: number } | null {
  let depth = 1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) return null;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { url: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** `![alt](url)` from the `!` at `i` (its `[` at i+1): alt any run without `]`
 *  (may be empty), then a gated parenthesised span (WEB_INTERFACE → Content). */
function tryImage(text: string, i: number): { inline: Inline; end: number } | null {
  const close = text.indexOf(']', i + 2);
  if (close === -1 || text[close + 1] !== '(') return null;
  const span = parenSpan(text, close + 1);
  if (!span || !gateUrl(span.url)) return null;
  return { inline: { kind: 'image', url: span.url, alt: text.slice(i + 2, close) }, end: span.end };
}

/** `[text](url)` from the `[` at `i`: text a non-empty run without `]`, then a
 *  gated parenthesised span. Null when any part fails — the whole construct is
 *  then text (WEB_INTERFACE → Content). */
function tryLink(text: string, i: number): { inline: Inline; end: number } | null {
  const close = text.indexOf(']', i + 1);
  if (close <= i + 1) return null; // no `]`, or empty text
  if (text[close + 1] !== '(') return null;
  const span = parenSpan(text, close + 1);
  if (!span || !gateUrl(span.url)) return null;
  return { inline: { kind: 'link', url: span.url, text: text.slice(i + 1, close) }, end: span.end };
}

/** `**text**` then `*text*` from the `*` at `i`: text non-empty, no whitespace at
 *  either edge, no emphasis inside — but scanned for images, links and bare URLs.
 *  An opener without its closer is null and the `*` is text (WEB_INTERFACE →
 *  Content). */
function tryEmphasis(text: string, i: number): { inline: Inline; end: number } | null {
  const edgesOk = (s: string): boolean => s.length > 0 && !/\s/.test(s[0]!) && !/\s/.test(s[s.length - 1]!);
  if (text[i + 1] === '*') {
    // Bold: the closer is the first `**` at or after the opener, whatever lone `*`
    // sits before it; the inner is scanned with emphasis off, so a lone `*` inside
    // is a text character (WEB_INTERFACE → Content).
    const close = text.indexOf('**', i + 2);
    if (close !== -1) {
      const inner = text.slice(i + 2, close);
      if (edgesOk(inner)) return { inline: { kind: 'strong', children: scan(inner, false) }, end: close + 2 };
    }
  }
  // Italic: the run to the next `*`, which by construction holds no `*`.
  const star = text.indexOf('*', i + 1);
  if (star !== -1) {
    const inner = text.slice(i + 1, star);
    if (edgesOk(inner)) return { inline: { kind: 'em', children: scan(inner, false) }, end: star + 1 };
  }
  return null;
}

/** A bare URL is recognised only at the start of the text or after whitespace or
 *  `(` (WEB_INTERFACE → Content). */
function atBareUrlStart(text: string, i: number): boolean {
  if (!(text.startsWith('http://', i) || text.startsWith('https://', i))) return false;
  return i === 0 || /\s/.test(text[i - 1]!) || text[i - 1] === '(';
}

/** A bare URL from `i`, running to the next whitespace; trailing punctuation is
 *  trimmed, and a trailing `)` when the URL holds no `(`. A gated URL whose path
 *  ends in an image extension is an image; otherwise a bare URL. Null when the
 *  trimmed string fails the gate (WEB_INTERFACE → Content). */
function tryBareUrl(text: string, i: number): { inline: Inline; end: number } | null {
  let j = i;
  while (j < text.length && !/\s/.test(text[j]!)) j++;
  let url = text.slice(i, j);
  for (;;) {
    const last = url[url.length - 1]!;
    if (BARE_TRIM.has(last)) url = url.slice(0, -1);
    else if (last === ')' && !url.includes('(')) url = url.slice(0, -1);
    else break;
  }
  const u = gateUrl(url);
  if (!u) return null;
  const inline: Inline = isImageUrl(u) ? { kind: 'image', url, alt: '' } : { kind: 'bareUrl', url };
  return { inline, end: i + url.length };
}

/** One left-to-right scan of a line's text; at each position the first rule that
 *  matches wins, in the contract's order (WEB_INTERFACE → Content). Emphasis
 *  scans its inner text with emphasis off. */
function scan(text: string, allowEmphasis: boolean): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };
  const emit = (inline: Inline, end: number): void => {
    flush();
    out.push(inline);
    i = end;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\') {
      const next = text[i + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        buf += next;
        i += 2;
      } else {
        buf += '\\';
        i += 1;
      }
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      const img = tryImage(text, i);
      if (img) {
        emit(img.inline, img.end);
        continue;
      }
    }
    if (c === '[') {
      const link = tryLink(text, i);
      if (link) {
        emit(link.inline, link.end);
        continue;
      }
    }
    if (allowEmphasis && c === '*') {
      const emph = tryEmphasis(text, i);
      if (emph) {
        emit(emph.inline, emph.end);
        continue;
      }
    }
    if (c === 'h' && atBareUrlStart(text, i)) {
      const bare = tryBareUrl(text, i);
      if (bare) {
        emit(bare.inline, bare.end);
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** A line's inlines — the full scan. */
function parseInlines(text: string): Inline[] {
  return scan(text, true);
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

/** The link card's single inline, or null: the block list is one paragraph whose
 *  inlines, after dropping whitespace-only text runs, are exactly one link, one
 *  image or one bare URL (WEB_INTERFACE → Content → "The link card"). */
export function linkCard(blocks: Block[]): Inline | null {
  const b = blocks[0];
  if (blocks.length !== 1 || !b || b.kind !== 'paragraph') return null;
  const flat = b.lines.flat().filter((inl) => !(inl.kind === 'text' && inl.text.trim() === ''));
  if (flat.length !== 1) return null;
  const only = flat[0]!;
  return only.kind === 'link' || only.kind === 'bareUrl' || only.kind === 'image' ? only : null;
}

/** What renderContent needs to build a card's content (WEB_INTERFACE → Content).
 *  An image loads on the reader's press: `expanded` holds the keys of images
 *  already shown, `onExpand` records a press, `onCollapse` drops a key whose image
 *  failed to load. The key is `<postId>:<image index in document order>`. */
export interface RenderContentOpts {
  postId: string;
  expanded?: ReadonlySet<string>;
  onExpand?: (key: string) => void;
  onCollapse?: (key: string) => void;
}

/** The render pass's mutable state: the opts, and the next image index in
 *  document order, so a re-render assigns the same key to the same image. */
interface RenderState {
  opts: RenderContentOpts;
  next: number;
}

/** An `<a>` to the URL: the href is the author's string, never a normalised form;
 *  a new tab with rel="noopener noreferrer", referrerpolicy="no-referrer" and the
 *  URL as its title (WEB_INTERFACE → Content). */
function anchor(url: string, text: string, cls?: string): HTMLAnchorElement {
  const a = el('a', cls ? 'card-link ' + cls : 'card-link') as HTMLAnchorElement;
  a.setAttribute('href', url);
  a.textContent = text;
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener noreferrer');
  a.setAttribute('referrerpolicy', 'no-referrer');
  a.setAttribute('title', url);
  return a;
}

/** The image widget: before the press no `img` element exists — the control names
 *  the host; the press swaps the image in place and records it; a load that fails
 *  says so in place and drops the key (WEB_INTERFACE → Content → "An image loads
 *  on the reader's press"). The loaded image always carries an alt — the
 *  description, or `image from <host>` when it is blank — and the referrer policy. */
function imageWidget(url: string, alt: string, key: string, opts: RenderContentOpts, block: boolean): HTMLElement {
  const host = gateUrl(url)!.host;
  const wrap = el(block ? 'div' : 'span', 'card-image' + (block ? ' block' : ''));
  const showImg = (): void => {
    wrap.textContent = '';
    const img = el('img', 'card-img') as HTMLImageElement;
    img.setAttribute('src', url);
    img.setAttribute('alt', alt || 'image from ' + host);
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.setAttribute('decoding', 'async');
    img.addEventListener('error', () => {
      wrap.textContent = '';
      const failed = el('span', 'img-failed');
      failed.appendChild(document.createTextNode('the image did not load from '));
      failed.appendChild(el('span', 'host', host));
      wrap.appendChild(failed);
      opts.onCollapse?.(key);
    });
    wrap.appendChild(img);
  };
  const showControl = (): void => {
    wrap.textContent = '';
    const btn = el('button', 'word img-show');
    btn.setAttribute('aria-label', 'show the image from ' + host);
    btn.appendChild(document.createTextNode('show image from '));
    btn.appendChild(el('span', 'host', host));
    btn.addEventListener('click', () => {
      showImg();
      opts.onExpand?.(key);
    });
    wrap.appendChild(btn);
  };
  if (opts.expanded?.has(key)) showImg();
  else showControl();
  return wrap;
}

/** An inline image: the alt words as text, then the collapsed control — no `img`
 *  before the press (WEB_INTERFACE → Content). */
function inlineImage(inline: { url: string; alt: string }, rs: RenderState): Node {
  const key = rs.opts.postId + ':' + rs.next++;
  const widget = imageWidget(inline.url, inline.alt, key, rs.opts, false);
  if (!inline.alt) return widget;
  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode(inline.alt + ' '));
  frag.appendChild(widget);
  return frag;
}

function renderInline(inline: Inline, rs: RenderState): Node {
  switch (inline.kind) {
    case 'text':
      return document.createTextNode(inline.text);
    case 'link':
      return anchor(inline.url, inline.text);
    case 'bareUrl':
      return anchor(inline.url, inline.url);
    case 'image':
      return inlineImage(inline, rs);
    case 'strong': {
      const s = el('strong');
      renderInlinesInto(inline.children, s, rs);
      return s;
    }
    case 'em': {
      const e = el('em');
      renderInlinesInto(inline.children, e, rs);
      return e;
    }
  }
}

function renderInlinesInto(inlines: Inline[], parent: HTMLElement, rs: RenderState): void {
  for (const inline of inlines) parent.appendChild(renderInline(inline, rs));
}

/** A paragraph's lines, each a line break from the last. */
function paragraphNode(lines: Inline[][], rs: RenderState): HTMLElement {
  const p = el('div', 'card-para');
  lines.forEach((line, i) => {
    if (i > 0) p.appendChild(el('br'));
    renderInlinesInto(line, p, rs);
  });
  return p;
}

function renderBlock(block: Block, rs: RenderState): HTMLElement {
  if (block.kind === 'title') {
    // A block one step up the card's type — 17px, weight 600 (WEB_INTERFACE → Content).
    const h = el('div', 'card-title');
    renderInlinesInto(block.inlines, h, rs);
    return h;
  }
  return paragraphNode(block.lines, rs);
}

/** The link card layout (WEB_INTERFACE → Content → "The link card"): for a link,
 *  the words as the card's text and the host `<a>` beneath — the only control
 *  that opens the target; for a bare URL, the URL's path (nothing when it is `/`)
 *  and the host beneath; for an image, the description as the text (nothing when
 *  blank) and the collapsed control beneath. The host renders in mono. */
function renderLinkCard(wrap: HTMLElement, only: Inline, rs: RenderState): void {
  wrap.classList.add('link-card');
  if (only.kind === 'link') {
    wrap.appendChild(el('div', 'lc-text', only.text));
    wrap.appendChild(anchor(only.url, gateUrl(only.url)!.host, 'lc-host'));
  } else if (only.kind === 'bareUrl') {
    const path = gateUrl(only.url)!.pathname;
    if (path !== '/') wrap.appendChild(el('div', 'lc-text', path));
    wrap.appendChild(anchor(only.url, gateUrl(only.url)!.host, 'lc-host'));
  } else if (only.kind === 'image') {
    if (only.alt) wrap.appendChild(el('div', 'lc-text', only.alt));
    wrap.appendChild(imageWidget(only.url, only.alt, rs.opts.postId + ':' + rs.next++, rs.opts, true));
  }
}

/** Build a card's content element, keeping the class `card-content` so every
 *  existing count and query holds (WEB_INTERFACE → Content). */
export function renderContent(blocks: Block[], opts: RenderContentOpts): HTMLElement {
  const wrap = el('div', 'card-content');
  const rs: RenderState = { opts, next: 0 };
  const only = linkCard(blocks);
  if (only) {
    renderLinkCard(wrap, only, rs);
    return wrap;
  }
  for (const block of blocks) wrap.appendChild(renderBlock(block, rs));
  return wrap;
}
