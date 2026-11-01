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

export function peerIdStringOf(notisId: string): string;
