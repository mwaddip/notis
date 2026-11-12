// NET_INTERFACE → Historical Sync — the one stream protocol every sync
// query and a serving reader's answer ride: `SyncInfo`, `GetHeaders` /
// `Headers`, `GetBlocks` / `Blocks`, `ModifierRequest` / `ModifierResponse`.
//
// Browser-safe: this module holds one string constant and imports nothing.
// It is the module a serving reader's handler imports, apart from
// `./sync.js`, which carries `node:crypto` through `./frame.js`.

export const SYNC_PROTOCOL = '/dagsocial/sync/1';
