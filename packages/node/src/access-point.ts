// NODE_INTERFACE → The access-point tool — the CLI entry. `main(argv,
// runner)` takes the Runner seam (`src/access-point/run.ts`); this file
// alone constructs the real one.
//
// The tool runs as root alone (NODE_INTERFACE → The access-point tool —
// "The tool is opt-in"); every change is written to the record BEFORE the
// command that makes it, so a `setup` that stopped half way is undone as
// far as it went by `remove`, which reverse-walks the record. `status`
// reads each step back from the box.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { Runner, RunResult } from './access-point/run.js';
import {
  parseCombinations,
  parseRadarChannels,
  parseUplink,
  parseScan,
  parseConnectedWifi,
  parseGeneralConnection,
  parsePhy,
  parseFirstInterface,
  type Uplink,
} from './access-point/radio.js';
import { chooseChannel, nodeEnvPlan } from './access-point/plan.js';
import {
  dnsmasqConf,
  firewall,
  ifaceUnit,
  dnsmasqUnit,
  firewallUnit,
} from './access-point/render.js';
import {
  parseRecord,
  serializeRecord,
  RECORD_PATH,
  RECORD_DIR,
  type AccessPointRecord,
  type RecordEntry,
} from './access-point/record.js';

const NODE_ENV_PATH = '/etc/dagsocial/node.env';
const DNSMASQ_CONF_PATH = '/etc/dagsocial/access-point/dnsmasq.conf';
const FIREWALL_NFT_PATH = '/etc/dagsocial/access-point/firewall.nft';
const IFACE_UNIT_PATH = '/etc/systemd/system/dagsocial-ap-iface.service';
const DNSMASQ_UNIT_PATH = '/etc/systemd/system/dagsocial-ap-dnsmasq.service';
const FIREWALL_UNIT_PATH = '/etc/systemd/system/dagsocial-ap-firewall.service';
const NM_PROFILE_NAME = 'dagsocial-ap';
const MESH_DEFAULT_UDP_PORT = 9733;
const MAX_NAME_BYTES = 32;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 63;
const DEVICE_POLL_MS = 500;
const DEVICE_WAIT_ITERATIONS = 40; // 40 × 500 ms = 20 s

interface SetupFlags {
  name: string;
  password: string | null;
}

export async function main(argv: readonly string[], runner: Runner): Promise<number> {
  const cmd = argv[0];
  if (cmd === 'setup') return setup(argv.slice(1), runner);
  if (cmd === 'status') return status(runner);
  if (cmd === 'remove') return remove(runner);
  runner.log('usage: dagsocial-access-point <setup|status|remove> [--name NAME] [--password PSK]');
  return 2;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function setup(args: readonly string[], runner: Runner): Promise<number> {
  if (!runner.isRoot()) {
    runner.log('dagsocial-access-point: must run as root');
    return 1;
  }
  const flags = parseFlags(args);
  if (flags.err !== null) {
    runner.log(`dagsocial-access-point: ${flags.err}`);
    return 1;
  }
  const f = flags.flags;
  if (f.password !== null) {
    if (f.password.length < MIN_PASSWORD_LEN || f.password.length > MAX_PASSWORD_LEN) {
      runner.log(
        `dagsocial-access-point: --password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} characters (got ${f.password.length})`,
      );
      return 1;
    }
  }
  if (Buffer.byteLength(f.name, 'utf8') > MAX_NAME_BYTES) {
    runner.log(
      `dagsocial-access-point: --name must be ${MAX_NAME_BYTES} bytes or fewer (got ${Buffer.byteLength(f.name, 'utf8')} bytes)`,
    );
    return 1;
  }
  const existingRecordText = await runner.read(RECORD_PATH);
  if (existingRecordText !== null) {
    const existing = parseRecord(existingRecordText);
    if (existing.complete) {
      runner.log('dagsocial-access-point: already set up; nothing to do');
      return 0;
    }
    runner.log(
      'dagsocial-access-point: the record names a setup that stopped half way; run `remove` first, then setup again',
    );
    return 1;
  }
  const nodeEnvText = (await runner.read(NODE_ENV_PATH)) ?? '';
  const envPlan = nodeEnvPlan(nodeEnvText, { meshPort: MESH_DEFAULT_UDP_PORT });
  if (envPlan.kind === 'refuse') {
    runner.log(`dagsocial-access-point: ${envPlan.reason}`);
    return 1;
  }
  const meshUdpPort = envPlan.meshUdpPort;
  const nodePort = readNodePort(nodeEnvText);
  const iwListOut = await runner.run('iw', ['list']);
  if (iwListOut.code !== 0) {
    runner.log(`dagsocial-access-point: iw list failed (${iwListOut.stderr.trim()})`);
    return 1;
  }
  const combo = parseCombinations(iwListOut.stdout);
  if (!combo.managedWithAp) {
    runner.log(
      'dagsocial-access-point: the radio does not list a managed-with-AP combination; the access point cannot run beside the uplink',
    );
    return 1;
  }
  const radar = parseRadarChannels(iwListOut.stdout);
  const uplinkRead = await readUplink(runner);
  const scan = uplinkRead.uplink !== null
    ? parseScan((await runner.run('nmcli', ['-t', '-f', 'SSID,CHAN,FREQ', 'dev', 'wifi', 'list'])).stdout)
    : [];
  const choice = chooseChannel(uplinkRead.uplink, radar, scan);
  if (choice.kind === 'refuse') {
    runner.log(`dagsocial-access-point: ${choice.reason}`);
    return 1;
  }
  // Read the phy name from `iw dev` so the no-uplink iface unit does not
  // assume `phy0` (NODE_INTERFACE → The access-point tool, step 4).
  const iwDev = await runner.run('iw', ['dev']);
  const phy = parsePhy(iwDev.stdout) ?? 'phy0';

  // Begin changes. Each record entry is pushed BEFORE the command it names,
  // so a failed command leaves the entry for `remove` to undo.
  const record: AccessPointRecord = { entries: [], complete: false };
  const saveRecord = async (): Promise<void> => {
    await runner.write(RECORD_PATH, serializeRecord(record));
  };
  const push = async (entry: RecordEntry): Promise<void> => {
    record.entries.push(entry);
    await saveRecord();
  };
  const check = (result: RunResult, what: string): boolean => {
    if (result.code === 0) return true;
    runner.log(`dagsocial-access-point: ${what} failed (code ${result.code}): ${result.stderr.trim()}`);
    return false;
  };

  // Step 1: write node.env (where an edit is needed).
  if (envPlan.kind === 'edit') {
    runner.log(`writing ${NODE_ENV_PATH}`);
    await push({ kind: 'nodeEnvEdited', priorText: nodeEnvText });
    await runner.write(NODE_ENV_PATH, envPlan.text);
  }

  // Step 3: move the uplink to 2.4 GHz where the choice calls for it; the
  // channel is re-read after the move. The prior band is read before the
  // change, so `remove` restores exactly what was there.
  let apChannel: number;
  if (choice.kind === 'own') apChannel = choice.channel;
  else if (choice.kind === 'follow') apChannel = choice.channel;
  else {
    // move-to-2g
    const profile = uplinkRead.profile;
    if (profile === null || uplinkRead.uplink === null) {
      runner.log('dagsocial-access-point: no uplink profile to move; refusing');
      return 1;
    }
    const bandRead = await runner.run(
      'nmcli',
      ['-g', '802-11-wireless.band', 'con', 'show', profile],
    );
    if (!check(bandRead, 'nmcli -g 802-11-wireless.band')) return 1;
    const priorBand = bandRead.stdout.replace(/\r?\n$/, '');
    runner.log(`moving uplink "${uplinkRead.uplink.ssid}" (profile ${profile}) to the 2.4 GHz band`);
    await push({ kind: 'uplinkBandSet', profile, priorBand });
    const modify = await runner.run(
      'nmcli',
      ['con', 'modify', profile, '802-11-wireless.band', 'bg'],
    );
    if (!check(modify, 'nmcli con modify band bg')) return 1;
    const up = await runner.run('nmcli', ['con', 'up', profile]);
    if (!check(up, `nmcli con up ${profile}`)) return 1;
    const iwDevInfo = await runner.run('iw', ['dev', uplinkRead.uplink.iface, 'info']);
    const re = parseUplink(iwDevInfo.stdout);
    if (re === null) {
      runner.log('dagsocial-access-point: uplink info unreadable after the band change');
      return 1;
    }
    apChannel = re.channel;
  }

  // Step 4: the uap0 interface unit. With an uplink, the device is
  // that uplink's interface; without one, the Wi-Fi interface `iw dev`
  // lists, read not assumed; a box with no Wi-Fi interface at all
  // leaves `uplinkIface` empty and the unit uses `iw phy <phy>`.
  const uplinkIface = uplinkRead.uplink !== null
    ? uplinkRead.uplink.iface
    : (parseFirstInterface(iwDev.stdout) ?? '');
  await writeFileChange(runner, record, IFACE_UNIT_PATH, ifaceUnit({ phy, uplinkIface }));
  await runner.run('systemctl', ['daemon-reload']);
  await push({ kind: 'unitEnabled', unit: 'dagsocial-ap-iface.service' });
  const enIface = await runner.run('systemctl', ['enable', 'dagsocial-ap-iface.service']);
  if (!check(enIface, 'systemctl enable dagsocial-ap-iface.service')) return 1;
  await push({ kind: 'unitStarted', unit: 'dagsocial-ap-iface.service' });
  const stIface = await runner.run('systemctl', ['start', 'dagsocial-ap-iface.service']);
  if (!check(stIface, 'systemctl start dagsocial-ap-iface.service')) return 1;

  // Wait for NetworkManager to register uap0 before the profile goes up —
  // the measured Pi races (2026-11-18): the systemd unit made uap0 but
  // `nmcli con up dagsocial-ap` runs before NetworkManager has registered
  // it, and fails with "No suitable device". Poll `nmcli -t -f DEVICE dev`
  // every 500 ms for at most 20 s.
  let uap0Seen = false;
  for (let i = 0; i < DEVICE_WAIT_ITERATIONS; i++) {
    const dev = await runner.run('nmcli', ['-t', '-f', 'DEVICE', 'dev']);
    if (dev.stdout.split('\n').some((l) => l.trim() === 'uap0')) {
      uap0Seen = true;
      break;
    }
    await runner.sleep(DEVICE_POLL_MS);
  }
  if (!uap0Seen) {
    runner.log(
      `dagsocial-access-point: NetworkManager never listed uap0 after ${(DEVICE_WAIT_ITERATIONS * DEVICE_POLL_MS) / 1000} s`,
    );
    return 1;
  }

  // Step 5: the NetworkManager profile dagsocial-ap.
  const band = apChannel <= 14 ? 'bg' : 'a';
  const nmArgs: string[] = [
    'con', 'add', 'type', 'wifi', 'ifname', 'uap0', 'con-name', NM_PROFILE_NAME,
    'autoconnect', 'yes',
    'ssid', f.name,
    '802-11-wireless.mode', 'ap',
    '802-11-wireless.band', band,
    '802-11-wireless.channel', String(apChannel),
    'ipv4.method', 'manual',
    'ipv4.addresses', '10.42.0.1/24',
    'ipv6.method', 'disabled',
  ];
  if (f.password !== null) {
    nmArgs.push('wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', f.password);
  }
  runner.log(`adding NetworkManager profile ${NM_PROFILE_NAME}`);
  await push({ kind: 'nmConnectionAdded', name: NM_PROFILE_NAME });
  const nmAdd = await runner.run('nmcli', nmArgs);
  if (!check(nmAdd, 'nmcli con add dagsocial-ap')) return 1;
  const nmUp = await runner.run('nmcli', ['con', 'up', NM_PROFILE_NAME]);
  if (!check(nmUp, 'nmcli con up dagsocial-ap')) return 1;

  // Step 6: the dnsmasq instance.
  await writeFileChange(runner, record, DNSMASQ_CONF_PATH, dnsmasqConf({
    iface: 'uap0',
    address: '10.42.0.1',
    range: ['10.42.0.10', '10.42.0.254'],
  }));
  await writeFileChange(runner, record, DNSMASQ_UNIT_PATH, dnsmasqUnit());
  await runner.run('systemctl', ['daemon-reload']);
  await push({ kind: 'unitEnabled', unit: 'dagsocial-ap-dnsmasq.service' });
  const enDns = await runner.run('systemctl', ['enable', 'dagsocial-ap-dnsmasq.service']);
  if (!check(enDns, 'systemctl enable dagsocial-ap-dnsmasq.service')) return 1;
  await push({ kind: 'unitStarted', unit: 'dagsocial-ap-dnsmasq.service' });
  const stDns = await runner.run('systemctl', ['start', 'dagsocial-ap-dnsmasq.service']);
  if (!check(stDns, 'systemctl start dagsocial-ap-dnsmasq.service')) return 1;

  // Step 7: the nftables table.
  await writeFileChange(runner, record, FIREWALL_NFT_PATH, firewall({
    iface: 'uap0',
    nodePort,
    meshUdpPort,
  }));
  await writeFileChange(runner, record, FIREWALL_UNIT_PATH, firewallUnit());
  await runner.run('systemctl', ['daemon-reload']);
  await push({ kind: 'unitEnabled', unit: 'dagsocial-ap-firewall.service' });
  const enFw = await runner.run('systemctl', ['enable', 'dagsocial-ap-firewall.service']);
  if (!check(enFw, 'systemctl enable dagsocial-ap-firewall.service')) return 1;
  await push({ kind: 'unitStarted', unit: 'dagsocial-ap-firewall.service' });
  const stFw = await runner.run('systemctl', ['start', 'dagsocial-ap-firewall.service']);
  if (!check(stFw, 'systemctl start dagsocial-ap-firewall.service')) return 1;

  // Step 8: restart the node so it reads the new node.env.
  runner.log('restarting dagsocial-node');
  const nodeRestart = await runner.run('systemctl', ['restart', 'dagsocial-node']);
  if (!check(nodeRestart, 'systemctl restart dagsocial-node')) return 1;

  record.complete = true;
  await saveRecord();
  runner.log('dagsocial-access-point: setup complete');
  return 0;
}

async function writeFileChange(
  runner: Runner,
  record: AccessPointRecord,
  path: string,
  text: string,
): Promise<void> {
  runner.log(`writing ${path}`);
  const prior = await runner.read(path);
  record.entries.push({ kind: 'fileWritten', path, priorText: prior });
  await runner.write(RECORD_PATH, serializeRecord(record));
  await runner.write(path, text);
}

interface UplinkRead {
  uplink: Uplink | null;
  profile: string | null;
}

async function readUplink(runner: Runner): Promise<UplinkRead> {
  const dev = await runner.run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'dev']);
  const wifi = parseConnectedWifi(dev.stdout);
  if (wifi === null) return { uplink: null, profile: null };
  const show = await runner.run('nmcli', ['-t', '-f', 'GENERAL.CONNECTION', 'dev', 'show', wifi]);
  const profile = parseGeneralConnection(show.stdout);
  const info = await runner.run('iw', ['dev', wifi, 'info']);
  const uplink = parseUplink(info.stdout);
  return { uplink, profile };
}

function readNodePort(nodeEnvText: string): number {
  for (const raw of nodeEnvText.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;
    const m = /^PORT\s*=\s*(\d+)/.exec(line);
    if (m !== null) return Number(m[1]);
  }
  return 3000;
}

interface FlagParseResult {
  flags: SetupFlags;
  err: string | null;
}

function parseFlags(args: readonly string[]): FlagParseResult {
  let name = 'Notis';
  let password: string | null = null;
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === '--name') {
      const v = args[i + 1];
      if (v === undefined) return { flags: { name, password }, err: '--name takes a value' };
      name = v;
      i += 2;
    } else if (a === '--password') {
      const v = args[i + 1];
      if (v === undefined) return { flags: { name, password }, err: '--password takes a value' };
      password = v;
      i += 2;
    } else {
      return { flags: { name, password }, err: `unknown argument: ${a}` };
    }
  }
  return { flags: { name, password }, err: null };
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

async function remove(runner: Runner): Promise<number> {
  if (!runner.isRoot()) {
    runner.log('dagsocial-access-point: must run as root');
    return 1;
  }
  const text = await runner.read(RECORD_PATH);
  if (text === null) {
    runner.log('dagsocial-access-point: no record; nothing to remove');
    return 0;
  }
  let rec: AccessPointRecord;
  try {
    rec = parseRecord(text);
  } catch (err) {
    runner.log(`dagsocial-access-point: record is unreadable (${(err as Error).message})`);
    return 1;
  }
  // The uplink drops for a few seconds whenever the access-point profile
  // is torn down on a radio that carries the uplink too; warn whenever
  // `nmConnectionAdded` is in the record, not only after a band move.
  if (rec.entries.some((e) => e.kind === 'nmConnectionAdded')) {
    runner.log('warning: the uplink drops for a few seconds while the access point is torn down');
  }
  let touchedUnits = false;
  for (const entry of [...rec.entries].reverse()) {
    if (entry.kind === 'unitEnabled' || entry.kind === 'unitStarted') touchedUnits = true;
    await undoEntry(entry, runner);
  }
  // `daemon-reload` after the unit files are gone, so systemd forgets them.
  if (touchedUnits) {
    await runner.run('systemctl', ['daemon-reload']);
  }
  if (rec.entries.some((e) => e.kind === 'nodeEnvEdited')) {
    await runner.run('systemctl', ['restart', 'dagsocial-node']);
  }
  await runner.remove(RECORD_PATH);
  // Remove the tool's directory if nothing else is in it. ENOTEMPTY
  // leaves it and is logged; ENOENT is nothing.
  try {
    await runner.remove(RECORD_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY') {
      runner.log(`dagsocial-access-point: ${RECORD_DIR} is not empty; leaving it`);
    } else if (code !== 'ENOENT') {
      throw err;
    }
  }
  runner.log('dagsocial-access-point: removed');
  return 0;
}

async function undoEntry(entry: RecordEntry, runner: Runner): Promise<void> {
  // Each undo is harmless when the command that made the entry never ran:
  // a non-zero code is logged and the walk goes on. `remove` must never
  // halt half way (NODE_INTERFACE → The access-point tool, the remove
  // lead).
  const noteNonZero = (res: RunResult, what: string): void => {
    if (res.code !== 0) {
      runner.log(`dagsocial-access-point: ${what} returned ${res.code}: ${res.stderr.trim()}`);
    }
  };
  switch (entry.kind) {
    case 'nodeEnvEdited':
      await runner.write(NODE_ENV_PATH, entry.priorText);
      return;
    case 'uplinkBandSet': {
      const r1 = await runner.run('nmcli', ['con', 'modify', entry.profile, '802-11-wireless.band', entry.priorBand]);
      noteNonZero(r1, `nmcli con modify ${entry.profile} band`);
      const r2 = await runner.run('nmcli', ['con', 'up', entry.profile]);
      noteNonZero(r2, `nmcli con up ${entry.profile}`);
      return;
    }
    case 'fileWritten':
      if (entry.priorText === null) await runner.remove(entry.path);
      else await runner.write(entry.path, entry.priorText);
      return;
    case 'unitEnabled': {
      const r = await runner.run('systemctl', ['disable', entry.unit]);
      noteNonZero(r, `systemctl disable ${entry.unit}`);
      return;
    }
    case 'unitStarted': {
      const r = await runner.run('systemctl', ['stop', entry.unit]);
      noteNonZero(r, `systemctl stop ${entry.unit}`);
      return;
    }
    case 'nmConnectionAdded': {
      const r = await runner.run('nmcli', ['con', 'delete', entry.name]);
      noteNonZero(r, `nmcli con delete ${entry.name}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function status(runner: Runner): Promise<number> {
  if (!runner.isRoot()) {
    runner.log('dagsocial-access-point: must run as root');
    return 1;
  }
  const text = await runner.read(RECORD_PATH);
  if (text === null) {
    runner.log('dagsocial-access-point: not set up');
    return 0;
  }
  const rec = parseRecord(text);
  runner.log(`dagsocial-access-point: ${rec.complete ? 'setup complete' : 'setup incomplete (half-done)'}`);
  for (const unit of [
    'dagsocial-ap-iface.service',
    'dagsocial-ap-dnsmasq.service',
    'dagsocial-ap-firewall.service',
  ]) {
    const active = await runner.run('systemctl', ['is-active', unit]);
    const enabled = await runner.run('systemctl', ['is-enabled', unit]);
    runner.log(`  ${unit}: ${active.stdout.trim() || 'unknown'} / ${enabled.stdout.trim() || 'unknown'}`);
  }
  // The uap0 interface — present if `iw dev uap0 info` reads.
  const uap = await runner.run('iw', ['dev', 'uap0', 'info']);
  runner.log(`  uap0: ${uap.code === 0 ? 'present' : 'absent'}`);
  // The firewall table — present if `nft list table inet dagsocial_ap` reads.
  const nft = await runner.run('nft', ['list', 'table', 'inet', 'dagsocial_ap']);
  runner.log(`  firewall table inet dagsocial_ap: ${nft.code === 0 ? 'loaded' : 'absent'}`);
  // NetworkManager profile.
  const nm = await runner.run('nmcli', ['-t', '-f', 'NAME', 'con', 'show']);
  const names = nm.stdout.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\\(.*)/, '$1').trim());
  const hasProfile = names.some((n) => n === NM_PROFILE_NAME);
  runner.log(`  NetworkManager profile ${NM_PROFILE_NAME}: ${hasProfile ? 'present' : 'missing'}`);
  // The uplink's current band.
  const uplinkRead = await readUplink(runner);
  if (uplinkRead.profile !== null) {
    const bandRead = await runner.run(
      'nmcli',
      ['-g', '802-11-wireless.band', 'con', 'show', uplinkRead.profile],
    );
    const band = bandRead.stdout.replace(/\r?\n$/, '');
    runner.log(`  uplink profile ${uplinkRead.profile} band: ${band === '' ? '(unset)' : band}`);
  }
  // Node env.
  const env = (await runner.read(NODE_ENV_PATH)) ?? '';
  const envPlan = nodeEnvPlan(env, { meshPort: MESH_DEFAULT_UDP_PORT });
  runner.log(`  /etc/dagsocial/node.env: ${envPlan.kind === 'unchanged' ? 'has a mesh listen' : envPlan.kind}`);
  return 0;
}

// ---------------------------------------------------------------------------
// The real runner, built in the entry file alone.
// ---------------------------------------------------------------------------

function realRunner(): Runner {
  return {
    async run(cmd, args): Promise<RunResult> {
      return await new Promise((resolve, reject) => {
        const child = spawn(cmd, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (b: Buffer) => stdout.push(b));
        child.stderr.on('data', (b: Buffer) => stderr.push(b));
        child.once('error', reject);
        child.once('close', (code: number | null) => {
          resolve({
            code: code ?? 0,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
        });
      });
    },
    async write(path, text): Promise<void> {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, text, 'utf8');
    },
    async read(path): Promise<string | null> {
      try {
        return await fs.readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async remove(path): Promise<void> {
      // Try as a file first; on EISDIR / EPERM (Linux / macOS), fall
      // back to rmdir, which propagates ENOTEMPTY.
      try {
        await fs.unlink(path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        if (code === 'EISDIR' || code === 'EPERM') {
          await fs.rmdir(path);
          return;
        }
        throw err;
      }
    },
    async sleep(ms): Promise<void> {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    },
    isRoot(): boolean {
      return typeof process.getuid === 'function' && process.getuid() === 0;
    },
    log(msg): void {
      process.stdout.write(msg + '\n');
    },
  };
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  main(process.argv.slice(2), realRunner()).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`dagsocial-access-point: ${msg}\n`);
      process.exit(1);
    },
  );
}
