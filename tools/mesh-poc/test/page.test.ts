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
import type { ClientState } from '../src/client/mesh-client.js';
import type { NodeEntry } from '../src/client/node-list.js';
import { render } from '../page/render.js';
import { runMain } from '../page/main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const DIST_PAGE = join(PACKAGE_ROOT, 'dist-page');

function makeEntry(over: Partial<NodeEntry> & { notisId: string }): NodeEntry {
  return {
    notisId: over.notisId,
    anchor: over.anchor ?? false,
    status: over.status ?? 'new',
    failures: over.failures ?? 0,
    retryAtMs: over.retryAtMs ?? 0,
    addrs: over.addrs ?? [],
    droppedAddrs: over.droppedAddrs ?? [],
    evidence: over.evidence ?? null,
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
          stunServers: [],
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
        const spec = match[1]!;
        if (spec.startsWith('node:')) builtinHits.push(`${f}: ${spec}`);
        else if (builtinModules.includes(spec)) builtinHits.push(`${f}: ${spec}`);
      }
    }
    expect(builtinHits, `Node built-in imports in the bundle: ${builtinHits.join(', ')}`).toEqual([]);
  }, 180_000);

  afterAll(() => { /* leave dist-page/ in place for the next run */ });
});
