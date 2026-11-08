// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NETWORK_PROFILES } from '@dagsocial/types';

// The six deployment reads — the shell head's <base> and five <meta> tags,
// parsed once at load (WEB_INTERFACE → "The client is served from the node's
// own origin"). These are the values a host edits after unzipping.

async function importPrefs(): Promise<typeof import('../src/prefs')> {
  // A fresh module every test: prefs.node is a const that captures
  // BUILD_NODE_BASES at import time, so the tag changes below must precede the
  // import.
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
  // WEB_INTERFACE → The client is served from the node's own origin → "The
  // three later tags" — an entry is an API base or a node
  // `{ notisId, addrs, api }`. `BUILD_NODE_BASES` is each entry's effective
  // base (a string's own, a node's `api`); `BUILD_NODES` is the node
  // entries as `MeshContact`. Any malformed entry refuses the whole list.
  const NID = '68112eb3027cf9649a2ebc7f5caa48dbaf7fdb77ad3b1427176767ed2bf50d09';
  const ADDR = `/ip4/64.176.70.50/udp/9733/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa`;

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

  it('a non-string, non-object entry refuses the whole list', async () => {
    setMeta('notis-nodes', '["https://a.example",42,null,"https://b.example"]');
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
  });

  it('a node entry contributes its api to BUILD_NODE_BASES and the node entry to BUILD_NODES', async () => {
    const entry = { notisId: NID, addrs: [ADDR], api: 'https://notis.fun/testnet/api' };
    setMeta('notis-nodes', JSON.stringify([entry]));
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual(['https://notis.fun/testnet/api']);
    expect(p.BUILD_NODE_BASES).toEqual(['https://notis.fun/testnet/api']);
    expect(p.BUILD_NODES).toEqual([{ notisId: NID, addrs: [ADDR], api: 'https://notis.fun/testnet/api' }]);
  });

  it("a node entry's api has its trailing / stripped", async () => {
    const entry = { notisId: NID, addrs: [ADDR], api: 'https://notis.fun/testnet/api/' };
    setMeta('notis-nodes', JSON.stringify([entry]));
    const p = await importPrefs();
    expect(p.BUILD_NODE_BASES).toEqual(['https://notis.fun/testnet/api']);
    expect(p.BUILD_NODES[0]!.api).toBe('https://notis.fun/testnet/api');
  });

  it('mixed entries — a string alongside a node entry — each contributes to BUILD_NODE_BASES; only the node entry to BUILD_NODES', async () => {
    const entry = { notisId: NID, addrs: [ADDR], api: 'https://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.BUILD_NODE_BASES).toEqual(['https://a.example/api', 'https://b.example/api']);
    expect(p.BUILD_NODES).toEqual([{ notisId: NID, addrs: [ADDR], api: 'https://b.example/api' }]);
  });

  it('a valid string entry alongside a node entry with a short notisId refuses the whole list', async () => {
    const entry = { notisId: 'abcd', addrs: [ADDR], api: 'https://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
    expect(p.BUILD_NODES).toEqual([]);
  });

  it('a node entry with an uppercase hex key refuses the whole list', async () => {
    const entry = { notisId: NID.toUpperCase(), addrs: [ADDR], api: 'https://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
    expect(p.BUILD_NODES).toEqual([]);
  });

  it('a node entry with an address carrying /dns4/ refuses the whole list', async () => {
    const dnsAddr = '/dns4/notis.fun/udp/9733/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';
    const entry = { notisId: NID, addrs: [dnsAddr], api: 'https://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
    expect(p.BUILD_NODES).toEqual([]);
  });

  it('a node entry with an address carrying /dns6/ refuses the whole list', async () => {
    const dnsAddr = '/dns6/notis.fun/udp/9733/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';
    const entry = { notisId: NID, addrs: [dnsAddr], api: 'https://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
    expect(p.BUILD_NODES).toEqual([]);
  });

  it('a node entry with an address carrying /dnsaddr/ refuses the whole list', async () => {
    const dnsAddr = '/dnsaddr/notis.fun/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';
    const entry = { notisId: NID, addrs: [dnsAddr], api: 'https://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
    expect(p.BUILD_NODES).toEqual([]);
  });

  it('a node entry whose address lacks /p2p/<peer id> refuses the whole list', async () => {
    const bareAddr = '/ip4/64.176.70.50/udp/9733/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg';
    const entry = { notisId: NID, addrs: [bareAddr], api: 'https://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
    expect(p.BUILD_NODES).toEqual([]);
  });

  it('a node entry with no http(s) api refuses the whole list', async () => {
    const entry = { notisId: NID, addrs: [ADDR], api: 'ftp://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
    expect(p.BUILD_NODES).toEqual([]);
  });

  it('a node entry with an empty addrs is a node reached at its api base alone', async () => {
    const entry = { notisId: NID, addrs: [], api: 'https://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.BUILD_NODES).toEqual([{ notisId: NID, addrs: [], api: 'https://b.example/api' }]);
    expect(p.BUILD_NODE_BASES).toEqual(['https://a.example/api', 'https://b.example/api']);
  });

  it.each([
    ['a string', 'x'],
    ['an object', {}],
    ['absent', undefined],
  ])('a node entry whose addrs is %s refuses the whole list', async (_name, addrs) => {
    const entry = { notisId: NID, addrs, api: 'https://b.example/api' };
    setMeta('notis-nodes', JSON.stringify(['https://a.example/api', entry]));
    const p = await importPrefs();
    expect(p.readNodesMeta()).toEqual([]);
    expect(p.BUILD_NODES).toEqual([]);
  });
});

describe('HAND_NODE_KEY — the hand-added node\'s address, in localStorage', () => {
  // WEB_INTERFACE → The settings window → "In the extension the row adds a
  // node by hand" — a new storage key beside `notis.node`, named in
  // `src/extension/storage-keys.ts`.
  it('is exported as `notis.node.hand`', async () => {
    const m = await import('../src/extension/storage-keys');
    expect(m.HAND_NODE_KEY).toBe('notis.node.hand');
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

describe('readNetworkMeta — the network the build is for', () => {
  it('each network name a profile answers to reads as itself', async () => {
    const p = await importPrefs();
    for (const name of Object.keys(NETWORK_PROFILES)) {
      document.head.innerHTML = '';
      setMeta('notis-network', name);
      expect(p.readNetworkMeta()).toBe(name);
    }
  });

  it('an empty value reads as null — the build with no verifier', async () => {
    setMeta('notis-network', '');
    const p = await importPrefs();
    expect(p.readNetworkMeta()).toBeNull();
  });

  it('whitespace reads as null — content is trimmed', async () => {
    setMeta('notis-network', '   ');
    const p = await importPrefs();
    expect(p.readNetworkMeta()).toBeNull();
  });

  it('an unknown name reads as null', async () => {
    setMeta('notis-network', 'nonsense');
    const p = await importPrefs();
    expect(p.readNetworkMeta()).toBeNull();
  });

  it('a missing meta reads as null', async () => {
    const p = await importPrefs();
    expect(p.readNetworkMeta()).toBeNull();
  });

  it('the accepted set is Object.keys(NETWORK_PROFILES), read not typed', async () => {
    const p = await importPrefs();
    for (const name of Object.keys(NETWORK_PROFILES)) {
      document.head.innerHTML = '';
      setMeta('notis-network', name);
      expect(p.readNetworkMeta()).not.toBeNull();
    }
    // A name absent from NETWORK_PROFILES is refused. `__proto__` covers the
    // prototype-key trap: `in` would answer true, `hasOwn` answers false.
    for (const bad of ['', ' ', 'unknown', 'MAINNET', '__proto__', 'toString']) {
      document.head.innerHTML = '';
      setMeta('notis-network', bad);
      expect(p.readNetworkMeta()).toBeNull();
    }
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
