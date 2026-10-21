// The slice of Node's `fs`, `os` and `path` the shell-policy test writes a
// throwaway bridge entry, stages a build directory and reads the emitted
// shell through (web-shell-policy.test.ts). Scoped to the test tree so the
// browser app keeps no Node types, hand-declared rather than via
// `@types/node` — which would drag Node's globals into the test tree and
// make setTimeout/fetch ambiguous against the DOM lib (node-crypto.d.ts
// states the same rule).
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  export function existsSync(path: string): boolean;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}
