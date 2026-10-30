export declare const NAME: 's5';
export declare function describe(): string[];
export declare function writeFreshMeshKey(path: string, opts: { randomBytes: (n: number) => Buffer | Uint8Array }): { seed: Buffer | Uint8Array; pub: Uint8Array; notisId: string };
export declare function applyFaults(log: unknown, topology: unknown): void;
export declare function run(ctx: { dryRun: boolean; topology: unknown; [k: string]: unknown }): Promise<{
  scenario: string;
  startedAt: number;
  endedAt: number;
  steps: Array<{ name: string; verdict: 'PASS' | 'FAIL' | 'skipped'; measurement: unknown; timeMs?: number }>;
  faults: string[];
}>;
