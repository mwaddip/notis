// MESH_INTERFACE → Place in the workspace — the mesh browser graph reaches
// `node:stream` through one module: `@libp2p/http-utils`' barrel re-exports
// `stream-to-socket.js`, whose `Libp2pSocket extends Duplex` is a Node-side
// server adapter the browser never instantiates. `vite.config.ts` aliases
// `node:stream` to this file so the import resolves to a stub; every class
// below throws if constructed, so a browser caller that reaches
// `Libp2pSocket` crashes at once rather than running on a half-ported Duplex.

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
