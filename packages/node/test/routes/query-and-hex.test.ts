// NODE_INTERFACE → HTTP API → "A query parameter is one string";
// NODE_INTERFACE → HTTP API → "Hex is lowercase".
//
// A query name holds one string: a repeated name answers 400 ahead of the
// routes, a bracketed name is a name of its own that no route reads. A hex
// value in a path, a body or a query is lowercase, and any other spelling is
// a 400 on every route.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import type { MockInstance } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { createApp } from '../../src/server.js';
import { makeTestConfig, activateProverOverStore } from '../helpers.js';

// A valid 64-char lowercase hex key, and its uppercase spelling.
const LOWER_KEY = 'ab'.repeat(32);
const UPPER_KEY = 'AB'.repeat(32);

// A tree key — 130 lowercase hex — and its uppercase spelling.
const LOWER_TREE_KEY = 'cd'.repeat(65);
const UPPER_TREE_KEY = 'CD'.repeat(65);

// A valid 64-char lowercase hex post id (unknown to the store).
const LOWER_POST_ID = 'ef'.repeat(32);
const UPPER_POST_ID = 'EF'.repeat(32);

// A box id, lowercase, and its uppercase spelling — rides inside `after`.
const LOWER_BOX_ID = '12'.repeat(32);
const UPPER_BOX_ID = '12'.repeat(31) + '1A';

describe('a query parameter is one string, and hex is lowercase', () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpDir: string;
  let shellPath: string;
  let errorSpy: MockInstance<[message?: unknown, ...optionalParams: unknown[]], void>;

  beforeAll(async () => {
    initDb(':memory:');
    getDb()
      .prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)')
      .run();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagsocial-query-and-hex-'));
    shellPath = path.join(tmpDir, 'index.html');
    fs.writeFileSync(
      shellPath,
      '<!doctype html><html><head><title>Notis</title></head><body></body></html>',
      'utf-8',
    );
    // The AVL prover's singleton is what createApp reads to mount
    // /api/v1/proof and /api/v1/range (NODE_INTERFACE → AVL+ State Root).
    await activateProverOverStore();
    const app = createApp(makeTestConfig({ webShellPath: shellPath }));
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Array- and object-shaped query names
  // ---------------------------------------------------------------------------

  it.fails(
    'GET /posts?after[]=1:0 answers 200 — after[] is no name a route reads',
    async () => {
      const res = await fetch(`${baseUrl}/posts?after%5B%5D=1:0`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
    },
  );

  it.fails(
    'GET /karma/<key>?after[]=x answers 200 — after[] is no name a route reads',
    async () => {
      const res = await fetch(`${baseUrl}/karma/${LOWER_KEY}?after%5B%5D=x`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
    },
  );

  it.fails(
    'GET /vouches?target[]=<key> answers the route\'s own 400 — no target was given',
    async () => {
      const res = await fetch(`${baseUrl}/vouches?target%5B%5D=${LOWER_KEY}`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: unknown; reason?: unknown };
      expect(String(body.reason ?? body.error)).toContain('?target=');
    },
  );

  // ---------------------------------------------------------------------------
  // A name given twice
  // ---------------------------------------------------------------------------

  it.fails(
    'GET /posts?limit=1&limit=2 answers 400 query parameter limit given twice',
    async () => {
      const res = await fetch(`${baseUrl}/posts?limit=1&limit=2`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 400,
        reason: 'query parameter limit given twice',
      });
    },
  );

  it.fails(
    'GET /posts?foo=1&foo=2 answers 400 naming foo — a name no route reads is refused the same',
    async () => {
      const res = await fetch(`${baseUrl}/posts?foo=1&foo=2`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 400,
        reason: 'query parameter foo given twice',
      });
    },
  );

  // ---------------------------------------------------------------------------
  // An uppercase hex spelling in an identity parameter or an `after` cursor
  // ---------------------------------------------------------------------------

  it.fails('GET /posts?author=<key in uppercase> answers 400', async () => {
    const res = await fetch(`${baseUrl}/posts?author=${UPPER_KEY}`);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it.fails('GET /karma/<key in uppercase> answers 400', async () => {
    const res = await fetch(`${baseUrl}/karma/${UPPER_KEY}`);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it.fails('GET /usernames?owner=<key in uppercase> answers 400', async () => {
    const res = await fetch(`${baseUrl}/usernames?owner=${UPPER_KEY}`);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it.fails(
    'GET /karma/<key>?after=<value>:<box id in uppercase> answers 400',
    async () => {
      const res = await fetch(
        `${baseUrl}/karma/${LOWER_KEY}?after=100:${UPPER_BOX_ID}`,
      );
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /posts/batch — an uppercase id
  // ---------------------------------------------------------------------------

  it.fails(
    'POST /posts/batch { ids: [<id in uppercase>] } answers 400 ids must be 64 lowercase hex characters',
    async () => {
      const res = await fetch(`${baseUrl}/posts/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [UPPER_POST_ID] }),
      });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: unknown };
      expect(body.error).toBe('ids must be 64 lowercase hex characters');
    },
  );

  // ---------------------------------------------------------------------------
  // GET /posts/:id and GET /posts/:id/thread — an uppercase or malformed id
  // ---------------------------------------------------------------------------

  it.fails(
    'GET /posts/<id in uppercase> answers 400 — the shape check runs ahead of the lookup',
    async () => {
      const res = await fetch(`${baseUrl}/posts/${UPPER_POST_ID}`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
    },
  );

  it.fails(
    'GET /posts/<id in uppercase>/thread answers 400 — the shape check runs ahead of the lookup',
    async () => {
      const res = await fetch(`${baseUrl}/posts/${UPPER_POST_ID}/thread`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
    },
  );

  it.fails(
    'GET /posts/<malformed id> answers 400 — the same shape check',
    async () => {
      const res = await fetch(`${baseUrl}/posts/xyz`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
    },
  );

  it.fails(
    'GET /posts/<malformed id>/thread answers 400 — the same shape check',
    async () => {
      const res = await fetch(`${baseUrl}/posts/xyz/thread`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/v1/proof/:key and GET /api/v1/range/:kind/:owner — uppercase hex
  // ---------------------------------------------------------------------------

  it.fails(
    'GET /api/v1/proof/<130 hex in uppercase> answers 400',
    async () => {
      const res = await fetch(`${baseUrl}/api/v1/proof/${UPPER_TREE_KEY}`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
    },
  );

  it.fails(
    'GET /api/v1/range/karma/<owner in uppercase> answers 400',
    async () => {
      const res = await fetch(`${baseUrl}/api/v1/range/karma/${UPPER_KEY}`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
    },
  );

  it.fails(
    'GET /api/v1/range/karma/<owner>?from=<key in uppercase> answers 400',
    async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/range/karma/${LOWER_KEY}?from=${UPPER_TREE_KEY}`,
      );
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /shell/:id — an uppercase id
  // ---------------------------------------------------------------------------

  it.fails(
    'GET /shell/<id in uppercase> answers 400 — the shell\'s own regex refuses it',
    async () => {
      const res = await fetch(`${baseUrl}/shell/${UPPER_POST_ID}`);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
    },
  );

  // ---------------------------------------------------------------------------
  // Controls — a request with its hex lowercase and its names given once
  // answers as the standing code has it.
  // ---------------------------------------------------------------------------

  it('control: GET /posts?after=0:0 answers 200', async () => {
    const res = await fetch(`${baseUrl}/posts?after=0:0`);
    expect(res.status).toBe(200);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('control: GET /karma/<lowercase key>?after=100:<lowercase box id> answers 200', async () => {
    const res = await fetch(
      `${baseUrl}/karma/${LOWER_KEY}?after=100:${LOWER_BOX_ID}`,
    );
    expect(res.status).toBe(200);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it(
    'control: GET /vouches?target=<lowercase key> answers 200 — an empty page',
    async () => {
      const res = await fetch(`${baseUrl}/vouches?target=${LOWER_KEY}`);
      expect(res.status).toBe(200);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it('control: GET /posts?limit=1 answers 200', async () => {
    const res = await fetch(`${baseUrl}/posts?limit=1`);
    expect(res.status).toBe(200);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('control: GET /posts?foo=1 answers 200 — a name no route reads is ignored', async () => {
    const res = await fetch(`${baseUrl}/posts?foo=1`);
    expect(res.status).toBe(200);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it(
    'control: GET /posts/<lowercase id>/thread answers 404 — an id the node has never heard of',
    async () => {
      const res = await fetch(`${baseUrl}/posts/${LOWER_POST_ID}/thread`);
      expect(res.status).toBe(404);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it(
    'control: POST /posts/batch { ids: [<lowercase id>] } answers 200',
    async () => {
      const res = await fetch(`${baseUrl}/posts/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [LOWER_POST_ID] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { posts: unknown[] };
      expect(body.posts).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it(
    'control: GET /api/v1/proof/<130 lowercase hex> answers 200',
    async () => {
      const res = await fetch(`${baseUrl}/api/v1/proof/${LOWER_TREE_KEY}`);
      expect(res.status).toBe(200);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it(
    'control: GET /api/v1/range/karma/<lowercase owner> answers 200',
    async () => {
      const res = await fetch(`${baseUrl}/api/v1/range/karma/${LOWER_KEY}`);
      expect(res.status).toBe(200);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it(
    'control: GET /shell/<lowercase id> answers the untagged shell 404 — the node holds no post of that id',
    async () => {
      const res = await fetch(`${baseUrl}/shell/${LOWER_POST_ID}`);
      expect(res.status).toBe(404);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );
});
