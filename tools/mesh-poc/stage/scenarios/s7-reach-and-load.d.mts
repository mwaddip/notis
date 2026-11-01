export declare const NAME: 's7';
export declare function describe(): string[];
export declare function pub2NetemArgs(topology: unknown): {
  iface: string;
  add: string[];
  del: string[];
};
export declare function applyFaults(log: unknown, topology: unknown): void;
export declare const S7_WAIT_ONE_COMPLETED_CHECK_PREDICATE: string;
export declare function buildSeedOnlyLanVariant(
  baseConfig: { network: string; anchors: unknown },
  lan1Row: { notisId: string; localAddrs?: string[]; multiaddrs?: string[] } | null,
): { network: string; anchors: unknown; seeds: Array<{ notisId: string; addrs: string[] }> };
export declare function buildByHandLanVariant(
  baseConfig: { network: string },
  lan1Row: { notisId: string; localAddrs?: string[]; multiaddrs?: string[] } | null,
  trusted: boolean,
): { network: string; anchors: unknown[]; seeds: unknown[]; byHand: Array<{ notisId: string; addrs: string[]; trusted: boolean }> };
export declare function run(ctx: { dryRun: boolean; topology: unknown; [k: string]: unknown }): Promise<{
  scenario: string;
  startedAt: number;
  endedAt: number;
  steps: Array<{ name: string; verdict: 'PASS' | 'FAIL' | 'skipped'; measurement: unknown; timeMs?: number }>;
  faults: string[];
}>;
