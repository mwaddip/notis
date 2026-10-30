// MESH_INTERFACE → Place in the workspace / Discovery — the page's wiring:
// fetch `config.json` beside the page (the stage writes it), take the
// profile from `NETWORK_PROFILES[network]`, start the client, and call
// `render` on every `onState`. The one injectable is `fetch` (config
// read); `startMeshClient` is the real one — its first statement runs
// `assertClientConfig`, which throws `MeshConfigError` for a `/dns4/`,
// `/dns6/` or `/dnsaddr/` anchor and for a non-IP STUN server before
// any libp2p node is created.
//
// A configuration that fails to load (network error, non-ok status,
// unparseable JSON, missing field) and a `MeshConfigError` from
// `startMeshClient` are shown on the page in words.

import { profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';
import { startMeshClient } from '../src/client/mesh-client.js';
import type { Anchor } from '../src/client/node-list.js';
import type { NetworkName } from '../src/protocols.js';
import { MeshConfigError } from '../src/config.js';
import { render } from './render.js';

export interface PageConfig {
  network: NetworkName;
  anchors: Anchor[];
  stunServers: string[];
}

export interface RunMainOptions {
  root: HTMLElement;
  fetch: typeof globalThis.fetch;
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

  let client;
  try {
    client = await startMeshClient({
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
