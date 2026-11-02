export const HOSTILE_FORK_PAIR: readonly ['hostile-lagging', 'hostile-malformed'];
export function partnerOf(name: string): string | null;
export function joinBootstrapPeers(base: string | undefined | null, extras: readonly string[]): string;
export function pairBootstrapAddr(topology: unknown, name: string): string | null;
export interface NftRule {
  description: string;
  argv: string[];
}
export function buildHostCutArgs(
  topology: unknown,
  name: string,
  options?: { table?: string },
): NftRule[];
export function buildPairCutArgs(
  topology: unknown,
  options?: { table?: string },
): NftRule[];
export function notisBootstrapPeersFor(
  topology: unknown,
  name: string,
  pub1Addr: string,
): string;
