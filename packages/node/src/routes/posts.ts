import { Router } from 'express';
import { protocolVersionAt } from '@dagsocial/types';
import { createPost } from '../services/post-service.js';
import type { PostServiceDeps } from '../services/post-service.js';
import { FeedService } from '../services/feed-service.js';
import type { FeedServiceDeps } from '../services/feed-service.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import { CorruptChainStateError, failStopIfCorruptChain } from '../services/corrupt-state.js';
import type { PostKey } from '../store/index.js';
import {
  parseLimit, isLimitError,
  parseAfter, isAfterError,
  parseRoots, isRootsError,
  parseTx, isTxError,
  parseLight, isLightError,
  parseViewer, isViewerError,
  resolveIdentityParam, isResolveError,
  formatKey,
} from './page.js';
import type { UsernameLookup } from './page.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface PostsDeps extends PostServiceDeps, FeedServiceDeps {
  getTopologyAuthor(postId: string): string | null;
  getUsername: UsernameLookup;
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
      tx = jsonToTx(rawTx, protocolVersionAt(deps.protocolVersionSchedule, deps.getCurrentHeight() + 1)!);
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
    const tx = parseTx(req.query as Record<string, unknown>);
    if (isTxError(tx)) { res.status(400).json({ error: tx.error }); return; }
    const light = parseLight(req.query as Record<string, unknown>);
    if (isLightError(light)) { res.status(400).json({ error: light.error }); return; }
    // NODE_INTERFACE → Posts → "`light` and `tx` do not combine"
    if (tx && light) { res.status(400).json({ error: 'tx and light cannot both be 1' }); return; }
    const viewer = parseViewer(req.query as Record<string, unknown>, deps.getUsername);
    if (isViewerError(viewer)) {
      res.status(viewer.status ?? 400).json({ error: viewer.error });
      return;
    }
    let thread;
    try {
      thread = feedService.getThread(
        req.params['id']!,
        { limit, after: after as PostKey | undefined },
        viewer,
        tx,
        light,
      );
    } catch (err) {
      // NODE_INTERFACE → Posts → "The creating transaction rides a post row":
      // a confirmed row whose block lists no such id is a stored chain
      // that contradicts itself — fail-stop as the proof routes do under
      // `InconsistentAvlNodeRowsError` (NODE_INTERFACE → AVL+ State Root →
      // "A height of the proof window with no kept root is served from the
      // store").
      if (err instanceof CorruptChainStateError) failStopIfCorruptChain(err);
      throw err;
    }
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
    const tx = parseTx(req.query as Record<string, unknown>);
    if (isTxError(tx)) { res.status(400).json({ error: tx.error }); return; }
    const viewer = parseViewer(req.query as Record<string, unknown>, deps.getUsername);
    if (isViewerError(viewer)) {
      res.status(viewer.status ?? 400).json({ error: viewer.error });
      return;
    }
    let result;
    try {
      result = feedService.getPost(id, viewer, tx);
    } catch (err) {
      if (err instanceof CorruptChainStateError) failStopIfCorruptChain(err);
      throw err;
    }
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
    const roots = parseRoots(req.query as Record<string, unknown>);
    if (isRootsError(roots)) { res.status(400).json({ error: roots.error }); return; }
    const tx = parseTx(req.query as Record<string, unknown>);
    if (isTxError(tx)) { res.status(400).json({ error: tx.error }); return; }
    const light = parseLight(req.query as Record<string, unknown>);
    if (isLightError(light)) { res.status(400).json({ error: light.error }); return; }
    // NODE_INTERFACE → Posts → "`light` and `tx` do not combine"
    if (tx && light) { res.status(400).json({ error: 'tx and light cannot both be 1' }); return; }
    const viewer = parseViewer(req.query as Record<string, unknown>, deps.getUsername);
    if (isViewerError(viewer)) {
      res.status(viewer.status ?? 400).json({ error: viewer.error });
      return;
    }
    let author: Uint8Array | undefined;
    const authorRaw = req.query['author'] as string | undefined;
    if (authorRaw) {
      const resolved = resolveIdentityParam(authorRaw, deps.getUsername);
      if (isResolveError(resolved)) { res.status(resolved.status).json({ error: resolved.error }); return; }
      author = new Uint8Array(Buffer.from(resolved.hex, 'hex'));
    }

    let result;
    try {
      result = feedService.queryPosts({
        author,
        roots,
        limit,
        after: after as PostKey | undefined,
        viewer,
        tx,
        light,
      });
    } catch (err) {
      if (err instanceof CorruptChainStateError) failStopIfCorruptChain(err);
      throw err;
    }
    res.json({
      ...result,
      next: result.next ? formatKey('post', result.next) : null,
    });
  });

  return router;
}
