import { makeTestConfig } from './helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { initDb, getDb, closeDb } from '../src/store/db.js';
import { createApp, createAdminApp } from '../src/server.js';
import { bodyRefusal } from '../src/routes/body-refusal.js';
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

  // NODE_INTERFACE → HTTP API → "A body the parser refuses is the client's
  // error". The public app's last handler reads `bodyRefusal` first and
  // answers 4xx with the mapped body, no log line, and the CORS header the
  // middleware set ahead of the parser.
  describe('a body the parser refuses', () => {
    it('POST /posts/batch with Content-Type JSON and body `{` answers 400 malformed JSON body, not logged', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await fetch(`${baseUrl}/posts/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 400, reason: 'malformed JSON body' });
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('POST /posts/batch with a top-level string `"x"` answers 400 malformed JSON body, not logged', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await fetch(`${baseUrl}/posts/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '"x"',
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 400, reason: 'malformed JSON body' });
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('POST /posts/batch with a body over 1 MB answers 413 body too large, not logged', async () => {
      // One byte past the parser's 1 MB limit, in valid JSON so the body
      // bound is what refuses it (raw-body's `entity.too.large`).
      const payload = '{"pad":"' + 'a'.repeat(1024 * 1024) + '"}';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await fetch(`${baseUrl}/posts/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: 413, reason: 'body too large' });
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('a well-formed POST /posts/batch still answers 200', async () => {
      const res = await fetch(`${baseUrl}/posts/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['a'.repeat(64)] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { posts: unknown[] };
      expect(body.posts).toEqual([]);
    });

    // A fault of the node's — the generic 500 answer and its one logged line
    // stand (NODE_INTERFACE → HTTP API → "500 … is a fault of the node's, and
    // it alone logs its stack"). A sync throw that reaches the public app's
    // last handler without a parser mark answers `{ error: 'internal' }`
    // with one `500 error:` log line.
    it('an error thrown inside a route still answers 500 and logs once', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let throwingServer: http.Server | undefined;
      try {
        const throwingApp = express();
        throwingApp.get('/boom', (_req, _res, next) => {
          next(new Error('inside a route'));
        });
        throwingApp.use(
          (
            err: unknown,
            _req: express.Request,
            res: express.Response,
            _next: express.NextFunction,
          ) => {
            const refusal = bodyRefusal(err);
            if (refusal !== null) {
              res.status(refusal.status).json({ error: refusal.status, reason: refusal.reason });
              return;
            }
            console.error('500 error:', err instanceof Error ? err.stack : err);
            res.status(500).json({ error: 'internal' });
          },
        );
        throwingServer = throwingApp.listen(0);
        const addr = throwingServer.address() as AddressInfo;
        const res = await fetch(`http://localhost:${addr.port}/boom`);
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'internal' });
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0]![0])).toBe('500 error:');
      } finally {
        errorSpy.mockRestore();
        throwingServer?.close();
      }
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
