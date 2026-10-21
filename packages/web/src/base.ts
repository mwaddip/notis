// The six-tag paragraph of WEB_INTERFACE → "The client is served from the
// node's own origin" states each meta's content, trimmed, with one trailing
// `/` stripped. One definition.

/** Strip exactly one trailing `/` from a base, so the client builds the same
 *  URL whichever form a caller passed in and `https://a/` and `https://a` are
 *  one node (WEB_INTERFACE → "The client is served from the node's own
 *  origin"). */
export function trimBase(base: string): string {
  return base.replace(/\/$/, '');
}
