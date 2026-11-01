// MESH_INTERFACE → Place in the workspace / Discovery / NAT — the
// page's wiring: fetch `config.json` beside the page (the stage
// writes it), take the profile from `NETWORK_PROFILES[network]`,
// start the client, apply `config.byHand` through `addByHand` in its
// given order, attach the hand-form, and call `render` on every
// `onState`. The one injectable is `fetch` (config read);
// `startMeshClient` is the real one — its first statement runs
// `assertClientConfig`, which throws `MeshConfigError` for a
// `/dns4/`, `/dns6/` or `/dnsaddr/` anchor before any libp2p node is
// created.
//
// MESH_INTERFACE → NAT → "A client's STUN list comes from the public
// nodes it holds" — the client derives its STUN servers from its
// node list. A config that still carries `stunServers` is refused in
// words, so a stale stage writer shows itself.
//
// A configuration that fails to load (network error, non-ok status,
// unparseable JSON, missing field), a `MeshConfigError` from
// `startMeshClient`, and a malformed `byHand` entry are shown on the
// page in words.

import { profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';
import { startMeshClient } from '../src/client/mesh-client.js';
import type { Anchor } from '../src/client/node-list.js';
import type { NetworkName } from '../src/protocols.js';
import type { ReadNeed } from '../src/client/server-pick.js';
import { MeshConfigError } from '../src/config.js';
import { render } from './render.js';
import { runProbe } from './probe.js';
import { attachHandForm } from './form.js';
import { runReads } from './reads.js';

export interface ByHandEntry {
  notisId: string;
  addrs: string[];
  trusted: boolean;
}

export interface PageConfig {
  network: NetworkName;
  anchors: Anchor[];
  /**
   * MESH_INTERFACE → Discovery → "Seeds" — contacts without trust. Optional;
   * default none. A seed's addresses meet the same refusals as an anchor's,
   * and no answer from a seed makes `anchorReached` true.
   */
  seeds?: Anchor[];
  /**
   * MESH_INTERFACE → Discovery → "A node added by hand" — entries
   * applied through `client.addByHand` after start, in the given
   * order. Optional; default none.
   */
  byHand?: ByHandEntry[];
}

export interface RunMainOptions {
  root: HTMLElement;
  fetch: typeof globalThis.fetch;
  /**
   * Test seam: swap the client factory. Defaults to the real
   * `startMeshClient`. Not meant for ordinary callers.
   */
  startMeshClient?: typeof startMeshClient;
}

export async function runMain(opts: RunMainOptions): Promise<void> {
  let config: PageConfig;
  try {
    config = await loadConfig(opts.fetch);
  } catch (e) {
    showError(opts.root, `config refused: ${messageOf(e)}`);
    return;
  }

  let profile;
  try {
    profile = profileFor(config.network as NetworkType);
  } catch (e) {
    showError(opts.root, `config refused: ${messageOf(e)}`);
    return;
  }

  const startFn = opts.startMeshClient ?? startMeshClient;
  let client;
  try {
    client = await startFn({
      anchors: config.anchors,
      ...(config.seeds !== undefined ? { seeds: config.seeds } : {}),
      network: config.network,
      profile,
    });
  } catch (e) {
    if (e instanceof MeshConfigError) {
      showError(opts.root, `config refused: ${messageOf(e)}`);
      return;
    }
    throw e;
  }

  // MESH_INTERFACE → Discovery → "A node added by hand" — the
  // config's `byHand` entries are applied in given order; a
  // malformed one refuses the whole config in words AND stops the
  // client, so a refused config leaves no libp2p node running on
  // the entries that landed before the bad one.
  if (config.byHand !== undefined) {
    try {
      for (const entry of config.byHand) {
        client.addByHand(entry.notisId, entry.addrs, entry.trusted);
      }
    } catch (e) {
      if (e instanceof MeshConfigError) {
        await client.stop();
        showError(opts.root, `config refused: byHand ${messageOf(e)}`);
        return;
      }
      throw e;
    }
  }

  client.onState((s) => render(s, opts.root));
  render(client.state(), opts.root);

  attachHandForm({ root: opts.root, client });

  // MESH_INTERFACE → Acceptance — the one query parameter the page honours:
  // `?probe=<path>` reads `<path>` through the client's own fetch after the
  // first state with a non-null `nodeId`, and writes `<pre id="probe">`.
  const probePath = readProbePath();
  if (probePath !== null) {
    void runProbe({ client, path: probePath, root: opts.root });
  }

  // MESH_INTERFACE → The client's node list → "A routed read goes to
  // a node its need allows" — `?reads=<n>&need=<tip|older>` drives
  // routed reads after the first check.
  const reads = readReadsParams();
  if (reads !== null) {
    void runReads({ client, n: reads.n, need: reads.need, root: opts.root });
  }
}

function readProbePath(): string | null {
  if (typeof globalThis.location === 'undefined') return null;
  const params = new URLSearchParams(globalThis.location.search);
  const value = params.get('probe');
  return value === null || value === '' ? null : value;
}

function readReadsParams(): { n: number; need: ReadNeed } | null {
  if (typeof globalThis.location === 'undefined') return null;
  const params = new URLSearchParams(globalThis.location.search);
  const nRaw = params.get('reads');
  const needRaw = params.get('need');
  if (nRaw === null || nRaw === '' || needRaw === null) return null;
  if (needRaw !== 'tip' && needRaw !== 'older') return null;
  const n = Number(nRaw);
  if (!Number.isInteger(n)) return null;
  return { n, need: needRaw };
}

async function loadConfig(fetchFn: typeof globalThis.fetch): Promise<PageConfig> {
  const res = await fetchFn('./config.json');
  if (!res.ok) {
    throw new Error(`config.json request answered ${String(res.status)}`);
  }
  const raw: unknown = await res.json();
  return validateConfig(raw);
}

function validateConfig(raw: unknown): PageConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('config.json must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const net = o['network'];
  if (net !== 'devnet' && net !== 'testnet' && net !== 'mainnet') {
    throw new Error(`config.network must be 'devnet' | 'testnet' | 'mainnet', not ${JSON.stringify(net)}`);
  }
  const anchors = o['anchors'];
  if (!Array.isArray(anchors)) {
    throw new Error('config.anchors must be an array');
  }
  // MESH_INTERFACE → NAT → "A client's STUN list comes from the
  // public nodes it holds" — the key is no longer read; its
  // presence shows a stale stage writer in words.
  if (o['stunServers'] !== undefined) {
    throw new Error(
      'config.stunServers is no longer read: the client takes its STUN servers from the nodes it holds',
    );
  }
  // MESH_INTERFACE → Discovery → "Seeds" — optional, default none; when present
  // it must be an array (its addresses are refused by `assertClientConfig`,
  // not here).
  const seedsRaw = o['seeds'];
  let seeds: Anchor[] | undefined;
  if (seedsRaw !== undefined) {
    if (!Array.isArray(seedsRaw)) {
      throw new Error('config.seeds must be an array when present');
    }
    seeds = seedsRaw as Anchor[];
  }
  // MESH_INTERFACE → Discovery → "A node added by hand" — optional
  // list of `{ notisId, addrs, trusted }`. Shape only here; the
  // semantic refusals (bad hex, DNS, non-webrtc-direct) ride on the
  // runtime `addByHand` call.
  const byHandRaw = o['byHand'];
  let byHand: ByHandEntry[] | undefined;
  if (byHandRaw !== undefined) {
    if (!Array.isArray(byHandRaw)) {
      throw new Error('config.byHand must be an array when present');
    }
    byHand = byHandRaw.map((entry, i) => validateByHandEntry(entry, i));
  }
  return {
    network: net,
    anchors: anchors as Anchor[],
    ...(seeds !== undefined ? { seeds } : {}),
    ...(byHand !== undefined ? { byHand } : {}),
  };
}

function validateByHandEntry(raw: unknown, index: number): ByHandEntry {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`config.byHand[${String(index)}] must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const notisId = o['notisId'];
  if (typeof notisId !== 'string') {
    throw new Error(`config.byHand[${String(index)}].notisId must be a string`);
  }
  const addrs = o['addrs'];
  if (!Array.isArray(addrs) || addrs.some((a) => typeof a !== 'string')) {
    throw new Error(`config.byHand[${String(index)}].addrs must be an array of strings`);
  }
  const trusted = o['trusted'];
  if (typeof trusted !== 'boolean') {
    throw new Error(`config.byHand[${String(index)}].trusted must be a boolean`);
  }
  return { notisId, addrs: addrs as string[], trusted };
}

function showError(root: HTMLElement, text: string): void {
  while (root.firstChild !== null) root.removeChild(root.firstChild);
  const box = document.createElement('div');
  box.setAttribute('data-role', 'error');
  box.textContent = text;
  root.appendChild(box);
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
