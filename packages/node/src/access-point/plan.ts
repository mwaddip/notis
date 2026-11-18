// NODE_INTERFACE → The access-point tool → "`setup` turns a box into an
// access point, in order" — the two choices `setup` makes before the first
// change: which channel the access point runs on, and what, if anything, has
// to be written into `/etc/dagsocial/node.env`.

import type { Uplink } from './radio.js';

export type ChannelChoice =
  | { kind: 'follow'; channel: number }
  | { kind: 'move-to-2g' }
  | { kind: 'own'; channel: number }
  | { kind: 'refuse'; reason: string };

// Step 3's rule: with an uplink, the access point runs on the uplink's
// channel (one radio, one channel); on a radar channel the uplink is moved
// to the 2.4 GHz band where its network offers one there, else `setup`
// stops. With no uplink, the tool picks a non-radar 2.4 GHz channel.
export function chooseChannel(
  uplink: Uplink | null,
  radar: ReadonlySet<number>,
  scan: ReadonlyArray<{ ssid: string; channel: number }>,
): ChannelChoice {
  if (uplink === null) {
    for (const c of [1, 6, 11]) {
      if (!radar.has(c)) return { kind: 'own', channel: c };
    }
    return { kind: 'refuse', reason: 'no non-radar 2.4 GHz channel is available' };
  }
  if (!radar.has(uplink.channel)) return { kind: 'follow', channel: uplink.channel };
  // The uplink is on a radar channel. Look for a 2.4 GHz channel its network
  // offers (channels 1–14).
  const hasTwoG = scan.some(
    (s) => s.ssid === uplink.ssid && s.channel >= 1 && s.channel <= 14,
  );
  if (hasTwoG) return { kind: 'move-to-2g' };
  return {
    kind: 'refuse',
    reason:
      `the uplink is on radar channel ${uplink.channel} and the network "${uplink.ssid}" offers no 2.4 GHz channel`,
  };
}

export type NodeEnvPlan =
  | { kind: 'unchanged'; meshUdpPort: number }
  | { kind: 'edit'; text: string; meshUdpPort: number }
  | { kind: 'refuse'; reason: string };

const WEBRTC_LISTEN_RE = /^\/ip4\/0\.0\.0\.0\/udp\/(\d+)\/webrtc-direct(?:\/|$)/;

// Step 1's rule (NODE_INTERFACE → The access-point tool, step 1 of
// "`setup` turns a box into an access point, in order"):
// no MESH_ROLE → append `MESH_ROLE=private` and a webrtc-direct listen;
// private with a matching listen → unchanged; private without one → add the
// listen on the first UDP port from `opts.meshPort` up that no listen uses;
// public → refuse.
export function nodeEnvPlan(
  text: string,
  opts: { meshPort: number },
): NodeEnvPlan {
  const env = parseEnv(text);
  const role = env.get('MESH_ROLE');
  const defaultListen = `/ip4/0.0.0.0/udp/${opts.meshPort}/webrtc-direct`;

  if (role === undefined) {
    let out = text;
    out = addOrReplaceEnvLine(out, 'MESH_ROLE', 'private');
    out = addOrReplaceEnvLine(out, 'MESH_LISTEN', defaultListen);
    return { kind: 'edit', text: out, meshUdpPort: opts.meshPort };
  }
  if (role === 'public') {
    return {
      kind: 'refuse',
      reason:
        'the node runs as public; a public node lists no local addresses, so discovery through an access point would dial nothing',
    };
  }
  if (role !== 'private') {
    return {
      kind: 'refuse',
      reason: `the node's MESH_ROLE is "${role}", neither private nor public`,
    };
  }
  // role === 'private'
  const listen = env.get('MESH_LISTEN') ?? '';
  const addrs = listen === ''
    ? []
    : listen.split(',').map((a) => a.trim()).filter((a) => a !== '');
  for (const a of addrs) {
    const m = WEBRTC_LISTEN_RE.exec(a);
    if (m !== null) return { kind: 'unchanged', meshUdpPort: Number(m[1]) };
  }
  // Private without a webrtc-direct listen: pick the first UDP port from
  // `opts.meshPort` up that no listen in the list uses — any transport
  // counts (NODE_INTERFACE → The access-point tool, step 1 of "`setup`
  // turns a box into an access point, in order").
  const used = new Set<number>();
  for (const a of addrs) {
    const m = /\/(udp|tcp)\/(\d+)/.exec(a);
    if (m !== null) used.add(Number(m[2]));
  }
  let port = opts.meshPort;
  while (used.has(port)) port++;
  const addedListen = `/ip4/0.0.0.0/udp/${port}/webrtc-direct`;
  const newListen = addrs.length === 0 ? addedListen : `${listen},${addedListen}`;
  const out = addOrReplaceEnvLine(text, 'MESH_LISTEN', newListen);
  return { kind: 'edit', text: out, meshUdpPort: port };
}

function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    m.set(key, val);
  }
  return m;
}

// Replaces the first uncommented `<key>=…` line, or appends a new one when
// the key is not present.
function addOrReplaceEnvLine(text: string, key: string, value: string): string {
  const lines = text.split('\n');
  const keyEq = `${key}=`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith(keyEq)) {
      lines[i] = `${key}=${value}`;
      return lines.join('\n');
    }
  }
  let out = text;
  if (out !== '' && !out.endsWith('\n')) out += '\n';
  out += `${key}=${value}\n`;
  return out;
}
