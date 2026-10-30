export declare const NAME: 's1';
export declare function describe(): string[];
export declare function applyFaults(log: unknown, topology: unknown): void;
export declare function hostOfNodeId(identities: unknown, nodeId: string): string | null;
export declare function anchorIdSet(config: unknown): Set<string>;
export declare function run(ctx: { dryRun: boolean; topology: unknown; [k: string]: unknown }): Promise<{
  scenario: string;
  startedAt: number;
  endedAt: number;
  steps: Array<{ name: string; verdict: 'PASS' | 'FAIL' | 'skipped'; measurement: unknown; timeMs?: number }>;
  faults: string[];
}>;
