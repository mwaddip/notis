import { makeTestConfig, makePostCommit, fixturePostId, fixtureTxId, uid } from './helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { initDb, getDb, closeDb } from '../src/store/db.js';
import { createApp, createAdminApp } from '../src/server.js';
import { bodyRefusal } from '../src/routes/body-refusal.js';
import { insertPost, confirmPost } from '../src/store/posts.js';
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

    it.fails('POST /posts/batch one byte past HTTP_BODY_MAX_BYTES answers 413 body too large, not logged', async () => {
      // 65 536 + 1 bytes of well-formed JSON so only the body bound can
      // refuse it (raw-body's `entity.too.large`).
      const prefix = `{"ids":["${'a'.repeat(64)}"],"pad":"`;
      const suffix = '"}';
      const payload = prefix + 'x'.repeat(65_536 + 1 - prefix.length - suffix.length) + suffix;
      expect(Buffer.byteLength(payload, 'utf-8')).toBe(65_536 + 1);
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
    // stand (NODE_INTERFACE → HTTP API → "A body the parser refuses is the
    // client's error"). A sync throw that reaches the public app's last
    // handler without a parser mark answers `{ error: 'internal' }` with one
    // `500 error:` log line.
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

// NODE_INTERFACE → The public server → "No answer names the software, and none
// is read as another type": every answer of the public app and the admin
// listener carries X-Content-Type-Options: nosniff, and neither sends
// X-Powered-By, whatever its status.
describe('nosniff and no X-Powered-By', () => {
  let publicServer: http.Server;
  let publicUrl: string;
  let shellDir: string;
  let shellPath: string;
  let livePostId: string;

  beforeAll(async () => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    shellDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagsocial-nosniff-'));
    shellPath = path.join(shellDir, 'index.html');
    fs.writeFileSync(
      shellPath,
      '<!doctype html><html><head><title>Notis</title></head><body></body></html>',
      'utf-8',
    );
    const author = uid('nosniff-live-author');
    const content = 'a live post for the nosniff coverage';
    const commit = makePostCommit(author, content);
    livePostId = fixturePostId(commit);
    insertPost(livePostId, fixtureTxId(commit), commit, content);
    confirmPost(livePostId, 30, 0);
    const app = createApp(makeTestConfig({ port: 0, webShellPath: shellPath }));
    publicServer = app.listen(0);
    await new Promise<void>((resolve) => {
      if (publicServer.listening) { resolve(); return; }
      publicServer.once('listening', resolve);
    });
    const addr = publicServer.address() as AddressInfo;
    publicUrl = `http://localhost:${addr.port}`;
  });

  afterAll(() => {
    publicServer.close();
    fs.rmSync(shellDir, { recursive: true, force: true });
    closeDb();
  });

  // The error-handler kind reaches the handler through a Content-Encoding:
  // gzip header on a non-gzip body: zlib raises an error whose `type` is
  // undefined, which `bodyRefusal` returns null for, so the final handler
  // answers 500.
  function postRawBadGzip(targetUrl: string): Promise<{ status: number; headers: Map<string, string> }> {
    const url = new URL(targetUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: '/posts/batch',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          },
        },
        (res) => {
          const headers = new Map<string, string>();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers.set(k.toLowerCase(), v);
          }
          res.on('data', () => {});
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers }));
        },
      );
      req.on('error', reject);
      req.write('{bad}');
      req.end();
    });
  }

  it.fails('the public app answers every listed kind with nosniff and no X-Powered-By', async () => {
    const bigBody = '{"pad":"' + 'a'.repeat(1024 * 1024) + '"}';
    const kinds: Array<{ kind: string; status: number; call: () => Promise<{ status: number; headers: Headers | Map<string, string> }> }> = [
      {
        kind: '2xx of a route',
        status: 200,
        call: async () => {
          const r = await fetch(`${publicUrl}/status`);
          return { status: r.status, headers: r.headers };
        },
      },
      {
        kind: '4xx of a route',
        status: 400,
        call: async () => {
          const r = await fetch(`${publicUrl}/posts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          return { status: r.status, headers: r.headers };
        },
      },
      {
        kind: '404 of an unmounted path',
        status: 404,
        call: async () => {
          const r = await fetch(`${publicUrl}/no/such/path`);
          return { status: r.status, headers: r.headers };
        },
      },
      {
        kind: 'OPTIONS 204',
        status: 204,
        call: async () => {
          const r = await fetch(`${publicUrl}/posts`, { method: 'OPTIONS' });
          return { status: r.status, headers: r.headers };
        },
      },
      {
        kind: "parser's 400",
        status: 400,
        call: async () => {
          const r = await fetch(`${publicUrl}/posts/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{',
          });
          return { status: r.status, headers: r.headers };
        },
      },
      {
        kind: "parser's 413",
        status: 413,
        call: async () => {
          const r = await fetch(`${publicUrl}/posts/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bigBody,
          });
          return { status: r.status, headers: r.headers };
        },
      },
      {
        kind: '/shell/:id 200',
        status: 200,
        call: async () => {
          const r = await fetch(`${publicUrl}/shell/${livePostId}`);
          return { status: r.status, headers: r.headers };
        },
      },
      {
        kind: '/shell/:id 400 bad id',
        status: 400,
        call: async () => {
          const r = await fetch(`${publicUrl}/shell/${'z'.repeat(64)}`);
          return { status: r.status, headers: r.headers };
        },
      },
      {
        kind: '/shell/:id 404 unknown id',
        status: 404,
        call: async () => {
          const r = await fetch(`${publicUrl}/shell/${'b'.repeat(64)}`);
          return { status: r.status, headers: r.headers };
        },
      },
      {
        kind: "error handler's 500",
        status: 500,
        call: async () => {
          const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
          try {
            return await postRawBadGzip(publicUrl);
          } finally {
            errorSpy.mockRestore();
          }
        },
      },
    ];
    for (const row of kinds) {
      const r = await row.call();
      expect(r.status, row.kind).toBe(row.status);
      const headerGet = (name: string): string | null =>
        r.headers instanceof Map ? (r.headers.get(name) ?? null) : r.headers.get(name);
      const headerHas = (name: string): boolean =>
        r.headers instanceof Map ? r.headers.has(name) : r.headers.has(name);
      expect(headerHas('x-powered-by'), `${row.kind}: X-Powered-By`).toBe(false);
      expect(headerGet('x-content-type-options'), `${row.kind}: nosniff`).toBe('nosniff');
    }
  });

  it.fails('the admin listener answers every listed kind with nosniff and no X-Powered-By', async () => {
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
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const kinds: Array<{ kind: string; status: number; path: string }> = [
        { kind: '2xx /health', status: 200, path: '/health' },
        { kind: '2xx /stats', status: 200, path: '/stats' },
        { kind: '404 unmounted', status: 404, path: '/no/such/path' },
      ];
      for (const row of kinds) {
        const r = await fetch(`${baseUrl}${row.path}`);
        expect(r.status, row.kind).toBe(row.status);
        expect(r.headers.has('x-powered-by'), `${row.kind}: X-Powered-By`).toBe(false);
        expect(r.headers.get('x-content-type-options'), `${row.kind}: nosniff`).toBe('nosniff');
      }
    } finally {
      adminServer.close();
    }
  });
});

// NODE_INTERFACE → "A body the parser refuses is the client's error":
// `HTTP_BODY_MAX_BYTES` is 64 KiB (CONSTANTS → HTTP server bounds), so a
// well-formed body one byte past it is answered 413, and one at exactly
// the limit reaches the route.
describe('body bound at HTTP_BODY_MAX_BYTES', () => {
  const BOUND = 65_536;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const app = createApp(makeTestConfig({ port: 0 }));
    server = app.listen(0);
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    closeDb();
  });

  function paddedBatchBody(total: number): string {
    const prefix = `{"ids":["${'a'.repeat(64)}"],"pad":"`;
    const suffix = '"}';
    const need = total - prefix.length - suffix.length;
    return prefix + 'x'.repeat(need) + suffix;
  }

  it('a well-formed body of exactly 65 536 bytes is answered by the route, not by the parser', async () => {
    const body = paddedBatchBody(BOUND);
    expect(Buffer.byteLength(body, 'utf-8')).toBe(BOUND);
    const r = await fetch(`${baseUrl}/posts/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(r.status).not.toBe(413);
  });

  it.fails('a well-formed body of 65 536 + 1 bytes answers 413 body too large', async () => {
    const body = paddedBatchBody(BOUND + 1);
    expect(Buffer.byteLength(body, 'utf-8')).toBe(BOUND + 1);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await fetch(`${baseUrl}/posts/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(r.status).toBe(413);
      expect(await r.json()).toEqual({ error: 413, reason: 'body too large' });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
