import { makeTestConfig } from './helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import { initDb, getDb, closeDb } from '../src/store/db.js';
import { createApp } from '../src/server.js';

// The demo UI reaches the faucet on its own host (a locally-run node serves no
// /faucet route — NODE_INTERFACE). The node injects window.__NOTIS_CONFIG__ into
// the served `/` page from FAUCET_URL; the UI reads it and falls back to the
// window.location heuristic when it is absent.
describe('demo UI config injection', () => {
  beforeAll(() => {
    initDb(':memory:');
    getDb()
      .prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)')
      .run();
  });
  afterAll(() => closeDb());

  async function fetchIndex(faucetUrl: string): Promise<string> {
    const app = createApp(makeTestConfig({ faucetUrl }));
    const server = app.listen(0);
    try {
      const addr = server.address() as AddressInfo;
      const res = await fetch(`http://localhost:${addr.port}/`);
      return await res.text();
    } finally {
      server.close();
    }
  }

  it('injects window.__NOTIS_CONFIG__.faucetBase when FAUCET_URL is set', async () => {
    const html = await fetchIndex('https://notis.fun/testnet/faucet');
    // the injected assignment (distinct from the client-side reader
    // `window.__NOTIS_CONFIG__?.faucetBase`, which is always in the page)
    expect(html).toContain('window.__NOTIS_CONFIG__ = {"faucetBase":"https://notis.fun/testnet/faucet"}');
  });

  it('omits faucetBase when FAUCET_URL is empty (heuristic preserved)', async () => {
    const html = await fetchIndex('');
    expect(html).not.toContain('window.__NOTIS_CONFIG__ = {');
  });
});
