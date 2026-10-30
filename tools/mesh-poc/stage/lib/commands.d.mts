import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export class CommandLog {
  dryRun: boolean;
  records: string[];
  privilegedCount: number;
  pids: Array<{ pid: number; description: string }>;
  constructor(opts: { dryRun: boolean });
  shell(name: string, argv: string[], opts?: { privileged?: boolean }): void;
  spawn(
    argvFull: string[],
    opts: { description: string; env?: Record<string, string>; cwd?: string },
  ): ChildProcessWithoutNullStreams | null;
}
