export interface PageConfigShape {
  network: string;
  anchors: Array<{ notisId: string; addrs: string[] }>;
  stunServers: string[];
  seeds: Array<{ notisId: string; addrs: string[] }>;
}
export declare function buildPrivateViaRelayVariant(
  baseConfig: PageConfigShape,
  opts: { privNotisId: string; privPeerIdString: string; viaPublicNotisId: string },
): PageConfigShape;
export interface IdentityRow {
  notisId: string;
  meshRole?: string | null;
  addr?: string | null;
  httpPort?: number | null;
  multiaddrs?: string[];
}
export declare function buildPrivateViaAnnouncedRelayVariant(
  baseConfig: PageConfigShape,
  opts: { privRow: IdentityRow; identities: Record<string, IdentityRow> },
): PageConfigShape;
export declare function buildPrivateViaAnnouncedRelayPairVariant(
  baseConfig: PageConfigShape,
  opts: { privRow: IdentityRow; identities: Record<string, IdentityRow> },
): PageConfigShape;
export declare function buildWithHostileSeedsVariant(
  baseConfig: PageConfigShape,
  seeds: Array<{ notisId: string; addrs: string[] }>,
): PageConfigShape;
export declare function buildHostileSeeds(
  identities: unknown,
  topology: unknown,
  opts: { peerIdStringOf: (notisId: string) => string },
): Array<{ notisId: string; addrs: string[] }>;
