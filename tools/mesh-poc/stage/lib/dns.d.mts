export const RCODE_REFUSED: 5;

export interface DnsQuestion {
  id: number;
  name: string;
  type: string;
  typeCode: number;
  questionEnd: number;
}

export function parseDnsQuery(bytes: Buffer | Uint8Array): DnsQuestion;
export function buildRefused(originalBytes: Buffer | Uint8Array, q: DnsQuestion): Buffer;
