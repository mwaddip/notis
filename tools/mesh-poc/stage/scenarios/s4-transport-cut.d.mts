export declare const NAME: 's4';
export declare function describe(): string[];
export declare function udpDropArgs(topology: unknown): {
  addTable: string[]; addChain: string[];
  perHost: Array<{ name: string; argv: string[] }>;
  deleteTable: string[];
};
export declare function notisTcpCutArgs(topology: unknown): Array<{
  host: string; addTable: string[]; addChain: string[]; dropDport: string[]; deleteTable: string[];
}>;
export declare function applyFaults(log: unknown, topology: unknown): void;
export declare function run(ctx: { dryRun: boolean; topology: unknown; [k: string]: unknown }): Promise<{
  scenario: string;
  startedAt: number;
  endedAt: number;
  steps: Array<{ name: string; verdict: 'PASS' | 'FAIL' | 'skipped'; measurement: unknown; timeMs?: number }>;
  faults: string[];
}>;
