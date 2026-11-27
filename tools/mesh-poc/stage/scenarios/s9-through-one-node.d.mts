export declare const NAME: 's9';
export declare function describe(): string[];
export declare function s9ThroughOneNodeArgs(topology: unknown, accessHost: string): {
  addTable: string[];
  addChain: string[];
  drops: Array<{ name: string; argv: string[] }>;
  deleteTable: string[];
};
export declare function s9CutArgs(topology: unknown, host: string): {
  addTable: string[];
  addChain: string[];
  dropWebrtc: string[];
  dropMeshTcp: string[];
  dropNotisTcp: string[];
  dropAllUdp: string[];
  deleteTable: string[];
};
export declare function applyFaults(log: unknown, topology: unknown): void;
export declare function run(ctx: { dryRun: boolean; topology: unknown; [k: string]: unknown }): Promise<{
  scenario: string;
  startedAt: number;
  endedAt: number;
  steps: Array<{ name: string; verdict: 'PASS' | 'FAIL' | 'skipped'; measurement: unknown; timeMs?: number }>;
  faults: string[];
}>;
