import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, it, expect } from 'vitest';
import { fetchJson, readCappedJson, type HttpFetch } from '../src/http.js';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  server.on('connection', (s) => sockets.push(s));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

// The deadline is the runtime's own: the request runs under a short signal of
// the test's in place of the one it is handed.
const underShortDeadline: HttpFetch = (url) =>
  fetch(url, { signal: AbortSignal.timeout(100) });

describe('fetchJson', () => {
  // A hung node must not stall the run, so every call carries a timeout signal.
  it('attaches a timeout signal to the request', async () => {
    let seen: RequestInit | undefined;
    const fake = async (_url: string, init?: RequestInit): Promise<Response> => {
      seen = init;
      return new Response('{}', { status: 200 });
    };
    await fetchJson(fake, 'http://node', 1_024);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  // NIPOPOW_INTERFACE → compareProofs — one dead or hostile peer is refused,
  // not fatal, so the reachable nodes still decide.
  it('reports a transport failure as a non-ok result, never a throw', async () => {
    const fake = async (): Promise<Response> => { throw new TypeError('fetch failed'); };
    const res = await fetchJson(fake, 'http://node', 1_024);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(0);
      expect(res.body).toContain('fetch failed');
    }
  });

  // A 200 whose body will not parse is one node's fault, not the run's.
  it('reports an unparseable 200 body as a non-ok result, never a throw', async () => {
    const fake = async (): Promise<Response> => new Response('not json', { status: 200 });
    const res = await fetchJson(fake, 'http://node', 1_024);
    expect(res.ok).toBe(false);
  });
});

describe('a failed read the deadline ended', () => {
  // WEB_INTERFACE → Reading a node's answer → "A failure the deadline ended says so"
  const deadlineBeforeAnswer = async (): Promise<void> => {
    const url = await listen(() => { /* accepts, never writes */ });
    const r = await fetchJson(underShortDeadline, url, 1_024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.timedOut).toBe(true);
  };
  const deadlineMidBody = async (): Promise<void> => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"a":');
    });
    const res = await fetch(url, { signal: AbortSignal.timeout(100) });
    const r = await readCappedJson(res, 1_024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.timedOut).toBe(true);
  };

  it('is marked when the deadline falls before any answer', deadlineBeforeAnswer);
  it('is marked when the deadline falls while the body is read', deadlineMidBody);

  it('carries no mark on a refused connection', async () => {
    const url = await listen((_req, res) => res.end('{}'));
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    const r = await fetchJson(underShortDeadline, url, 1_024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect('timedOut' in r).toBe(false);
  });

  it('carries no mark on a body stream that errors', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() { throw new Error('reset'); },
    });
    const r = await readCappedJson(new Response(stream), 1_024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect('timedOut' in r).toBe(false);
  });

  it('reads an answer the deadline did not end', async () => {
    const url = await listen((_req, res) => res.end('{}'));
    const r = await fetchJson(underShortDeadline, url, 1_024);
    expect(r.ok).toBe(true);
  });
});
