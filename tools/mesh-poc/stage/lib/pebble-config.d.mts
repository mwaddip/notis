export const SHORTLIVED_VALIDITY_SECONDS: number;
export const DEFAULT_VALIDITY_SECONDS: number;

export function buildPebbleConfig(opts: {
  listenAddress: string;
  managementListenAddress: string;
  httpChallengePort: number;
  tlsPort?: number;
  certificatePath: string;
  privateKeyPath: string;
}): {
  pebble: {
    listenAddress: string;
    managementListenAddress: string;
    httpPort: number;
    tlsPort: number;
    ocspResponderURL: string;
    profiles: Record<string, { description: string; validityPeriod: number }>;
    certificate: string;
    privateKey: string;
  };
};
