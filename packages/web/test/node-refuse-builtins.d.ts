// The slice of Node's fs and path the refuse-node-builtins test writes and
// cleans up a throwaway entry through (refuse-node-builtins.test.ts). Scoped
// to the test tree so the browser app keeps no Node types, hand-declared
// rather than via @types/node — which would drag Node's globals into the
// test tree and make setTimeout/fetch ambiguous against the DOM lib
// (node-crypto.d.ts states the same rule).
declare module 'node:fs' {
  export function writeFileSync(path: string, data: string): void;
}
declare module 'node:path' {
  export function dirname(path: string): string;
}
