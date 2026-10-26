/** The hex check for client input — a 64-char string, case-insensitive, since
 *  the caller may supply the key as the row shows it; the client lowercases
 *  it where the chain is read against (TYPES_INTERFACE → Identity). The hex of
 *  a node's answer takes `isHex64` of `@dagsocial/types`
 *  (NODE_INTERFACE → HTTP API → "Hex is lowercase"). */
export const HEX_64 = /^[0-9a-f]{64}$/i;
