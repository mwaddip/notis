// A recording fake for the access-point tool's Runner seam. Tests register
// canned responses by predicate; the response may be a thunk so the fake
// can answer differently after a state-changing call. The fake records
// every call, file write and remove in order.

import type { Runner, RunResult } from '../../src/access-point/run.js';

export type RunMatch = (cmd: string, args: readonly string[]) => boolean;
export type RunResponse =
  | Partial<RunResult>
  | ((cmd: string, args: readonly string[]) => Partial<RunResult>);

export interface RunCall {
  cmd: string;
  args: string[];
}

export class FakeRunner implements Runner {
  calls: RunCall[] = [];
  writes: Array<{ path: string; text: string }> = [];
  removes: string[] = [];
  reads: string[] = [];
  files: Map<string, string> = new Map();
  logs: string[] = [];
  root = true;
  responses: Array<{ match: RunMatch; response: RunResponse }> = [];

  on(match: RunMatch, response: RunResponse = {}): this {
    this.responses.push({ match, response });
    return this;
  }

  async run(cmd: string, args: readonly string[]): Promise<RunResult> {
    this.calls.push({ cmd, args: [...args] });
    for (const r of this.responses) {
      if (r.match(cmd, args)) {
        const resp = typeof r.response === 'function' ? r.response(cmd, args) : r.response;
        return { code: 0, stdout: '', stderr: '', ...resp };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  async write(path: string, text: string): Promise<void> {
    this.writes.push({ path, text });
    this.files.set(path, text);
  }

  async read(path: string): Promise<string | null> {
    this.reads.push(path);
    return this.files.get(path) ?? null;
  }

  async remove(path: string): Promise<void> {
    this.removes.push(path);
    this.files.delete(path);
  }

  isRoot(): boolean {
    return this.root;
  }

  log(msg: string): void {
    this.logs.push(msg);
  }
}
