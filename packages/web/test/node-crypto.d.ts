// The slice of Node's `crypto` the identity module's tests round-trip through
// — the real implementation a signature or a key the module makes is checked
// against. Scoped to the test tree so the browser app keeps no Node types:
// tsconfig.json compiles only `src`.
//
// Everything is typed against `Uint8Array` (a Buffer is one) so the test needs
// no `@types/node` — which would drag Node's globals into the test tree and make
// `setTimeout`/`fetch` ambiguous against the DOM lib.
declare module 'node:crypto' {
  // A KeyObject the identity module's tests round-trip through Node:
  // `createPublicKey` parses the module's own SPKI DER, `verify` accepts a
  // signature the module's key produced.
  interface KeyObject {
    readonly type: string;
  }
  export function createPublicKey(input: { key: Uint8Array; format: string; type: string }): KeyObject;
  export function verify(algorithm: null, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;

  // The scrypt + ChaCha20-Poly1305 the envelope interop test decrypts with — the
  // standard-library half of the "any Node tool opens the file" claim (envelope.test.ts).
  export function scryptSync(
    password: Uint8Array,
    salt: Uint8Array,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem?: number },
  ): Uint8Array;
  interface Decipher {
    setAAD(buffer: Uint8Array, options: { plaintextLength: number }): Decipher;
    setAuthTag(buffer: Uint8Array): Decipher;
    update(data: Uint8Array): Uint8Array;
    final(): Uint8Array;
  }
  export function createDecipheriv(
    algorithm: string,
    key: Uint8Array,
    iv: Uint8Array,
    options: { authTagLength: number },
  ): Decipher;
}
