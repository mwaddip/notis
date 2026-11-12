export interface DirectRead { status: number; bytes: number; sha256: string }
export interface PidEntry {
  pid: number;
  description: string;
  logPath: string;
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
}
export declare function execIn(ns: string, argv: string[], opts?: { user?: string; timeoutMs?: number; inputBuffer?: Buffer | null }): Buffer;
export declare function readDirect(ns: string, httpUrl: string, opts?: { user?: string; timeoutMs?: number }): DirectRead;
export declare function readLineCount(path: string): number;
export declare function readMtimeMs(path: string): number | null;
export declare function sumNftCounters(json: unknown): number;
export declare function readNftCounterSum(ns: string, table: string, opts?: { timeoutMs?: number }): number;
export declare function findPid(pids: PidEntry[] | undefined, description: string): PidEntry | null;
export declare function sigterm(pid: number): { sent: boolean; reason: string | null };
export declare function signal(pid: number, sig: NodeJS.Signals): { sent: boolean; reason: string | null };
export declare function signalPid(pid: number, sig: NodeJS.Signals): { sent: boolean; reason: string | null };
export declare function isPidAlive(pid: number): boolean;
export declare function descendantPids(pid: number): number[];
export declare function leafPids(pid: number): number[];
export declare function stopTree(rootPid: number, opts?: {
  timeoutMs?: number;
  pollMs?: number;
  killGraceMs?: number;
}): Promise<{
  initialTree: number[];
  termSent: number[];
  killSent: number[];
  survivors: number[];
}>;
export declare function waitNetworkingUp(ns: string, adminPort: number, opts?: {
  timeoutMs?: number;
  pollMs?: number;
  user?: string | null;
}): Promise<{ peers_connected: number } & Record<string, unknown>>;
export declare function restartFromEntry(entry: PidEntry, opts?: {
  pidsPath?: string | null;
  envOverride?: Record<string, string>;
}): number;
export declare function pollUntil<T>(read: () => Promise<T> | T, predicate: (v: T) => boolean, opts?: { timeoutMs?: number; pollMs?: number; name?: string }): Promise<T>;
export declare function nftApply(ns: string, nftArgs: string[], opts?: { timeoutMs?: number }): void;
