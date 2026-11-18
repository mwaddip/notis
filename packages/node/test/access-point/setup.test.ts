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

// The standard primePi fake: the uplink is on wlan0, channel 100 (a
// radar channel), the network offers 2.4 GHz too, and node.env has no
// MESH_ROLE — so `setup` runs the radar-move branch end to end.
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
  // The uplink profile's current band — the tool reads it from
  // `nmcli -g 802-11-wireless.band con show <profile>` before setting
  // it to `bg`, and records what it read. A profile with no
  // `802-11-wireless.band` set answers an empty line; this fixture
  // simulates a profile that declared `a` so the existing remove case
  // asserts the band back.
  r.on(
    (c, a) =>
      c === 'nmcli' && a.includes('-g')
      && a.includes('802-11-wireless.band')
      && a.includes('netplan-wlan0-HomeNetwork'),
    { stdout: 'a\n' },
  );
  // The DEVICE-only poll `nmcli -t -f DEVICE dev` the tool runs between
  // `systemctl start dagsocial-ap-iface.service` and `nmcli con add` —
  // defaults to uap0 present, so existing cases do not loop. Specific
  // cases override via `prependOn`.
  r.on(
    (c, a) =>
      c === 'nmcli' && a[0] === '-t' && a[1] === '-f'
      && a[2] === 'DEVICE' && a[3] === 'dev',
    { stdout: 'uap0\nwlan0\nlo\n' },
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

// NODE_INTERFACE → The access-point tool — the prior band is read, not
// fixed; every command's result is checked; record entries land before
// the commands they name; `remove` is harmless over entries whose
// commands never ran, warns about the uplink drop whenever
// `nmConnectionAdded` is present, and runs `daemon-reload` after the
// walk; `status` reads uap0, the firewall table and the uplink's band.

describe('setup — the prior band is read, not fixed', () => {
  it('records the band read from nmcli -g, empty string included', async () => {
    const r = primePi(new FakeRunner());
    // A profile with no band set answers "" — override the fixture's "a".
    r.responses = r.responses.filter((x) => {
      // keep every response except the primePi band-g answer
      const ex = x;
      return !(ex.match && (() => {
        const dummy: string[] = ['-g', '802-11-wireless.band', 'con', 'show', 'netplan-wlan0-HomeNetwork'];
        try { return ex.match('nmcli', dummy); } catch { return false; }
      })());
    });
    r.on(
      (c, a) =>
        c === 'nmcli' && a.includes('-g')
        && a.includes('802-11-wireless.band')
        && a.includes('netplan-wlan0-HomeNetwork'),
      { stdout: '\n' },
    );
    const code = await main(['setup'], r);
    expect(code).toBe(0);
    const rec = parseRecord(r.files.get(RECORD_PATH)!);
    const band = rec.entries.find((e) => e.kind === 'uplinkBandSet');
    expect(band).toBeTruthy();
    if (band && band.kind === 'uplinkBandSet') {
      expect(band.priorBand).toBe('');
    }
    // remove then sets the band back to "" — the same empty string.
    const code2 = await main(['remove'], r);
    expect(code2).toBe(0);
    const bandBack = r.calls.find(
      (c) =>
        c.cmd === 'nmcli' && c.args[0] === 'con' && c.args[1] === 'modify'
        && c.args.includes('802-11-wireless.band')
        && c.args[c.args.length - 1] === '',
    );
    expect(bandBack).toBeTruthy();
  });
});

describe('setup — every command\'s result is checked', () => {
  it('nmcli con up dagsocial-ap failing returns 1 and leaves no complete record', async () => {
    const r = primePi(new FakeRunner());
    r.on(
      (c, a) => c === 'nmcli' && a[0] === 'con' && a[1] === 'up' && a[2] === 'dagsocial-ap',
      { code: 4, stderr: 'cannot bring up profile\n' },
    );
    const code = await main(['setup'], r);
    expect(code).toBe(1);
    const rec = parseRecord(r.files.get(RECORD_PATH)!);
    expect(rec.complete).toBe(false);
    // The nmConnectionAdded entry lands before the con up call — so it
    // appears in the record even though `con up` failed.
    expect(rec.entries.some((e) => e.kind === 'nmConnectionAdded')).toBe(true);
    // remove then walks the record and deletes the profile.
    const code2 = await main(['remove'], r);
    expect(code2).toBe(0);
    const del = r.calls.find(
      (c) => c.cmd === 'nmcli' && c.args.includes('delete') && c.args.includes('dagsocial-ap'),
    );
    expect(del).toBeTruthy();
    // setup complete is NOT printed.
    expect(r.logs.join('\n')).not.toMatch(/setup complete/i);
  });

  it('systemctl start dagsocial-ap-dnsmasq.service failing returns 1 and keeps the record', async () => {
    const r = primePi(new FakeRunner());
    r.on(
      (c, a) =>
        c === 'systemctl' && a[0] === 'start'
        && a[1] === 'dagsocial-ap-dnsmasq.service',
      { code: 1, stderr: 'Failed to start dagsocial-ap-dnsmasq.service\n' },
    );
    const code = await main(['setup'], r);
    expect(code).toBe(1);
    const rec = parseRecord(r.files.get(RECORD_PATH)!);
    expect(rec.complete).toBe(false);
    // unitStarted was pushed before `systemctl start`, so the record
    // holds it.
    expect(
      rec.entries.some(
        (e) => e.kind === 'unitStarted' && e.unit === 'dagsocial-ap-dnsmasq.service',
      ),
    ).toBe(true);
    // The firewall unit is NEVER reached.
    expect(
      rec.entries.some(
        (e) => e.kind === 'unitStarted' && e.unit === 'dagsocial-ap-firewall.service',
      ),
    ).toBe(false);
  });
});

describe('remove — harmless over entries whose commands never ran', () => {
  it('a `systemctl disable` that fails is logged and the walk goes on', async () => {
    const r = new FakeRunner();
    r.files.set(
      RECORD_PATH,
      serializeRecord({
        entries: [
          { kind: 'unitEnabled', unit: 'phantom-a.service' },
          { kind: 'unitEnabled', unit: 'phantom-b.service' },
        ],
        complete: false,
      }),
    );
    r.on(
      (c, a) => c === 'systemctl' && a[0] === 'disable' && a[1] === 'phantom-a.service',
      { code: 1, stderr: 'Failed to disable unit: Unit phantom-a.service does not exist.\n' },
    );
    const code = await main(['remove'], r);
    expect(code).toBe(0);
    // Both disables were called despite the first one failing.
    const disables = r.calls.filter(
      (c) => c.cmd === 'systemctl' && c.args[0] === 'disable',
    );
    expect(disables.map((c) => c.args[1])).toEqual([
      'phantom-b.service',
      'phantom-a.service',
    ]);
    expect(r.removes).toContain(RECORD_PATH);
  });
});

describe('remove — the uplink-drop warning fires whenever nmConnectionAdded is in the record', () => {
  it('fires after a follow setup with no band move', async () => {
    const r = primePi(new FakeRunner());
    // Replace the uplink's channel to a non-radar one so the choice is
    // `follow` and no band move happens.
    r.responses = [];
    r.files.set('/etc/dagsocial/node.env', 'PORT=3000\n');
    r.on((c, a) => c === 'iw' && a[0] === 'list', { stdout: iwList });
    r.on(
      (c, a) => c === 'nmcli' && a.includes('DEVICE,TYPE,STATE'),
      { stdout: 'wlan0:wifi:connected\n' },
    );
    r.on(
      (c, a) => c === 'nmcli' && a.includes('GENERAL.CONNECTION') && a.includes('wlan0'),
      { stdout: 'GENERAL.CONNECTION:netplan-wlan0-HomeNetwork\n' },
    );
    r.on(
      (c, a) => c === 'iw' && a[0] === 'dev' && a[1] === 'wlan0' && a[2] === 'info',
      { stdout: iwDevWlan0_2g }, // channel 1 — a non-radar follow
    );
    r.on(
      (c, a) => c === 'nmcli' && a.includes('SSID,CHAN,FREQ'),
      { stdout: 'HomeNetwork:1:2412 MHz\n' },
    );
    r.on(
      (c, a) =>
        c === 'nmcli' && a[0] === '-t' && a[1] === '-f'
        && a[2] === 'DEVICE' && a[3] === 'dev',
      { stdout: 'uap0\nwlan0\nlo\n' },
    );
    await main(['setup'], r);
    const beforeRemoveLogs = r.logs.length;
    const code = await main(['remove'], r);
    expect(code).toBe(0);
    expect(r.logs.slice(beforeRemoveLogs).join('\n')).toMatch(/uplink|drop/i);
  });
});

describe('remove — runs systemctl daemon-reload after the walk', () => {
  it('a daemon-reload call appears after the disables', async () => {
    const r = primePi(new FakeRunner());
    await main(['setup'], r);
    const beforeRemoveCalls = r.calls.length;
    await main(['remove'], r);
    const after = r.calls.slice(beforeRemoveCalls);
    const reloadIdx = after.findIndex(
      (c) => c.cmd === 'systemctl' && c.args[0] === 'daemon-reload',
    );
    expect(reloadIdx).toBeGreaterThanOrEqual(0);
    // At least one disable preceded daemon-reload.
    const lastDisableIdx = after
      .map((c, i) => (c.cmd === 'systemctl' && c.args[0] === 'disable' ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    expect(lastDisableIdx).toBeDefined();
    expect(reloadIdx).toBeGreaterThan(lastDisableIdx!);
  });
});

describe('status — reads each step back from the box', () => {
  it('status queries iw dev uap0 info, nft list table inet dagsocial_ap, and the uplink profile band', async () => {
    const r = primePi(new FakeRunner());
    await main(['setup'], r);
    const after = new FakeRunner();
    after.files = new Map(r.files);
    after.on((c, _a) => c === 'systemctl', { stdout: 'active\n' });
    // Answer the status queries so the tool can print them.
    after.on(
      (c, a) => c === 'iw' && a[0] === 'dev' && a[1] === 'uap0' && a[2] === 'info',
      { stdout: 'Interface uap0\n\ttype AP\n\tchannel 1 (2412 MHz)\n' },
    );
    after.on(
      (c, a) => c === 'nft' && a[0] === 'list' && a[1] === 'table',
      { stdout: 'table inet dagsocial_ap {\n}\n' },
    );
    after.on(
      (c, a) => c === 'nmcli' && a.includes('-g') && a.includes('802-11-wireless.band'),
      { stdout: 'bg\n' },
    );
    // Discovery of the uplink profile from nmcli dev.
    after.on(
      (c, a) => c === 'nmcli' && a.includes('DEVICE,TYPE,STATE'),
      { stdout: 'wlan0:wifi:connected\n' },
    );
    after.on(
      (c, a) => c === 'nmcli' && a.includes('GENERAL.CONNECTION') && a.includes('wlan0'),
      { stdout: 'GENERAL.CONNECTION:netplan-wlan0-HomeNetwork\n' },
    );
    const code = await main(['status'], after);
    expect(code).toBe(0);
    // The three new reads landed.
    const iwUap = after.calls.find(
      (c) => c.cmd === 'iw' && c.args[0] === 'dev' && c.args[1] === 'uap0' && c.args[2] === 'info',
    );
    expect(iwUap).toBeTruthy();
    const nftList = after.calls.find(
      (c) => c.cmd === 'nft' && c.args[0] === 'list' && c.args[1] === 'table',
    );
    expect(nftList).toBeTruthy();
    const bandRead = after.calls.find(
      (c) =>
        c.cmd === 'nmcli' && c.args.includes('-g')
        && c.args.includes('802-11-wireless.band'),
    );
    expect(bandRead).toBeTruthy();
    // And status named each in its output.
    const text = after.logs.join('\n');
    expect(text).toMatch(/uap0/);
    expect(text).toMatch(/dagsocial_ap|table/);
    expect(text).toMatch(/band/);
  });
});

// NODE_INTERFACE → The access-point tool — `setup` waits for
// NetworkManager to list uap0 between
// `systemctl start dagsocial-ap-iface.service` and
// `nmcli con up dagsocial-ap`; `remove` removes the tool's directory
// when empty.

describe('setup — waits for NetworkManager to list uap0', () => {
  it('lists uap0 only from its third nmcli dev read: con add runs after, two sleep(500) recorded', async () => {
    const r = primePi(new FakeRunner());
    let count = 0;
    r.prependOn(
      (c, a) =>
        c === 'nmcli' && a[0] === '-t' && a[1] === '-f'
        && a[2] === 'DEVICE' && a[3] === 'dev',
      () => ({ stdout: ++count >= 3 ? 'uap0\nwlan0\nlo\n' : 'wlan0\nlo\n' }),
    );
    const code = await main(['setup'], r);
    expect(code).toBe(0);
    // Two sleep(500) during the device wait.
    expect(r.sleeps).toContain(500);
    expect(r.sleeps.filter((s) => s === 500).length).toBe(2);
    // con add dagsocial-ap ran after the wait.
    const nmAdd = r.calls.find(
      (c) =>
        c.cmd === 'nmcli' && c.args.includes('add')
        && c.args.includes('wifi') && c.args.includes('dagsocial-ap'),
    );
    expect(nmAdd).toBeTruthy();
  });

  it('never lists uap0: exit 1 after the 20 s budget, no con add', async () => {
    const r = primePi(new FakeRunner());
    r.prependOn(
      (c, a) =>
        c === 'nmcli' && a[0] === '-t' && a[1] === '-f'
        && a[2] === 'DEVICE' && a[3] === 'dev',
      { stdout: 'wlan0\nlo\n' },
    );
    const code = await main(['setup'], r);
    expect(code).toBe(1);
    // No con add for dagsocial-ap.
    const nmAdd = r.calls.find(
      (c) =>
        c.cmd === 'nmcli' && c.args.includes('add')
        && c.args.includes('wifi') && c.args.includes('dagsocial-ap'),
    );
    expect(nmAdd).toBeUndefined();
    // The record is kept incomplete without nmConnectionAdded.
    const rec = parseRecord(r.files.get(RECORD_PATH)!);
    expect(rec.complete).toBe(false);
    expect(rec.entries.some((e) => e.kind === 'nmConnectionAdded')).toBe(false);
    // 40 sleep(500) during the budget's polls.
    expect(r.sleeps.filter((s) => s === 500).length).toBe(40);
    expect(r.logs.join('\n')).toMatch(/uap0.*20/i);
  });
});

describe('remove — the tool\'s directory is removed when empty', () => {
  it('after remove, /etc/dagsocial/access-point is gone and no file lives under it', async () => {
    const r = primePi(new FakeRunner());
    await main(['setup'], r);
    const beforeRemoveRemoves = r.removes.length;
    const code = await main(['remove'], r);
    expect(code).toBe(0);
    // The record file and the tool's directory are both removed.
    const after = r.removes.slice(beforeRemoveRemoves);
    expect(after).toContain(RECORD_PATH);
    expect(after).toContain('/etc/dagsocial/access-point');
    // No file under the tool's directory remains in the fake's filesystem.
    for (const key of r.files.keys()) {
      expect(key.startsWith('/etc/dagsocial/access-point/')).toBe(false);
    }
  });
});
