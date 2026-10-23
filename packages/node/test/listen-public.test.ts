import { describe, it, expect } from 'vitest';
import express from 'express';
import * as net from 'net';
import * as http from 'http';
import { once } from 'events';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_CHECK_INTERVAL_MS,
  HTTP_CONNECTIONS_MAX,
} from '@dagsocial/types';
import { listenPublic } from '../src/server.js';

const SRC_DIR = join(__dirname, '../src');

// NODE_INTERFACE → The public server; CONSTANTS → HTTP server bounds.
const HTTP_IDLE_TIMEOUT_MS = 30_000;

// NODE_INTERFACE → The public server → "The node holds at most
// HTTP_UNREAD_ANSWER_BYTES (64 MiB) of answers its readers have not taken."
const HTTP_UNREAD_ANSWER_BYTES = 67_108_864;

/**
 * NODE_INTERFACE → The public server → "One function builds the public server,
 * and every bound below is set there": the node's start listens through
 * `listenPublic`, and the admin listener is the one other `.listen(` call in
 * the package's source — on loopback, with none of the public server's bounds.
 *
 * The scan is the literal substring `.listen(` under `src/`; its enclosing
 * function is read off the nearest `function`/`export function` header above
 * each hit. A `.listen(` written on a line without the ascii dot — a bracketed
 * call, a reflective call — is not seen by this scan.
 */
describe('under src/, `.listen(` is listenPublic\'s and createAdminApp\'s alone, and index.ts calls listenPublic', () => {
  function enclosingFunctionName(lines: string[], lineIndex: number): string | null {
    for (let i = lineIndex; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined) continue;
      const match = line.match(/^\s*(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
      if (match && match[1] !== undefined) return match[1];
    }
    return null;
  }

  it('every `.listen(` under src/ sits in listenPublic or createAdminApp, and src/index.ts has one `listenPublic(` call', () => {
    const hits: { file: string; line: number; enclosing: string | null }[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const content = readFileSync(full, 'utf8');
          const lines = content.split('\n');
          const relative = full.replace(SRC_DIR + '/', '');
          lines.forEach((line, i) => {
            if (/\.listen\(/.test(line)) {
              hits.push({ file: relative, line: i + 1, enclosing: enclosingFunctionName(lines, i) });
            }
          });
        }
      }
    }

    walk(SRC_DIR);

    const enclosingByFile = hits.map(h => `${h.file}:${h.enclosing}`).sort();
    expect(enclosingByFile).toEqual([
      'server.ts:createAdminApp',
      'server.ts:listenPublic',
    ]);

    const indexTs = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8');
    const listenPublicCalls = indexTs.match(/\blistenPublic\(/g) ?? [];
    expect(listenPublicCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// listenPublic — the bounds and the budget
// ---------------------------------------------------------------------------

/**
 * The helpers below set up a public server with a tracked set of server-side
 * sockets, as `NODE_INTERFACE → The public server → "The node holds at most
 * HTTP_UNREAD_ANSWER_BYTES (64 MiB) of answers its readers have not taken"`
 * describes the sweep's view: `'connection'` adds one, its `'close'` drops it.
 */

interface ServerHarness {
  server: http.Server;
  serverSockets: Set<net.Socket>;
  closedServerSockets: Set<net.Socket>;
}

function startHarness(app: express.Express): ServerHarness {
  const server = listenPublic(app, 0);
  const serverSockets = new Set<net.Socket>();
  const closedServerSockets = new Set<net.Socket>();
  server.on('connection', (s: net.Socket) => {
    serverSockets.add(s);
    s.on('close', () => {
      serverSockets.delete(s);
      closedServerSockets.add(s);
    });
  });
  return { server, serverSockets, closedServerSockets };
}

async function serverPort(server: http.Server): Promise<number> {
  if (!server.listening) await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor exceeded ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function closeHarness(h: ServerHarness, clients: net.Socket[]): Promise<void> {
  for (const c of clients) {
    try { c.destroy(); } catch { /* already gone */ }
  }
  for (const s of h.serverSockets) {
    try { s.destroy(); } catch { /* already gone */ }
  }
  h.server.close();
  if (h.server.listening) await once(h.server, 'close').catch(() => undefined);
}

async function openSilentReader(port: number, bodySize: number): Promise<net.Socket> {
  const client = net.connect(port);
  client.pause();
  await once(client, 'connect');
  client.write(
    `GET /body?size=${bodySize} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
  );
  return client;
}

function bodyApp(): express.Express {
  const app = express();
  app.get('/body', (req, res) => {
    const size = Number(req.query['size']);
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.write(Buffer.alloc(size));
    res.end();
  });
  return app;
}

function sumWritable(sockets: Set<net.Socket>): number {
  let total = 0;
  for (const s of sockets) total += s.writableLength;
  return total;
}

function findServerSocketByRemotePort(sockets: Set<net.Socket>, remotePort: number): net.Socket | null {
  for (const s of sockets) {
    if (s.remotePort === remotePort) return s;
  }
  return null;
}

function httpPing(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/ping`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('listenPublic sets the deadlines, the connection bound and the unread-answer budget', () => {
  it.fails('each of the six bounds read off the returned server equals its constant', async () => {
    const app = express();
    const server = listenPublic(app, 0);
    try {
      await once(server, 'listening');
      // Control: the server actually started.
      expect(server.listening).toBe(true);

      // NODE_INTERFACE → The public server
      expect(server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
      expect(server.requestTimeout).toBe(HTTP_REQUEST_TIMEOUT_MS);
      expect(server.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
      expect((server as http.Server & { connectionsCheckingInterval?: number }).connectionsCheckingInterval)
        .toBe(HTTP_CHECK_INTERVAL_MS);
      expect(server.timeout).toBe(HTTP_IDLE_TIMEOUT_MS);
      expect(server.maxConnections).toBe(HTTP_CONNECTIONS_MAX);
    } finally {
      server.close();
    }
  });

  it.fails('over the budget: the largest holder is among the closed, and the open connections sum within the budget', async () => {
    const BIG_SIZE = 50 * 1024 * 1024;   // 50 MiB — larger than every other
    const MED_SIZE = 10 * 1024 * 1024;   // 10 MiB
    const MED_COUNT = 5;                 // 5 × 10 = 50 MiB, plus 50 BIG = 100 MiB in flight

    const h = startHarness(bodyApp());
    const clients: net.Socket[] = [];
    try {
      const port = await serverPort(h.server);

      const bigClient = await openSilentReader(port, BIG_SIZE);
      clients.push(bigClient);
      for (let i = 0; i < MED_COUNT; i++) {
        clients.push(await openSilentReader(port, MED_SIZE));
      }

      // Control: the server received every connection.
      await waitFor(() => h.serverSockets.size === MED_COUNT + 1, 10_000);
      expect(h.serverSockets.size).toBe(MED_COUNT + 1);

      // Control: the big client's server-side socket is identifiable by its remote port.
      const bigRemotePort = bigClient.localPort;
      expect(typeof bigRemotePort).toBe('number');
      const bigServerSocket = findServerSocketByRemotePort(h.serverSockets, bigRemotePort!);
      expect(bigServerSocket).not.toBeNull();

      // Control: the summed writableLength is above the budget — bytes queued and nobody reading.
      await waitFor(() => sumWritable(h.serverSockets) > HTTP_UNREAD_ANSWER_BYTES, 10_000);
      expect(sumWritable(h.serverSockets)).toBeGreaterThan(HTTP_UNREAD_ANSWER_BYTES);

      // Control: a server-side close fires once the sweep runs.
      await waitFor(() => h.closedServerSockets.size > 0, 10_000);
      expect(h.closedServerSockets.size).toBeGreaterThan(0);

      // The largest holder is among the closed, and the open sum is within the budget.
      expect(h.closedServerSockets.has(bigServerSocket!)).toBe(true);
      expect(sumWritable(h.serverSockets)).toBeLessThanOrEqual(HTTP_UNREAD_ANSWER_BYTES);
    } finally {
      await closeHarness(h, clients);
    }
  });

  it.fails('under the budget: no connection is closed across three check intervals', async () => {
    // The positive control arrangement — one above-budget probe closes under
    // the sweep — holds the arrangement to the sweep's reality before the
    // quarter-sum arrangement makes its negative claim.
    const PROBE_SIZE = 80 * 1024 * 1024; // 80 MiB — above the 64 MiB budget alone
    const SMALL_SIZE = 4 * 1024 * 1024;  // 4 MiB
    const COUNT = 4;                     // 4 × 4 MiB = 16 MiB — a quarter of the 64 MiB budget

    const h = startHarness(bodyApp());
    const clients: net.Socket[] = [];
    try {
      const port = await serverPort(h.server);

      // Positive control: one above-budget probe closes under the sweep.
      const probe = await openSilentReader(port, PROBE_SIZE);
      clients.push(probe);
      await waitFor(() => h.serverSockets.size === 1, 10_000);
      expect(h.serverSockets.size).toBe(1);
      await waitFor(() => sumWritable(h.serverSockets) > HTTP_UNREAD_ANSWER_BYTES, 10_000);
      await waitFor(() => h.closedServerSockets.size > 0, 10_000);
      expect(h.closedServerSockets.size).toBeGreaterThan(0);
      const beforeQuarterArrangement = h.closedServerSockets.size;

      // The quarter-sum arrangement.
      for (let i = 0; i < COUNT; i++) {
        clients.push(await openSilentReader(port, SMALL_SIZE));
      }

      // Control: the server received every quarter-sum connection.
      await waitFor(() => h.serverSockets.size === COUNT, 10_000);
      expect(h.serverSockets.size).toBe(COUNT);

      // Control: bytes are queued on the server side.
      await waitFor(() => sumWritable(h.serverSockets) > 0, 10_000);
      const queued = sumWritable(h.serverSockets);
      expect(queued).toBeGreaterThan(0);

      // Control: the summed writableLength is well within the budget.
      expect(queued).toBeLessThan(HTTP_UNREAD_ANSWER_BYTES);

      // Three check intervals elapse.
      await sleep(HTTP_CHECK_INTERVAL_MS * 3 + 500);

      // Nothing more closes on the server side.
      expect(h.closedServerSockets.size).toBe(beforeQuarterArrangement);
    } finally {
      await closeHarness(h, clients);
    }
  });

  it.fails('beside the over-budget arrangement, a client that reads its answer receives it whole', async () => {
    const BIG_SIZE = 50 * 1024 * 1024;
    const MED_SIZE = 10 * 1024 * 1024;
    const MED_COUNT = 5;
    const READER_SIZE = 4 * 1024 * 1024;

    const h = startHarness(bodyApp());
    const clients: net.Socket[] = [];
    try {
      const port = await serverPort(h.server);

      // Over-budget silent clients, their local ports held for the sweep check.
      const silentRemotePorts = new Set<number>();
      const big = await openSilentReader(port, BIG_SIZE);
      clients.push(big);
      silentRemotePorts.add(big.localPort!);
      for (let i = 0; i < MED_COUNT; i++) {
        const c = await openSilentReader(port, MED_SIZE);
        clients.push(c);
        silentRemotePorts.add(c.localPort!);
      }

      // The reader.
      const reader = net.connect(port);
      clients.push(reader);
      let received = 0;
      reader.on('data', (d: Buffer) => { received += d.length; });
      await once(reader, 'connect');
      reader.write(
        `GET /body?size=${READER_SIZE} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );

      // Control: every connection reached the server.
      await waitFor(() => h.serverSockets.size === MED_COUNT + 2, 10_000);
      expect(h.serverSockets.size).toBe(MED_COUNT + 2);

      // Control: the arrangement is above the budget.
      await waitFor(() => sumWritable(h.serverSockets) > HTTP_UNREAD_ANSWER_BYTES, 10_000);
      expect(sumWritable(h.serverSockets)).toBeGreaterThan(HTTP_UNREAD_ANSWER_BYTES);

      // Control: a silent (never-read) client closes under the sweep.
      const silentClosed = (): boolean => {
        for (const s of h.closedServerSockets) {
          if (s.remotePort !== undefined && silentRemotePorts.has(s.remotePort)) return true;
        }
        return false;
      };
      await waitFor(silentClosed, 10_000);
      expect(silentClosed()).toBe(true);

      // The reader receives the whole body.
      await waitFor(() => received >= READER_SIZE, 15_000);
      expect(received).toBeGreaterThanOrEqual(READER_SIZE);
    } finally {
      await closeHarness(h, clients);
    }
  });

  it.fails('HTTP_CONNECTIONS_MAX raw connections are all held, one more is dropped with no byte answered and emits drop, and a freed slot answers a request', async () => {
    const app = express();
    app.get('/ping', (_req, res) => { res.status(200).end('pong'); });

    const h = startHarness(app);
    const dropped: unknown[] = [];
    h.server.on('drop', (info: unknown) => { dropped.push(info); });

    const held: net.Socket[] = [];
    let extra: net.Socket | null = null;
    try {
      const port = await serverPort(h.server);

      await Promise.all(
        Array.from({ length: HTTP_CONNECTIONS_MAX }, async () => {
          const c = net.connect(port);
          c.pause();
          held.push(c);
          await once(c, 'connect');
        }),
      );

      // Control: the server's connection count reached the bound.
      await waitFor(() => h.serverSockets.size === HTTP_CONNECTIONS_MAX, 20_000);
      expect(h.serverSockets.size).toBe(HTTP_CONNECTIONS_MAX);

      // One more.
      extra = net.connect(port);
      let bytesFromExtra = 0;
      extra.on('data', (d: Buffer) => { bytesFromExtra += d.length; });
      await waitFor(() => extra!.destroyed, 10_000);

      // Control: the server emitted 'drop' for the extra connection.
      expect(dropped.length).toBeGreaterThan(0);
      // Control: no bytes come back to it.
      expect(bytesFromExtra).toBe(0);

      // Free one held slot.
      const freed = held[0]!;
      freed.destroy();
      await waitFor(() => h.serverSockets.size < HTTP_CONNECTIONS_MAX, 10_000);

      // A real request is answered.
      const result = await httpPing(port);
      expect(result.status).toBe(200);
    } finally {
      await closeHarness(h, [...held, ...(extra ? [extra] : [])]);
    }
  });
});
