import { Router } from 'express';
import { MAX_CONTENT_BYTES } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import { createPost } from '../services/post-service.js';
import type { PostServiceDeps } from '../services/post-service.js';
import { FeedService } from '../services/feed-service.js';
import type { FeedServiceDeps } from '../services/feed-service.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { ClientError } from '../services/client-error.js';
import { respondError } from './respond-error.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface PostsDeps extends PostServiceDeps, FeedServiceDeps {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: PostsDeps): Router {
  const router = Router();
  const feedService = new FeedService(deps);

  // POST /posts — submit a post transaction
  //
  // ⛔ **One transaction, one body field.** The post rides inside `tx.post`
  // (NODE_INTERFACE → Post transactions); there is no separate post object and no
  // `karmaLockTx` beside it, because they were always one intent and splitting
  // them is what the mempool `batchId` existed to paper over.
  router.post('/', (req, res) => {
    // ---- 1. Validate input shape ----
    const rawTx = (req.body as { tx?: Record<string, unknown> }).tx;
    if (!rawTx) {
      res.status(400).json({ error: 400, reason: 'tx required' });
      return;
    }

    let tx;
    try {
      tx = jsonToTx(rawTx);
    } catch (err) {
      respondError(res, err, 'POST /posts (tx decode)');
      return;
    }

    const post = tx.post;
    if (!post) {
      res.status(400).json({ error: 400, reason: 'tx.post required' });
      return;
    }

    if (!post.content || !post.author) {
      res.status(400).json({ error: 400, reason: 'Missing required fields' });
      return;
    }

    if (
      post.content.length < 1 ||
      post.content.length > MAX_CONTENT_BYTES
    ) {
      res.status(400).json({ error: 400, reason: 'Content must be 1-300 bytes' });
      return;
    }

    // ---- 2. Delegate to service ----
    try {
      const result = createPost(deps, tx);

      // ---- 3. Broadcast (fire-and-forget) ----
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast post transaction: ${err.message}`);
        });
      }

      // ---- 4. Serialize result ----
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

  // GET /posts/:id/thread — fetch a post with full thread context
  router.get('/:id/thread', (req, res) => {
    const thread = feedService.getThread(req.params['id']!);
    if (!thread) {
      res.status(404).json({ error: 404, reason: 'Post not found' });
      return;
    }
    res.json(thread);
  });

  // GET /posts/:id — retrieve a specific post
  router.get('/:id', (req, res) => {
    const result = feedService.getPost(req.params['id']!);
    if (!result) {
      res.status(404).json({ error: 404, reason: 'Post not found' });
      return;
    }
    res.json(result);
  });

  // GET /posts — query posts with pagination
  router.get('/', (req, res) => {
    const limit = Math.min(
      parseInt((req.query['limit'] as string) ?? '50', 10),
      100,
    );
    const offset = parseInt(
      (req.query['offset'] as string) ?? '0',
      10,
    );
    const authorHex = req.query['author'] as string | undefined;
    const author = authorHex ? new Uint8Array(Buffer.from(authorHex, 'hex')) : undefined;

    const posts = feedService.queryPosts({ author, limit, offset });
    res.json(posts);
  });

  return router;
}
