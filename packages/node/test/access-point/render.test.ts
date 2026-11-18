// NODE_INTERFACE → The access-point tool — the file contents each step
// writes. The renders are pure functions; this suite reads them back.

import { describe, it, expect } from 'vitest';
import {
  dnsmasqConf,
  firewall,
  ifaceUnit,
  dnsmasqUnit,
  firewallUnit,
} from '../../src/access-point/render.js';

describe('dnsmasqConf', () => {
  it('names the interface, binds dynamic, answers notis.internal, every other name refused at once', () => {
    const t = dnsmasqConf({
      iface: 'uap0',
      address: '10.42.0.1',
      range: ['10.42.0.10', '10.42.0.254'],
    });
    expect(t).toContain('interface=uap0');
    expect(t).toContain('bind-dynamic');
    expect(t).toContain('no-resolv');
    expect(t).toContain('no-hosts');
    expect(t).toContain('local=/#/');
    expect(t).toContain('address=/notis.internal/10.42.0.1');
    expect(t).toContain('dhcp-range=10.42.0.10,10.42.0.254,255.255.255.0,12h');
    expect(t).toContain('dhcp-option=option:router,10.42.0.1');
    expect(t).toContain('dhcp-option=option:dns-server,10.42.0.1');
    expect(t).toContain('dhcp-authoritative');
    expect(t).toContain('/var/lib/dagsocial/access-point/');
  });
});

describe('firewall', () => {
  it('redirects :80 to the node port, accepts DHCP, DNS, the node port and the mesh UDP port from uap0, rejects the rest', () => {
    const t = firewall({ iface: 'uap0', nodePort: 3000, meshUdpPort: 9733 });
    expect(t).toContain('table inet dagsocial_ap');
    expect(t).toContain('delete table inet dagsocial_ap');
    expect(t).toMatch(/iifname "uap0" tcp dport 80 redirect to :3000/);
    expect(t).toMatch(/iifname "uap0" udp dport 67 accept/);
    expect(t).toMatch(/iifname "uap0" udp dport 53 accept/);
    expect(t).toMatch(/iifname "uap0" tcp dport 53 accept/);
    expect(t).toMatch(/iifname "uap0" tcp dport 3000 accept/);
    expect(t).toMatch(/iifname "uap0" udp dport 9733 accept/);
    expect(t).toMatch(/iifname "uap0" reject/);
    expect(t).toMatch(/iifname "uap0" reject with icmpx admin-prohibited/);
    expect(t).toMatch(/oifname "uap0" drop/);
  });
});

describe('ifaceUnit', () => {
  it('runs before NetworkManager, oneshot, adds uap0 from the uplink interface', () => {
    const t = ifaceUnit({ phy: 'phy0', uplinkIface: 'wlan0' });
    expect(t).toContain('Before=NetworkManager.service');
    expect(t).toContain('Type=oneshot');
    expect(t).toContain('RemainAfterExit=yes');
    expect(t).toContain('ExecStart=/usr/sbin/iw dev wlan0 interface add uap0 type __ap');
    expect(t).toContain('ExecStop=/usr/sbin/iw dev uap0 del');
  });
});

describe('dnsmasqUnit', () => {
  it('runs dnsmasq in the foreground with the tool\'s conf', () => {
    const t = dnsmasqUnit();
    expect(t).toContain('ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file=/etc/dagsocial/access-point/dnsmasq.conf');
  });
});

describe('firewallUnit', () => {
  it('loads the rule set on start and deletes the table on stop', () => {
    const t = firewallUnit();
    expect(t).toContain('ExecStart=/usr/sbin/nft -f /etc/dagsocial/access-point/firewall.nft');
    expect(t).toContain('ExecStop=/usr/sbin/nft delete table inet dagsocial_ap');
  });
});
