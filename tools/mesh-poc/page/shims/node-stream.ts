// MESH_INTERFACE → Place in the workspace — a browser-side shim for the
// `node:stream` imports pulled in by `@libp2p/http-utils`'s barrel: its
// `stream-to-socket.js` builds a `Libp2pSocket` whose base is `Duplex`,
// and the barrel re-exports the module unconditionally. The browser
// never instantiates `Libp2pSocket` (the server side runs on Node),
// so the import stays satisfiable while the class itself is dead code
// that rollup's tree shake drops. `Duplex` is a stand-in whose
// prototype is never reached in the browser build.
//
// The vite alias replaces `node:stream` with this file BEFORE
// `refuseNodeBuiltins` runs (vite's alias plugin precedes user
// `enforce: 'pre'` plugins), so the built bundle holds no `node:`
// specifier and the output scan stays green.

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
