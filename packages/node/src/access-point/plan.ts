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

export function chooseChannel(
  _uplink: Uplink | null,
  _radar: Set<number>,
  _scan: Array<{ ssid: string; channel: number }>,
): ChannelChoice {
  throw new Error('access-point: not implemented');
}

export type NodeEnvPlan =
  | { kind: 'unchanged'; meshUdpPort: number }
  | { kind: 'edit'; text: string; meshUdpPort: number }
  | { kind: 'refuse'; reason: string };

export function nodeEnvPlan(_text: string, _opts: { meshPort: number }): NodeEnvPlan {
  throw new Error('access-point: not implemented');
}
