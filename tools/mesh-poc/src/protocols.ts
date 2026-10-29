// The contract's numbers in one place (`MESH_INTERFACE → Discovery`,
// `MESH_INTERFACE → The client's node list`, `MESH_INTERFACE → NAT`,
// `MESH_INTERFACE → The IP certificate`).

export type NetworkName = 'devnet' | 'testnet' | 'mainnet';

export function dhtProtocol(_network: NetworkName): string {
  throw new Error('not implemented yet');
}

export const RETRY_BASE_MS: 5000 = 5000;
export const RETRY_CAP_MS: 600000 = 600000;
export const CHECK_INTERVAL_MS: 30000 = 30000;
export const CERT_RETRY_MS: 3600000 = 3600000;
export const STUN_PORT: 3478 = 3478;
