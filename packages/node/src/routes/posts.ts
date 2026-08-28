import { Router } from 'express';
import { createPost } from '../services/post-service.js';
import type { PostServiceDeps } from '../services/post-service.js';
import { FeedService } from '../services/feed-service.js';
import type { FeedServiceDeps } from '../services/feed-service.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import type { PostKey } from '../store/index.js';
import { parseLimit, isLimitError, parseAfter, isAfterError, parseViewer, isViewerError, formatKey } from './page.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface PostsDeps extends PostServiceDeps, FeedServiceDeps {
  getTopologyAuthor(postId: string): string | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: PostsDeps): Router {
  const router = Router();
  const feedService = new FeedService(deps);

  // POST /posts — submit a post transaction with its body
  // NODE_INTERFACE → HTTP API → Posts: { tx, content }
  router.post('/', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown>; content?: string };
    const rawTx = body.tx;
    if (!rawTx) {
      res.status(400).json({ error: 400, reason: 'tx required' });
      return;
    }
    const content = body.content;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 400, reason: 'content required (string)' });
      return;
    }

    let tx;
    try {
      tx = jsonToTx(rawTx);
    } catch (err) {
      respondError(res, err, 'POST /posts (tx decode)');
      return;
    }

    if (!tx.post) {
      res.status(400).json({ error: 400, reason: 'tx.post required' });
      return;
    }

    try {
      const result = createPost(deps, tx, content);

      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx, content).catch((err: Error) => {
          console.warn(`Failed to broadcast post transaction: ${err.message}`);
        });
      }

      res.status(200).json({
        postId: result.postId,
        status: result.status,
        expiresAtHeight: result.expiresAtHeight,
        txId: result.txId,
      });
    } catch (err) {
      respondError(res, err, 'POST /posts');
    }
  });

  // GET /posts/:id/thread
  router.get('/:id/thread', (req, res) => {
    const limit = parseLimit(req.query as Record<string, unknown>);
    if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
    const after = parseAfter(req.query as Record<string, unknown>, 'post');
    if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }
    const viewer = parseViewer(req.query as Record<string, unknown>);
    if (isViewerError(viewer)) {
      res.status(400).json({ error: viewer.error });
      return;
    }
    const thread = feedService.getThread(
      req.params['id']!,
      { limit, after: after as PostKey | undefined },
      viewer,
    );
    if (!thread) {
      res.status(404).json({ error: 404, reason: 'Post not found' });
      return;
    }
    res.json({
      ...thread,
      next: thread.next ? formatKey('post', thread.next) : null,
    });
  });

  // GET /posts/:id
  router.get('/:id', (req, res) => {
    const id = req.params['id']!;
    const viewer = parseViewer(req.query as Record<string, unknown>);
    if (isViewerError(viewer)) {
      res.status(400).json({ error: viewer.error });
      return;
    }
    const result = feedService.getPost(id, viewer);
    if (!result) {
      res.status(404).json({ error: 404, reason: 'Post not found' });
      return;
    }
    res.json({ ...result, confirmedAuthor: deps.getTopologyAuthor(id) });
  });

  // GET /posts — NODE_INTERFACE → Posts
  router.get('/', (req, res) => {
    const limit = parseLimit(req.query as Record<string, unknown>);
    if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
    const after = parseAfter(req.query as Record<string, unknown>, 'post');
    if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }
    const viewer = parseViewer(req.query as Record<string, unknown>);
    if (isViewerError(viewer)) {
      res.status(400).json({ error: viewer.error });
      return;
    }
    const authorHex = req.query['author'] as string | undefined;
    const author = authorHex ? new Uint8Array(Buffer.from(authorHex, 'hex')) : undefined;

    const result = feedService.queryPosts({
      author,
      limit,
      after: after as PostKey | undefined,
      viewer,
    });
    res.json({
      ...result,
      next: result.next ? formatKey('post', result.next) : null,
    });
  });

  return router;
}
