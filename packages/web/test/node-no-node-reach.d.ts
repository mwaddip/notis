// The slice of Node's fs, path, url and module the mesh bundle's no-Node-reach
// scan reads. Scoped to the test tree so the browser app keeps no Node types,
// and hand-declared rather than via @types/node — which would drag Node's
// globals into the test tree and make setTimeout/fetch ambiguous against the
// DOM lib.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function statSync(path: string): Stats;
}
declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}
declare module 'node:module' {
  export const builtinModules: readonly string[];
}
declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface Process {
    env: ProcessEnv;
  }
}
declare const process: NodeJS.Process;
