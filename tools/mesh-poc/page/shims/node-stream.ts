// MESH_INTERFACE → Place in the workspace — the mesh browser graph reaches
// `node:stream` only through `@libp2p/http-utils`'s barrel re-export of
// `stream-to-socket.js`, which `@libp2p/http-fetch`'s `read-response.js`
// and `send-request.js` pull in on every mesh fetch. The `Libp2pSocket`
// class in that module is a Duplex-based Node-side server adapter the
// browser never instantiates; `@libp2p/http-utils`'s `package.json`
// carries a `"browser": { "node:stream": "readable-stream" }` mapping
// for exactly this reason, but vite's `aliasPlugin` is the one hook that
// runs before user `enforce: 'pre'` plugins — `refuseNodeBuiltins` fires
// on `node:stream` before vite's internal resolver would apply that
// browser-field remap. The `resolve.alias` in `vite.config.ts` points
// `node:stream` here so the pre-plugin never sees the specifier; the
// resulting bundle holds no `node:` import. Pending main's direction on
// how to retire this file (one path is to rewrite `@libp2p/http-fetch`'s
// request/response pair ourselves without crossing the barrel).

export class Duplex {
  constructor() {
    throw new Error('node:stream Duplex is a server-only path (Libp2pSocket); browser must not instantiate it');
  }
}

export class Readable extends Duplex {}
export class Writable extends Duplex {}
export class Transform extends Duplex {}
export class PassThrough extends Duplex {}

export default { Duplex, Readable, Writable, Transform, PassThrough };
