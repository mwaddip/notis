export function malformedBody(): { proof: string };
export function invalidBody(validProofHex: string): { proof: string };
export function startHostileUpstream(opts: {
  port: number;
  mode: 'malformed' | 'invalid';
  pub1Base: string;
}): Promise<{ server: import('node:http').Server; port: number }>;
