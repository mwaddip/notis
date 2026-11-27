export declare const NAME: 's10';
export declare function describe(): string[];
export declare function parseStrangerPeerNpubs(stdout: string | Buffer): string[];
export declare function extractNotisNpubFromMeshIdentity(identity: unknown): string | null;
export declare function s10SplitArgs(topology: unknown, hostA: string, hostB: string): {
  hostA: {
    addTable: string[];
    addChainOut: string[];
    addChainIn: string[];
    dropOut: string[];
    dropIn: string[];
    deleteTable: string[];
  };
  hostB: {
    addTable: string[];
    addChainOut: string[];
    addChainIn: string[];
    dropOut: string[];
    dropIn: string[];
    deleteTable: string[];
  };
};
export declare function s10BrowserDropArgs(topology: unknown, accessHost: string): {
  addTable: string[];
  addChain: string[];
  drops: Array<{ name: string; argv: string[] }>;
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
