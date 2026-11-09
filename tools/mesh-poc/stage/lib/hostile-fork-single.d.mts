// MESH_INTERFACE → Acceptance 6 — the single-host fork builder's
// types, read by tests and by stage code. The .mjs module holds the
// doc; these are the shapes.

export interface Topology {
  hosts: Record<string, {
    addr?: string;
    node?: { p2pPort?: number; httpPort?: number; role?: string };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface NftRule {
  description: string;
  argv: string[];
}

export function buildForkCutArgs(
  topology: Topology,
  name: string,
  options: {
    table?: string;
    partner: { addr: string };
    browserAddr: string;
  },
): NftRule[];

export function buildForkCutTeardownArgs(
  name: string,
  options?: { table?: string },
): NftRule[];

export interface MinerSpawnPlan {
  description: string;
  argv: string[];
  env: Record<string, string>;
}

export function buildForkMinerSpawn(
  topology: Topology,
  name: string,
  options: {
    minerScript: string;
    minerPct?: number;
    invokingUser?: string;
    miningSecret?: string;
    nodeBin?: string;
  },
): MinerSpawnPlan;

export function forkHostBootstrapPeers(pub1Addr: string): string;
