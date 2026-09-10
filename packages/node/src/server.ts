import express from 'express';
import { createRouter as postRoutes } from './routes/posts.js';
import { createRouter as likeRoutes } from './routes/likes.js';
import { createRouter as inviteRoutes } from './routes/invites.js';
import { withdrawRoutes } from './routes/withdraw.js';
import { createRouter as utxoRoutes } from './routes/utxo.js';
import { createRouter as vouchRoutes } from './routes/vouches.js';
import { createRouter as blockRoutes, KARMA_SUPPLY_TYPES } from './routes/blocks.js';
import { createRouter as miningRoutes } from './routes/mining.js';
import { createRouter as nipopowRoutes } from './routes/nipopow.js';
import { createRouter as usernameRoutes } from './routes/usernames.js';
import { createPopowHeaderReader } from './services/nipopow.js';
import * as store from './store/index.js';
import { guardStoreRead } from './services/corrupt-state.js';
import { verifyPost } from './services/verifier.js';
import { getCurrentTemplate, submitMinedBlock, setMinerPubkey, decayConfig } from './services/block-creator.js';
import { isPeerReady } from './services/peer-readiness.js';
import { castLike } from './services/likes.js';
import { castVouch, initiateUnvouch } from './services/vouch.js';
import { createInvite } from './services/invites.js';
import { executePostWithdraw } from './services/post-withdraw.js';
import { readFileSync } from 'fs';
import { isLivePost, type StoredPost } from './store/posts.js';
import { getDb } from './store/db.js';
import { validateTx } from './services/utxo-engine.js';
import { admitTx } from './services/admit-tx.js';
import { createAdminRouter, type AdminDeps } from './routes/admin.js';
import { noteHttpRequest } from './metrics.js';
import { registerProofEndpoint } from './state/avl-endpoint.js';
import { tryGetAvlProver } from './state/avl-prover.js';
import type { Config } from './config.js';
import type { Server } from 'http';

// ---------------------------------------------------------------------------
// createAdminApp
// ---------------------------------------------------------------------------

export function createAdminApp(config: Config, deps: AdminDeps): Server {
  const adminApp = express();
  adminApp.use(createAdminRouter(deps));

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
// GET /shell/:id support — NODE_INTERFACE → Link previews
// ---------------------------------------------------------------------------

/**
 * NODE_INTERFACE → Link previews: every value injected into the shell is
 * HTML-escaped through this one function, since `<title>` is element text
 * where `<` is live.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * NODE_INTERFACE → Link previews: the content's first 200 characters as they
 * are, cut at a word with "...", whitespace collapsed.
 */
function shellDescription(content: string): string {
  const cut = content.length > 200
    ? content.slice(0, 197).replace(/\s+\S*$/, '') + '...'
    : content;
  return cut.replace(/\s+/g, ' ').trim();
}

interface ShellTags {
  title: string;
  description: string;
  ogUrl: string | null;
}

/**
 * NODE_INTERFACE → Link previews: the shell's `<title>Notis</title>` becomes
 * `<title>{title}</title>`, and `og:title`, `description`, `og:description`,
 * `og:type` article, `og:site_name` Notis and `twitter:card` summary are
 * injected before `</head>`; `og:url` only when `tags.ogUrl` is set.
 */
function taggedShell(shellHtml: string, tags: ShellTags): string {
  const title = escapeHtml(tags.title);
  const description = escapeHtml(tags.description);
  const metaTags = [
    `<meta property="og:title" content="${title}">`,
    `<meta name="description" content="${description}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:type" content="article">`,
    tags.ogUrl !== null ? `<meta property="og:url" content="${escapeHtml(tags.ogUrl)}">` : null,
    `<meta property="og:site_name" content="Notis">`,
    `<meta name="twitter:card" content="summary">`,
  ].filter((tag): tag is string => tag !== null).join('\n');

  return shellHtml
    .replace('<title>Notis</title>', `<title>${title}</title>`)
    .replace('</head>', `${metaTags}\n</head>`);
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(config: Config): express.Express {
  const app = express();

  // ---- Middleware ----

  // NODE_INTERFACE → Admin Listener: every request the public app receives.
  app.use((_req, _res, next) => {
    noteHttpRequest();
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  // GET /shell/:id — NODE_INTERFACE → Link previews
  app.get('/shell/:id', (req, res) => {
    if (config.webShellPath === '') {
      res.status(404).type('text').send('no web shell is configured');
      return;
    }

    let shellHtml: string;
    try {
      shellHtml = readFileSync(config.webShellPath, 'utf-8');
    } catch (err) {
      console.error(
        `GET /shell/:id: could not read WEB_SHELL_PATH "${config.webShellPath}": ` +
        `${(err as Error).message}`,
      );
      res.status(500).type('text').send('could not read the web shell');
      return;
    }

    const postId = req.params['id']!;
    if (!/^[0-9a-fA-F]{64}$/.test(postId)) {
      res.status(400).json({ error: 400, reason: 'id must be a 64-character hex string' });
      return;
    }

    const result = store.getPost(postId);
    if (result === null) {
      res.status(404).type('html').send(shellHtml);
      return;
    }

    if ('withdrawnAtHeight' in result && (result as StoredPost).withdrawnAtHeight !== null) {
      res.status(200).type('html').send(taggedShell(shellHtml, {
        title: 'withdrawn · Notis',
        description: 'withdrawn by its author',
        ogUrl: null,
      }));
      return;
    }

    if (!isLivePost(result) || result.content === null) {
      res.status(200).type('html').send(shellHtml);
      return;
    }

    const authorHex = Buffer.from(result.author).toString('hex');
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) ?? req.get('host') ?? 'localhost';
    const originalUri = req.get('x-original-uri');

    // NODE_INTERFACE → Link previews
    const held = store.getUsernameByOwner(result.author);
    const title = held
      ? `@${held.name} · Notis`
      : `${authorHex.slice(0, 16)}… · Notis`;

    res.status(200).type('html').send(taggedShell(shellHtml, {
      title,
      description: shellDescription(result.content),
      ogUrl: originalUri ? `${proto}://${host}${originalUri}` : null,
    }));
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
    decayCfg: decayConfig(),
    storageRentPeriodBlocks: config.storageRentPeriodBlocks,
    getBoxProvenance: store.getBoxProvenance,
    getTopologyAuthor: store.getTopologyAuthorBytes,
    getPendingPostAuthor: store.getPendingPostAuthor,
    runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    getVouchBox: store.getVouchBox,
    getNetworkRecord: store.getNetworkRecord,
    membershipBarMultiplier: config.membershipBarMultiplier,
    putIdentityRecord: store.putIdentityRecord,
    protocolVersionSchedule: config.protocolVersionSchedule,
    getUsername: store.getUsername,
    getUsernameByOwner: store.getUsernameByOwner,
  };

  // ---- Routes ----

  // Posts — /posts
  app.use(
    '/posts',
    postRoutes({
      verifyPost,
      insertPost: store.insertPost,
      getPost: store.getPost,
      queryPostsPage: store.queryPostsPage,
      getKarmaBoxes: store.getKarmaBoxes,
      getIdentityRecord: store.getIdentityRecord,
      decayCfg: decayConfig(),
      getCurrentHeight: store.getCurrentHeight,
      protocolVersionSchedule: config.protocolVersionSchedule,
      getLikeRecordCount: store.getLikeRecordCount,
      getDescendantCount: store.getDescendantCount,
      hasLikeRecord: store.hasLikeRecord,
      getAncestorsNearest: store.getAncestorsNearest,
      getSubtreePage: store.getSubtreePage,
      getBlockCreatedAt: store.getBlockCreatedAt,
      getUsernameByOwner: store.getUsernameByOwner,
      getUsername: store.getUsername,
      getTopologyAuthor: store.getTopologyAuthor,
      admitTx,
      validateTx: (tx, currentBlockHeight) =>
        validateTx(utxoEngineDeps, tx, currentBlockHeight),
      getBox: store.getBoxWithPending,
      runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    }),
  );

  // Likes — /likes
  app.use(
    '/likes',
    likeRoutes({
      castLike,
      ...utxoEngineDeps,
      getCurrentHeight: store.getCurrentHeight,
    }),
  );

  // Vouches — /vouches
  app.use(
    '/vouches',
    vouchRoutes({
      castVouch,
      initiateUnvouch,
      ...utxoEngineDeps,
      getCurrentHeight: store.getCurrentHeight,
    }),
  );

  // Invites — /invites
  app.use(
    '/invites',
    inviteRoutes({
      createInvite,
      ...utxoEngineDeps,
      getCurrentHeight: store.getCurrentHeight,
    }),
  );

  // Withdraw route
  app.use(
    '/',
    withdrawRoutes({
      executePostWithdraw,
      ...utxoEngineDeps,
      getCurrentHeight: store.getCurrentHeight,
    }),
  );

  // Usernames — /usernames
  app.use(
    '/usernames',
    usernameRoutes({
      ...utxoEngineDeps,
      getCurrentHeight: store.getCurrentHeight,
      validateTx: (tx, currentBlockHeight) =>
        validateTx(utxoEngineDeps, tx, currentBlockHeight),
      getUsername: store.getUsername,
      getUsernameByOwner: store.getUsernameByOwner,
    }),
  );

  // UTXO — mounts at /, routes include /karma/:userId, /credits/:userId, /invites/:userId
  app.use(
    '/',
    utxoRoutes({
      getKarmaTotal: store.getKarmaTotal,
      getKarmaBoxesPage: store.getKarmaBoxesPage,
      getIdentityRecord: store.getIdentityRecord,
      getCreditValue: store.getCreditValue,
      getCreditBoxesPage: store.getCreditBoxesPage,
      getBondBoxesPage: store.getBondBoxesPage,
      getCurrentHeight: store.getCurrentHeight,
      getUtxoEngineDeps: () => utxoEngineDeps,
      decayCfg: decayConfig(),
      getNetworkRecord: store.getNetworkRecord,
      membershipBarMultiplier: config.membershipBarMultiplier,
      getUsername: store.getUsername,
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
        getUsername: store.getUsername,
      }),
    );
  }

  // Blocks + Status — mounts at /, routes include /blocks/current, /blocks/:height, /status
  const db = getDb();
  app.use(
    '/',
    blockRoutes({
      getOrderingBlock: guardStoreRead(store.getOrderingBlock),
      getOrderingBlockHash: store.getOrderingBlockHash,
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
      // Karma in existence, escrow included: karma held in a bond, a vouch
      // escrow or a like accrual is held, not destroyed. The types come from
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
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      getNetworkRecord: store.getNetworkRecord,
      membershipBarMultiplier: config.membershipBarMultiplier,
      protocolVersionSchedule: config.protocolVersionSchedule,
      countUsernames: store.countUsernames,
    }),
  );

  // Nipopow — NODE_INTERFACE → Nipopow; on every role, unauthenticated
  app.use(
    '/',
    nipopowRoutes({
      reader: createPopowHeaderReader({
        getPopowHeaderByHash: store.getPopowHeaderByHash,
        getPopowHeaderAtHeight: store.getPopowHeaderAtHeight,
        getLastHeaders: store.getLastHeaders,
        getHeadersAfter: store.getHeadersAfter,
        getCurrentHeight: store.getCurrentHeight,
      }),
      getCurrentHeight: store.getCurrentHeight,
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
