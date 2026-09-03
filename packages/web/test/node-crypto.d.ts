// The slice of Node's `crypto` the shim equivalence test compares against — the
// real implementation the shim must match. Scoped to the test tree so the
// browser app keeps no Node types: tsconfig.json compiles only `src`, and the
// shim there reaches these symbols through `buffer` and `@noble/*`, never Node.
//
// Everything is typed against `Uint8Array` (a Buffer is one) so the test needs
// no `@types/node` — which would drag Node's globals into the test tree and make
// `setTimeout`/`fetch` ambiguous against the DOM lib.
declare module 'node:crypto' {
  interface Hash {
    update(data: Uint8Array): Hash;
    digest(): Uint8Array;
  }
  export function createHash(algorithm: string): Hash;

  interface KeyObject {
    export(opts: { type: string; format: string }): Uint8Array;
  }
  export function generateKeyPairSync(type: 'ed25519'): { publicKey: KeyObject; privateKey: KeyObject };
  export function createPublicKey(input: { key: Uint8Array; format: string; type: string }): KeyObject;
  export function sign(algorithm: null, data: Uint8Array, key: KeyObject): Uint8Array;
  export function verify(algorithm: null, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;
}
