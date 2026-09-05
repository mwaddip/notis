// The slice of Node's fs and url a lexical stylesheet pin reads a source file
// through (style.test.ts). Scoped to the test tree so the browser app keeps no
// Node types, and hand-declared rather than via @types/node — which would drag
// Node's globals into the test tree and make setTimeout/fetch ambiguous against
// the DOM lib (node-crypto.d.ts states the same rule).
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}
