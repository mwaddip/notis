// NODE_INTERFACE → The access-point tool — the access point's address,
// its network's CIDR and the DHCP range. The one place these are named;
// the orchestrator and `render.ts` import them from here.

export const AP_ADDRESS = '10.78.79.1';
export const AP_ADDRESS_CIDR = '10.78.79.1/24';
export const AP_NETWORK_CIDR = '10.78.79.0/24';
export const AP_DHCP_FROM = '10.78.79.10';
export const AP_DHCP_TO = '10.78.79.254';

// `nmcli -g IP4.ADDRESS dev show <dev>` emits each address on its own
// line or, where several hold, joined on one line by ` | `. The parser
// keeps the `<ip>/<prefix>` tokens and drops the rest.
export function parseIp4Addresses(nmcliOut: string): string[] {
  const out: string[] = [];
  for (const raw of nmcliOut.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    for (const part of line.split('|')) {
      const addr = part.trim();
      if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(addr)) out.push(addr);
    }
  }
  return out;
}

// Two IPv4 CIDRs overlap when their network addresses, masked to the
// shorter of the two prefixes, are equal — so a /24 and a /16 that
// share the first 16 bits overlap, and a /24 and a /25 that share the
// first 24 bits overlap. Unparseable input answers false.
export function overlaps(aCidr: string, bCidr: string): boolean {
  const a = parseCidr(aCidr);
  const b = parseCidr(bCidr);
  if (a === null || b === null) return false;
  const common = Math.min(a.bits, b.bits);
  const mask = cidrMask(common);
  return ((a.base & mask) >>> 0) === ((b.base & mask) >>> 0);
}

function parseCidr(cidr: string): { base: number; bits: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (m === null) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  for (const x of parts) {
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
  }
  const bits = Number(m[5]);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const base = (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
  return { base, bits };
}

function cidrMask(bits: number): number {
  if (bits === 0) return 0;
  if (bits >= 32) return 0xffffffff;
  return (-1 << (32 - bits)) >>> 0;
}
