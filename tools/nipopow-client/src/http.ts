// The light client's verdict text and the proof blob's base64 decode. The
// capped reader and the shape guard this file's callers pass through come
// from @dagsocial/node-reads.

/** The most characters of any one node-supplied string a verdict names,
 *  counted as shown. */
const VERDICT_TEXT_MAX = 120;

/**
 * A node's text as a verdict names it, for a person to read: every C0 control,
 * DEL and C1 control as its `\u` escape — ESC as `\u001b`, CR as `\u000d` —
 * never raw; the text so shown whole up to 120 characters, else as much of it
 * as fits in 120 and `…`, a surrogate pair and an escape never split. Applied
 * where the text enters a verdict, never to the data a status is decided on —
 * the nipopow route's 404 is classified by its body's `error` (NODE_INTERFACE →
 * Nipopow).
 */
export function capped(text: string): string {
  let out = '';
  // A string iterates by code point, a surrogate pair as one step.
  for (const ch of text) {
    const unit = isControl(ch) ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch;
    if (out.length + unit.length > VERDICT_TEXT_MAX) return `${out}…`;
    out += unit;
  }
  return out;
}

// C0 (U+0000–U+001F), DEL (U+007F) and C1 (U+0080–U+009F).
function isControl(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
}

/**
 * A node's value as a verdict names it: a string quoted and capped, anything
 * else by its kind. Never converted — a parsed object can carry a `toString`
 * that is not a function, and converting it throws.
 */
export function shown(v: unknown): string {
  if (typeof v === 'string') return `'${capped(v)}'`;
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

/**
 * NODE_INTERFACE → AVL+ State Root — the proof blob is standard base64,
 * decoded with `atob`, a global in both browsers and Node 22. It throws on a
 * character outside the alphabet or on a wrong length — caught here so a
 * malformed blob from a lying node is a refused proof, `null`, never an
 * exception out of the library.
 */
export function base64ToBytes(b64: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
