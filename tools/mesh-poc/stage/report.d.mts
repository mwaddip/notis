export interface ScenarioStep {
  name: string;
  verdict: 'PASS' | 'FAIL' | 'skipped';
  measurement: unknown;
  timeMs?: number;
}
export interface ScenarioResult {
  scenario: string;
  startedAt: number;
  endedAt: number;
  steps: ScenarioStep[];
  faults?: string[];
}
export declare function buildSummary(scenarios: ScenarioResult[]): string;
export declare function writeSummaryFromDir(scenariosDir?: string, summaryPath?: string): { summaryPath: string; scenarios: number };
