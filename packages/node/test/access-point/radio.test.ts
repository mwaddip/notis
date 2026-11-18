// NODE_INTERFACE → The access-point tool — the parsers that read `iw` and
// `nmcli` output on the Pi. Each case runs against the fixture from the
// measured Pi (replaced identifiers only; §3.1 of the design).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseCombinations,
  parseRadarChannels,
  parseUplink,
  parseScan,
  parseConnectedWifi,
  parseGeneralConnection,
} from '../../src/access-point/radio.js';

const FIX = join(__dirname, '../fixtures/access-point');
const iwList = readFileSync(join(FIX, 'iw-list.txt'), 'utf8');
const iwDev = readFileSync(join(FIX, 'iw-dev.txt'), 'utf8');
const iwDevWlan0 = readFileSync(join(FIX, 'iw-dev-wlan0-info.txt'), 'utf8');
const nmcliWifi = readFileSync(join(FIX, 'nmcli-wifi-list.txt'), 'utf8');
const nmcliCon = readFileSync(join(FIX, 'nmcli-con.txt'), 'utf8');

describe('parseCombinations', () => {
  it('the Pi offers a managed-with-AP combination', () => {
    const c = parseCombinations(iwList);
    expect(c.managedWithAp).toBe(true);
  });

  it('a radio without any AP line answers managedWithAp: false', () => {
    const noAp = `valid interface combinations:
\t * #{ managed } <= 2, total <= 2, #channels <= 1
`;
    expect(parseCombinations(noAp).managedWithAp).toBe(false);
  });

  it('a combination with managed alone, another with AP alone, is refused', () => {
    const split = `valid interface combinations:
\t * #{ managed } <= 2, total <= 2, #channels <= 1
\t * #{ AP } <= 1, total <= 1, #channels <= 1
`;
    expect(parseCombinations(split).managedWithAp).toBe(false);
  });
});

describe('parseRadarChannels', () => {
  it('the Pi reports 52–64 and 100–144 as radar channels', () => {
    const r = parseRadarChannels(iwList);
    for (const c of [52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144]) {
      expect(r.has(c)).toBe(true);
    }
    // 2.4 GHz and non-radar 5 GHz channels are not in the set.
    expect(r.has(1)).toBe(false);
    expect(r.has(6)).toBe(false);
    expect(r.has(149)).toBe(false);
  });
});

describe('parseUplink', () => {
  it('the Pi is on wlan0, SSID HomeNetwork, channel 100', () => {
    const u = parseUplink(iwDevWlan0);
    expect(u).not.toBeNull();
    expect(u!.iface).toBe('wlan0');
    expect(u!.ssid).toBe('HomeNetwork');
    expect(u!.channel).toBe(100);
  });

  it('an `iw dev` without a wlan0 info block answers null', () => {
    // The `iw dev` output alone doesn't carry channel for an unassociated
    // interface — parseUplink reads `iw dev <dev> info`, so a non-info
    // text with no ssid line answers null.
    expect(parseUplink('phy#0\n\tUnnamed/non-netdev interface\n')).toBeNull();
  });
});

describe('parseScan', () => {
  it('the Pi sees HomeNetwork on channel 1 and 100', () => {
    const scan = parseScan(nmcliWifi);
    expect(scan).toEqual([
      { ssid: 'HomeNetwork', channel: 1 },
      { ssid: 'HomeNetwork', channel: 100 },
    ]);
  });

  it('a colon escape in the SSID is honoured', () => {
    const txt = `my\\:net:1:2412 MHz\nother:6:2437 MHz\n`;
    expect(parseScan(txt)).toEqual([
      { ssid: 'my:net', channel: 1 },
      { ssid: 'other', channel: 6 },
    ]);
  });
});

describe('parseConnectedWifi', () => {
  it('reads the connected wifi device name from nmcli dev', () => {
    const txt = `lo:loopback:unmanaged\nwlan0:wifi:connected\neth0:ethernet:unavailable\n`;
    expect(parseConnectedWifi(txt)).toBe('wlan0');
  });

  it('answers null when no wifi device is connected', () => {
    const txt = `lo:loopback:unmanaged\nwlan0:wifi:disconnected\n`;
    expect(parseConnectedWifi(txt)).toBeNull();
  });
});

describe('parseGeneralConnection', () => {
  it('reads the profile name from the Pi fixture', () => {
    // nmcli-con.txt's last line is `GENERAL.CONNECTION:netplan-wlan0-HomeNetwork`.
    expect(parseGeneralConnection(nmcliCon)).toBe('netplan-wlan0-HomeNetwork');
  });

  it('answers null when the profile line is missing', () => {
    expect(parseGeneralConnection('OTHER:thing\n')).toBeNull();
  });
});

describe('parseUplink on iw-dev.txt', () => {
  it('reads the same fields from the whole-device `iw dev` output', () => {
    // The tool calls `iw dev <dev> info`, but the whole-device output
    // carries the same lines for an associated interface — the parser
    // reads the first interface block it finds.
    const u = parseUplink(iwDev);
    expect(u).not.toBeNull();
    expect(u!.iface).toBe('wlan0');
    expect(u!.ssid).toBe('HomeNetwork');
    expect(u!.channel).toBe(100);
  });
});
