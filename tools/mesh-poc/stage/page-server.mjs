// MESH_INTERFACE → Acceptance — the browser's page is served from
// `http://localhost:<port>` inside the browser namespace. A tiny static
// server reads `SERVE_DIR` for every path and splices `CONFIG_PATH` at
// `/config.json`. No cache headers; no cookies; the one role is to answer
// bytes.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const SERVE_DIR = resolve(process.env.SERVE_DIR ?? './dist-page');
const CONFIG_PATH = process.env.CONFIG_PATH ?? '';
const PORT = Number(process.env.PAGE_PORT ?? '80');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    let path = url.pathname;
    if (path === '/config.json' && CONFIG_PATH !== '') {
      const body = await readFile(CONFIG_PATH);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    if (path === '/') path = '/index.html';
    const normalized = normalize(path);
    if (normalized.includes('..')) {
      res.writeHead(400); res.end('bad request'); return;
    }
    const full = join(SERVE_DIR, normalized);
    if (!full.startsWith(SERVE_DIR)) {
      res.writeHead(400); res.end('bad request'); return;
    }
    const s = await stat(full);
    if (!s.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const body = await readFile(full);
    const ct = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct, 'content-length': String(body.length) });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(500); res.end(err.message);
  }
});

server.on('error', (err) => {
  process.stderr.write(`page-server: ${err.message}\n`);
  process.exit(1);
});
server.listen(PORT, () => {
  process.stdout.write(`page-server listening on :${PORT}\n`);
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
