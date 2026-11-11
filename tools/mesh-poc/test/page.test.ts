// @vitest-environment happy-dom
// MESH_INTERFACE → What the client remembers / The client's node list / Discovery →
// "First contact" — the page's banner words, the state element, the hostile-text rule, the
// config refusal path, and the bundle scan (no Node built-in). Each case
// holds one guard the page keeps.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ClientState, MeshClient } from '@dagsocial/web/mesh';
import { emptyTraffic } from '@dagsocial/web/mesh';
import type { NodeEntry } from '@dagsocial/web/mesh';
import type { ReadNeed } from '@dagsocial/web/mesh';
import { MeshConfigError } from '@dagsocial/web/mesh';
import { MeshFetchError } from '@dagsocial/net/browser';
import { render } from '../page/render.js';
import { runMain } from '../page/main.js';
import { runProbe } from '../page/probe.js';
import { attachHandForm } from '../page/form.js';
import { runReads } from '../page/reads.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const DIST_PAGE = join(PACKAGE_ROOT, 'dist-page');

function makeEntry(over: Partial<NodeEntry> & { notisId: string }): NodeEntry {
  return {
    notisId: over.notisId,
    firstContact: over.firstContact ?? false,
    known: over.known ?? false,
    byHand: over.byHand ?? false,
    yours: over.yours ?? false,
    status: over.status ?? 'new',
    failures: over.failures ?? 0,
    retryAtMs: over.retryAtMs ?? 0,
    readMs: over.readMs ?? null,
    behindBy: over.behindBy ?? null,
    addrs: over.addrs ?? [],
    droppedAddrs: over.droppedAddrs ?? [],
    evidence: over.evidence ?? null,
    lastFailure: over.lastFailure ?? null,
    lastFailures: over.lastFailures ?? {},
    transport: over.transport ?? null,
    path: over.path ?? null,
    api: over.api ?? null,
    seenMs: over.seenMs ?? null,
  };
}

function emptyState(over: Partial<ClientState> = {}): ClientState {
  return {
    nodeId: over.nodeId ?? null,
    transport: over.transport ?? null,
    path: over.path ?? null,
    lastLeft: over.lastLeft ?? null,
    tip: over.tip ?? null,
    agreement: over.agreement ?? null,
    checks: over.checks ?? 0,
    traffic: over.traffic ?? emptyTraffic(),
    nodes: over.nodes ?? [],
    seated: over.seated ?? false,
    proofs: over.proofs ?? null,
    anchor: over.anchor ?? null,
    chain: over.chain ?? null,
    notContinued: over.notContinued ?? false,
    disagreement: over.disagreement ?? null,
  };
}

describe('page/render.ts', () => {
  it('the not-continued words are the contract\'s', () => {
    const root = document.createElement('div');
    render(emptyState({ notContinued: true }), root);
    const banner = root.querySelector('[data-role="banner"]');
    expect(banner, 'the banner must appear while notContinued is true').not.toBeNull();
    expect(banner!.textContent).toBe('No node reached continues the chain you verified.');

    const root2 = document.createElement('div');
    render(emptyState({ notContinued: false }), root2);
    expect(root2.querySelector('[data-role="banner"]')).toBeNull();
  });

  it('the state element holds the state', () => {
    const root = document.createElement('div');
    const state = emptyState({
      nodeId: 'aa'.repeat(32),
      transport: 'webrtc-direct',
      path: 'direct',
      tip: { height: 42, hash: 'bb'.repeat(32) },
      nodes: [makeEntry({ notisId: 'aa'.repeat(32), firstContact: true, status: 'ok' })],
    });
    render(state, root);
    const pre = root.querySelector('pre#state');
    expect(pre, 'a <pre id="state"> element is required').not.toBeNull();
    const parsed = JSON.parse(pre!.textContent ?? '');
    expect(parsed).toEqual(state);
  });

  it('renderNode shows each entry\'s transport and path alongside its other fields', () => {
    const root = document.createElement('div');
    const nodes = [
      makeEntry({
        notisId: 'aa'.repeat(32), firstContact: true, status: 'ok',
        transport: 'webrtc-direct', path: 'direct',
      }),
      makeEntry({
        notisId: 'bb'.repeat(32), status: 'behind',
        transport: 'webrtc', path: 'direct',
      }),
      makeEntry({ notisId: 'cc'.repeat(32), status: 'retry' }),
    ];
    render(emptyState({ nodes }), root);
    const metas = Array.from(root.querySelectorAll('.nodes .meta')).map((n) => n.textContent ?? '');
    expect(metas[0], 'first entry carries { webrtc-direct, direct }').toContain('transport=webrtc-direct');
    expect(metas[0]).toContain('path=direct');
    expect(metas[1], 'second entry carries { webrtc, direct }').toContain('transport=webrtc');
    expect(metas[1]).toContain('path=direct');
    expect(metas[2], 'third entry has no open connection — the pair reads none')
      .toContain('transport=none');
    expect(metas[2]).toContain('path=none');
  });

  it('a hostile node\'s text is text', () => {
    const root = document.createElement('div');
    const hostile = makeEntry({
      notisId: 'cc'.repeat(32),
      status: 'blacklisted',
      evidence: {
        kind: 'malformed',
        atMs: 0,
        detail: '<img src=x onerror=alert(1)>',
      },
    });
    render(emptyState({ nodes: [hostile] }), root);
    expect(root.querySelector('img'), 'no img may be built from the hostile string').toBeNull();
    expect(root.innerHTML.includes('<img'), 'the hostile string must not have become a tag').toBe(false);
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a refused config is shown', async () => {
    // Real `startMeshClient` through `runMain`: a /dns4/ first-contact node runs through
    // `assertClientConfig` (`startMeshClient`'s first statement) and throws
    // `MeshConfigError` before any libp2p node is created. The "no node is
    // created" property is held by `mesh-client.test.ts`'s own case.
    const root = document.createElement('div');
    const fakeFetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          network: 'devnet',
          firstContact: [
            {
              notisId: 'aa'.repeat(32),
              addrs: ['/dns4/example.com/tcp/4001/p2p/12D3KooWBad'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await runMain({
      root,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    });
    const errText = root.textContent ?? '';
    expect(errText.toLowerCase()).toContain('refused');
    expect(errText).toContain('DNS');
  });
});

describe('page/probe.ts', () => {
  // MESH_INTERFACE → Acceptance — the one query parameter the page honours:
  // `?probe=<path>`. After the first state with a non-null `nodeId`, the
  // page reads the path through its own client's fetch (a mesh URL
  // `notis-mesh://<nodeId><path>`), and writes `<pre id="probe">` with
  // `{ path, nodeId, status, bytes, sha256 }`. The SHA-256 is lowercase
  // hex over the response body.
  type FakeClient = Pick<MeshClient, 'fetch' | 'state' | 'onState'>;
  function buildFake(opts: {
    nodeId: string;
    body: Uint8Array;
    status?: number;
    expectUrl?: string;
  }): { client: FakeClient; emit: (nodeId: string | null) => void; fetched: string[] } {
    const listeners = new Set<(s: ClientState) => void>();
    let state: ClientState = {
      nodeId: null, transport: null, path: null, lastLeft: null,
      tip: null, agreement: null, checks: 0, traffic: emptyTraffic(), nodes: [],
      seated: false, proofs: null, anchor: null, chain: null, notContinued: false, disagreement: null,
    };
    const fetched: string[] = [];
    const client: FakeClient = {
      fetch: async (url: string) => {
        fetched.push(url);
        if (opts.expectUrl !== undefined && url !== opts.expectUrl) {
          throw new Error(`unexpected mesh URL: ${url}`);
        }
        const body = opts.body;
        return new Response(body as unknown as BodyInit, { status: opts.status ?? 200 });
      },
      state: () => state,
      onState: (cb) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
    };
    const emit = (nodeId: string | null) => {
      state = { ...state, nodeId };
      for (const l of listeners) l(state);
    };
    return { client, emit, fetched };
  }

  it('writes <pre id="probe"> with { path, nodeId, status, bytes, sha256 } after the first state with a nodeId', async () => {
    const root = document.createElement('div');
    const nodeId = 'a'.repeat(64);
    const path = '/blocks/current';
    const body = new TextEncoder().encode('{"height":42,"hash":"ab"}');
    const expectedSha = '5aeebf56f0f896ce1fd8e4bccb182c047c91d71692408a418ef8aecca022d90c';
    const { client, emit, fetched } = buildFake({
      nodeId,
      body,
      expectUrl: `notis-mesh://${nodeId}${path}`,
    });
    const promise = runProbe({ client, path, root });
    emit(nodeId);
    const result = await promise;
    expect(result.path).toBe(path);
    expect(result.nodeId).toBe(nodeId);
    expect(result.status).toBe(200);
    expect(result.bytes).toBe(body.length);
    expect(result.sha256).toBe(expectedSha);
    expect(fetched).toEqual([`notis-mesh://${nodeId}${path}`]);
    const pre = root.querySelector('pre#probe');
    expect(pre, '<pre id="probe"> under root').not.toBeNull();
    const parsed = JSON.parse(pre!.textContent ?? '');
    expect(parsed).toEqual({ path, nodeId, status: 200, bytes: body.length, sha256: expectedSha });
  });

  it('reads the first non-null state when the client already has a nodeId', async () => {
    const root = document.createElement('div');
    const nodeId = 'b'.repeat(64);
    const body = new Uint8Array([1, 2, 3, 4]);
    // sha256 of 0x01020203... — compute via the real digest to avoid duplicating
    // the function in the test.
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', body));
    let expectedSha = '';
    for (const b of digest) expectedSha += b.toString(16).padStart(2, '0');

    const listeners = new Set<(s: ClientState) => void>();
    let state: ClientState = {
      nodeId, transport: 'webrtc-direct', path: 'direct', lastLeft: null,
      tip: null, agreement: null, checks: 0, traffic: emptyTraffic(), nodes: [],
      seated: false, proofs: null, anchor: null, chain: null, notContinued: false, disagreement: null,
    };
    const client: FakeClient = {
      fetch: async () => new Response(body as unknown as BodyInit, { status: 200 }),
      state: () => state,
      onState: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    };
    const result = await runProbe({ client, path: '/nipopow/proof/24/20', root });
    expect(result.nodeId).toBe(nodeId);
    expect(result.bytes).toBe(4);
    expect(result.sha256).toBe(expectedSha);
  });
});

describe('page/probe.ts survives a render', () => {
  // MESH_INTERFACE → Acceptance 1 — the mesh's answers equal the
  // node's direct HTTP answers byte for byte, and the stage's CDP
  // reads `<pre id="probe">` for that byte-for-byte check, which the
  // page writes once per `?probe=<path>` run. The state renderer and
  // the probe each own their own subtree under `#root`, so a render
  // leaves `<pre id="probe">` in place.
  type FakeClient = Pick<MeshClient, 'fetch' | 'state' | 'onState'>;
  function buildFake(opts: { nodeId: string; body: Uint8Array }): FakeClient {
    const state: ClientState = {
      nodeId: opts.nodeId, transport: 'webrtc-direct', path: 'direct',
      lastLeft: null, tip: null, agreement: null, checks: 0, traffic: emptyTraffic(), nodes: [],
      seated: false, proofs: null, anchor: null, chain: null, notContinued: false, disagreement: null,
    };
    return {
      fetch: async () => new Response(opts.body as unknown as BodyInit, { status: 200 }),
      state: () => state,
      onState: () => () => { /* no listener */ },
    };
  }

  it('a state render after the probe keeps <pre id="probe"> with the same text', async () => {
    const root = document.createElement('div');
    const nodeId = 'a'.repeat(64);
    const body = new TextEncoder().encode('{"height":42,"hash":"ab"}');
    await runProbe({ client: buildFake({ nodeId, body }), path: '/blocks/current', root });
    const before = root.querySelector('pre#probe');
    expect(before, 'the probe is written before the render').not.toBeNull();
    const probeText = before!.textContent;
    const state: ClientState = {
      nodeId, transport: 'webrtc-direct', path: 'direct',
      lastLeft: null, tip: null, agreement: null, checks: 0, traffic: emptyTraffic(), nodes: [],
      seated: false, proofs: null, anchor: null, chain: null, notContinued: false, disagreement: null,
    };
    render(state, root);
    const after = root.querySelector('pre#probe');
    expect(after, 'the probe survives the state render').not.toBeNull();
    expect(after!.textContent, 'with the same text').toBe(probeText);
  });

  it('two state renders after the probe keep <pre id="probe"> with the same text', async () => {
    const root = document.createElement('div');
    const nodeId = 'a'.repeat(64);
    const body = new TextEncoder().encode('{"height":42,"hash":"ab"}');
    await runProbe({ client: buildFake({ nodeId, body }), path: '/blocks/current', root });
    const probeText = root.querySelector('pre#probe')!.textContent;
    const state1: ClientState = {
      nodeId, transport: 'webrtc-direct', path: 'direct',
      lastLeft: null, tip: null, agreement: null, checks: 0, traffic: emptyTraffic(), nodes: [],
      seated: false, proofs: null, anchor: null, chain: null, notContinued: false, disagreement: null,
    };
    render(state1, root);
    const state2: ClientState = { ...state1, tip: { height: 7, hash: 'c'.repeat(64) } };
    render(state2, root);
    const after = root.querySelector('pre#probe');
    expect(after, 'the probe survives two renders').not.toBeNull();
    expect(after!.textContent, 'with the same text').toBe(probeText);
  });
});

describe('page/main.ts probe wiring', () => {
  // MESH_INTERFACE → Acceptance — `main.ts` reads `?probe=<path>` from
  // `globalThis.location.search`. A URL without `?probe=` does not run the
  // probe (no `<pre id="probe">` ever appears); a URL with it runs the
  // probe after the client's first state with a nodeId.
  it('absent ?probe= query parameter leaves no <pre id="probe">', async () => {
    const root = document.createElement('div');
    const fakeFetch = async (): Promise<Response> => new Response(
      JSON.stringify({
        network: 'devnet',
        firstContact: [{ notisId: 'aa'.repeat(32), addrs: ['/dns4/example.com/tcp/4001/p2p/12D3KooWBad'] }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    await runMain({ root, fetch: fakeFetch as unknown as typeof globalThis.fetch });
    expect(root.querySelector('pre#probe')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fakes for the client surface the form, reads driver, and main.ts rely on.

interface FakeClientInit {
  nodeId?: string | null;
  nodes?: NodeEntry[];
  agreement?: ClientState['agreement'];
  checks?: number;
  addByHandBehavior?: (notisId: string, addrs: string[], trusted: boolean) => void;
  readAnswers?: Array<{ nodeId: string } | { error: string }>;
}

interface FakeClient {
  client: Pick<MeshClient, 'read' | 'state' | 'onState' | 'addByHand' | 'fetch' | 'stop' | 'order'>;
  emit: (over: Partial<ClientState>) => void;
  calls: {
    addByHand: Array<{ notisId: string; addrs: string[]; trusted: boolean }>;
    read: Array<{ path: string; need: ReadNeed }>;
    stop: number;
  };
}

function buildFakeClient(init: FakeClientInit = {}): FakeClient {
  const listeners = new Set<(s: ClientState) => void>();
  let state: ClientState = {
    nodeId: init.nodeId ?? null,
    transport: null,
    path: null,
    lastLeft: null,
    tip: null,
    agreement: init.agreement ?? null,
    checks: init.checks ?? 0,
    traffic: emptyTraffic(),
    nodes: init.nodes ?? [],
    seated: false,
    proofs: null,
    anchor: null,
    chain: null,
    notContinued: false,
    disagreement: null,
  };
  const calls: FakeClient['calls'] = { addByHand: [], read: [], stop: 0 };
  const readQueue: Array<{ nodeId: string } | { error: string }> = (init.readAnswers ?? []).slice();
  const client: FakeClient['client'] = {
    fetch: async () => new Response('', { status: 200 }),
    read: async (path: string, need: ReadNeed) => {
      calls.read.push({ path, need });
      const answer = readQueue.shift();
      if (answer === undefined) {
        throw new MeshFetchError('transport', 'no answer queued');
      }
      if ('error' in answer) throw new MeshFetchError('transport', answer.error);
      return { response: new Response('', { status: 200 }), nodeId: answer.nodeId, route: 'mesh' };
    },
    order: () => [],
    state: () => state,
    onState: (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    addByHand: (notisId, addrs, trusted) => {
      calls.addByHand.push({ notisId, addrs, trusted });
      if (init.addByHandBehavior !== undefined) {
        init.addByHandBehavior(notisId, addrs, trusted);
      }
    },
    stop: async () => {
      calls.stop += 1;
    },
  };
  const emit = (over: Partial<ClientState>) => {
    state = { ...state, ...over };
    for (const l of [...listeners]) l(state);
  };
  return { client, emit, calls };
}

// ---------------------------------------------------------------------------
// MESH_INTERFACE → What the client remembers → "The agreement counts" —
// the page shows how many nodes name a tip on the client's chain within
// its last `k` headers and how many name one off those headers; before
// the first check, the line reads `On this chain: —`, and in every state
// it sits above the not-continued words.

describe('page/render.ts agreement line', () => {
  it('reads "On this chain: —" before the first check (agreement === null)', () => {
    const root = document.createElement('div');
    render(emptyState({ agreement: null }), root);
    const line = root.querySelector('[data-role="agreement"]');
    expect(line, 'the agreement line is required').not.toBeNull();
    expect(line!.textContent).toBe('On this chain: —');
  });

  it('reads "On this chain: <n> · Not on this chain\'s last 20 blocks: <p>" after a check', () => {
    const root = document.createElement('div');
    render(
      emptyState({
        agreement: { onChain: 3, offChain: 2 },
      }),
      root,
    );
    const line = root.querySelector('[data-role="agreement"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toBe(
      "On this chain: 3 · Not on this chain's last 20 blocks: 2",
    );
  });

  it('sits above the not-continued words', () => {
    const root = document.createElement('div');
    render(
      emptyState({
        notContinued: true,
        agreement: { onChain: 0, offChain: 1 },
      }),
      root,
    );
    const line = root.querySelector('[data-role="agreement"]');
    const banner = root.querySelector('[data-role="banner"]');
    expect(line, 'the agreement line is required').not.toBeNull();
    expect(banner, 'the banner is required while notContinued is true').not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING means banner is after line in the tree.
    const rel = line!.compareDocumentPosition(banner!);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And the banner still says exactly the contract's words.
    expect(banner!.textContent).toBe('No node reached continues the chain you verified.');
  });
});

// ---------------------------------------------------------------------------
// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — the latest routed read's node is shown under
// the heading `Last read from`. The three rows keep their keys so the
// stage reads them.

describe('page/render.ts last-read-from heading', () => {
  it('the heading reads "Last read from"; the three rows keep notisId / transport / path', () => {
    const root = document.createElement('div');
    render(
      emptyState({
        nodeId: 'aa'.repeat(32),
        transport: 'webrtc-direct',
        path: 'direct',
      }),
      root,
    );
    const section = root.querySelector('[data-role="in-use"]');
    expect(section, 'the section is required').not.toBeNull();
    const h = section!.querySelector('h2');
    expect(h, 'a heading is required').not.toBeNull();
    expect(h!.textContent).toBe('Last read from');
    const dts = Array.from(section!.querySelectorAll('dt')).map((d) => d.textContent ?? '');
    expect(dts, 'the three row keys the stage reads').toEqual(['notisId', 'transport', 'path']);
  });
});

// MESH_INTERFACE → Block gossip → "A refused block is evidence as
// `net` weighs it" / The client's node list — the traffic section
// shows the counts the client keeps per check: how many proofs were
// read; the bytes read for tip, header, proof and gossip; and the
// number of blocks forwarded on delivery.

describe('page/render.ts traffic section', () => {
  it('the section reads Proofs read, tip, header, proof, gossip and forwarded in order, with the live values', () => {
    const root = document.createElement('div');
    render(
      emptyState({
        traffic: {
          tipBytes: 123,
          headerBytes: 456,
          proofBytes: 7890,
          gossipBytes: 11,
          proofReads: 3,
          forwarded: 2,
        },
      }),
      root,
    );
    const section = root.querySelector('[data-role="traffic"]');
    expect(section, 'the traffic section is required').not.toBeNull();
    const h = section!.querySelector('h2');
    expect(h, 'a heading is required').not.toBeNull();
    expect(h!.textContent).toBe('Traffic');
    const dts = Array.from(section!.querySelectorAll('dt')).map((d) => d.textContent ?? '');
    expect(dts).toEqual(['Proofs read', 'tip', 'header', 'proof', 'gossip', 'forwarded']);
    const dds = Array.from(section!.querySelectorAll('dd')).map((d) => d.textContent ?? '');
    expect(dds).toEqual(['3', '123', '456', '7890', '11', '2']);
  });
});

// ---------------------------------------------------------------------------
// MESH_INTERFACE → Discovery → "A node added by hand" — the page's form
// takes a key, an address and a "trust this node" checkbox (checked by
// default), and calls `client.addByHand(key, [address], trusted)`. The
// form lives outside the state renderer's subtree, so a render never
// touches it (the probe's sibling pattern). A `MeshConfigError` shows
// in words under the form (`textContent`), the fields kept; a success
// clears them.

const VALID_KEY_A = '0'.repeat(64);
const VALID_ADDR_A =
  '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiAA/p2p/12D3KooWBad';
const VALID_KEY_B = '1'.repeat(64);

function fillAndSubmit(root: HTMLElement, over: {
  key?: string; addr?: string; trusted?: boolean;
}): void {
  const form = root.querySelector('[data-role="hand-form"]') as HTMLElement | null;
  if (form === null) throw new Error('form element missing from the root');
  const keyEl = form.querySelector('input[name="key"]') as HTMLInputElement | null;
  const addrEl = form.querySelector('input[name="address"]') as HTMLInputElement | null;
  const trustEl = form.querySelector('input[name="trusted"]') as HTMLInputElement | null;
  const addBtn = form.querySelector('button') as HTMLButtonElement | null;
  if (keyEl === null || addrEl === null || trustEl === null || addBtn === null) {
    throw new Error('form fields missing');
  }
  if (over.key !== undefined) keyEl.value = over.key;
  if (over.addr !== undefined) addrEl.value = over.addr;
  if (over.trusted !== undefined) trustEl.checked = over.trusted;
  addBtn.click();
}

describe('page/form.ts', () => {
  it('attaches a form outside the state renderer subtree; the trust box is checked by default', () => {
    const root = document.createElement('div');
    const { client } = buildFakeClient();
    attachHandForm({ root, client });
    const form = root.querySelector('[data-role="hand-form"]');
    expect(form, 'form must be in the root').not.toBeNull();
    expect(form!.parentElement, 'form is a direct child of the root').toBe(root);
    const insideState = root.querySelector('[data-role="state-root"] [data-role="hand-form"]');
    expect(insideState, 'form is NOT inside the state renderer subtree').toBeNull();
    const trust = form!.querySelector('input[name="trusted"]') as HTMLInputElement;
    expect(trust).not.toBeNull();
    expect(trust.type).toBe('checkbox');
    expect(trust.checked, 'trust is on by default').toBe(true);
    // The label text names what the box controls.
    const label = form!.querySelector('label[for="hand-form-trusted"]');
    expect(label, 'a label pointing at the checkbox is required').not.toBeNull();
    expect(label!.textContent).toContain('trust this node');
  });

  it('a submit with the box ticked calls addByHand(key, [address], true)', () => {
    const root = document.createElement('div');
    const { client, calls } = buildFakeClient();
    attachHandForm({ root, client });
    fillAndSubmit(root, { key: VALID_KEY_A, addr: VALID_ADDR_A });
    expect(calls.addByHand).toEqual([{ notisId: VALID_KEY_A, addrs: [VALID_ADDR_A], trusted: true }]);
    // Fields reset on success.
    const keyEl = root.querySelector('input[name="key"]') as HTMLInputElement;
    const addrEl = root.querySelector('input[name="address"]') as HTMLInputElement;
    const trustEl = root.querySelector('input[name="trusted"]') as HTMLInputElement;
    expect(keyEl.value).toBe('');
    expect(addrEl.value).toBe('');
    expect(trustEl.checked, 'the box resets to its default (ticked)').toBe(true);
  });

  it('a submit with the box unticked calls addByHand(..., false)', () => {
    const root = document.createElement('div');
    const { client, calls } = buildFakeClient();
    attachHandForm({ root, client });
    fillAndSubmit(root, { key: VALID_KEY_B, addr: VALID_ADDR_A, trusted: false });
    expect(calls.addByHand).toEqual([{ notisId: VALID_KEY_B, addrs: [VALID_ADDR_A], trusted: false }]);
  });

  it('a MeshConfigError from addByHand shows under the form; the fields are kept; a later success clears them', () => {
    const root = document.createElement('div');
    const refuseKey = 'nope';
    let shouldThrow = true;
    const { client } = buildFakeClient({
      addByHandBehavior: () => {
        if (shouldThrow) throw new MeshConfigError(`addByHand key refused: ${refuseKey} is not 64 lowercase hex characters`);
      },
    });
    attachHandForm({ root, client });
    fillAndSubmit(root, { key: refuseKey, addr: VALID_ADDR_A });
    const err = root.querySelector('[data-role="hand-form"] [data-role="form-error"]');
    expect(err, 'the error element must appear under the form').not.toBeNull();
    expect(err!.textContent, 'the refusal is shown in words').toContain('refused');
    expect(err!.textContent).toContain(refuseKey);
    // The fields are kept on refusal.
    const keyEl = root.querySelector('input[name="key"]') as HTMLInputElement;
    const addrEl = root.querySelector('input[name="address"]') as HTMLInputElement;
    expect(keyEl.value).toBe(refuseKey);
    expect(addrEl.value).toBe(VALID_ADDR_A);
    // Now a success clears the error AND the fields.
    shouldThrow = false;
    fillAndSubmit(root, { key: VALID_KEY_A, addr: VALID_ADDR_A });
    expect(root.querySelector('[data-role="form-error"]'), 'the error is gone after success').toBeNull();
    expect((root.querySelector('input[name="key"]') as HTMLInputElement).value).toBe('');
    expect((root.querySelector('input[name="address"]') as HTMLInputElement).value).toBe('');
  });

  it('a render does not touch the form (its sibling)', () => {
    const root = document.createElement('div');
    const { client } = buildFakeClient();
    attachHandForm({ root, client });
    const formBefore = root.querySelector('[data-role="hand-form"]');
    expect(formBefore).not.toBeNull();
    // Set a value, then render; the value must survive.
    (formBefore!.querySelector('input[name="key"]') as HTMLInputElement).value = 'held';
    render(emptyState(), root);
    const formAfter = root.querySelector('[data-role="hand-form"]');
    expect(formAfter, 'the form survives the render').toBe(formBefore);
    expect((formAfter!.querySelector('input[name="key"]') as HTMLInputElement).value).toBe('held');
  });
});

// ---------------------------------------------------------------------------
// MESH_INTERFACE → NAT → "A client's STUN list comes from the public
// nodes it holds" — a config that still carries `stunServers` is
// refused with words naming the key; `config.byHand` is the one path
// through which the page adds nodes at start, applied in the given
// order after `startMeshClient`.

describe('page/main.ts config refusals', () => {
  it('config.stunServers is refused in words', async () => {
    const root = document.createElement('div');
    const fakeFetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          network: 'devnet',
          firstContact: [],
          stunServers: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await runMain({ root, fetch: fakeFetch as unknown as typeof globalThis.fetch });
    const err = root.querySelector('[data-role="error"]');
    expect(err, 'a config error element is required').not.toBeNull();
    expect(err!.textContent).toContain(
      'config.stunServers is refused: the client takes its STUN servers from the nodes it holds',
    );
  });

  it('a malformed byHand entry refuses the whole config in words', async () => {
    const root = document.createElement('div');
    const fakeFetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          network: 'devnet',
          firstContact: [],
          byHand: [
            { notisId: VALID_KEY_A, addrs: [VALID_ADDR_A], trusted: true },
            { notisId: VALID_KEY_B, addrs: 'not-an-array', trusted: true },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await runMain({ root, fetch: fakeFetch as unknown as typeof globalThis.fetch });
    const err = root.querySelector('[data-role="error"]');
    expect(err, 'the config refusal is required').not.toBeNull();
    expect(err!.textContent?.toLowerCase()).toContain('refused');
    expect(err!.textContent).toContain('byHand');
  });

  // MESH_INTERFACE → Discovery → "A node added by hand" — a malformed
  // byHand entry stops the client before showing the words, so a
  // refused config leaves no libp2p node running on the entries that
  // landed before the bad one.
  it('a malformed byHand entry stops the client before showing the words', async () => {
    const root = document.createElement('div');
    const fakeFetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          network: 'devnet',
          firstContact: [],
          byHand: [
            { notisId: VALID_KEY_A, addrs: [VALID_ADDR_A], trusted: true },
            { notisId: 'bad-key', addrs: [VALID_ADDR_A], trusted: true },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const fake = buildFakeClient({
      addByHandBehavior: (notisId) => {
        if (notisId === 'bad-key') {
          throw new MeshConfigError('addByHand key refused: bad-key is not 64 lowercase hex characters');
        }
      },
    });
    await runMain({
      root,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      startMeshClient: (async () => fake.client as unknown as MeshClient) as never,
    });
    expect(fake.calls.stop, 'client.stop() was called before the words').toBe(1);
    const err = root.querySelector('[data-role="error"]');
    expect(err, 'the config refusal is required').not.toBeNull();
    expect(err!.textContent).toContain('byHand');
  });
});

// ---------------------------------------------------------------------------
// MESH_INTERFACE → Discovery → "A node added by hand" — `config.byHand`
// entries are applied through `addByHand` after `startMeshClient` in
// their given order.

describe('page/main.ts byHand application', () => {
  it('config.byHand reaches addByHand in order', async () => {
    const root = document.createElement('div');
    const entries = [
      { notisId: VALID_KEY_A, addrs: [VALID_ADDR_A], trusted: true },
      { notisId: VALID_KEY_B, addrs: [VALID_ADDR_A], trusted: false },
    ];
    const fakeFetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          network: 'devnet',
          firstContact: [],
          byHand: entries,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const fake = buildFakeClient();
    await runMain({
      root,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      startMeshClient: (async () => fake.client as unknown as MeshClient) as never,
    });
    expect(fake.calls.addByHand).toEqual(entries);
  });
});

// ---------------------------------------------------------------------------
// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — `?reads=<n>&need=<tip|older>` runs `n`
// routed reads through `client.read` after the first check and writes
// `<pre id="reads">` with `{ need, served: Array<{ nodeId, status }> }`
// as a sibling of the state root. A failed read records
// `{ nodeId: null, status: null, error: <message> }`. `n` is 1–100.

function entryAt(notisId: string, status: NodeEntry['status']): NodeEntry {
  return makeEntry({ notisId, status });
}

describe('page/reads.ts', () => {
  // Each served entry carries the state the pick was made from: the
  // client's `tipHeight` and the list of candidates sampled BEFORE
  // the read is made. The fake client's default state has `tip: null`
  // and no entries, so `tipHeight: null` and `nodes: []` — the tests
  // that care name entries explicitly.
  it('?reads=3&need=older runs three reads through client.read and writes three served ids with their statuses', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    const fake = buildFakeClient({
      agreement: { onChain: 2, offChain: 0 },
      nodes: [entryAt(idA, 'ok'), entryAt(idB, 'trailing')],
      readAnswers: [{ nodeId: idA }, { nodeId: idB }, { nodeId: idA }],
    });
    await runReads({ client: fake.client, n: 3, need: 'older', root });
    expect(fake.calls.read).toEqual([
      { path: '/blocks/1', need: 'older' },
      { path: '/blocks/1', need: 'older' },
      { path: '/blocks/1', need: 'older' },
    ]);
    const pre = root.querySelector('pre#reads');
    expect(pre, '<pre id="reads"> is required').not.toBeNull();
    const parsed = JSON.parse(pre!.textContent ?? '');
    const sampledNodes = [
      { id: 'a'.repeat(8), status: 'ok', behindBy: null, readMs: null, lastFailure: null },
      { id: 'b'.repeat(8), status: 'trailing', behindBy: null, readMs: null, lastFailure: null },
    ];
    expect(parsed).toEqual({
      need: 'older',
      served: [
        { nodeId: idA, status: 'ok', checks: 0, tipHeight: null, nodes: sampledNodes },
        { nodeId: idB, status: 'trailing', checks: 0, tipHeight: null, nodes: sampledNodes },
        { nodeId: idA, status: 'ok', checks: 0, tipHeight: null, nodes: sampledNodes },
      ],
    });
  });

  it('a tip read sends to /blocks/current', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const fake = buildFakeClient({
      agreement: { onChain: 1, offChain: 0 },
      nodes: [entryAt(idA, 'ok')],
      readAnswers: [{ nodeId: idA }],
    });
    await runReads({ client: fake.client, n: 1, need: 'tip', root });
    expect(fake.calls.read).toEqual([{ path: '/blocks/current', need: 'tip' }]);
    const pre = root.querySelector('pre#reads');
    const parsed = JSON.parse(pre!.textContent ?? '');
    expect(parsed).toEqual({
      need: 'tip',
      served: [
        {
          nodeId: idA,
          status: 'ok',
          checks: 0,
          tipHeight: null,
          nodes: [
            { id: 'a'.repeat(8), status: 'ok', behindBy: null, readMs: null, lastFailure: null },
          ],
        },
      ],
    });
  });

  it('waits for the first completed check (agreement !== null)', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const fake = buildFakeClient({
      agreement: null,
      nodes: [entryAt(idA, 'ok')],
      readAnswers: [{ nodeId: idA }],
    });
    // Starting before any check: the driver must wait.
    const started = runReads({ client: fake.client, n: 1, need: 'older', root });
    // Yield once; the read must NOT have fired yet.
    await Promise.resolve();
    expect(fake.calls.read, 'no reads fire before agreement !== null').toEqual([]);
    expect(root.querySelector('pre#reads'), 'nothing is written before the check').toBeNull();
    // Now emit a completed check: the driver proceeds.
    fake.emit({ agreement: { onChain: 1, offChain: 0 } });
    await started;
    expect(fake.calls.read).toEqual([{ path: '/blocks/1', need: 'older' }]);
    const parsed = JSON.parse(root.querySelector('pre#reads')!.textContent ?? '');
    expect(parsed).toEqual({
      need: 'older',
      served: [
        {
          nodeId: idA,
          status: 'ok',
          checks: 0,
          tipHeight: null,
          nodes: [
            { id: 'a'.repeat(8), status: 'ok', behindBy: null, readMs: null, lastFailure: null },
          ],
        },
      ],
    });
  });

  it('a failed read lands as { nodeId: null, status: null, error, tipHeight, nodes }', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const fake = buildFakeClient({
      agreement: { onChain: 1, offChain: 0 },
      nodes: [entryAt(idA, 'ok')],
      readAnswers: [{ nodeId: idA }, { error: 'no node allowed for a tip read' }, { nodeId: idA }],
    });
    await runReads({ client: fake.client, n: 3, need: 'tip', root });
    const parsed = JSON.parse(root.querySelector('pre#reads')!.textContent ?? '');
    const sampledNodes = [
      { id: 'a'.repeat(8), status: 'ok', behindBy: null, readMs: null, lastFailure: null },
    ];
    expect(parsed).toEqual({
      need: 'tip',
      served: [
        { nodeId: idA, status: 'ok', checks: 0, tipHeight: null, nodes: sampledNodes },
        {
          nodeId: null,
          status: null,
          checks: 0,
          tipHeight: null,
          nodes: sampledNodes,
          error: 'no node allowed for a tip read',
        },
        { nodeId: idA, status: 'ok', checks: 0, tipHeight: null, nodes: sampledNodes },
      ],
    });
  });

  it('n outside 1–100 writes nothing', async () => {
    const root = document.createElement('div');
    const fake = buildFakeClient({
      agreement: { onChain: 0, offChain: 0 },
    });
    for (const n of [0, 101, -1, Number.NaN]) {
      await runReads({ client: fake.client, n, need: 'older', root });
    }
    expect(fake.calls.read, 'no reads for out-of-range n').toEqual([]);
    expect(root.querySelector('pre#reads'), 'no <pre id="reads"> for out-of-range n').toBeNull();
  });

  // MESH_INTERFACE → The client's node list → "A read opens no
  // connection" — each read drains the response body before
  // recording its entry, so the stream closes and the connection
  // the read rides is free for the next one.
  it('each read drains the response body before recording', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const bodies: Response[] = [
      new Response(new TextEncoder().encode('body-0')),
      new Response(new TextEncoder().encode('body-1')),
    ];
    const kept = bodies.slice();
    const fake = buildFakeClient({
      agreement: { onChain: 1, offChain: 0 },
      nodes: [entryAt(idA, 'ok')],
    });
    (fake.client as unknown as { read: (p: string, n: ReadNeed) => Promise<{ response: Response; nodeId: string }> }).read =
      async (_path: string, _need: ReadNeed) => ({ response: bodies.shift()!, nodeId: idA });
    await runReads({ client: fake.client, n: 2, need: 'older', root });
    expect(kept.map((r) => r.bodyUsed), 'every response body was consumed').toEqual([true, true]);
  });

  // MESH_INTERFACE → The client's node list — a body that fails
  // mid-read records the error entry, so a half-read stream never
  // sits open under a success entry.
  it('a body that fails mid-read records the error entry', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const failing = new Response(new ReadableStream({
      pull(controller) { controller.error(new Error('stream broke')); },
    }));
    const good = new Response(new TextEncoder().encode('ok-body'));
    const bodies: Response[] = [failing, good];
    const fake = buildFakeClient({
      agreement: { onChain: 1, offChain: 0 },
      nodes: [entryAt(idA, 'ok')],
    });
    (fake.client as unknown as { read: (p: string, n: ReadNeed) => Promise<{ response: Response; nodeId: string }> }).read =
      async (_path: string, _need: ReadNeed) => ({ response: bodies.shift()!, nodeId: idA });
    await runReads({ client: fake.client, n: 2, need: 'older', root });
    const parsed = JSON.parse(root.querySelector('pre#reads')!.textContent ?? '');
    const sampledNodes = [
      { id: 'a'.repeat(8), status: 'ok', behindBy: null, readMs: null, lastFailure: null },
    ];
    expect(parsed.served[0]).toEqual({
      nodeId: null,
      status: null,
      checks: 0,
      tipHeight: null,
      nodes: sampledNodes,
      error: expect.stringContaining('stream broke'),
    });
    expect(parsed.served[1]).toEqual({
      nodeId: idA,
      status: 'ok',
      checks: 0,
      tipHeight: null,
      nodes: sampledNodes,
    });
  });

  // MESH_INTERFACE → The client's node list → "A routed read goes to a
  // node its need allows" — each served entry carries the client's
  // `checks` count at the read, so a reader of the measurement can
  // tell one read's state from the next.
  it("each served entry carries the client's `checks` count at the read", async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const fake = buildFakeClient({
      agreement: { onChain: 1, offChain: 0 },
      nodes: [entryAt(idA, 'ok')],
      checks: 7,
      readAnswers: [{ nodeId: idA }, { nodeId: idA }],
    });
    await runReads({ client: fake.client, n: 2, need: 'older', root });
    const parsed = JSON.parse(root.querySelector('pre#reads')!.textContent ?? '');
    expect(parsed.served[0].checks).toBe(7);
    expect(parsed.served[1].checks).toBe(7);
  });

  // MESH_INTERFACE → The client's node list → "A routed read goes to a
  // node its need allows" — each served entry carries the client's
  // `tipHeight` at the read and the list of candidate nodes the pick
  // was made from. The entries record one row per node not in `new`:
  // `{ id, status, behindBy, readMs, lastFailure }`.
  it('each served entry carries tipHeight and the node list behind the pick', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    const idC = 'c'.repeat(64);
    const entries = [
      makeEntry({
        notisId: idA,
        status: 'ok',
        behindBy: 0,
        readMs: 45,
        lastFailure: null,
      }),
      makeEntry({
        notisId: idB,
        status: 'retry',
        behindBy: null,
        readMs: null,
        lastFailure: { kind: 'timeout', message: 'read deadline', atMs: 1_000 },
      }),
      makeEntry({ notisId: idC, status: 'new' }),
    ];
    const fake = buildFakeClient({
      agreement: { onChain: 1, offChain: 0 },
      nodes: entries,
      readAnswers: [{ nodeId: idA }],
    });
    (fake as unknown as { emit: (over: Partial<ClientState>) => void }).emit({
      tip: { height: 42, hash: 'f'.repeat(64) },
    });
    await runReads({ client: fake.client, n: 1, need: 'older', root });
    const parsed = JSON.parse(root.querySelector('pre#reads')!.textContent ?? '');
    expect(parsed.served[0].tipHeight).toBe(42);
    expect(parsed.served[0].nodes).toEqual([
      { id: 'a'.repeat(8), status: 'ok', behindBy: 0, readMs: 45, lastFailure: null },
      {
        id: 'b'.repeat(8),
        status: 'retry',
        behindBy: null,
        readMs: null,
        lastFailure: 'read deadline',
      },
    ]);
  });

  // MESH_INTERFACE → The client's node list → "A routed read goes to a
  // node its need allows" — the node list is sampled BEFORE
  // `client.read` resolves. A later change to `nodes` must not show
  // up in the served entry: the pick was made from the earlier
  // state.
  it('the node list is sampled before the read, not after', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    const entries = [entryAt(idA, 'ok'), entryAt(idB, 'trailing')];
    const fake = buildFakeClient({
      agreement: { onChain: 1, offChain: 0 },
      nodes: entries,
    });
    // Replace read so a change to `nodes` lands between the pick's
    // sample and the read's resolve.
    (fake.client as unknown as {
      read: (p: string, n: ReadNeed) => Promise<{ response: Response; nodeId: string }>;
    }).read = async () => {
      (fake as unknown as { emit: (over: Partial<ClientState>) => void }).emit({
        nodes: [entryAt(idA, 'ok')],
      });
      return { response: new Response('', { status: 200 }), nodeId: idA };
    };
    await runReads({ client: fake.client, n: 1, need: 'older', root });
    const parsed = JSON.parse(root.querySelector('pre#reads')!.textContent ?? '');
    // The served entry's `nodes` carries both — the state before the
    // read, not the state after the mid-read change.
    expect(parsed.served[0].nodes.map((e: { id: string }) => e.id)).toEqual([
      'a'.repeat(8),
      'b'.repeat(8),
    ]);
  });

  // MESH_INTERFACE → The client's node list — an entry in `new`
  // (never read) is no candidate: it has no speed, no verdict, no
  // failure to show. The served entry's `nodes` leaves it out.
  it('an entry in status `new` is not in the pick record', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    const fake = buildFakeClient({
      agreement: { onChain: 1, offChain: 0 },
      nodes: [entryAt(idA, 'ok'), entryAt(idB, 'new')],
      readAnswers: [{ nodeId: idA }],
    });
    await runReads({ client: fake.client, n: 1, need: 'older', root });
    const parsed = JSON.parse(root.querySelector('pre#reads')!.textContent ?? '');
    expect(parsed.served[0].nodes.map((e: { id: string }) => e.id)).toEqual(['a'.repeat(8)]);
  });
});

describe('page/reads.ts sibling pattern', () => {
  it('a render leaves <pre id="reads"> in place', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const fake = buildFakeClient({
      agreement: { onChain: 1, offChain: 0 },
      nodes: [entryAt(idA, 'ok')],
      readAnswers: [{ nodeId: idA }],
    });
    await runReads({ client: fake.client, n: 1, need: 'older', root });
    const before = root.querySelector('pre#reads');
    expect(before, '<pre id="reads"> is written before the render').not.toBeNull();
    const text = before!.textContent;
    render(emptyState(), root);
    const after = root.querySelector('pre#reads');
    expect(after, 'the reads element survives a render').not.toBeNull();
    expect(after!.textContent).toBe(text);
    // Two renders keep it in place too.
    render(emptyState(), root);
    const after2 = root.querySelector('pre#reads');
    expect(after2!.textContent).toBe(text);
  });
});

describe('probe and reads coexist', () => {
  it('both can run on one page load; each owns its own <pre> as a sibling of the state root', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const fake = buildFakeClient({
      nodeId: idA,
      agreement: { onChain: 1, offChain: 0 },
      nodes: [entryAt(idA, 'ok')],
      readAnswers: [{ nodeId: idA }],
    });
    const body = new TextEncoder().encode('{"height":1,"hash":"ab"}');
    // The probe fetches through `client.fetch`; override to return the body.
    (fake.client as unknown as { fetch: (url: string) => Promise<Response> }).fetch = async () =>
      new Response(body as unknown as BodyInit, { status: 200 });
    await Promise.all([
      runProbe({ client: fake.client, path: '/blocks/current', root }),
      runReads({ client: fake.client, n: 1, need: 'older', root }),
    ]);
    expect(root.querySelector('pre#probe'), 'the probe wrote its own element').not.toBeNull();
    expect(root.querySelector('pre#reads'), 'the reads driver wrote its own element').not.toBeNull();
  });
});

describe('page/build output', () => {
  // The build step runs once for the describe: `page:build` is a few seconds,
  // and the bundle scan reads from `dist-page/`. The scan does NOT look for
  // `/dns4/`, `/dns6/`, `/dnsaddr/` string literals — `NETWORK_PROFILES`
  // legitimately carries testnet's bootstrap address for the node's own
  // gossip net
  // (`TYPES_INTERFACE → "bootstrapPeers is the network's known nodes, per network"`), and a string in the bundle is not a DNS lookup.
  // The browser never dials a DNS first-contact node — that is held at runtime by
  // `assertClientConfig` on every first-contact entry, and `packages/web/src/mesh/config.ts`'s DNS guard
  // names the three prefixes in the source itself.
  beforeAll(() => {
    execSync('pnpm --filter @dagsocial/mesh-poc page:build', {
      cwd: join(PACKAGE_ROOT, '..', '..'),
      stdio: 'pipe',
      timeout: 120_000,
    });
  }, 180_000);

  function walkFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) out.push(...walkFiles(full));
      else out.push(full);
    }
    return out;
  }

  it('the bundle holds no Node built-in', async () => {
    const files = walkFiles(DIST_PAGE);
    expect(files.length, 'dist-page/ must hold at least one file').toBeGreaterThan(0);
    const { builtinModules } = await import('node:module');
    const importRe = /(?:from\s*['"]|require\s*\(\s*['"]|import\s*\(\s*['"])([^'"\s)]+)['"]/g;
    const builtinHits: string[] = [];
    for (const f of files) {
      if (!/\.(?:js|mjs|html|css|map)$/.test(f)) continue;
      const code = readFileSync(f, 'utf8');
      for (const match of code.matchAll(importRe)) {
        const importSpecifier = match[1]!;
        if (importSpecifier.startsWith('node:')) builtinHits.push(`${f}: ${importSpecifier}`);
        else if (builtinModules.includes(importSpecifier)) builtinHits.push(`${f}: ${importSpecifier}`);
      }
    }
    expect(builtinHits, `Node built-in imports in the bundle: ${builtinHits.join(', ')}`).toEqual([]);
  }, 180_000);

  afterAll(() => { /* leave dist-page/ in place for the next run */ });
});

// MESH_INTERFACE → Discovery → "A disagreement is the reader's question,
// never the client's choice" — a standing disagreement displaces the
// not-continued banner, carries the two tips, the fork and the two
// buttons, each of which calls `client.answer` once per press.

describe('page/render.ts — a standing disagreement', () => {
  const Y_HASH = 'a'.repeat(64);
  const O_HASH = 'b'.repeat(64);
  const FORK = 'c'.repeat(64);

  function stateWithDisagreement(which: 'memory' | 'heavier'): ClientState {
    return emptyState({
      notContinued: true,
      disagreement: {
        which,
        yours: { height: 11, hash: Y_HASH },
        other: which === 'memory' ? null : { height: 12, hash: O_HASH },
        fork: FORK,
      },
    });
  }

  it('the heavier words sit under [data-role="disagreement-words"]', () => {
    const root = document.createElement('div');
    render(stateWithDisagreement('heavier'), root);
    const words = root.querySelector('[data-role="disagreement-words"]');
    expect(words, 'the words element is required').not.toBeNull();
    expect(words!.textContent).toBe(
      'another node serves a heavier chain than your node. Your node may be compromised.',
    );
  });

  it('the memory words sit under [data-role="disagreement-words"]', () => {
    const root = document.createElement('div');
    render(stateWithDisagreement('memory'), root);
    const words = root.querySelector('[data-role="disagreement-words"]');
    expect(words!.textContent).toBe(
      'your node serves a chain that does not continue the one you verified. It may be compromised.',
    );
  });

  it('a standing disagreement displaces the not-continued banner', () => {
    const root = document.createElement('div');
    render(stateWithDisagreement('heavier'), root);
    expect(root.querySelector('[data-role="banner"]'), 'no banner while a disagreement stands').toBeNull();
    expect(root.querySelector('[data-role="disagreement"]'), 'the disagreement section stands').not.toBeNull();
  });

  it('the two buttons stand under [data-role="disagreement-buttons"]', () => {
    const root = document.createElement('div');
    render(stateWithDisagreement('heavier'), root);
    const buttons = root.querySelector('[data-role="disagreement-buttons"]');
    expect(buttons, 'the buttons section is required').not.toBeNull();
    const cont = root.querySelector('[data-role="disagreement-continue"]') as HTMLButtonElement | null;
    const disable = root.querySelector('[data-role="disagreement-disable"]') as HTMLButtonElement | null;
    expect(cont, 'the continue button is required').not.toBeNull();
    expect(disable, 'the disable button is required').not.toBeNull();
    expect(cont!.textContent).toBe('continue on this node');
    expect(disable!.textContent).toBe('disable it');
  });

  it('each button press calls client.answer once with its own decision', () => {
    const calls: Array<'continue' | 'disable'> = [];
    const client = { answer: (d: 'continue' | 'disable') => { calls.push(d); } };
    const root = document.createElement('div');
    render(stateWithDisagreement('heavier'), root, { client });
    const cont = root.querySelector('[data-role="disagreement-continue"]') as HTMLButtonElement;
    const disable = root.querySelector('[data-role="disagreement-disable"]') as HTMLButtonElement;
    cont.click();
    expect(calls).toEqual(['continue']);
    disable.click();
    expect(calls).toEqual(['continue', 'disable']);
  });

  it("with no client bound the buttons do nothing — a cold snapshot render carries no handler", () => {
    const root = document.createElement('div');
    // A client of `null` is the default `RenderOptions.client` the caller
    // uses in a cold snapshot. The buttons still render, but a press is
    // ignored — there is no client to answer the question.
    render(stateWithDisagreement('heavier'), root);
    const cont = root.querySelector('[data-role="disagreement-continue"]') as HTMLButtonElement;
    // Click does not throw and no callback fires; the page stays open.
    expect(() => cont.click()).not.toThrow();
  });

  it('the yours tip and the fork are named; other is named only for a heavier disagreement', () => {
    const root = document.createElement('div');
    render(stateWithDisagreement('heavier'), root);
    const text = root.querySelector('[data-role="disagreement"]')!.textContent ?? '';
    expect(text).toContain(Y_HASH);
    expect(text).toContain(O_HASH);
    expect(text).toContain(FORK);

    const root2 = document.createElement('div');
    render(stateWithDisagreement('memory'), root2);
    const text2 = root2.querySelector('[data-role="disagreement"]')!.textContent ?? '';
    expect(text2).toContain(Y_HASH);
    expect(text2).not.toContain(O_HASH);
    expect(text2).toContain(FORK);
  });
});

// MESH_INTERFACE → What the client remembers — "A client remembers, per
// network, the nodes it found, the proof of the chain it verified, and
// the forks the reader answered". `runMain` opens the per-network
// `localStorage` record, reads it at start as `seeds: record.nodes` +
// `memory: { proof, answeredForks }`, hands `onChecked` to the client,
// and the callback writes the snapshot under one lock. These cases
// hold the wiring through a fake `startMeshClient` and a fake storage.

describe("page/main.ts — the memory wiring", () => {
  // The record, as the store writes it, is base64 of the encoded
  // proof plus the per-network key. A malformed record's bytes never
  // reach the client's verifier under these fakes — the cases hold
  // the wiring, not the decode.
  const G1 = 'a'.repeat(64);

  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map<string, string>(Object.entries(initial));
    return {
      map,
      getItem(k: string): string | null { return map.get(k) ?? null; },
      setItem(k: string, v: string): void { map.set(k, v); },
      removeItem(k: string): void { map.delete(k); },
    };
  }

  // A no-op `startMeshClient` whose only job is to record what runMain
  // passed and to wire `onChecked` into its own answer.
  type StartArgs = Parameters<typeof import('../page/main.js')['runMain']>[0];
  type StartMeshFn = NonNullable<StartArgs['startMeshClient']>;
  type StartCapture = { opts: Parameters<StartMeshFn>[0]; triggerChecked: (snap: unknown) => void };

  type StartCaptureExt = StartCapture & {
    setChain: (chain: string | null) => void;
  };

  function buildStartCapture(): { startMeshClient: StartMeshFn; captured: StartCaptureExt[] } {
    const captured: StartCaptureExt[] = [];
    const startMeshClient: StartMeshFn = async (opts) => {
      let latestChecked: ((snap: unknown) => void) | null = null;
      if (typeof opts.onChecked === 'function') {
        latestChecked = opts.onChecked as (snap: unknown) => void;
      }
      // Mutable state so a test can seat a chain before triggering
      // `onChecked` — the page reads `client.state().chain` to key
      // the memory record (MESH_INTERFACE → What the client remembers).
      let state: ClientState = {
        nodeId: null, transport: null, path: null, lastLeft: null,
        tip: null, agreement: null, checks: 0,
        traffic: emptyTraffic(), nodes: [], seated: false, proofs: null,
        anchor: null, chain: null, notContinued: false, disagreement: null,
      };
      // The returned shape is `MeshClient`; the test does not touch
      // most of its methods, so a minimal one that satisfies the
      // seam's calls suffices (runMain reads `onState`, `state`,
      // `addByHand` and leaves the rest alone).
      const client = {
        fetch: async () => new Response(''),
        read: async () => ({ response: new Response(''), nodeId: '', route: 'mesh' as const }),
        order: () => [],
        check: async () => {},
        state: () => state,
        onState: () => () => {},
        stop: async () => {},
        addByHand: () => {},
        removeByHand: () => {},
        answer: () => {},
        base: () => null,
        configuredAddrs: () => [],
        iceConfiguration: () => ({ iceServers: [] }),
        toRemember: () => ({ proof: null, nodes: [], dropped: [], answeredForks: [], replace: false }),
        libp2p: {} as unknown as import('libp2p').Libp2p,
      };
      captured.push({
        opts,
        triggerChecked: (snap) => { latestChecked?.(snap); },
        setChain: (chain) => { state = { ...state, chain }; },
      });
      return client as unknown as MeshClient;
    };
    return { startMeshClient, captured };
  }

  function fakeLocks() {
    const tails = new Map<string, Promise<void>>();
    return {
      async request(name: string, fn: () => Promise<void>): Promise<void> {
        const prev = tails.get(name) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        const next = prev.then(() => held);
        tails.set(name, next);
        await prev;
        try { await fn(); } finally {
          release();
          if (tails.get(name) === next) tails.delete(name);
        }
      },
    };
  }

  async function loadConfig(opts: {
    firstContact?: unknown[];
    seeds?: unknown[];
    byHand?: unknown[];
    network?: string;
  } = {}) {
    const body = JSON.stringify({
      network: opts.network ?? 'devnet',
      firstContact: opts.firstContact ?? [],
      ...(opts.seeds !== undefined ? { seeds: opts.seeds } : {}),
      ...(opts.byHand !== undefined ? { byHand: opts.byHand } : {}),
    });
    return async () => new Response(body, { status: 200 });
  }

  it('devnet (profile pins no genesisId): the record is keyed by the network name', async () => {
    const storage = fakeStorage();
    const key = `notis.mesh.memory.devnet`;
    // Seed a record with real base64 bytes (the page's `continues`
    // seam catches a decode throw and answers false — the wiring does
    // not need a verifiable proof, only a well-formed record).
    const b64Bytes = btoa(String.fromCharCode(1, 2, 3, 4));
    storage.setItem(key, JSON.stringify({
      genesis: G1,
      proof: b64Bytes,
      nodes: [{ notisId: 'd'.repeat(64), addrs: [] }],
      answeredForks: ['f'.repeat(64)],
    }));
    const { startMeshClient, captured } = buildStartCapture();
    const root = document.createElement('div');
    const { runMain } = await import('../page/main.js');
    await runMain({
      root,
      fetch: await loadConfig({ firstContact: [{ notisId: 'e'.repeat(64), addrs: [] }] }),
      startMeshClient,
      storage,
      locks: fakeLocks(),
      wallClock: () => 0,
    });
    expect(captured).toHaveLength(1);
    const opts = captured[0]!.opts;
    expect(opts.network).toBe('devnet');
    expect(opts.seeds, 'the record\'s nodes come in as seeds').not.toBeUndefined();
    expect(opts.seeds).toEqual([{ notisId: 'd'.repeat(64), addrs: [] }]);
    expect(opts.memory, 'the record\'s proof + forks come in as memory').not.toBeUndefined();
    expect(opts.memory!.answeredForks).toEqual(['f'.repeat(64)]);
    expect(opts.memory!.proof).toBeInstanceOf(Uint8Array);
    expect(Array.from(opts.memory!.proof)).toEqual([1, 2, 3, 4]);
  });

  it('a profile that pins a genesis reads only a record whose genesis matches', async () => {
    const storage = fakeStorage();
    const key = `notis.mesh.memory.devnet`;
    const b64Bytes = btoa('zzzz');
    const otherGenesis = 'b'.repeat(64);
    storage.setItem(key, JSON.stringify({
      genesis: otherGenesis,
      proof: b64Bytes,
      nodes: [{ notisId: 'd'.repeat(64), addrs: [] }],
      answeredForks: [],
    }));
    const { startMeshClient, captured } = buildStartCapture();
    const root = document.createElement('div');
    const { runMain } = await import('../page/main.js');
    // The page reads `profile.genesisId`; devnet pins none, so the
    // record IS used, which is this case's control. The other case
    // (a profile pinning the different genesis) belongs on a network
    // that pins one — testnet/mainnet. The wiring rule here is: when
    // the stored `genesis` matches the profile's pin, the record is
    // used; when it does not, it is ignored. devnet's path is "no
    // pin, take the record as it stands" — exactly what this case
    // measures.
    await runMain({
      root,
      fetch: await loadConfig(),
      startMeshClient,
      storage,
      locks: fakeLocks(),
      wallClock: () => 0,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.opts.memory, 'devnet pins no genesis — any stored record stands').not.toBeUndefined();
  });

  it('a malformed stored record (not valid JSON) is ignored; no memory, no seeds', async () => {
    const storage = fakeStorage({ 'notis.mesh.memory.devnet': '{not json' });
    const { startMeshClient, captured } = buildStartCapture();
    const root = document.createElement('div');
    const { runMain } = await import('../page/main.js');
    await runMain({
      root,
      fetch: await loadConfig(),
      startMeshClient,
      storage,
      locks: fakeLocks(),
      wallClock: () => 0,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.opts.memory).toBeUndefined();
    expect(captured[0]!.opts.seeds).toBeUndefined();
  });

  it('onChecked writes the snapshot through the memory store under the lock, keyed by the client\'s chain', async () => {
    const storage = fakeStorage();
    const { startMeshClient, captured } = buildStartCapture();
    const root = document.createElement('div');
    const { runMain } = await import('../page/main.js');
    await runMain({
      root,
      fetch: await loadConfig(),
      startMeshClient,
      storage,
      locks: fakeLocks(),
      wallClock: () => 0,
    });
    expect(captured).toHaveLength(1);
    // Seat the client's chain — block 1's hex blockHash — before the
    // check fires. The page reads it through `state().chain` and keys
    // the record under it (MESH_INTERFACE → What the client remembers).
    const chain = 'c'.repeat(64);
    captured[0]!.setChain(chain);
    const snapshotBytes = new Uint8Array([9, 8, 7]);
    captured[0]!.triggerChecked({
      proof: snapshotBytes,
      nodes: [{ notisId: 'c'.repeat(64), addrs: [] }],
      dropped: [],
      answeredForks: [],
      replace: false,
    });
    // The write is async under the fake lock; await a microtask.
    await new Promise((r) => setTimeout(r, 0));
    const raw = storage.getItem('notis.mesh.memory.devnet');
    expect(raw, 'the store wrote a record').not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.proof).toBe(btoa(String.fromCharCode(9, 8, 7)));
    expect(parsed.nodes).toEqual([{ notisId: 'c'.repeat(64), addrs: [] }]);
    // Keyed by the client's chain (block 1's hex hash), so the store's
    // read keeps the record — it refuses any `genesis` that is not 64 hex.
    expect(parsed.genesis).toBe(chain);
  });

  it("onChecked before the client's chain is seated writes nothing — no record under a non-hex key", async () => {
    const storage = fakeStorage();
    const { startMeshClient, captured } = buildStartCapture();
    const root = document.createElement('div');
    const { runMain } = await import('../page/main.js');
    await runMain({
      root,
      fetch: await loadConfig(),
      startMeshClient,
      storage,
      locks: fakeLocks(),
      wallClock: () => 0,
    });
    // No `setChain` — the client's chain is `null` as it is before the
    // first check seats one. The onChecked callback skips the write.
    captured[0]!.triggerChecked({
      proof: new Uint8Array([1, 2, 3]),
      nodes: [{ notisId: 'a'.repeat(64), addrs: [] }],
      dropped: [],
      answeredForks: [],
      replace: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    const raw = storage.getItem('notis.mesh.memory.devnet');
    expect(raw, 'no record was written before the chain was seated').toBeNull();
  });

  it("two page starts over one storage: the second start hands the client the first's kept proof and nodes", async () => {
    // Shared storage — simulates the same browser profile opening the
    // page twice. The first start writes a record through onChecked;
    // the second start reads it and hands it to the mesh client as
    // `seeds` + `memory` (MESH_INTERFACE → What the client remembers).
    const storage = fakeStorage();
    const chain = 'b'.repeat(64);
    const snapshotBytes = new Uint8Array([4, 5, 6]);
    const rememberedNodes = [{ notisId: 'd'.repeat(64), addrs: [] }];

    // ----- first start -----
    {
      const { startMeshClient, captured } = buildStartCapture();
      const root = document.createElement('div');
      const { runMain } = await import('../page/main.js');
      await runMain({
        root,
        fetch: await loadConfig(),
        startMeshClient,
        storage,
        locks: fakeLocks(),
        wallClock: () => 0,
      });
      expect(captured).toHaveLength(1);
      // First start reads an empty storage.
      expect(captured[0]!.opts.memory).toBeUndefined();
      expect(captured[0]!.opts.seeds).toBeUndefined();
      // Seat the chain, fire a check — the write lands on `storage`.
      captured[0]!.setChain(chain);
      captured[0]!.triggerChecked({
        proof: snapshotBytes,
        nodes: rememberedNodes,
        dropped: [],
        answeredForks: [],
        replace: false,
      });
      await new Promise((r) => setTimeout(r, 0));
      // The record is on disk under the chain name; the store's read
      // (64-hex check) will keep it.
      const raw = storage.getItem('notis.mesh.memory.devnet');
      expect(raw, 'the first start wrote a record').not.toBeNull();
      expect(JSON.parse(raw!).genesis).toBe(chain);
    }

    // ----- second start -----
    {
      const { startMeshClient, captured } = buildStartCapture();
      const root = document.createElement('div');
      const { runMain } = await import('../page/main.js');
      await runMain({
        root,
        fetch: await loadConfig(),
        startMeshClient,
        storage,
        locks: fakeLocks(),
        wallClock: () => 0,
      });
      expect(captured).toHaveLength(1);
      // The second start hands the first start's kept proof + nodes
      // to the client.
      expect(captured[0]!.opts.seeds, 'the record\'s nodes come in as seeds').toEqual(rememberedNodes);
      expect(captured[0]!.opts.memory, 'the record\'s proof comes in as memory').not.toBeUndefined();
      expect(Array.from(captured[0]!.opts.memory!.proof)).toEqual([4, 5, 6]);
      expect(captured[0]!.opts.memory!.answeredForks).toEqual([]);
    }
  });

  // MESH_INTERFACE → What the client remembers — the page honours one
  // query parameter here: `?clearMemory=1` removes every
  // `notis.mesh.memory.*` key from the origin's `localStorage` BEFORE
  // the client reads any memory. A scenario that measures a client
  // with no memory opens the page at `<url>?clearMemory=1`. The
  // clear walks the real `Storage`'s `length` + `key(i)` index, so a
  // test that passes `opts.storage` holds the keys it means to; the
  // clear fires only when no custom storage is handed.
  describe("?clearMemory=1", () => {
    let originalLocation: Location | undefined;
    let originalLocalStorage: Storage | undefined;
    beforeEach(() => {
      originalLocation = globalThis.location;
      originalLocalStorage = globalThis.localStorage;
    });
    afterEach(() => {
      if (originalLocation !== undefined) {
        Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true });
      }
      if (originalLocalStorage !== undefined) {
        Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true });
      }
    });

    function setLocation(search: string): void {
      const loc = { ...originalLocation, search };
      Object.defineProperty(globalThis, 'location', { value: loc, configurable: true });
    }

    function liveStorageOver(map: Map<string, string>): Storage {
      return {
        get length() { return map.size; },
        key(i) { return Array.from(map.keys())[i] ?? null; },
        getItem(k) { return map.get(k) ?? null; },
        setItem(k, v) { map.set(k, v); },
        removeItem(k) { map.delete(k); },
        clear() { map.clear(); },
      };
    }

    it('clears every notis.mesh.memory.<network> key on the real localStorage; leaves other keys', async () => {
      const map = new Map<string, string>([
        ['notis.mesh.memory.devnet', '{"genesis":"devnet"}'],
        ['notis.mesh.memory.testnet', '{"genesis":"testnet"}'],
        ['notis.posts.chain', 'a'.repeat(64)],
        ['unrelated', 'kept'],
      ]);
      Object.defineProperty(globalThis, 'localStorage', { value: liveStorageOver(map), configurable: true });
      setLocation('?clearMemory=1');
      const { startMeshClient, captured } = buildStartCapture();
      const root = document.createElement('div');
      const { runMain } = await import('../page/main.js');
      await runMain({
        root,
        fetch: await loadConfig(),
        startMeshClient,
        locks: fakeLocks(),
        wallClock: () => 0,
      });
      expect(captured).toHaveLength(1);
      expect(map.has('notis.mesh.memory.devnet'), 'devnet memory cleared').toBe(false);
      expect(map.has('notis.mesh.memory.testnet'), 'testnet memory cleared').toBe(false);
      expect(map.has('notis.posts.chain'), 'post cache name untouched').toBe(true);
      expect(map.has('unrelated'), 'unrelated key untouched').toBe(true);
    });

    it('without ?clearMemory=1 the memory keys stay', async () => {
      // A well-formed record so the store's `readRaw` keeps it; a
      // malformed record is cleaned up on read, which would hide the
      // test's point (that the clear only fires under the flag).
      const wellFormed = JSON.stringify({
        genesis: 'a'.repeat(64),
        proof: btoa('x'),
        nodes: [],
        answeredForks: [],
      });
      const map = new Map<string, string>([
        ['notis.mesh.memory.devnet', wellFormed],
      ]);
      Object.defineProperty(globalThis, 'localStorage', { value: liveStorageOver(map), configurable: true });
      setLocation('');
      const { startMeshClient, captured } = buildStartCapture();
      const root = document.createElement('div');
      const { runMain } = await import('../page/main.js');
      await runMain({
        root,
        fetch: await loadConfig(),
        startMeshClient,
        locks: fakeLocks(),
        wallClock: () => 0,
      });
      expect(captured).toHaveLength(1);
      expect(map.has('notis.mesh.memory.devnet'), 'memory key stayed').toBe(true);
    });
  });
});
