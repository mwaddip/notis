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
export declare function restartFromEntry(entry: PidEntry): number;
export declare function pollUntil<T>(read: () => Promise<T> | T, predicate: (v: T) => boolean, opts?: { timeoutMs?: number; pollMs?: number; name?: string }): Promise<T>;
export declare function nftApply(ns: string, nftArgs: string[], opts?: { timeoutMs?: number }): void;
