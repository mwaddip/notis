// STUB — the real implementation lands in the next commit.

export class FaultLog {
  constructor(opts) {
    this.dryRun = Boolean(opts?.dryRun);
    this.scenario = String(opts?.scenario ?? '');
    this.records = [];
    this.removals = [];
  }
  apply() { throw new Error('FaultLog.apply: not implemented'); }
  signal() { throw new Error('FaultLog.signal: not implemented'); }
  spawn() { throw new Error('FaultLog.spawn: not implemented'); }
  removeAll() { /* stub: nothing to remove */ }
}

export function assertStagePrivileged() {
  throw new Error('assertStagePrivileged: not implemented');
}
