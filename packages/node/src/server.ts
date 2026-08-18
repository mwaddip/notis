import express from 'express';
import { createRouter as postRoutes } from './routes/posts.js';
import { createRouter as likeRoutes } from './routes/likes.js';
import { createRouter as inviteRoutes } from './routes/invites.js';
import { createRouter as faucetRoutes } from './routes/faucet.js';
import { deleteRoutes } from './routes/delete.js';
import { createRouter as utxoRoutes } from './routes/utxo.js';
import { createRouter as vouchRoutes } from './routes/vouches.js';
import { createRouter as blockRoutes, KARMA_SUPPLY_TYPES } from './routes/blocks.js';
import { createRouter as miningRoutes } from './routes/mining.js';
import * as store from './store/index.js';
import { getSystemKeypair } from './store/system.js';
import { verifyPost } from './services/verifier.js';
import { getCurrentTemplate, submitMinedBlock, setMinerPubkey } from './services/block-creator.js';
import { isPeerReady } from './services/peer-readiness.js';
import { castLike } from './services/likes.js';
import { castVouch, initiateUnvouch } from './services/vouch.js';
import { createInvite } from './services/invites.js';
import { executePrune } from './services/stump-engine.js';
import { readFileSync } from 'fs';
import { encodePost } from '@dagsocial/types';
import { getDb } from './store/db.js';
import { validateTx } from './services/utxo-engine.js';
import { admitTx } from './services/admit-tx.js';
import { createAdminRouter } from './routes/admin.js';
import { registerProofEndpoint } from './state/avl-endpoint.js';
import { tryGetAvlProver } from './state/avl-prover.js';
import { isFaucetNetwork } from './config.js';
import type { Config } from './config.js';
import type { Server } from 'http';

// ---------------------------------------------------------------------------
// createAdminApp
// ---------------------------------------------------------------------------

export function createAdminApp(config: Config): Server {
  const adminApp = express();
  adminApp.use(createAdminRouter());

  // WARN if not loopback
  if (config.adminBindAddress !== '127.0.0.1' && config.adminBindAddress !== '::1') {
    console.warn(
      `Admin listener binding to non-loopback address: ${config.adminBindAddress}:${config.adminPort}. ` +
      `This exposes internal metrics to the network.`,
    );
  }

  const server = adminApp.listen(config.adminPort, config.adminBindAddress, () => {
    console.log(`Admin listener on ${config.adminBindAddress}:${config.adminPort}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(config: Config): express.Express {
  const app = express();

  // ---- Middleware ----

  app.use(express.json({ limit: '1mb' }));

  // Demo UI
  const publicDir = new URL('../public', import.meta.url).pathname;
  const indexPath = new URL('../public/index.html', import.meta.url).pathname;
  const indexHtml = readFileSync(indexPath, 'utf-8');

  // Inject OG meta tags into index.html when ?post=<id> is present.
  // This handles the case where a user copies the browser URL bar to share.
  app.get('/', (req, res, next) => {
    const postId = req.query['post'] as string | undefined;
    if (!postId) return next();

    const result = store.getPost(postId);
    if (!result || !('content' in result)) return next();

    const post = result as import('@dagsocial/types').Post;
    const authorHex = Buffer.from(post.author).toString('hex');
    const shortAuthor = authorHex.slice(0, 12);
    const descRaw = post.content.length > 200
      ? post.content.slice(0, 197).replace(/\s+\S*$/, '') + '...'
      : post.content;
    const desc = descRaw.replace(/\s+/g, ' ').replace(/"/g, '&quot;').trim();

    const publicBase = config.publicUrl.replace(/\/$/, '');
    const apiBase = publicBase ? `${publicBase}/api` : '';
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) ?? req.get('host') ?? 'localhost';
    const canonicalUrl = `${proto}://${host}${publicBase}/?post=${encodeURIComponent(postId)}`;

    const ogTags = `
<meta property="og:title" content="Post by ${shortAuthor}... — Notis">
<meta name="description" content="${desc}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:site_name" content="Notis">
<meta name="twitter:card" content="summary">`;

    const html = indexHtml.replace('</head>', `${ogTags}\n</head>`);
    res.type('html').send(html);
  });

  app.use(express.static(publicDir));

  // GET /preview/:id — Open Graph preview page for link sharing (Telegram, etc.)
  app.get('/preview/:id', (req, res) => {
    const postId = req.params['id']!;
    const result = store.getPost(postId);
    if (!result || !('content' in result)) {
      res.status(404).type('html').send('<!DOCTYPE html><html><body><p>Post not found.</p></body></html>');
      return;
    }

    const post = result as import('@dagsocial/types').Post;
    const authorHex = Buffer.from(post.author).toString('hex');
    const shortAuthor = authorHex.slice(0, 12);
    // Truncate content to ~200 chars for og:description. Collapse whitespace
    // (newlines break HTML attribute parsing) and escape for HTML.
    const descRaw = post.content.length > 200
      ? post.content.slice(0, 197).replace(/\s+\S*$/, '') + '...'
      : post.content;
    const desc = descRaw.replace(/\s+/g, ' ').replace(/"/g, '&quot;').trim();

    // Build absolute URL for og:url (Telegram requires absolute URLs).
    // The Express app may be behind nginx with a path prefix (e.g. /testnet/api).
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) ?? req.get('host') ?? 'localhost';
    const publicBase = config.publicUrl.replace(/\/$/, ''); // e.g. "" or "/testnet"
    const apiBase = publicBase ? `${publicBase}/api` : '';
    const previewUrl = `${proto}://${host}${apiBase}/preview/${encodeURIComponent(postId)}`;
    const uiUrl = `${publicBase}/?post=${encodeURIComponent(postId)}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Post by ${shortAuthor}... — Notis</title>
<meta property="og:title" content="Post by ${shortAuthor}... — Notis">
<meta name="description" content="${desc}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="article">
<meta property="og:url" content="${previewUrl.replace(/"/g, '&quot;')}">
<meta property="og:site_name" content="Notis">
<meta name="twitter:card" content="summary">
<script>window.location.href = '${uiUrl.replace(/'/g, "\\'")}';</script>
</head>
<body>
<p><a href="${uiUrl.replace(/"/g, '&quot;')}">View post</a></p>
</body>
</html>`;
    res.type('html').send(html);
  });

  // ---- Shared UTXO engine deps (curried into validateTx for routes) ----

  // Bond settlement's unlock predicate reads the invitee's summed unspent
  // karma (NODE_INTERFACE → "Bond transition rules"). Every deps literal below
  // references the store's getKarmaValue directly — the single implementation
  // shared with block application and the relay path.
  // ⛔ **Every `getBox` below is `getBoxWithPending`, and that is an admission
  // convenience, not a consensus one.** These deps reach submission services
  // only. Block application takes its `getBox` from a direct store import
  // (`block-apply.ts`), so nothing here can reach it — and nothing here may be
  // given to it: a block's inputs must resolve against the confirmed set alone,
  // or what a block may spend would depend on one node's unshared pool.
  //
  // Submission needs the wider view because a transaction that spends the change
  // box of one still in the pool is ordinary — the client chains rather than
  // re-spending the box its own pending transaction consumed — and the confirmed
  // set does not hold that output yet.
  const utxoEngineDeps = {
    getBox: store.getBoxWithPending,
    insertBox: store.insertBox,
    consumeBox: store.consumeBox,
    getKarmaBox: store.getKarmaBox,
    getKarmaBoxes: store.getKarmaBoxes,
    getKarmaValue: store.getKarmaValue,
    getIdentityRecord: store.getIdentityRecord,
    hasActiveVouchEscrow: store.hasActiveVouchEscrow,
    vouchCooldownBlocks: config.vouchCooldownBlocks,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    getTopologyAuthor: store.getTopologyAuthorBytes,
    runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    isSystemBox: (boxId: string) => {
      const sysKey = getSystemKeypair();
      if (!sysKey) return false;
      // The pending view here too: the faucet's second grant in a block interval
      // spends the change box of its first, which is still pending. Resolved
      // against the confirmed set this returns false and the grant is rejected
      // as an ordinary karma transfer.
      const box = store.getBoxWithPending(boxId);
      if (!box || box.boxType !== 'karma') return false;
      return Buffer.from((box as import('@dagsocial/types').KarmaBox).owner).equals(
        Buffer.from(sysKey.publicKey),
      );
    },
  };

  // ---- Routes ----

  // Reserved, never to be reused: the route path `/challenge`. The PoW handshake
  // is gone with post PoW — a post is admitted by the stateful karma lock.

  // Posts — /posts
  app.use(
    '/posts',
    postRoutes({
      verifyPost,
      encodePost,
      insertPost: store.insertPost,
      getPost: store.getPost,
      queryPosts: store.queryPosts,
      getKarmaBoxes: store.getKarmaBoxes,
      getCurrentHeight: store.getCurrentHeight,
      getLikeRecordCount: store.getLikeRecordCount,
      getLikersForPost: store.getLikersForPost,
      getAncestors: store.getAncestors,
      getSubtree: store.getSubtree,
      getTopologyAuthor: store.getTopologyAuthor,
      admitTx,
      validateTx: (tx, currentBlockHeight) =>
        validateTx(utxoEngineDeps, tx, currentBlockHeight),
      getBox: store.getBoxWithPending,
    }),
  );

  // Likes — /likes
  app.use(
    '/likes',
    likeRoutes({
      castLike,
      getCurrentHeight: store.getCurrentHeight,
      getBox: store.getBoxWithPending,
      insertBox: store.insertBox,
      consumeBox: store.consumeBox,
      getKarmaBox: store.getKarmaBox,
      getKarmaValue: store.getKarmaValue,
      getIdentityRecord: store.getIdentityRecord,
      hasActiveVouchEscrow: store.hasActiveVouchEscrow,
      vouchCooldownBlocks: config.vouchCooldownBlocks,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      getTopologyAuthor: store.getTopologyAuthorBytes,
      runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    }),
  );

  // Vouches — /vouches
  app.use(
    '/vouches',
    vouchRoutes({
      castVouch,
      initiateUnvouch,
      getCurrentHeight: store.getCurrentHeight,
      getBox: store.getBoxWithPending,
      insertBox: store.insertBox,
      consumeBox: store.consumeBox,
      getKarmaBox: store.getKarmaBox,
      getKarmaValue: store.getKarmaValue,
      getIdentityRecord: store.getIdentityRecord,
      hasActiveVouchEscrow: store.hasActiveVouchEscrow,
      vouchCooldownBlocks: config.vouchCooldownBlocks,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      getTopologyAuthor: store.getTopologyAuthorBytes,
      runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    }),
  );

  // Invites — /invites
  app.use(
    '/invites',
    inviteRoutes({
      createInvite,
      getCurrentHeight: store.getCurrentHeight,
      getBox: store.getBoxWithPending,
      insertBox: store.insertBox,
      consumeBox: store.consumeBox,
      getKarmaBox: store.getKarmaBox,
      getKarmaValue: store.getKarmaValue,
      getIdentityRecord: store.getIdentityRecord,
      hasActiveVouchEscrow: store.hasActiveVouchEscrow,
      vouchCooldownBlocks: config.vouchCooldownBlocks,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      getTopologyAuthor: store.getTopologyAuthorBytes,
      runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    }),
  );

  // Faucet — /faucet (allow-listed networks only; NODE_INTERFACE §Faucet).
  // Gate shares isFaucetNetwork with the system-box provisioning in index.ts
  // and the /credits/faucet handler in routes/utxo.ts — the three move together.
  if (isFaucetNetwork(config.networkType)) {
    app.use(
      '/faucet',
      faucetRoutes({
        getKarmaBox: store.getKarmaBox,
        getKarmaValue: store.getKarmaValue,
        getIdentityRecord: store.getIdentityRecord,
        hasActiveVouchEscrow: store.hasActiveVouchEscrow,
        vouchCooldownBlocks: config.vouchCooldownBlocks,
        inviteBondMin: config.inviteBondMin,
        inviteBondMax: config.inviteBondMax,
        getTopologyAuthor: store.getTopologyAuthorBytes,
        getCurrentHeight: store.getCurrentHeight,
        getBox: store.getBoxWithPending,
        insertBox: store.insertBox,
        consumeBox: store.consumeBox,
        runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
        isSystemBox: utxoEngineDeps.isSystemBox,
      }),
    );
  } else {
    app.use('/faucet', (_req, res) => {
      res.status(403).json({ error: 'faucet disabled in production mode' });
    });
  }

  // Delete — POST /posts/:id/prune
  app.use(
    '/',
    deleteRoutes({
      executePrune,
    }),
  );

  // UTXO — mounts at /, routes include /karma/:userId, /credits/:userId, /invites/:userId
  app.use(
    '/',
    utxoRoutes({
      networkType: config.networkType,
      getKarmaBox: store.getKarmaBox,
      getKarmaBoxes: store.getKarmaBoxes,
      getCreditBox: store.getCreditBox,
      getCreditBoxes: store.getCreditBoxes,
      getBondBoxes: store.getBondBoxes,
      getCurrentHeight: store.getCurrentHeight,
      getUtxoEngineDeps: () => utxoEngineDeps,
    }),
  );

  // Mining — /mining. A miner node is by definition one that serves templates,
  // so the role alone decides the surface (audit M-7).
  if (config.nodeRole === 'miner') {
    app.use(
      '/mining',
      miningRoutes({
        getCurrentTemplate,
        submitMinedBlock,
        setMinerPubkey,
        // Only template serving is gated. `POST /mining/submit` is not: by the
        // time a miner submits, the hashes are already spent, and the node it
        // solved against had met its peers when it handed out the preimage.
        peerReady: isPeerReady,
        miningSecret: config.miningSecret,
      }),
    );
  }

  // Blocks + Status — mounts at /, routes include /blocks/current, /blocks/:height, /status
  const db = getDb();
  app.use(
    '/',
    blockRoutes({
      getOrderingBlock: store.getOrderingBlock,
      getCurrentHeight: store.getCurrentHeight,
      getPostCount: () =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM dag_posts WHERE status = 'confirmed'",
            )
            .get() as { c: number }
        ).c,
      getPendingPostCount: () =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM dag_posts WHERE status = 'pending'",
            )
            .get() as { c: number }
        ).c,
      // Karma in existence, escrow included: karma locked in a post lock, a
      // bond, an invite or a vouch is held, not destroyed. The types come from
      // `KARMA_SUPPLY_TYPES`, which answers that question and only that one —
      // it is independent of the transition set the engine's karma arm admits
      // as outputs, and a karma-bearing type is added to each separately
      // (NODE_INTERFACE → "Three karma sets, and none derives from another").
      getTotalKarma: () => {
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes
              WHERE box_type IN (${KARMA_SUPPLY_TYPES.map(() => '?').join(', ')})
                AND spent_at_block IS NULL`,
          )
          .safeIntegers()
          .get(...KARMA_SUPPLY_TYPES) as { s: bigint };
        return row.s;
      },
      // Karma its owner can spend now — the escrowed four are excluded by
      // construction.
      getLiquidKarma: () => {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'karma' AND spent_at_block IS NULL",
          )
          .safeIntegers()
          .get() as { s: bigint };
        return row.s;
      },
      // Credits in circulation. ⛔ **`emission` and `treasury` are deliberately
      // not summed here.** The emission box holds what has never been released
      // and the treasury holds what is out of circulation with no rule to
      // release it (ARCHITECTURE → Treasury), so counting either would report a
      // supply larger than anyone can hold. Keyed on `credit` by name rather
      // than by excluding them, so a later credit-bearing box type is a
      // deliberate addition here.
      //
      // ⛔ **`fee` is credit-bearing and is still not summed**, because the sum
      // could only ever be zero: block application consumes a fee box in the
      // block that created it (MINING_INTERFACE → Coinbase Application), so no
      // fee box is unspent at any height a caller can observe. Its value
      // reaches this total through the coinbase, as a `credit` box.
      getTotalCredits: () => {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'credit' AND spent_at_block IS NULL",
          )
          .safeIntegers()
          .get() as { s: bigint };
        return row.s;
      },
      networkType: config.networkType,
      inviteProbationBlocks: config.inviteProbationBlocks,
      vouchCooldownBlocks: config.vouchCooldownBlocks,
    }),
  );

  // Proof endpoint — GET /api/v1/proof/:boxId (light-client AVL proofs)
  const proverHandle = tryGetAvlProver();
  if (proverHandle) {
    registerProofEndpoint(app, proverHandle);
  } else {
    console.warn('AVL prover not initialized — /api/v1/proof endpoint unavailable');
  }

  // ---- Error handler ----

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error('500 error:', err instanceof Error ? err.stack : err);
      res.status(500).json({ error: 'internal' });
    },
  );

  return app;
}
