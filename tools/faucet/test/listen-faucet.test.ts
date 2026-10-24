import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import {
  HTTP_CHECK_INTERVAL_MS,
  HTTP_CONNECTIONS_MAX,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
} from '@dagsocial/types';
import { createApp, listenFaucet } from '../src/server.js';
import type { NodeClient } from '../src/node-client.js';
import { C1, ERA, K1, baseCfg, recipient } from './fixture.js';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

describe('how the faucet listens', () => {
  it('listens in listenFaucet alone, and the start calls it', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    const listening = files.filter((f) => readFileSync(join(SRC, f), 'utf8').includes('.listen('));
    expect(listening).toEqual(['server.ts']);
    const server = readFileSync(join(SRC, 'server.ts'), 'utf8');
    expect(server.split('.listen(')).toHaveLength(2);
    const start = server.indexOf('export function listenFaucet(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = server.indexOf('\n}\n', start);
    expect(server.slice(start, end)).toContain('.listen(');
    expect(readFileSync(join(SRC, 'index.ts'), 'utf8')).toContain('listenFaucet(');
  });
});

const stubbed = (): NodeClient => ({
  status: async () => ({ blockHeight: 100, protocolVersion: ERA }),
  karmaView: async () => ({ boxes: [{ boxId: K1, value: 1000n }], effective: 1000n }),
  creditView: async () => ({ boxes: [{ boxId: C1, value: 1000n }] }),
  submitInvite: async () => ({ expiresAtHeight: 821 }),
  submitTransfer: async () => ({ expiresAtHeight: 921 }),
});

const listening = (server: Server): Promise<void> =>
  server.listening ? Promise.resolve() : new Promise((resolve) => server.once('listening', () => resolve()));

describe('the faucet server', () => {
  it('holds the deadlines, the connection bound and no idle deadline', async () => {
    const server = listenFaucet(createApp(baseCfg, stubbed()), 0);
    try {
      await listening(server);
      expect(server.listening).toBe(true);
      expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
      const table: [string, number, number][] = [
        ['headersTimeout', server.headersTimeout, HTTP_HEADERS_TIMEOUT_MS],
        ['requestTimeout', server.requestTimeout, HTTP_REQUEST_TIMEOUT_MS],
        ['keepAliveTimeout', server.keepAliveTimeout, HTTP_KEEP_ALIVE_TIMEOUT_MS],
        ['connectionsCheckingInterval', (server as Server & { connectionsCheckingInterval: number }).connectionsCheckingInterval, HTTP_CHECK_INTERVAL_MS],
        ['maxConnections', server.maxConnections as number, HTTP_CONNECTIONS_MAX],
        ['timeout', server.timeout, 0],
      ];
      for (const [name, held, bound] of table) {
        expect(held, name).toBe(bound);
      }
    } finally {
      server.close();
    }
  });

  it('sends nosniff and no X-Powered-By on every status', async () => {
    const client = stubbed();
    const failing: NodeClient = { ...stubbed(), status: async () => { throw new Error('boom'); } };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const table: [number, () => Promise<request.Response>][] = [
        [202, () => request(createApp(baseCfg, client)).post('/faucet/karma').send({ pubkey: recipient })],
        [400, () => request(createApp(baseCfg, client)).post('/faucet/karma').send({ pubkey: 'no' })],
        [429, async () => {
          const app = createApp(baseCfg, client);
          const first = await request(app).post('/faucet/karma').send({ pubkey: recipient });
          expect(first.status).toBe(202);
          return request(app).post('/faucet/karma').send({ pubkey: recipient });
        }],
        [404, () => request(createApp(baseCfg, client)).get('/nowhere')],
        [500, () => request(createApp(baseCfg, failing)).post('/faucet/karma').send({ pubkey: recipient })],
      ];
      for (const [status, send] of table) {
        const res = await send();
        expect(res.status, `status ${status}`).toBe(status);
        expect(res.headers['x-powered-by'], `x-powered-by on ${status}`).toBeUndefined();
        expect(res.headers['x-content-type-options'], `nosniff on ${status}`).toBe('nosniff');
      }
    } finally {
      logged.mockRestore();
    }
  });

  it('refuses a body of 129 bytes and takes one of 128', async () => {
    const bodyOf = (bytes: number): string => {
      const open = JSON.stringify({ pubkey: recipient, pad: '' });
      const body = JSON.stringify({ pubkey: recipient, pad: 'x'.repeat(bytes - open.length) });
      expect(Buffer.byteLength(body)).toBe(bytes);
      return body;
    };
    const post = (body: string) => request(createApp(baseCfg, stubbed()))
      .post('/faucet/karma').set('Content-Type', 'application/json').send(body);
    const within = await post(bodyOf(128));
    expect(within.status).toBe(202);
    expect(within.body.txId).toMatch(/^[0-9a-f]{64}$/);
    const over = await post(bodyOf(129));
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('request entity too large');
  });

  // NODE_INTERFACE → HTTP API → "The node reads no compressed request body" —
  // the faucet's parser runs `inflate: false`, so a request carrying a
  // Content-Encoding is refused before a decompression stream is created; the
  // service relays the parser's 4xx as its own 400. Sent over a raw socket:
  // supertest does not deliver a Content-Encoding body byte for byte.
  it('refuses a gzip-encoded body unread — 400, no decompression', async () => {
    const server = listenFaucet(createApp(baseCfg, stubbed()), 0);
    try {
      await listening(server);
      const port = (server.address() as AddressInfo).port;
      const body = gzipSync(Buffer.from(JSON.stringify({ pubkey: recipient })));
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/faucet/karma',
            headers: {
              'Content-Type': 'application/json',
              'Content-Encoding': 'gzip',
              'Content-Length': body.length,
            },
          },
          (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(status).toBe(400);
    } finally {
      server.close();
    }
  });
});
