// Storage keys the identity module and the extension's background and proxy
// read and write under (WEB_INTERFACE → The extension → "The contexts, and
// what each may hold"). One name per key, every reader imports it; the string
// is byte-exact so an installed build reads the value it already holds.

/** The envelope — scrypt and ChaCha20-Poly1305 over the seed — in
 *  `storage.local` (WEB_INTERFACE → The identity module). */
export const IDENTITY_KEY = 'notis.identity';

/** The flag the export of the encrypted key file sets, in `storage.local`
 *  (WEB_INTERFACE → The profile window → "The backed up state"). */
export const BACKEDUP_KEY = 'notis.identity.backedup';

/** The extension's binary sign preference — `'silent'` or `'ask'` — in
 *  `storage.local` (WEB_INTERFACE → The extension → "sign each rep action"). */
export const POLICY_KEY = 'notis.signPolicy';

/** The unlocked seed in hex, in `storage.session`
 *  (WEB_INTERFACE → The extension → "The contexts, and what each may hold"). */
export const SEED_KEY = 'notis.seed';
