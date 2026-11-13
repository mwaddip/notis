// Storage keys the identity module and the extension's background and proxy
// read and write under (WEB_INTERFACE → The extension → "The contexts, and
// what each may hold"). One name per key, every reader imports it; the string
// is byte-exact so an installed build reads the value it already holds.

/** The envelope — scrypt and ChaCha20-Poly1305 over the seed — in
 *  `storage.local` (WEB_INTERFACE → The identity module). */
export const IDENTITY_KEY = 'notis.identity';

/** The flag the export of the encrypted key file sets, in `storage.local`
 *  (WEB_INTERFACE → The profile window). */
export const BACKEDUP_KEY = 'notis.identity.backedup';

/** The extension's binary sign preference — `'silent'` or `'ask'` — in
 *  `storage.local` (WEB_INTERFACE → The extension). */
export const POLICY_KEY = 'notis.signPolicy';

/** The unlocked seed in hex, in `storage.session`
 *  (WEB_INTERFACE → The extension → "The contexts, and what each may hold"). */
export const SEED_KEY = 'notis.seed';

/** The hand-added node's address, in `localStorage` — the address a node prints
 *  at start, held by the page and handed to the mesh client as a trusted node at
 *  load (WEB_INTERFACE → The settings window → "In the extension the row adds a
 *  node by hand"; MESH_INTERFACE → Discovery → "A node added by hand"). */
export const HAND_NODE_KEY = 'notis.node.hand';

/** The hand-added node's off state, in `localStorage` (WEB_INTERFACE → The
 *  settings window → "The reader may switch it off"). Holds `'1'` while the
 *  reader has switched it off; a page that loads next starts without the
 *  node until the reader turns it on. */
export const HAND_NODE_OFF_KEY = 'notis.node.hand.off';

/** The reader's serve-posts choice, in `localStorage` (WEB_INTERFACE → The
 *  settings window → "The serve row"). Holds `'1'` while on; any other value
 *  or none is off. Read at the mesh client's start and written at a press. */
export const SERVE_KEY = 'notis.serve';
