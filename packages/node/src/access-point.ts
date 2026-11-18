// NODE_INTERFACE → The access-point tool — the CLI entry. `main(argv,
// runner)` takes the Runner seam (`src/access-point/run.ts`); this file
// alone constructs the real one.
//
// The tool runs as root alone (NODE_INTERFACE → The access-point tool →
// "The tool is opt-in"); every change is written to the record as it is
// made, so a `setup` that stopped half way is undone as far as it went
// (→ "The record"). `remove` walks the record in reverse; `status` reads
// each step back.

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
  // The existing record decides which of three branches: nothing to do,
  // refuse (half-done) or proceed (no record).
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
  // Step 1 (planned): read node.env and decide whether a change is needed.
  // A public node refuses here, before the first change.
  const nodeEnvText = (await runner.read(NODE_ENV_PATH)) ?? '';
  const envPlan = nodeEnvPlan(nodeEnvText, { meshPort: MESH_DEFAULT_UDP_PORT });
  if (envPlan.kind === 'refuse') {
    runner.log(`dagsocial-access-point: ${envPlan.reason}`);
    return 1;
  }
  const meshUdpPort = envPlan.meshUdpPort;
  const nodePort = readNodePort(nodeEnvText);
  // Step 2 (pre-check): the radio.
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
  // Step 3 (pre-check): the uplink.
  const uplink = await readUplink(runner);
  const scan = uplink !== null
    ? parseScan((await runner.run('nmcli', ['-t', '-f', 'SSID,CHAN,FREQ', 'dev', 'wifi', 'list'])).stdout)
    : [];
  const choice = chooseChannel(uplink.uplink, radar, scan);
  if (choice.kind === 'refuse') {
    runner.log(`dagsocial-access-point: ${choice.reason}`);
    return 1;
  }
  // Every refusal has fired. Begin changes.
  const record: AccessPointRecord = { entries: [], complete: false };
  const push = async (entry: RecordEntry): Promise<void> => {
    record.entries.push(entry);
    await runner.write(RECORD_PATH, serializeRecord(record));
  };

  // Step 1: write node.env (where an edit is needed).
  if (envPlan.kind === 'edit') {
    runner.log(`writing ${NODE_ENV_PATH}`);
    await push({ kind: 'nodeEnvEdited', priorText: nodeEnvText });
    await runner.write(NODE_ENV_PATH, envPlan.text);
  }

  // Step 3: move the uplink to 2.4 GHz where the choice calls for it; the
  // channel is re-read after the move.
  let apChannel: number;
  if (choice.kind === 'own') apChannel = choice.channel;
  else if (choice.kind === 'follow') apChannel = choice.channel;
  else {
    // move-to-2g
    const profile = uplink.profile;
    if (profile === null || uplink.uplink === null) {
      runner.log('dagsocial-access-point: no uplink profile to move; refusing');
      return 1;
    }
    runner.log(`moving uplink "${uplink.uplink.ssid}" (profile ${profile}) to the 2.4 GHz band`);
    const modify = await runner.run(
      'nmcli',
      ['con', 'modify', profile, '802-11-wireless.band', 'bg'],
    );
    if (modify.code !== 0) {
      runner.log(`dagsocial-access-point: nmcli modify failed (${modify.stderr.trim()})`);
      return 1;
    }
    await push({ kind: 'uplinkBandSet', profile, priorBand: 'a' });
    await runner.run('nmcli', ['con', 'up', profile]);
    const iwDev = await runner.run('iw', ['dev', uplink.uplink.iface, 'info']);
    const re = parseUplink(iwDev.stdout);
    if (re === null) {
      runner.log('dagsocial-access-point: uplink info unreadable after the band change');
      return 1;
    }
    apChannel = re.channel;
  }

  // Step 4: the uap0 interface unit.
  await writeFileChange(runner, record, IFACE_UNIT_PATH, ifaceUnit({
    phy: 'phy0',
    uplinkIface: uplink.uplink !== null ? uplink.uplink.iface : '',
  }));
  await runner.run('systemctl', ['daemon-reload']);
  await runner.run('systemctl', ['enable', 'dagsocial-ap-iface.service']);
  await push({ kind: 'unitEnabled', unit: 'dagsocial-ap-iface.service' });
  await runner.run('systemctl', ['start', 'dagsocial-ap-iface.service']);
  await push({ kind: 'unitStarted', unit: 'dagsocial-ap-iface.service' });

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
  const nmAdd = await runner.run('nmcli', nmArgs);
  if (nmAdd.code !== 0) {
    runner.log(`dagsocial-access-point: nmcli con add failed (${nmAdd.stderr.trim()})`);
    return 1;
  }
  await push({ kind: 'nmConnectionAdded', name: NM_PROFILE_NAME });
  await runner.run('nmcli', ['con', 'up', NM_PROFILE_NAME]);

  // Step 6: the dnsmasq instance.
  await writeFileChange(runner, record, DNSMASQ_CONF_PATH, dnsmasqConf({
    iface: 'uap0',
    address: '10.42.0.1',
    range: ['10.42.0.10', '10.42.0.254'],
  }));
  await writeFileChange(runner, record, DNSMASQ_UNIT_PATH, dnsmasqUnit());
  await runner.run('systemctl', ['daemon-reload']);
  await runner.run('systemctl', ['enable', 'dagsocial-ap-dnsmasq.service']);
  await push({ kind: 'unitEnabled', unit: 'dagsocial-ap-dnsmasq.service' });
  await runner.run('systemctl', ['start', 'dagsocial-ap-dnsmasq.service']);
  await push({ kind: 'unitStarted', unit: 'dagsocial-ap-dnsmasq.service' });

  // Step 7: the nftables table.
  await writeFileChange(runner, record, FIREWALL_NFT_PATH, firewall({
    iface: 'uap0',
    nodePort,
    meshUdpPort,
  }));
  await writeFileChange(runner, record, FIREWALL_UNIT_PATH, firewallUnit());
  await runner.run('systemctl', ['daemon-reload']);
  await runner.run('systemctl', ['enable', 'dagsocial-ap-firewall.service']);
  await push({ kind: 'unitEnabled', unit: 'dagsocial-ap-firewall.service' });
  await runner.run('systemctl', ['start', 'dagsocial-ap-firewall.service']);
  await push({ kind: 'unitStarted', unit: 'dagsocial-ap-firewall.service' });

  // Step 8: restart the node so it reads the new node.env.
  runner.log('restarting dagsocial-node');
  await runner.run('systemctl', ['restart', 'dagsocial-node']);

  record.complete = true;
  await runner.write(RECORD_PATH, serializeRecord(record));
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

// Read PORT= from node.env, defaulting to 3000 where absent or unparseable.
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
  if (rec.entries.some((e) => e.kind === 'uplinkBandSet')) {
    runner.log('warning: the uplink drops for a few seconds while the access point is torn down');
  }
  for (const entry of [...rec.entries].reverse()) {
    await undoEntry(entry, runner);
  }
  if (rec.entries.some((e) => e.kind === 'nodeEnvEdited')) {
    await runner.run('systemctl', ['restart', 'dagsocial-node']);
  }
  await runner.remove(RECORD_PATH);
  runner.log('dagsocial-access-point: removed');
  return 0;
}

async function undoEntry(entry: RecordEntry, runner: Runner): Promise<void> {
  switch (entry.kind) {
    case 'nodeEnvEdited':
      await runner.write(NODE_ENV_PATH, entry.priorText);
      return;
    case 'uplinkBandSet':
      if (entry.priorBand !== '') {
        await runner.run('nmcli', ['con', 'modify', entry.profile, '802-11-wireless.band', entry.priorBand]);
      } else {
        await runner.run('nmcli', ['con', 'modify', entry.profile, '802-11-wireless.band', '']);
      }
      await runner.run('nmcli', ['con', 'up', entry.profile]);
      return;
    case 'fileWritten':
      if (entry.priorText === null) await runner.remove(entry.path);
      else await runner.write(entry.path, entry.priorText);
      return;
    case 'unitEnabled':
      await runner.run('systemctl', ['disable', entry.unit]);
      return;
    case 'unitStarted':
      await runner.run('systemctl', ['stop', entry.unit]);
      return;
    case 'nmConnectionAdded':
      await runner.run('nmcli', ['con', 'delete', entry.name]);
      return;
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
  // Walk each step by reading the box.
  for (const unit of [
    'dagsocial-ap-iface.service',
    'dagsocial-ap-dnsmasq.service',
    'dagsocial-ap-firewall.service',
  ]) {
    const active = await runner.run('systemctl', ['is-active', unit]);
    const enabled = await runner.run('systemctl', ['is-enabled', unit]);
    runner.log(`  ${unit}: ${active.stdout.trim() || 'unknown'} / ${enabled.stdout.trim() || 'unknown'}`);
  }
  // NetworkManager profile.
  const nm = await runner.run('nmcli', ['-t', '-f', 'NAME', 'con', 'show']);
  const names = nm.stdout.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\\(.*)/, '$1').trim());
  const hasProfile = names.some((n) => n === NM_PROFILE_NAME);
  runner.log(`  NetworkManager profile ${NM_PROFILE_NAME}: ${hasProfile ? 'present' : 'missing'}`);
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
      try {
        await fs.unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
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
