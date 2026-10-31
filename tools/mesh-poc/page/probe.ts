// MESH_INTERFACE → Acceptance — the one query parameter the page reads:
// `?probe=<path>`. After the first state with a non-null `nodeId`
// (which is the client's first check: a `resolveTip` success on an
// anchor it could verify, `MESH_INTERFACE → The client's node list → "A
// check"`), the page reads `<path>` through its own client's
// `fetch` — a mesh URL `notis-mesh://<nodeId><path>` — and writes a
// `<pre id="probe">` with `{ path, nodeId, status, bytes, sha256 }`:
// the body's byte length and its SHA-256 as 64 lowercase hex. Text
// only, no global, no other behaviour change.
//
// Browser-safe: `globalThis.crypto.subtle.digest('SHA-256', body)` is
// Web Crypto (CryptoSubtle) in every browser Notis supports, and in
// Node 20+ as a built-in; no `node:crypto` import.

import type { MeshClient } from '../src/client/mesh-client.js';
import { meshBaseUrl } from '../src/mesh-url.js';

export interface ProbeResult {
  path: string;
  nodeId: string;
  status: number;
  bytes: number;
  sha256: string;
}

export interface RunProbeOptions {
  client: Pick<MeshClient, 'fetch' | 'state' | 'onState'>;
  path: string;
  root: HTMLElement;
}

export async function runProbe(opts: RunProbeOptions): Promise<ProbeResult> {
  const nodeId = await firstNodeId(opts.client);
  const url = meshBaseUrl(nodeId) + opts.path;
  const res = await opts.client.fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', buf),
  );
  const result: ProbeResult = {
    path: opts.path,
    nodeId,
    status: res.status,
    bytes: buf.length,
    sha256: bytesToHex(digest),
  };
  writeProbe(opts.root, result);
  return result;
}

function firstNodeId(
  client: Pick<MeshClient, 'state' | 'onState'>,
): Promise<string> {
  const current = client.state().nodeId;
  if (current !== null) return Promise.resolve(current);
  return new Promise<string>((resolve) => {
    const unsubscribe = client.onState((s) => {
      if (s.nodeId !== null) {
        unsubscribe();
        resolve(s.nodeId);
      }
    });
  });
}

function writeProbe(root: HTMLElement, r: ProbeResult): void {
  // The probe owns `<pre id="probe">` as a sibling of the state
  // renderer's `[data-role="state-root"]` container; a render replaces
  // only its container's children, so this element is never touched by
  // the state renderer and the stage's CDP driver sees a stable payload.
  const existing = root.querySelector('pre#probe');
  if (existing !== null) existing.remove();
  const pre = document.createElement('pre');
  pre.id = 'probe';
  pre.textContent = JSON.stringify(r);
  root.appendChild(pre);
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
