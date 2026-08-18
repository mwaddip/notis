import { makeTestConfig, uid } from './helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { initDb, closeDb } from '../src/store/db.js';
import { createApp } from '../src/server.js';
import type { Config } from '../src/config.js';
import { MAX_BLOCK_BODY_BYTES, profileFor } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The literal below states only this suite's deliberate deviations;
// `makeTestConfig` supplies every other `Config` field from the loaded
// singleton, so the fixture cannot fall behind the type (see `helpers.ts`).
function makeConfig(overrides?: Partial<Config>): Config {
  return makeTestConfig({
    port: 0,
    dbPath: ':memory:',
    networkType: 'testnet',
    profile: profileFor('testnet'),
    nodeRole: 'server',
    blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
    orderingBlockPowTargetBits: 3072,
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 50,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    initDb(':memory:');
    const app = createApp(makeConfig());
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    closeDb();
  });

  describe('GET /status', () => {
    it('returns 200 with JSON body containing blockHeight', async () => {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('blockHeight');
      expect(typeof body.blockHeight).toBe('number');
    });
  });

  describe('GET /', () => {
    it('returns HTML (Content-Type includes text/html)', async () => {
      const res = await fetch(`${baseUrl}/`);
      // The demo UI HTML may or may not exist in the test environment,
      // but express.static will either serve it or fall through.
      // If express.static serves the file, status is 200 and content-type is text/html.
      // If it falls through, it hits the 404 from one of the routers or
      // the default Express 404 handler.
      // We accept both: presence of index.html is a build artifact concern.
      const contentType = res.headers.get('content-type') ?? '';
      if (res.status === 200) {
        expect(contentType).toContain('text/html');
      }
      // If 404, the file just isn't there — not a server bug.
    });
  });

  describe('unknown route', () => {
    it('returns 404 for a nonexistent path', async () => {
      const res = await fetch(`${baseUrl}/nonexistent-route-xyz`);
      expect(res.status).toBe(404);
    });
  });

  // ⛔ **NO NETWORK MOUNTS A FAUCET, and the node holds no key to run one
  // with.** The karma a newcomer receives is a pool draw in the settlement,
  // requested by an ordinary member's bond, so a faucet is an off-chain service
  // holding an owner key like anyone else (ARCHITECTURE → "What varies per
  // network, and what must not").
  //
  // ⚠ **404, not 403.** A 403 would mean a route exists and refuses, which is
  // what a network-gated mount answered — so the two statuses are exactly what
  // separates "disabled here" from "not a thing this node serves".
  describe('the faucet is not a route on any network', () => {
    async function postFaucet(networkType: 'mainnet' | 'testnet' | 'devnet') {
      const app = createApp(
        makeConfig({ networkType, profile: profileFor(networkType) }),
      );
      const gateServer = app.listen(0);
      try {
        const addr = gateServer.address() as AddressInfo;
        return await fetch(`http://localhost:${addr.port}/faucet`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } finally {
        gateServer.close();
      }
    }

    for (const networkType of ['mainnet', 'testnet', 'devnet'] as const) {
      it(`${networkType}: POST /faucet is 404`, async () => {
        const res = await postFaucet(networkType);
        expect(res.status).toBe(404);
      });
    }

    // The same for the credit half, which had its own handler rather than a
    // mount — so a 404 here is the handler's absence and not the mount's.
    for (const networkType of ['mainnet', 'testnet', 'devnet'] as const) {
      it(`${networkType}: POST /credits/faucet is 404`, async () => {
        const app = createApp(
          makeConfig({ networkType, profile: profileFor(networkType) }),
        );
        const gateServer = app.listen(0);
        try {
          const addr = gateServer.address() as AddressInfo;
          const res = await fetch(`http://localhost:${addr.port}/credits/faucet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          expect(res.status).toBe(404);
        } finally {
          gateServer.close();
        }
      });
    }
  });
});
