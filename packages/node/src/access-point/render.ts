// NODE_INTERFACE → The access-point tool → "`setup` turns a box into an
// access point, in order" — the file contents each step writes: step 4's
// interface unit, step 6's dnsmasq conf and its systemd unit, step 7's
// nftables ruleset and its systemd unit.

export interface DnsmasqOptions {
  iface: 'uap0';
  address: '10.42.0.1';
  range: [string, string];
}

export function dnsmasqConf(_o: DnsmasqOptions): string {
  throw new Error('access-point: not implemented');
}

export interface FirewallOptions {
  iface: 'uap0';
  nodePort: number;
  meshUdpPort: number;
}

export function firewall(_o: FirewallOptions): string {
  throw new Error('access-point: not implemented');
}

export interface IfaceUnitOptions {
  phy: string;
  uplinkIface: string;
}

export function ifaceUnit(_o: IfaceUnitOptions): string {
  throw new Error('access-point: not implemented');
}

export function dnsmasqUnit(): string {
  throw new Error('access-point: not implemented');
}

export function firewallUnit(): string {
  throw new Error('access-point: not implemented');
}
