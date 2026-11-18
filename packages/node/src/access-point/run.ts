// NODE_INTERFACE → The access-point tool — the seam the tool runs its
// commands and file edits through. The real one is built in
// `src/access-point.ts`; the suite's recording fake answers from the
// fixtures.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(cmd: string, args: readonly string[]): Promise<RunResult>;
  write(path: string, text: string): Promise<void>;
  read(path: string): Promise<string | null>;
  remove(path: string): Promise<void>;
  isRoot(): boolean;
  log(msg: string): void;
}
