import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../src/store/db.js';
import { createApp } from '../src/server.js';
import { insertPost, confirmPost, withdrawPost } from '../src/store/posts.js';
import { putUsername } from '../src/store/usernames.js';
import { makeTestConfig, makePostCommit, fixturePostId, uid, toHex } from './helpers.js';

// NODE_INTERFACE → Link previews: GET /shell/:id answers the web client's
// shell with a post's preview tags injected, gated by WEB_SHELL_PATH
// (NODE_INTERFACE → Configuration).
describe('GET /shell/:id', () => {
  const SITE_BLOCK = [
    '<meta name="description" content="Reputation not for sale">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Notis">',
    '<meta property="og:title" content="Notis">',
    '<meta property="og:description" content="Reputation not for sale">',
    '<meta property="og:image" content="https://example.test/web/og.png">',
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="The Notis mark">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta content="Notis social" property="og:title:alt">',
  ].join('\n');
  const SHELL_HTML = `<!doctype html><html><head><title>Notis</title>\n${SITE_BLOCK}\n</head><body></body></html>`;

  let tmpDir: string;
  let shellPath: string;

  beforeAll(() => {
    initDb(':memory:');
    getDb()
      .prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)')
      .run();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagsocial-shell-'));
    shellPath = path.join(tmpDir, 'index.html');
    fs.writeFileSync(shellPath, SHELL_HTML, 'utf-8');
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function startApp(webShellPath: string): { port: number; close: () => void } {
    const app = createApp(makeTestConfig({ webShellPath }));
    const server = app.listen(0);
    const addr = server.address() as AddressInfo;
    return { port: addr.port, close: () => server.close() };
  }

  // Node's global fetch refuses to send a caller-set Host header (it always
  // carries the real connection target), so the og:url case that pins a
  // literal `Host` header goes through a raw request instead.
  function getWithHeaders(
    port: number,
    urlPath: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port, path: urlPath, method: 'GET', headers },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('answers 404 and never reads the file when WEB_SHELL_PATH is empty', async () => {
    const { port, close } = startApp('');
    try {
      const res = await fetch(`http://localhost:${port}/shell/${'a'.repeat(64)}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const body = await res.text();
      expect(body).not.toContain('<title>');
    } finally {
      close();
    }
  });

  it('answers 500 when the configured file cannot be read', async () => {
    const { port, close } = startApp(path.join(tmpDir, 'does-not-exist.html'));
    try {
      const res = await fetch(`http://localhost:${port}/shell/${'a'.repeat(64)}`);
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toContain('text/plain');
    } finally {
      close();
    }
  });

  it('answers 400 for an id that is not 64 hex characters', async () => {
    const { port, close } = startApp(shellPath);
    try {
      const res = await fetch(`http://localhost:${port}/shell/${'a'.repeat(63)}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: number };
      expect(body.error).toBe(400);
    } finally {
      close();
    }
  });

  it('answers 404 with the untagged shell for an id the node has never heard of — site block intact', async () => {
    const { port, close } = startApp(shellPath);
    try {
      const res = await fetch(`http://localhost:${port}/shell/${'b'.repeat(64)}`);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('<title>Notis</title>');
      expect(html).toContain('og:title');
      expect(html).toContain('Reputation not for sale');
      expect(html).toContain('og:image');
      expect(html).toContain('twitter:card');
    } finally {
      close();
    }
  });

  it('tags a live post with content: title, every meta tag, description cut at a word', async () => {
    const author = uid('shell-live-author');
    // Sliced at 197 chars: an embedded blank run collapses to one space, and
    // the word straddling the cut is dropped whole rather than left partial.
    const prefix = 'x'.repeat(90) + '\n\n' + 'x'.repeat(98);
    const content = prefix + ' wordone' +
      ' padding well beyond two hundred characters so the cut always triggers xxxxxxxxxxxxxxxxxxxx';
    const commit = makePostCommit(author, content);
    const id = fixturePostId(commit);
    insertPost(id, commit, content);
    confirmPost(id, 10, 0);

    const { port, close } = startApp(shellPath);
    try {
      const res = await fetch(`http://localhost:${port}/shell/${id}`);
      expect(res.status).toBe(200);
      const html = await res.text();

      const authorHex = toHex(author);
      const expectedTitle = `${authorHex.slice(0, 16)}… · Notis`;
      const expectedDescription = 'x'.repeat(90) + ' ' + 'x'.repeat(98) + '...';

      expect(html).toContain(`<title>${expectedTitle}</title>`);
      expect(html).toContain(`<meta property="og:title" content="${expectedTitle}">`);
      expect(html).toContain(`<meta name="description" content="${expectedDescription}">`);
      expect(html).toContain(`<meta property="og:description" content="${expectedDescription}">`);
      expect(html).toContain('<meta property="og:type" content="article">');
      expect(html).toContain('<meta property="og:site_name" content="Notis">');
      expect(html).toContain('<meta name="twitter:card" content="summary">');
      // NODE_INTERFACE → Link previews → "A tagged answer replaces the shell's
      // own preview tags": no og:image, no site values, one of each tag.
      expect(html).not.toContain('og:image');
      expect(html).not.toContain('Reputation not for sale');
      expect(html).not.toContain('summary_large_image');
      expect(html).not.toContain('og:title:alt');
      expect(html.match(/og:title/g)).toHaveLength(1);
      expect(html.match(/og:description/g)).toHaveLength(1);
      expect(html.match(/name="description"/g)).toHaveLength(1);
      expect(html.match(/twitter:card/g)).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('titles a live post @Name when the author holds a username', async () => {
    const author = uid('shell-named-author');
    const content = 'a post by an author with a username';
    const commit = makePostCommit(author, content);
    const id = fixturePostId(commit);
    insertPost(id, commit, content);
    confirmPost(id, 16, 0);

    const authorHex = toHex(author);
    putUsername({
      nameLower: 'alice_01',
      name: 'Alice_01',
      owner: authorHex,
      boxId: 'a'.repeat(64),
      claimedAtBlock: 5,
    });

    const { port, close } = startApp(shellPath);
    try {
      const res = await fetch(`http://localhost:${port}/shell/${id}`);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('<title>@Alice_01 · Notis</title>');
      expect(html).toContain('<meta property="og:title" content="@Alice_01 · Notis">');
      expect(html).not.toContain('og:image');
      expect(html).not.toContain('Reputation not for sale');
      expect(html.match(/og:title/g)).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('HTML-escapes content holding <script>, quotes and ampersands', async () => {
    const author = uid('shell-escape-author');
    const content = 'a <script>alert("x")</script> & <b>bold</b>';
    const commit = makePostCommit(author, content);
    const id = fixturePostId(commit);
    insertPost(id, commit, content);
    confirmPost(id, 11, 0);

    const { port, close } = startApp(shellPath);
    try {
      const res = await fetch(`http://localhost:${port}/shell/${id}`);
      const html = await res.text();

      const expectedDescription =
        'a &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;';
      expect(html).toContain(`<meta name="description" content="${expectedDescription}">`);
      expect(html).toContain(`<meta property="og:description" content="${expectedDescription}">`);
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert("x")');

      // The title is author-derived only, so content can never reach it —
      // pinned anyway: no raw '<' between its open and close tag.
      const titleStart = html.indexOf('<title>') + '<title>'.length;
      const titleEnd = html.indexOf('</title>');
      expect(html.slice(titleStart, titleEnd)).not.toContain('<');
      expect(html).not.toContain('og:image');
      expect(html.match(/name="description"/g)).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('sets og:url from X-Original-URI, X-Forwarded-Proto and Host; omits it without the header', async () => {
    const author = uid('shell-url-author');
    const content = 'a post with a canonical url';
    const commit = makePostCommit(author, content);
    const id = fixturePostId(commit);
    insertPost(id, commit, content);
    confirmPost(id, 12, 0);

    const { port, close } = startApp(shellPath);
    try {
      const withHeader = await getWithHeaders(port, `/shell/${id}`, {
        'X-Original-URI': `/web/p/${id}`,
        'X-Forwarded-Proto': 'https',
        'Host': 'notis.fun',
      });
      expect(withHeader.status).toBe(200);
      expect(withHeader.body).toContain(
        `<meta property="og:url" content="https://notis.fun/web/p/${id}">`,
      );

      const withoutHeader = await fetch(`http://localhost:${port}/shell/${id}`);
      const htmlWithout = await withoutHeader.text();
      expect(htmlWithout).not.toContain('og:url');
    } finally {
      close();
    }
  });

  it('tags a withdrawn post as withdrawn, with no og:url', async () => {
    const author = uid('shell-withdrawn-author');
    const content = 'a post that will be withdrawn';
    const commit = makePostCommit(author, content);
    const id = fixturePostId(commit);
    insertPost(id, commit, content);
    confirmPost(id, 13, 0);
    withdrawPost(id, 14);

    const { port, close } = startApp(shellPath);
    try {
      const res = await getWithHeaders(port, `/shell/${id}`, {
        'X-Original-URI': `/web/p/${id}`,
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain(`<title>withdrawn · Notis</title>`);
      expect(res.body).toContain(
        '<meta property="og:description" content="withdrawn by its author">',
      );
      expect(res.body).not.toContain('og:url');
      expect(res.body).not.toContain('og:image');
      expect(res.body).not.toContain('Reputation not for sale');
      expect(res.body.match(/og:description/g)).toHaveLength(1);
      expect(res.body.match(/twitter:card/g)).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('reads the shell file fresh on every request', async () => {
    const freshPath = path.join(tmpDir, 'fresh.html');
    fs.writeFileSync(freshPath, SHELL_HTML, 'utf-8');
    const { port, close } = startApp(freshPath);
    try {
      const id = 'c'.repeat(64);
      const first = await fetch(`http://localhost:${port}/shell/${id}`);
      expect(await first.text()).toContain('<title>Notis</title>');

      fs.writeFileSync(
        freshPath,
        '<!doctype html><html><head><title>Notis</title><meta name="marker" content="v2"></head><body></body></html>',
        'utf-8',
      );

      const second = await fetch(`http://localhost:${port}/shell/${id}`);
      expect(await second.text()).toContain('marker');
    } finally {
      close();
    }
  });

  it('answers 200 untagged for a live post whose content has not arrived yet — site block intact', async () => {
    const author = uid('shell-placeholder-author');
    const commit = makePostCommit(author, 'placeholder body, not stored on this node');
    const id = fixturePostId(commit);
    insertPost(id, commit, null);
    confirmPost(id, 15, 0);

    const { port, close } = startApp(shellPath);
    try {
      const res = await fetch(`http://localhost:${port}/shell/${id}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<title>Notis</title>');
      expect(html).toContain('Reputation not for sale');
      expect(html).toContain('og:image');
      expect(html).toContain('twitter:card');
    } finally {
      close();
    }
  });
});
