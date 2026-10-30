import type { ChildProcess } from 'node:child_process';

export interface PidEntry {
  pid: number;
  description: string;
  logPath?: string;
}

export function isProcessAlive(pid: number): { alive: boolean; reason: string };

export class CommandLog {
  dryRun: boolean;
  records: string[];
  privilegedCount: number;
  pids: PidEntry[];
  constructor(opts: { dryRun: boolean });
  shell(name: string, argv: string[], opts?: { privileged?: boolean }): void;
  spawn(
    argvFull: string[],
    opts: {
      description: string;
      env?: Record<string, string>;
      cwd?: string;
      logPath?: string;
    },
  ): ChildProcess | null;
}
