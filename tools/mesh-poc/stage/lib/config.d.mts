export function buildPageConfig(
  topology: any,
  nodeIdentities: Record<string, string>,
): {
  network: 'devnet' | 'testnet' | 'mainnet';
  anchors: Array<{ notisId: string; addrs: string[] }>;
  seeds: Array<{ notisId: string; addrs: string[] }>;
  stunServers: string[];
};
