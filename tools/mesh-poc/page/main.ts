// MESH_INTERFACE → Place in the workspace / Discovery — the page's wiring:
// fetch `config.json` beside the page (the stage writes it), take the
// profile from `NETWORK_PROFILES[network]`, start the client, and call
// `render` on every `onState`. `fetch` and `startMeshClient` are
// parameters so the cases can inject fakes; `entry.ts` passes the real
// ones.
//
// A configuration that fails to load (network error, non-ok status,
// unparseable JSON, missing field) and a `MeshConfigError` thrown by
// `startMeshClient` (a `/dns4/` anchor address, a hostname ICE server)
// are shown on the page in words, and no client is started.

import { profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';
import type { startMeshClient as realStartMeshClient } from '../src/client/mesh-client.js';
import type { Anchor } from '../src/client/node-list.js';
import type { NetworkName } from '../src/protocols.js';
import { MeshConfigError, assertNoDns } from '../src/config.js';
import { render } from './render.js';

export interface PageConfig {
  network: NetworkName;
  anchors: Anchor[];
  stunServers: string[];
}

export interface RunMainOptions {
  root: HTMLElement;
  fetch: typeof globalThis.fetch;
  startMeshClient: typeof realStartMeshClient;
}

export async function runMain(opts: RunMainOptions): Promise<void> {
  let config: PageConfig;
  try {
    config = await loadConfig(opts.fetch);
  } catch (e) {
    showError(opts.root, `config refused: ${messageOf(e)}`);
    return;
  }

  // MESH_INTERFACE → Discovery / NAT — refuse a /dns4/, /dns6/ or /dnsaddr/
  // anchor and a hostname ICE server before calling the client. The client
  // runs the same checks, but the page cannot start a libp2p host for a
  // config it already knows is refused (the brief: "the injected
  // startMeshClient is never called").
  try {
    for (const a of config.anchors) assertNoDns('anchor', a.addrs);
    assertIceLiterals(config.stunServers);
  } catch (e) {
    if (e instanceof MeshConfigError) {
      showError(opts.root, `config refused: ${messageOf(e)}`);
      return;
    }
    throw e;
  }

  let profile;
  try {
    profile = profileFor(config.network as NetworkType);
  } catch (e) {
    showError(opts.root, `config refused: ${messageOf(e)}`);
    return;
  }

  let client;
  try {
    client = await opts.startMeshClient({
      anchors: config.anchors,
      network: config.network,
      profile,
      stunServers: config.stunServers,
    });
  } catch (e) {
    if (e instanceof MeshConfigError) {
      showError(opts.root, `config refused: ${messageOf(e)}`);
      return;
    }
    throw e;
  }

  client.onState((s) => render(s, opts.root));
  render(client.state(), opts.root);
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
  const stunServers = o['stunServers'];
  if (!Array.isArray(stunServers)) {
    throw new Error('config.stunServers must be an array');
  }
  return {
    network: net,
    anchors: anchors as Anchor[],
    stunServers: stunServers as string[],
  };
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

// MESH_INTERFACE → NAT — a stun server named by anything but an IP literal
// is refused. A full check lives in `src/client/mesh-client.ts`; the page
// catches the gross cases up front so the "injected startMeshClient is
// never called" rule holds for every refusal the config can carry.
const STUN_IP_RE = /^stun:(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):\d{1,5}$/;

function assertIceLiterals(servers: readonly string[]): void {
  for (const s of servers) {
    if (!STUN_IP_RE.test(s)) {
      throw new MeshConfigError(`ICE server refused: ${JSON.stringify(s)} is not stun:<IP>:<port>`);
    }
  }
}
