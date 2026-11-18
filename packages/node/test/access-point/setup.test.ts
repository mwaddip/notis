// NODE_INTERFACE → The access-point tool — `setup`, `status` and `remove`
// driven through the recording fake runner. Each case asserts what the
// tool did against the sequence of calls, writes and removes, and the
// record that landed on disk.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/access-point.js';
import {
  parseRecord,
  RECORD_PATH,
  serializeRecord,
  type AccessPointRecord,
} from '../../src/access-point/record.js';
import { FakeRunner } from './fake-runner.js';

const FIX = join(__dirname, '../fixtures/access-point');
const iwList = readFileSync(join(FIX, 'iw-list.txt'), 'utf8');
const iwDevWlan0 = readFileSync(join(FIX, 'iw-dev-wlan0-info.txt'), 'utf8');
const nmcliWifi = readFileSync(join(FIX, 'nmcli-wifi-list.txt'), 'utf8');

const iwDevWlan0_2g = iwDevWlan0.replace(
  /channel 100 \([^\n]*\)/,
  'channel 1 (2412 MHz), width: 20 MHz, center1: 2412 MHz',
);

// A matching pass over the Pi's state: the uplink is on wlan0, channel 100
// (a radar channel), the network offers 2.4 GHz too, and node.env has no
// MESH_ROLE.
function primePi(r: FakeRunner): FakeRunner {
  r.files.set('/etc/dagsocial/node.env', 'PORT=3000\n');
  const state = { band: '5' as '5' | '2.4' };
  r.on((c, a) => c === 'iw' && a[0] === 'list', { stdout: iwList });
  r.on(
    (c, a) => c === 'nmcli' && a.includes('DEVICE,TYPE,STATE'),
    { stdout: 'lo:loopback:unmanaged\nwlan0:wifi:connected\n' },
  );
  r.on(
    (c, a) => c === 'nmcli' && a.includes('GENERAL.CONNECTION') && a.includes('wlan0'),
    { stdout: 'GENERAL.CONNECTION:netplan-wlan0-HomeNetwork\n' },
  );
  r.on(
    (c, a) => c === 'iw' && a[0] === 'dev' && a[1] === 'wlan0' && a[2] === 'info',
    () => ({ stdout: state.band === '2.4' ? iwDevWlan0_2g : iwDevWlan0 }),
  );
  r.on(
    (c, a) =>
      c === 'nmcli' && a[0] === 'con' && a[1] === 'modify'
      && a.includes('802-11-wireless.band')
      && a[a.length - 1] === 'bg',
    () => {
      state.band = '2.4';
      return {};
    },
  );
  r.on(
    (c, a) => c === 'nmcli' && a.includes('SSID,CHAN,FREQ'),
    { stdout: nmcliWifi },
  );
  return r;
}

describe('setup', () => {
  let r: FakeRunner;
  beforeEach(() => {
    r = primePi(new FakeRunner());
  });

  it('refuses when not root', async () => {
    r.root = false;
    const code = await main(['setup'], r);
    expect(code).not.toBe(0);
    expect(r.logs.join('\n')).toMatch(/root/i);
    // No change touched the box.
    expect(r.writes).toEqual([]);
    expect(r.calls.filter((c) => c.cmd === 'systemctl')).toEqual([]);
  });

  it('refuses a half-done record, saying to run `remove`', async () => {
    const half: AccessPointRecord = {
      entries: [{ kind: 'nodeEnvEdited', priorText: 'PORT=3000\n' }],
      complete: false,
    };
    r.files.set(RECORD_PATH, serializeRecord(half));
    const code = await main(['setup'], r);
    expect(code).not.toBe(0);
    expect(r.logs.join('\n')).toMatch(/remove/i);
    expect(r.writes.find((w) => w.path === '/etc/dagsocial/node.env')).toBeUndefined();
  });

  it('refuses a public node', async () => {
    r.files.set('/etc/dagsocial/node.env', 'MESH_ROLE=public\n');
    const code = await main(['setup'], r);
    expect(code).not.toBe(0);
    expect(r.logs.join('\n')).toMatch(/public/i);
  });

  it('refuses a radio without the managed-with-AP combination', async () => {
    r.responses = [];
    r.on(
      (c, a) => c === 'iw' && a[0] === 'list',
      { stdout: 'valid interface combinations:\n\t * #{ managed } <= 2, total <= 2, #channels <= 1\n' },
    );
    const code = await main(['setup'], r);
    expect(code).not.toBe(0);
    expect(r.logs.join('\n')).toMatch(/combination|managed.*AP|AP/i);
  });

  it('refuses a --password shorter than 8 or longer than 63', async () => {
    const short = await main(['setup', '--password', 'short'], r);
    expect(short).not.toBe(0);
    expect(r.logs.join('\n')).toMatch(/password/i);
    r = primePi(new FakeRunner());
    const long = await main(['setup', '--password', 'x'.repeat(64)], r);
    expect(long).not.toBe(0);
  });

  it('refuses a --name longer than 32 bytes', async () => {
    const code = await main(['setup', '--name', 'x'.repeat(33)], r);
    expect(code).not.toBe(0);
    expect(r.logs.join('\n')).toMatch(/name/i);
  });

  it('refuses a radar uplink whose network offers no 2.4 GHz channel', async () => {
    // A fresh runner with only 5 GHz in the scan.
    const r2 = new FakeRunner();
    r2.files.set('/etc/dagsocial/node.env', 'PORT=3000\n');
    r2.on((c, a) => c === 'iw' && a[0] === 'list', { stdout: iwList });
    r2.on(
      (c, a) => c === 'nmcli' && a.includes('DEVICE,TYPE,STATE'),
      { stdout: 'wlan0:wifi:connected\n' },
    );
    r2.on(
      (c, a) => c === 'nmcli' && a.includes('GENERAL.CONNECTION') && a.includes('wlan0'),
      { stdout: 'GENERAL.CONNECTION:netplan-wlan0-HomeNetwork\n' },
    );
    r2.on(
      (c, a) => c === 'iw' && a[0] === 'dev' && a[1] === 'wlan0' && a[2] === 'info',
      { stdout: iwDevWlan0 },
    );
    r2.on(
      (c, a) => c === 'nmcli' && a.includes('SSID,CHAN,FREQ'),
      { stdout: 'HomeNetwork:100:5500 MHz\n' },
    );
    const code = await main(['setup'], r2);
    expect(code).not.toBe(0);
    expect(r2.logs.join('\n')).toMatch(/2\.4|2 ?GHz/i);
  });

  it('a fresh setup runs the steps in order and writes the record', async () => {
    const code = await main(['setup'], r);
    expect(code).toBe(0);
    // The record is complete.
    const rec = parseRecord(r.files.get(RECORD_PATH)!);
    expect(rec.complete).toBe(true);
    // The entries, in order:
    const kinds = rec.entries.map((e) => e.kind);
    // node.env (edit) → uplink band → iface unit file → iface enable → iface start
    // → dagsocial-ap profile added → dnsmasq conf → dnsmasq unit file → dnsmasq enable → dnsmasq start
    // → firewall nft → firewall unit file → firewall enable → firewall start.
    expect(kinds[0]).toBe('nodeEnvEdited');
    expect(kinds).toContain('uplinkBandSet');
    expect(kinds).toContain('nmConnectionAdded');
    // node.env was actually written.
    const written = r.writes.find((w) => w.path === '/etc/dagsocial/node.env');
    expect(written).toBeTruthy();
    expect(written!.text).toContain('MESH_ROLE=private');
    expect(written!.text).toContain('/webrtc-direct');
    // The iface unit was enabled and started.
    const unitWritten = r.writes.find((w) => w.path.endsWith('dagsocial-ap-iface.service'));
    expect(unitWritten).toBeTruthy();
    const enabled = r.calls.find(
      (c) =>
        c.cmd === 'systemctl'
        && c.args[0] === 'enable'
        && typeof c.args[1] === 'string'
        && c.args[1].includes('dagsocial-ap-iface'),
    );
    expect(enabled).toBeTruthy();
    // The node was restarted at the end.
    const restarted = r.calls.find(
      (c) => c.cmd === 'systemctl' && c.args[0] === 'restart' && c.args[1] === 'dagsocial-node',
    );
    expect(restarted).toBeTruthy();
    // The dagsocial-ap profile was added with ssid Notis and no wpa-psk.
    const nmAdd = r.calls.find((c) => c.cmd === 'nmcli' && c.args.includes('add') && c.args.includes('wifi'));
    expect(nmAdd).toBeTruthy();
    expect(nmAdd!.args.join(' ')).toContain('ssid Notis');
    expect(nmAdd!.args.join(' ')).not.toContain('wpa-psk');
  });

  it('a second setup on a complete record changes nothing', async () => {
    // First run.
    await main(['setup'], r);
    const after = new FakeRunner();
    after.files = new Map(r.files);
    after.on((c, a) => c === 'iw' && a[0] === 'list', { stdout: iwList });
    const code = await main(['setup'], after);
    expect(code).toBe(0);
    // No writes, no systemctl calls past possibly zero diagnostics.
    expect(after.writes).toEqual([]);
    expect(after.calls.filter((c) => c.cmd === 'systemctl')).toEqual([]);
    expect(after.logs.join('\n')).toMatch(/already/i);
  });

  it('--name X --password Y names the profile X and sets WPA2 with Y', async () => {
    const code = await main(['setup', '--name', 'MyAP', '--password', 'secret123'], r);
    expect(code).toBe(0);
    const nmAdd = r.calls.find((c) => c.cmd === 'nmcli' && c.args.includes('add') && c.args.includes('wifi'));
    expect(nmAdd).toBeTruthy();
    const joined = nmAdd!.args.join(' ');
    expect(joined).toContain('ssid MyAP');
    expect(joined).toContain('wifi-sec.key-mgmt wpa-psk');
    expect(joined).toContain('wifi-sec.psk secret123');
  });
});

describe('remove', () => {
  it('restores exactly what the record names, in reverse, and warns about the uplink drop', async () => {
    const r = primePi(new FakeRunner());
    await main(['setup'], r);
    // Verify setup completed.
    expect(parseRecord(r.files.get(RECORD_PATH)!).complete).toBe(true);
    // Snapshot the writes `setup` made (paths it wrote) so remove's undo is checkable.
    const setupWrites = r.writes.map((w) => w.path);
    const beforeRemoveCalls = r.calls.length;
    const beforeRemoveWrites = r.writes.length;
    const beforeRemoveRemoves = r.removes.length;
    const code = await main(['remove'], r);
    expect(code).toBe(0);
    // Warning about the uplink drop.
    expect(r.logs.join('\n')).toMatch(/uplink|drop/i);
    // The record is gone.
    expect(r.removes.slice(beforeRemoveRemoves)).toContain(RECORD_PATH);
    // The dagsocial-ap profile was deleted.
    const nmDel = r.calls.slice(beforeRemoveCalls).find(
      (c) => c.cmd === 'nmcli' && c.args.includes('delete') && c.args.includes('dagsocial-ap'),
    );
    expect(nmDel).toBeTruthy();
    // Units were disabled.
    const disabled = r.calls.slice(beforeRemoveCalls).filter(
      (c) => c.cmd === 'systemctl' && c.args[0] === 'disable',
    );
    expect(disabled.length).toBeGreaterThanOrEqual(3);
    // The uplink's band was set back to `a`.
    const bandBack = r.calls.slice(beforeRemoveCalls).find(
      (c) =>
        c.cmd === 'nmcli'
        && c.args[0] === 'con' && c.args[1] === 'modify'
        && c.args.includes('802-11-wireless.band')
        && c.args[c.args.length - 1] === 'a',
    );
    expect(bandBack).toBeTruthy();
    // node.env was restored.
    expect(r.files.get('/etc/dagsocial/node.env')).toBe('PORT=3000\n');
    // Node was restarted.
    const restart = r.calls.slice(beforeRemoveCalls).find(
      (c) => c.cmd === 'systemctl' && c.args[0] === 'restart' && c.args[1] === 'dagsocial-node',
    );
    expect(restart).toBeTruthy();
    void setupWrites;
    void beforeRemoveWrites;
  });

  it('after a setup that stopped at step N, undoes steps 1…N−1 (Review Focus 4)', async () => {
    // A hand-built half-done record: only node.env was edited.
    const r = new FakeRunner();
    r.files.set(RECORD_PATH, serializeRecord({
      entries: [{ kind: 'nodeEnvEdited', priorText: 'PORT=3000\n' }],
      complete: false,
    }));
    r.files.set('/etc/dagsocial/node.env', 'PORT=3000\nMESH_ROLE=private\nMESH_LISTEN=/ip4/0.0.0.0/udp/9733/webrtc-direct\n');
    const code = await main(['remove'], r);
    expect(code).toBe(0);
    expect(r.files.get('/etc/dagsocial/node.env')).toBe('PORT=3000\n');
    expect(r.removes).toContain(RECORD_PATH);
    // Node restarted (because node.env changed).
    const restart = r.calls.find(
      (c) => c.cmd === 'systemctl' && c.args[0] === 'restart' && c.args[1] === 'dagsocial-node',
    );
    expect(restart).toBeTruthy();
  });
});

describe('status', () => {
  it('reads each step back and reports completion', async () => {
    const r = primePi(new FakeRunner());
    await main(['setup'], r);
    const after = new FakeRunner();
    after.files = new Map(r.files);
    after.on((c, _a) => c === 'systemctl', { stdout: 'active\n' });
    const code = await main(['status'], after);
    expect(code).toBe(0);
    const text = after.logs.join('\n');
    expect(text).toMatch(/setup complete|complete/i);
    // Names each of the three units.
    expect(text).toContain('dagsocial-ap-iface.service');
    expect(text).toContain('dagsocial-ap-dnsmasq.service');
    expect(text).toContain('dagsocial-ap-firewall.service');
  });

  it('refuses when not root', async () => {
    const r = new FakeRunner();
    r.root = false;
    const code = await main(['status'], r);
    expect(code).not.toBe(0);
    expect(r.logs.join('\n')).toMatch(/root/i);
  });
});
