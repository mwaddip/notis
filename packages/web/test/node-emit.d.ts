// The slice of Node's `child_process`, `fs`, `os` and `path` the emitter test
// reads (emit-manifests.test.ts): spawn the emitter, make a fresh temp dir per
// case, remove it after, read the emitted manifests. Scoped to the test tree
// so the browser app keeps no Node types, hand-declared rather than via
// `@types/node` — which would drag Node's globals into the test tree and make
// setTimeout/fetch ambiguous against the DOM lib (node-crypto.d.ts and
// node-fs.d.ts state the same rule).
declare module 'node:child_process' {
  interface SpawnSyncReturns {
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: { encoding: 'utf8'; env?: Record<string, string | undefined> },
  ): SpawnSyncReturns;
}
declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...paths: string[]): string;
}
