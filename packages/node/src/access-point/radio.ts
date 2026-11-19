// NODE_INTERFACE → The access-point tool → "`setup` turns a box into an
// access point, in order" — step 2 reads the radio's combinations and radar
// channels from `iw list`; step 3 reads the connected Wi-Fi device from
// `nmcli dev`, its profile from `nmcli dev show <dev>`, its channel from
// `iw dev <dev> info`, and the scan from `nmcli dev wifi list`.

export interface IwCombination {
  // The one shape the access-point tool needs: a combination that carries
  // a managed (client) link and an AP interface together, on one channel.
  managedWithAp: boolean;
}

// `iw list` prints "valid interface combinations:" and then one indented
// `* …` block per combination. Each block is a comma-separated list of
// clauses — `#{ managed } <= 1, #{ AP } <= 1, …` — wrapped across lines.
// A combination holds the shape the tool needs where the block names both
// `managed` and `AP` inside one `* …` entry.
export function parseCombinations(iwList: string): IwCombination {
  const lines = iwList.split('\n');
  let inCombinations = false;
  let combo = '';
  const check = (c: string): boolean =>
    /#\{\s*[^}]*\bmanaged\b[^}]*\}/.test(c) && /#\{\s*[^}]*\bAP\b[^}]*\}/.test(c);
  for (const raw of lines) {
    if (!inCombinations) {
      if (/^\s*valid interface combinations:/i.test(raw)) inCombinations = true;
      continue;
    }
    // Any line that starts without indentation ends the combinations block.
    if (raw.length > 0 && !/^\s/.test(raw)) break;
    const trimmed = raw.trim();
    if (trimmed.startsWith('*')) {
      if (combo !== '' && check(combo)) return { managedWithAp: true };
      combo = trimmed;
    } else {
      combo += ' ' + trimmed;
    }
  }
  if (combo !== '' && check(combo)) return { managedWithAp: true };
  return { managedWithAp: false };
}

// `iw list` prints each supported frequency on its own line; a channel is
// flagged for radar detection by `(radar detection)` at the end of the line.
export function parseRadarChannels(iwList: string): Set<number> {
  const out = new Set<number>();
  const re = /\[(\d+)\][^\n]*\(radar detection\)/;
  for (const line of iwList.split('\n')) {
    const m = re.exec(line);
    if (m !== null) out.add(Number(m[1]));
  }
  return out;
}

export interface Uplink {
  iface: string;
  ssid: string;
  channel: number;
}

// `iw dev <dev> info` prints the fields of one interface, one per line.
// The whole-device `iw dev` output is accepted too — the parser reads the
// first interface block it finds that carries ssid and channel.
export function parseUplink(iwDevInfo: string): Uplink | null {
  let iface: string | null = null;
  let ssid: string | null = null;
  let channel: number | null = null;
  for (const raw of iwDevInfo.split('\n')) {
    const line = raw.trim();
    const mi = /^Interface (\S+)$/.exec(line);
    if (mi !== null) {
      // On a second Interface line, keep the first one's values.
      if (iface === null) iface = mi[1] ?? null;
      continue;
    }
    if (iface === null) continue;
    const ms = /^ssid (.+)$/.exec(line);
    if (ms !== null && ssid === null) ssid = (ms[1] ?? '').trim();
    const mc = /^channel (\d+)/.exec(line);
    if (mc !== null && channel === null) channel = Number(mc[1]);
  }
  if (iface !== null && ssid !== null && channel !== null) {
    return { iface, ssid, channel };
  }
  return null;
}

// `nmcli -t -f SSID,CHAN,FREQ dev wifi list` emits one row per visible
// network; terse mode separates fields with `:`, and a `:` inside a value
// is escaped `\:`.
export function parseScan(
  nmcliWifiList: string,
): Array<{ ssid: string; channel: number }> {
  const out: Array<{ ssid: string; channel: number }> = [];
  for (const raw of nmcliWifiList.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    const fields = splitNmcliTerse(line);
    if (fields.length < 2) continue;
    const ssid = fields[0]!;
    const chan = Number(fields[1]);
    if (!Number.isFinite(chan)) continue;
    out.push({ ssid, channel: chan });
  }
  return out;
}

function splitNmcliTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && line[i + 1] === ':') {
      cur += ':';
      i++;
      continue;
    }
    if (c === ':') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

// `nmcli -t -f DEVICE,TYPE,STATE dev` lists every device as
// `<device>:<type>:<state>`. The uplink is the first wifi row whose state
// is `connected`.
export function parseConnectedWifi(nmcliDev: string): string | null {
  for (const raw of nmcliDev.split('\n')) {
    const fields = splitNmcliTerse(raw.replace(/\r$/, ''));
    if (fields.length < 3) continue;
    if (fields[1] === 'wifi' && fields[2] === 'connected') return fields[0] ?? null;
  }
  return null;
}

// `iw dev` lists its phy as a leading `phy#N` line; the tool reads this
// for a no-uplink `ifaceUnit` (NODE_INTERFACE → The access-point tool,
// step 4), rather than assuming `phy0`.
export function parsePhy(iwDev: string): string | null {
  for (const raw of iwDev.split('\n')) {
    const m = /^phy#(\d+)/.exec(raw.trim());
    if (m !== null) return `phy${m[1]}`;
  }
  return null;
}

// The first `Interface <name>` block `iw dev` lists — the Wi-Fi interface's
// name the tool reads for step 4 even where no uplink is connected
// (NODE_INTERFACE → The access-point tool, step 4). An "Unnamed/non-netdev
// interface" entry carries no `Interface <name>` line and is passed over.
export function parseFirstInterface(iwDev: string): string | null {
  for (const raw of iwDev.split('\n')) {
    const m = /^\s+Interface (\S+)$/.exec(raw);
    if (m !== null) return m[1] ?? null;
  }
  return null;
}

export interface DeviceState {
  state: string;
  connection: string | null;
}

// `nmcli -t -f DEVICE,STATE,CONNECTION dev` lists every device as
// `<device>:<state>:<connection>`; `<connection>` is empty for a
// device that holds none. Reads the line for `<iface>`.
export function parseDeviceState(nmcliOut: string, iface: string): DeviceState | null {
  for (const raw of nmcliOut.split('\n')) {
    const fields = splitNmcliTerse(raw.replace(/\r$/, ''));
    if (fields.length < 2) continue;
    if (fields[0] !== iface) continue;
    const state = (fields[1] ?? '').trim();
    const conn = (fields[2] ?? '').trim();
    return { state, connection: conn === '' || conn === '--' ? null : conn };
  }
  return null;
}

// `nmcli -t -f GENERAL.CONNECTION dev show <dev>` prints one line,
// `GENERAL.CONNECTION:<profile>`.
export function parseGeneralConnection(nmcliShow: string): string | null {
  for (const raw of nmcliShow.split('\n')) {
    const fields = splitNmcliTerse(raw.replace(/\r$/, ''));
    if (fields.length < 2) continue;
    if (fields[0] === 'GENERAL.CONNECTION') {
      const name = (fields[1] ?? '').trim();
      return name === '' || name === '--' ? null : name;
    }
  }
  return null;
}
