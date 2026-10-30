export type Verdict = 'PASS' | 'FAIL' | 'skipped';
export interface StepResult { verdict: Verdict; measurement: unknown }
export interface Step { name: string; verdict: Verdict; measurement: unknown; timeMs: number }
export declare class StepRecorder {
  constructor();
  readonly steps: Step[];
  step(name: string, fn: () => Promise<StepResult> | StepResult): Promise<StepResult>;
  skipped(name: string, measurement?: unknown): void;
}
