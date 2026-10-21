import { isHex64Lower } from '@dagsocial/node-reads';

// WEB_INTERFACE → The standalone thread, → The workspace, → The extension:
// an id in a page's path, a token in the stored layout, and an id arriving
// from the hosted page through the bridge are read either-case and lower-cased.
// An id from a node is 64 lowercase hex (NODE_INTERFACE → HTTP API → "Hex is
// lowercase") and is read through `@dagsocial/node-reads`' `isHex64Lower`.

/** Read an either-case 64-hex string lower-cased, or `null` for anything else.
 *  Takes a value — the field read from a path, from the stored layout, or
 *  from an event on the hosted page — and either answers it as the id the
 *  client uses or refuses it.
 *
 *  WEB_INTERFACE → The standalone thread → "The id is 64 hex characters,
 *  lower-cased on read", → The workspace → "the stored layout's `parse`
 *  reads a token lower-cased". */
export function readHex64(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return isHex64Lower(lower) ? lower : null;
}
