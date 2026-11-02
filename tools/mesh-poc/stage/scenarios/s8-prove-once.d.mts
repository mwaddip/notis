export declare const NAME: 's8';
export declare function describe(): string[];
export declare function s8GapFirewallArgs(topology: unknown): {
  addTable: string[];
  addChain: string[];
  drops: Array<{ name: string; argv: string[] }>;
  deleteTable: string[];
};
export declare function applyFaults(log: unknown, topology: unknown): void;
export declare const S8_GOSSIP_EXPR: string;
export declare const S8_GOSSIP_PREDICATE: string;
export declare function buildS8NoProofsExpression(honestIds: string[]): string;
export declare const S8_NOPROOFS_PREDICATE: string;
export declare function buildS8ForkExpression(laggingId: string): string;
export declare const S8_FORK_PREDICATE: string;
export declare const S8_GAP_EXPR: string;
export declare const S8_GAP_PREDICATE: string;
export declare function run(ctx: { dryRun: boolean; topology: unknown; [k: string]: unknown }): Promise<{
  scenario: string;
  startedAt: number;
  endedAt: number;
  steps: Array<{ name: string; verdict: 'PASS' | 'FAIL' | 'skipped'; measurement: unknown; timeMs?: number }>;
  faults: string[];
}>;
