// NODE_INTERFACE → The access-point tool — the two choices `setup` makes
// before the first change. `chooseChannel` picks the channel; `nodeEnvPlan`
// decides what, if anything, has to be written into /etc/dagsocial/node.env.

import { describe, it, expect } from 'vitest';
import {
  chooseChannel,
  nodeEnvPlan,
} from '../../src/access-point/plan.js';
import type { Uplink } from '../../src/access-point/radio.js';

const radarSet = new Set([52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144]);

describe('chooseChannel', () => {
  it('follows a non-radar uplink', () => {
    const uplink: Uplink = { iface: 'wlan0', ssid: 'Home', channel: 6 };
    const c = chooseChannel(uplink, radarSet, [{ ssid: 'Home', channel: 6 }]);
    expect(c).toEqual({ kind: 'follow', channel: 6 });
  });

  it('moves a radar uplink to 2.4 GHz where the network offers one', () => {
    const uplink: Uplink = { iface: 'wlan0', ssid: 'HomeNetwork', channel: 100 };
    const scan = [
      { ssid: 'HomeNetwork', channel: 1 },
      { ssid: 'HomeNetwork', channel: 100 },
    ];
    const c = chooseChannel(uplink, radarSet, scan);
    expect(c).toEqual({ kind: 'move-to-2g' });
  });

  it('refuses a radar uplink whose network offers no 2.4 GHz channel', () => {
    const uplink: Uplink = { iface: 'wlan0', ssid: 'HomeNetwork', channel: 100 };
    const scan = [
      { ssid: 'HomeNetwork', channel: 100 },
      { ssid: 'Other', channel: 1 },
    ];
    const c = chooseChannel(uplink, radarSet, scan);
    expect(c.kind).toBe('refuse');
    if (c.kind !== 'refuse') throw new Error('wrong kind');
    expect(c.reason).toMatch(/2\.4|2 ?GHz/i);
  });

  it('with no uplink, picks a non-radar 2.4 GHz channel', () => {
    const c = chooseChannel(null, radarSet, []);
    expect(c.kind).toBe('own');
    if (c.kind !== 'own') throw new Error('wrong kind');
    expect([1, 6, 11]).toContain(c.channel);
  });
});

describe('nodeEnvPlan', () => {
  it('no MESH_ROLE: appends MESH_ROLE=private and MESH_LISTEN', () => {
    const r = nodeEnvPlan('PORT=3000\n', { meshPort: 9733 });
    expect(r.kind).toBe('edit');
    if (r.kind !== 'edit') throw new Error('wrong kind');
    expect(r.meshUdpPort).toBe(9733);
    expect(r.text).toContain('MESH_ROLE=private');
    expect(r.text).toContain('MESH_LISTEN=/ip4/0.0.0.0/udp/9733/webrtc-direct');
  });

  it('private with a matching webrtc-direct listen: unchanged', () => {
    const text =
      'PORT=3000\nMESH_ROLE=private\nMESH_LISTEN=/ip4/0.0.0.0/udp/9733/webrtc-direct\n';
    const r = nodeEnvPlan(text, { meshPort: 9733 });
    expect(r).toEqual({ kind: 'unchanged', meshUdpPort: 9733 });
  });

  it('private without a webrtc-direct listen: gains one on the first free port', () => {
    const text = 'PORT=3000\nMESH_ROLE=private\nMESH_LISTEN=/ip4/0.0.0.0/tcp/9733\n';
    const r = nodeEnvPlan(text, { meshPort: 9733 });
    expect(r.kind).toBe('edit');
    if (r.kind !== 'edit') throw new Error('wrong kind');
    expect(r.meshUdpPort).toBe(9734);
    expect(r.text).toContain(
      'MESH_LISTEN=/ip4/0.0.0.0/tcp/9733,/ip4/0.0.0.0/udp/9734/webrtc-direct',
    );
  });

  it('a private node with UDP 9733 in use picks 9734', () => {
    const text =
      'MESH_ROLE=private\nMESH_LISTEN=/ip4/0.0.0.0/udp/9733/quic-v1,/ip4/0.0.0.0/tcp/9734\n';
    const r = nodeEnvPlan(text, { meshPort: 9733 });
    expect(r.kind).toBe('edit');
    if (r.kind !== 'edit') throw new Error('wrong kind');
    expect(r.meshUdpPort).toBe(9735);
  });

  it('a public node is refused', () => {
    const text = 'MESH_ROLE=public\n';
    const r = nodeEnvPlan(text, { meshPort: 9733 });
    expect(r.kind).toBe('refuse');
    if (r.kind !== 'refuse') throw new Error('wrong kind');
    expect(r.reason).toMatch(/public/i);
  });
});
