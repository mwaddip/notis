export declare const NAME: 's6';
export declare function describe(): string[];
export declare function anchorBlockArgs(topology: unknown): {
  addTable: string[]; addChain: string[]; drops: string[][]; deleteTable: string[];
};
export declare function applyFaults(log: unknown, topology: unknown): void;
export declare function run(ctx: { dryRun: boolean; topology: unknown; [k: string]: unknown }): Promise<{
  scenario: string;
  startedAt: number;
  endedAt: number;
  steps: Array<{ name: string; verdict: 'PASS' | 'FAIL' | 'skipped'; measurement: unknown; timeMs?: number }>;
  faults: string[];
}>;
