// The slice of Node's `fs`, `child_process`, `os`, `path` and `url` the
// build-commit test reads: spawn `git` under a fresh mkdtemp, write the
// tracked placeholder, read the module's answer. Scoped to the test tree so
// the browser app keeps no Node types, hand-declared rather than via
// `@types/node` — which would drag Node's globals into the test tree and make
// setTimeout/fetch ambiguous against the DOM lib.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive: boolean }): void;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  export function existsSync(path: string): boolean;
}
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
    options: { encoding: 'utf8'; env?: Record<string, string | undefined>; cwd?: string },
  ): SpawnSyncReturns;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...paths: string[]): string;
}
