import { makeTestConfig } from './helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { initDb, getDb, closeDb } from '../src/store/db.js';
import { createApp, createAdminApp } from '../src/server.js';
import type { Config } from '../src/config.js';
import { MAX_BLOCK_BODY_BYTES, profileFor } from '@dagsocial/types';
import { resetForTests, getCounters } from '../src/metrics.js';

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
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
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
    it('answers 404', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(404);
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

  // NODE_INTERFACE → Cross-origin requests
  describe('CORS', () => {
    it('OPTIONS /posts: 204, empty body, the four headers, no credentials', async () => {
      const res = await fetch(`${baseUrl}/posts`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      expect(res.status).toBe(204);
      const body = await res.text();
      expect(body).toBe('');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
      expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization');
      expect(res.headers.get('access-control-max-age')).toBe('86400');
      expect(res.headers.has('access-control-allow-credentials')).toBe(false);
    });

    it('OPTIONS /no/such/path: 204 with the same headers', async () => {
      const res = await fetch(`${baseUrl}/no/such/path`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
      expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization');
      expect(res.headers.get('access-control-max-age')).toBe('86400');
    });

    it('GET /status with Origin: 200 and Access-Control-Allow-Origin: *', async () => {
      const res = await fetch(`${baseUrl}/status`, {
        headers: { Origin: 'https://example.com' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('GET /no/such/path with Origin: 404 and the header', async () => {
      const res = await fetch(`${baseUrl}/no/such/path`, {
        headers: { Origin: 'https://example.com' },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('POST /posts with Origin and a body the route refuses: 400 and the header', async () => {
      const res = await fetch(`${baseUrl}/posts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://example.com',
        },
        body: '{}',
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('http_requests_total increments for an OPTIONS', async () => {
      resetForTests();
      await fetch(`${baseUrl}/posts`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });
      expect(getCounters().httpRequestsTotal).toBe(1);
    });
  });
});

// NODE_INTERFACE → Cross-origin requests: the admin app sends none.
describe('admin app CORS', () => {
  it('GET /health with Origin: 200 and no Access-Control-Allow-Origin', async () => {
    const adminServer = createAdminApp(
      makeTestConfig({ adminPort: 0, adminBindAddress: '127.0.0.1' }),
      {
        getConnectedPeers: () => [],
        syncPhase: () => 'idle',
        protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      },
    );
    await new Promise<void>((resolve) => {
      if (adminServer.listening) { resolve(); return; }
      adminServer.once('listening', resolve);
    });
    try {
      const addr = adminServer.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`, {
        headers: { Origin: 'https://example.com' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.has('access-control-allow-origin')).toBe(false);
    } finally {
      adminServer.close();
    }
  });
});
