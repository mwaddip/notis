// @vitest-environment happy-dom
// MESH_INTERFACE → No anchor reached / The client's node list / Discovery —
// the page's banner words, the state element, the hostile-text rule, the
// config refusal path, and the bundle scan (no Node built-in). Each case
// holds one guard the page keeps.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ClientState, MeshClient } from '../src/client/mesh-client.js';
import type { NodeEntry } from '../src/client/node-list.js';
import type { ReadNeed } from '../src/client/server-pick.js';
import { MeshConfigError } from '../src/config.js';
import { MeshFetchError } from '../src/http-fetch.js';
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
    anchor: over.anchor ?? false,
    byHand: over.byHand ?? false,
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
  };
}

function emptyState(over: Partial<ClientState> = {}): ClientState {
  return {
    nodeId: over.nodeId ?? null,
    transport: over.transport ?? null,
    path: over.path ?? null,
    lastLeft: over.lastLeft ?? null,
    anchorReached: over.anchorReached ?? false,
    tip: over.tip ?? null,
    agreement: over.agreement ?? null,
    nodes: over.nodes ?? [],
  };
}

describe('page/render.ts', () => {
  it('the no-anchor words are the contract\'s', () => {
    const root = document.createElement('div');
    render(emptyState({ anchorReached: false }), root);
    const banner = root.querySelector('[data-role="banner"]');
    expect(banner, 'the banner must appear while anchorReached is false').not.toBeNull();
    expect(banner!.textContent).toBe('No anchor reached. Nothing shown here is verified.');

    const root2 = document.createElement('div');
    render(emptyState({ anchorReached: true }), root2);
    expect(root2.querySelector('[data-role="banner"]')).toBeNull();
  });

  it('the state element holds the state', () => {
    const root = document.createElement('div');
    const state = emptyState({
      nodeId: 'aa'.repeat(32),
      transport: 'webrtc-direct',
      path: 'direct',
      anchorReached: true,
      tip: { height: 42, hash: 'bb'.repeat(32) },
      nodes: [makeEntry({ notisId: 'aa'.repeat(32), anchor: true, status: 'ok' })],
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
        notisId: 'aa'.repeat(32), anchor: true, status: 'ok',
        transport: 'webrtc-direct', path: 'direct',
      }),
      makeEntry({
        notisId: 'bb'.repeat(32), status: 'behind',
        transport: 'webrtc', path: 'direct',
      }),
      makeEntry({ notisId: 'cc'.repeat(32), status: 'retry' }),
    ];
    render(emptyState({ anchorReached: true, nodes }), root);
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
    render(emptyState({ anchorReached: true, nodes: [hostile] }), root);
    expect(root.querySelector('img'), 'no img may be built from the hostile string').toBeNull();
    expect(root.innerHTML.includes('<img'), 'the hostile string must not have become a tag').toBe(false);
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a refused config is shown', async () => {
    // Real `startMeshClient` through `runMain`: a /dns4/ anchor runs through
    // `assertClientConfig` (`startMeshClient`'s first statement) and throws
    // `MeshConfigError` before any libp2p node is created. The "no node is
    // created" property is held by `mesh-client.test.ts`'s own case.
    const root = document.createElement('div');
    const fakeFetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          network: 'devnet',
          anchors: [
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
      anchorReached: false, tip: null, agreement: null, nodes: [],
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
      anchorReached: true, tip: null, agreement: null, nodes: [],
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
  // MESH_INTERFACE → Acceptance → "No name, no hosted page" — the
  // stage's CDP reads `<pre id="probe">` for its byte-for-byte check,
  // which the page writes once per `?probe=<path>` run. The state
  // renderer and the probe each own their own subtree under `#root`,
  // so a render leaves `<pre id="probe">` in place.
  type FakeClient = Pick<MeshClient, 'fetch' | 'state' | 'onState'>;
  function buildFake(opts: { nodeId: string; body: Uint8Array }): FakeClient {
    const state: ClientState = {
      nodeId: opts.nodeId, transport: 'webrtc-direct', path: 'direct',
      lastLeft: null, anchorReached: true, tip: null, agreement: null, nodes: [],
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
      lastLeft: null, anchorReached: true, tip: null, agreement: null, nodes: [],
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
      lastLeft: null, anchorReached: true, tip: null, agreement: null, nodes: [],
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
        anchors: [{ notisId: 'aa'.repeat(32), addrs: ['/dns4/example.com/tcp/4001/p2p/12D3KooWBad'] }],
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
  anchorReached?: boolean;
  addByHandBehavior?: (notisId: string, addrs: string[], trusted: boolean) => void;
  readAnswers?: Array<{ nodeId: string } | { error: string }>;
}

interface FakeClient {
  client: Pick<MeshClient, 'read' | 'state' | 'onState' | 'addByHand' | 'fetch' | 'stop'>;
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
    anchorReached: init.anchorReached ?? false,
    tip: null,
    agreement: init.agreement ?? null,
    nodes: init.nodes ?? [],
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
      return { response: new Response('', { status: 200 }), nodeId: answer.nodeId };
    },
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
// MESH_INTERFACE → No anchor reached → "The agreement counts" — the page
// shows how many nodes verified a proof on the tip's chain within its
// last `k` headers, how many of those are anchors, and how many
// verified off those headers; before the first check, the line reads
// `Agreeing: —`, and in every state it sits above the no-anchor words.

describe('page/render.ts agreement line', () => {
  it('reads "Agreeing: —" before the first check (agreement === null)', () => {
    const root = document.createElement('div');
    render(emptyState({ anchorReached: false, agreement: null }), root);
    const line = root.querySelector('[data-role="agreement"]');
    expect(line, 'the agreement line is required').not.toBeNull();
    expect(line!.textContent).toBe('Agreeing: —');
  });

  it('reads "Agreeing: <n> (<a> anchors) · not on the tip\'s last 20 blocks: <m>" after a check', () => {
    const root = document.createElement('div');
    render(
      emptyState({
        anchorReached: true,
        agreement: { agreeing: 3, agreeingAnchors: 1, notAgreeing: 2 },
      }),
      root,
    );
    const line = root.querySelector('[data-role="agreement"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toBe(
      "Agreeing: 3 (1 anchors) · not on the tip's last 20 blocks: 2",
    );
  });

  it('sits above the no-anchor words', () => {
    const root = document.createElement('div');
    render(
      emptyState({
        anchorReached: false,
        agreement: { agreeing: 0, agreeingAnchors: 0, notAgreeing: 1 },
      }),
      root,
    );
    const line = root.querySelector('[data-role="agreement"]');
    const banner = root.querySelector('[data-role="banner"]');
    expect(line, 'the agreement line is required').not.toBeNull();
    expect(banner, 'the banner is required while anchorReached is false').not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING means banner is after line in the tree.
    const rel = line!.compareDocumentPosition(banner!);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And the banner still says exactly the contract's words.
    expect(banner!.textContent).toBe('No anchor reached. Nothing shown here is verified.');
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
        anchorReached: true,
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
    render(emptyState({ anchorReached: true }), root);
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
          anchors: [],
          stunServers: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await runMain({ root, fetch: fakeFetch as unknown as typeof globalThis.fetch });
    const err = root.querySelector('[data-role="error"]');
    expect(err, 'a config error element is required').not.toBeNull();
    expect(err!.textContent).toContain(
      'config.stunServers is no longer read: the client takes its STUN servers from the nodes it holds',
    );
  });

  it('a malformed byHand entry refuses the whole config in words', async () => {
    const root = document.createElement('div');
    const fakeFetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          network: 'devnet',
          anchors: [],
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
          anchors: [],
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
          anchors: [],
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
  it('?reads=3&need=older runs three reads through client.read and writes three served ids with their statuses', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    const fake = buildFakeClient({
      agreement: { agreeing: 2, agreeingAnchors: 1, notAgreeing: 0 },
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
    expect(parsed).toEqual({
      need: 'older',
      served: [
        { nodeId: idA, status: 'ok' },
        { nodeId: idB, status: 'trailing' },
        { nodeId: idA, status: 'ok' },
      ],
    });
  });

  it('a tip read sends to /blocks/current', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const fake = buildFakeClient({
      agreement: { agreeing: 1, agreeingAnchors: 1, notAgreeing: 0 },
      nodes: [entryAt(idA, 'ok')],
      readAnswers: [{ nodeId: idA }],
    });
    await runReads({ client: fake.client, n: 1, need: 'tip', root });
    expect(fake.calls.read).toEqual([{ path: '/blocks/current', need: 'tip' }]);
    const pre = root.querySelector('pre#reads');
    const parsed = JSON.parse(pre!.textContent ?? '');
    expect(parsed).toEqual({ need: 'tip', served: [{ nodeId: idA, status: 'ok' }] });
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
    fake.emit({ agreement: { agreeing: 1, agreeingAnchors: 1, notAgreeing: 0 } });
    await started;
    expect(fake.calls.read).toEqual([{ path: '/blocks/1', need: 'older' }]);
    const parsed = JSON.parse(root.querySelector('pre#reads')!.textContent ?? '');
    expect(parsed).toEqual({ need: 'older', served: [{ nodeId: idA, status: 'ok' }] });
  });

  it('a failed read lands as { nodeId: null, status: null, error }', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const fake = buildFakeClient({
      agreement: { agreeing: 1, agreeingAnchors: 1, notAgreeing: 0 },
      nodes: [entryAt(idA, 'ok')],
      readAnswers: [{ nodeId: idA }, { error: 'no node allowed for a tip read' }, { nodeId: idA }],
    });
    await runReads({ client: fake.client, n: 3, need: 'tip', root });
    const parsed = JSON.parse(root.querySelector('pre#reads')!.textContent ?? '');
    expect(parsed).toEqual({
      need: 'tip',
      served: [
        { nodeId: idA, status: 'ok' },
        { nodeId: null, status: null, error: 'no node allowed for a tip read' },
        { nodeId: idA, status: 'ok' },
      ],
    });
  });

  it('n outside 1–100 writes nothing', async () => {
    const root = document.createElement('div');
    const fake = buildFakeClient({
      agreement: { agreeing: 0, agreeingAnchors: 0, notAgreeing: 0 },
    });
    for (const n of [0, 101, -1, Number.NaN]) {
      await runReads({ client: fake.client, n, need: 'older', root });
    }
    expect(fake.calls.read, 'no reads for out-of-range n').toEqual([]);
    expect(root.querySelector('pre#reads'), 'no <pre id="reads"> for out-of-range n').toBeNull();
  });
});

describe('page/reads.ts sibling pattern', () => {
  it('a render leaves <pre id="reads"> in place', async () => {
    const root = document.createElement('div');
    const idA = 'a'.repeat(64);
    const fake = buildFakeClient({
      agreement: { agreeing: 1, agreeingAnchors: 1, notAgreeing: 0 },
      nodes: [entryAt(idA, 'ok')],
      readAnswers: [{ nodeId: idA }],
    });
    await runReads({ client: fake.client, n: 1, need: 'older', root });
    const before = root.querySelector('pre#reads');
    expect(before, '<pre id="reads"> is written before the render').not.toBeNull();
    const text = before!.textContent;
    render(emptyState({ anchorReached: true }), root);
    const after = root.querySelector('pre#reads');
    expect(after, 'the reads element survives a render').not.toBeNull();
    expect(after!.textContent).toBe(text);
    // Two renders keep it in place too.
    render(emptyState({ anchorReached: false }), root);
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
      agreement: { agreeing: 1, agreeingAnchors: 1, notAgreeing: 0 },
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
  // legitimately carries testnet's `/dns4/notis.fun/tcp/9733` for the node's
  // own gossip net (TYPES_INTERFACE → "bootstrapPeers is the network's known
  // nodes, per network"), and a string in the bundle is not a DNS lookup.
  // The browser never dials a DNS anchor — that is held at runtime by
  // `assertClientConfig` on every anchor, and `src/config.ts`'s DNS guard
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
