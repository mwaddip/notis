export function buildPageConfig(
  topology: any,
  nodeIdentities: Record<string, string>,
  realMultiaddrs?: Record<string, string[]>,
  opts?: { dryRun?: boolean },
): {
  network: 'devnet' | 'testnet' | 'mainnet';
  anchors: Array<{ notisId: string; addrs: string[] }>;
  seeds: Array<{ notisId: string; addrs: string[] }>;
};

export interface IdentitiesRow {
  notisId: string;
  meshRole: 'public' | 'private' | null;
  addr: string | null;
  httpPort: number | null;
  multiaddrs: string[];
  localAddrs: string[];
}

export function buildIdentitiesOut(
  topology: any,
  notisIds: Record<string, string>,
  meshIdentities: Record<string, { multiaddrs?: string[]; localAddrs?: string[] } | undefined>,
): Record<string, IdentitiesRow>;

export function peerIdStringOf(notisId: string): string;
