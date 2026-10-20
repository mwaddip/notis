// WEB_INTERFACE → The wallet → "Reconcile runs on the reader's own refresh
// and on the bounded poll below" — the decrement of a 64-lowercase-hex id,
// so a pending send's landing read asks the one page the payment box would
// open: `GET /credits/<recipient>?after=<amount>:<the id less one>&limit=1`.
// The all-zero id has none below it (the entry reads as pending; no request
// leaves).

/** The 64-lowercase-hex id one below `id`, or `null` when `id` is all zeros.
 *  Each nibble decrements from 'f' through 'a' and '9' through '0'; a '0'
 *  borrows from the nibble to its left (which decrements by one). */
export function decrementBoxId(id: string): string | null {
  const chars = id.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i]!;
    if (c === '0') {
      chars[i] = 'f';
      continue;
    }
    chars[i] = c === 'a' ? '9'
      : c === 'b' ? 'a'
      : c === 'c' ? 'b'
      : c === 'd' ? 'c'
      : c === 'e' ? 'd'
      : c === 'f' ? 'e'
      : String.fromCharCode(c.charCodeAt(0) - 1); // '1'..'9' → '0'..'8'
    return chars.join('');
  }
  return null; // id is all zeros
}
