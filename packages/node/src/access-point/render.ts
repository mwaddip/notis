// NODE_INTERFACE → The access-point tool → "`setup` turns a box into an
// access point, in order" — the file contents each step writes: step 4's
// interface unit, step 6's dnsmasq conf and its systemd unit, step 7's
// nftables ruleset and its systemd unit.

export interface DnsmasqOptions {
  iface: 'uap0';
  address: '10.42.0.1';
  range: [string, string];
}

// Step 6's conf: the box's own DNS server, bound dynamically to uap0 so it
// starts before the interface holds its address, answers notis.internal
// with the box's address and refuses every other name at once — `local=/#/`
// with `no-resolv` and `no-hosts` — and hands out addresses naming the box
// as router and DNS server. The lease file lives under `/run/dagsocial-ap/`,
// which the dnsmasq unit creates with `RuntimeDirectory=`.
export function dnsmasqConf(o: DnsmasqOptions): string {
  const lines = [
    `interface=${o.iface}`,
    'bind-dynamic',
    'no-resolv',
    'no-hosts',
    'local=/#/',
    `address=/notis.internal/${o.address}`,
    `dhcp-range=${o.range[0]},${o.range[1]},255.255.255.0,12h`,
    `dhcp-option=option:router,${o.address}`,
    `dhcp-option=option:dns-server,${o.address}`,
    'dhcp-authoritative',
    'dhcp-leasefile=/run/dagsocial-ap/dnsmasq.leases',
    '',
  ];
  return lines.join('\n');
}

export interface FirewallOptions {
  iface: 'uap0';
  nodePort: number;
  meshUdpPort: number;
}

// Step 7's rule set: one table `inet dagsocial_ap`, flushed and redefined
// so a second load is the same rules. From uap0 the box accepts DHCP, DNS,
// the node port (after prerouting redirects :80 to it) and the mesh UDP
// port; every forwarded packet is refused, so a device on the access point
// learns at once that nothing beyond the box answers.
export function firewall(o: FirewallOptions): string {
  const q = '"';
  return `# nftables rules for the dagsocial access-point.
# Loaded by dagsocial-ap-firewall.service.
table inet dagsocial_ap
delete table inet dagsocial_ap
table inet dagsocial_ap {
\tchain prerouting {
\t\ttype nat hook prerouting priority -100; policy accept;
\t\tiifname ${q}${o.iface}${q} tcp dport 80 redirect to :${o.nodePort}
\t}
\tchain input {
\t\ttype filter hook input priority 0; policy accept;
\t\tiifname ${q}${o.iface}${q} udp dport 67 accept
\t\tiifname ${q}${o.iface}${q} udp dport 53 accept
\t\tiifname ${q}${o.iface}${q} tcp dport 53 accept
\t\tiifname ${q}${o.iface}${q} tcp dport ${o.nodePort} accept
\t\tiifname ${q}${o.iface}${q} udp dport ${o.meshUdpPort} accept
\t\tiifname ${q}${o.iface}${q} reject
\t}
\tchain forward {
\t\ttype filter hook forward priority 0; policy accept;
\t\tiifname ${q}${o.iface}${q} reject with icmpx admin-prohibited
\t\toifname ${q}${o.iface}${q} drop
\t}
}
`;
}

export interface IfaceUnitOptions {
  phy: string;
  uplinkIface: string;
}

// Step 4's unit: make uap0 from the uplink interface (or, for a box with no
// uplink, from the phy) at every boot, before NetworkManager starts. The
// unit waits for the uplink device at `/sys/subsystem/net/devices/<iface>`
// so the kernel has brought the interface up before `iw dev <iface>` runs;
// a no-uplink unit names no device dependency and runs under the phy. The
// unit remains after exit so a `systemctl stop` of it hits ExecStop.
export function ifaceUnit(o: IfaceUnitOptions): string {
  const hasUplink = o.uplinkIface !== '';
  const addCmd = hasUplink
    ? `/usr/sbin/iw dev ${o.uplinkIface} interface add uap0 type __ap`
    : `/usr/sbin/iw phy ${o.phy} interface add uap0 type __ap`;
  const deviceLine = hasUplink
    ? `Requires=sys-subsystem-net-devices-${o.uplinkIface}.device\nAfter=sys-subsystem-net-devices-${o.uplinkIface}.device\n`
    : '';
  return `[Unit]
Description=dagsocial access-point interface (uap0)
${deviceLine}Before=NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${addCmd}
ExecStop=/usr/sbin/iw dev uap0 del

[Install]
WantedBy=multi-user.target
`;
}

// Step 6's unit: the tool's own dnsmasq, bound to uap0 alone. systemd's
// `RuntimeDirectory=dagsocial-ap` creates `/run/dagsocial-ap/` before the
// service starts, so dnsmasq can write its lease file there.
export function dnsmasqUnit(): string {
  return `[Unit]
Description=dagsocial access-point dnsmasq
After=dagsocial-ap-iface.service
Wants=dagsocial-ap-iface.service

[Service]
Type=simple
RuntimeDirectory=dagsocial-ap
ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file=/etc/dagsocial/access-point/dnsmasq.conf
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;
}

// Step 7's unit: load the rule set on start, drop the table on stop.
export function firewallUnit(): string {
  return `[Unit]
Description=dagsocial access-point firewall

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/dagsocial/access-point/firewall.nft
ExecStop=/usr/sbin/nft delete table inet dagsocial_ap

[Install]
WantedBy=multi-user.target
`;
}
