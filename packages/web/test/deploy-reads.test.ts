// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The five deployment reads — the shell head's <base> and four <meta> tags,
// parsed once at load (WEB_INTERFACE → "The client is served from the node's
// own origin"). These are the values a host edits after unzipping.

async function importPrefs(): Promise<typeof import('../src/prefs')> {
  // A fresh module every test: prefs.node is a const that captures BUILD_NODES
  // at import time, so the tag changes below must precede the import.
  vi.resetModules();
  return await import('../src/prefs');
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

function setMeta(name: string, content: string): void {
  const m = document.createElement('meta');
  m.setAttribute('name', name);
  m.setAttribute('content', content);
  document.head.appendChild(m);
}

function setBase(href: string): void {
  const b = document.createElement('base');
  b.setAttribute('href', href);
  document.head.appendChild(b);
}

describe('readBase / readMeta — the three original tags', () => {
  it('readBase reads the <base> href and always ends with /', async () => {
    setBase('/web/');
    const p = await importPrefs();
    expect(p.readBase()).toBe('/web/');
  });

  it('readBase adds a trailing slash when the href has none', async () => {
    setBase('/some/path');
    const p = await importPrefs();
    expect(p.readBase()).toBe('/some/path/');
  });

  it('readMeta trims trailing slashes and empty content answers empty', async () => {
    setMeta('notis-api', '/testnet/api/');
    setMeta('notis-faucet', '');
    const p = await importPrefs();
    expect(p.readMeta('notis-api')).toBe('/testnet/api');
    expect(p.readMeta('notis-faucet')).toBe('');
    expect(p.readMeta('notis-does-not-exist')).toBe('');
  });
});

describe('readNodesMeta — the extension\'s per-network seed list', () => {
  it('parses a JSON array of API base strings', async () => {
    setMeta('notis-nodes', '["https://notis.fun/testnet/api"]');
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual(['https://notis.fun/testnet/api']);
  });

  it('multiple entries in order — the resolution takes the first that answers', async () => {
    setMeta('notis-nodes', '["https://a.example/api","https://b.example/api"]');
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual(['https://a.example/api', 'https://b.example/api']);
  });

  it('an empty array answers []', async () => {
    setMeta('notis-nodes', '[]');
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
  });

  it('a missing meta answers []', async () => {
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
  });

  it('malformed JSON answers []', async () => {
    setMeta('notis-nodes', 'not json');
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
  });

  it('non-string entries are dropped', async () => {
    setMeta('notis-nodes', '["https://a.example",42,null,"https://b.example"]');
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('readPublicMeta — the origin+base a link should carry', () => {
  it('reads the value and adds a trailing / when missing', async () => {
    setMeta('notis-public', 'https://notis.fun/web');
    const p = await importPrefs();
    expect(p.readPublicMeta()).toBe('https://notis.fun/web/');
  });

  it('preserves an existing trailing /', async () => {
    setMeta('notis-public', 'https://notis.fun/web/');
    const p = await importPrefs();
    expect(p.readPublicMeta()).toBe('https://notis.fun/web/');
  });

  it('an empty value answers empty — the extension\'s "no public URL" state', async () => {
    setMeta('notis-public', '');
    const p = await importPrefs();
    expect(p.readPublicMeta()).toBe('');
  });

  it('a missing meta answers empty', async () => {
    const p = await importPrefs();
    expect(p.readPublicMeta()).toBe('');
  });
});

describe('prefs.node — the initial node resolution', () => {
  it('a stored preference wins', async () => {
    setMeta('notis-nodes', '["https://seeded.example/api"]');
    setMeta('notis-api', '/api');
    localStorage.setItem('notis.node', 'https://stored.example/api');
    const p = await importPrefs();
    expect(p.prefs.node).toBe('https://stored.example/api');
  });

  it('no stored preference — the seed list\'s first entry wins over the same-origin fallback', async () => {
    setMeta('notis-nodes', '["https://seeded.example/api"]');
    setMeta('notis-api', '/api');
    const p = await importPrefs();
    expect(p.prefs.node).toBe('https://seeded.example/api');
  });

  it('no stored preference and no seed list — falls back to notis-api (same-origin)', async () => {
    setMeta('notis-api', '/testnet/api');
    const p = await importPrefs();
    expect(p.prefs.node).toBe('/testnet/api');
  });
});

describe('prefs.faucet — the build\'s value alone', () => {
  // WEB_INTERFACE → The faucet step → "A faucet is a fact of the deployment,
  // not of the network" — the faucet's base is the shell's notis-faucet, and
  // no preference overrides it (user, 2026-09-18).
  it('reads the notis-faucet meta at load', async () => {
    setMeta('notis-faucet', 'https://faucet.example');
    const p = await importPrefs();
    expect(p.prefs.faucet).toBe('https://faucet.example');
  });

  it('a stored notis.faucet is never read — the field takes the build\'s value', async () => {
    setMeta('notis-faucet', 'https://faucet.example');
    localStorage.setItem('notis.faucet', 'https://poisoned.example');
    const p = await importPrefs();
    expect(p.prefs.faucet).toBe('https://faucet.example');
    // The stored key still exists — the client just does not read it.
    expect(localStorage.getItem('notis.faucet')).toBe('https://poisoned.example');
  });

  it('an empty notis-faucet answers empty — the *no faucet, no button* state', async () => {
    setMeta('notis-faucet', '');
    const p = await importPrefs();
    expect(p.prefs.faucet).toBe('');
  });
});
