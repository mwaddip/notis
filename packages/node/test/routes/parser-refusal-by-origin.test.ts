import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { createApp } from '../../src/server.js';
import * as store from '../../src/store/index.js';
import { insertPost, confirmPost } from '../../src/store/posts.js';
import {
  makeTestConfig,
  makePostCommit,
  fixturePostId,
  fixtureTxId,
  uid,
} from '../helpers.js';

// NODE_INTERFACE → HTTP API → "A refusal is the parser's by where it comes from"

describe('an encoded request body is refused unread', () => {
  let publicServer: http.Server;
  let publicUrl: string;
  let shellDir: string;
  let shellPath: string;
  let livePostId: string;

  beforeAll(async () => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    shellDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagsocial-decompress-'));
    shellPath = path.join(shellDir, 'index.html');
    fs.writeFileSync(
      shellPath,
      '<!doctype html><html><head><title>Notis</title></head><body></body></html>',
      'utf-8',
    );
    const author = uid('decompress-author');
    const content = 'a live post for the decompression coverage';
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

  type RawRes = { status: number; headers: Map<string, string>; body: string };

  function postRaw(encoding: string, body: string | Buffer): Promise<RawRes> {
    const url = new URL(publicUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: '/posts/batch',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': encoding,
          },
        },
        (res) => {
          const headers = new Map<string, string>();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers.set(k.toLowerCase(), v);
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf-8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  it('a gzip-encoded body answers 415 bad request body with nosniff', async () => {
    const r = await postRaw('gzip', '{bad}');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.has('x-powered-by')).toBe(false);
    expect({ status: r.status, body: JSON.parse(r.body) }).toEqual({
      status: 415,
      body: { error: 415, reason: 'bad request body' },
    });
  });

  it('a deflate-encoded body answers 415 bad request body with nosniff', async () => {
    const r = await postRaw('deflate', '{bad}');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.has('x-powered-by')).toBe(false);
    expect({ status: r.status, body: JSON.parse(r.body) }).toEqual({
      status: 415,
      body: { error: 415, reason: 'bad request body' },
    });
  });

  it('a gzip-encoded body is refused before its bytes are read — 415, never a decompression error', async () => {
    const r = await postRaw('gzip', Buffer.from([0x1f, 0x8b, 0x08]));
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.has('x-powered-by')).toBe(false);
    expect({ status: r.status, body: JSON.parse(r.body) }).toEqual({
      status: 415,
      body: { error: 415, reason: 'bad request body' },
    });
  });

  it(
    'across the three encoding refusals and the sync-throw 500, console.error is called exactly once',
    async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const getPostSpy = vi.spyOn(store, 'getPost').mockImplementation(() => {
        throw new Error('store read failed');
      });
      try {
        const g = await postRaw('gzip', '{bad}');
        const d = await postRaw('deflate', '{bad}');
        const t = await postRaw('gzip', Buffer.from([0x1f, 0x8b, 0x08]));
        expect(g.status).not.toBe(0);
        expect(d.status).not.toBe(0);
        expect(t.status).not.toBe(0);
        const shell = await fetch(`${publicUrl}/shell/${livePostId}`);
        expect(shell.status).toBe(500);
        expect(errorSpy).toHaveBeenCalledTimes(1);
      } finally {
        getPostSpy.mockRestore();
        errorSpy.mockRestore();
      }
    },
  );

  it('a Content-Encoding: br body answers 415 bad request body', async () => {
    const r = await postRaw('br', '{"x":1}');
    expect(r.status).toBe(415);
    expect(JSON.parse(r.body)).toEqual({ error: 415, reason: 'bad request body' });
  });

  it("an error raised outside the parser is the node's fault whatever status it carries", async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const getPostSpy = vi.spyOn(store, 'getPost').mockImplementation(() => {
      throw Object.assign(new Error('store read failed'), { status: 400, statusCode: 400 });
    });
    try {
      // control: the parser's 415 for a gzip-encoded body counts zero calls through the same spy.
      const gzip = await postRaw('gzip', '{bad}');
      expect(gzip.status).toBe(415);
      expect(errorSpy).toHaveBeenCalledTimes(0);
      const r = await fetch(`${publicUrl}/shell/${livePostId}`);
      const body = (await r.json()) as unknown;
      expect(r.status).toBe(500);
      expect(body).toEqual({ error: 'internal' });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      getPostSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
