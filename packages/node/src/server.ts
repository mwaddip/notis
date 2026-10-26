import express from 'express';
import { createRouter as postRoutes } from './routes/posts.js';
import { createRouter as likeRoutes } from './routes/likes.js';
import { createRouter as inviteRoutes } from './routes/invites.js';
import { withdrawRoutes } from './routes/withdraw.js';
import { createRouter as utxoRoutes } from './routes/utxo.js';
import { createRouter as vouchRoutes } from './routes/vouches.js';
import { createRouter as blockRoutes } from './routes/blocks.js';
import { createRouter as miningRoutes } from './routes/mining.js';
import { createRouter as nipopowRoutes } from './routes/nipopow.js';
import { createRouter as usernameRoutes } from './routes/usernames.js';
import { createRouter as backerRoutes } from './routes/backers.js';
import { createPopowHeaderReader } from './services/nipopow.js';
import * as store from './store/index.js';
import { guardStoreRead } from './services/corrupt-state.js';
import { verifyPost } from './services/verifier.js';
import { getCurrentTemplate, submitMinedBlock, setMinerPubkey, decayConfig } from './services/block-creator.js';
import { windowOpen as intakeWindowOpen } from './services/intake.js';
import { isPeerReady } from './services/peer-readiness.js';
import { castLike } from './services/likes.js';
import { castVouch, initiateUnvouch } from './services/vouch.js';
import { createInvite } from './services/invites.js';
import { executePostWithdraw } from './services/post-withdraw.js';
import { admissionHeld, admissionOwed, admissionGetOwnKarmaBoxIds } from './services/karma-admission.js';
import { getBoxesPageWithPending, getBoxTotalWithPending } from './store/mempool.js';
import { readFileSync } from 'fs';
import { isLivePost, type StoredPost } from './store/posts.js';
import { getDb } from './store/db.js';
import { validateTx } from '@dagsocial/consensus';
import { admitTx } from './services/admit-tx.js';
import { signatureMemo } from './services/signature-memo.js';
import { createAdminRouter, type AdminDeps } from './routes/admin.js';
import { noteHttpRequest } from './metrics.js';
import { registerProofEndpoint, registerRangeEndpoint } from './state/avl-endpoint.js';
import { tryGetAvlProver } from './state/avl-prover.js';
import { bodyRefusal } from './routes/body-refusal.js';
import type { Config } from './config.js';
import { createServer, type Server } from 'http';
import type { Socket } from 'net';
import {
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_CHECK_INTERVAL_MS,
  HTTP_CONNECTIONS_MAX,
  isHex64,
} from '@dagsocial/types';

// NODE_INTERFACE → "A body the parser refuses is the client's error"; CONSTANTS
// → HTTP server bounds. The limit the JSON parser holds every write request to.
export const HTTP_BODY_MAX_BYTES = 65_536;

// NODE_INTERFACE → The public server → "No answer names the software, and none
// is read as another type". Set on every answer of both apps, before any route
// or body-parser middleware.
function noAnswerNamesTheSoftware(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

// ---------------------------------------------------------------------------
// listenPublic
// ---------------------------------------------------------------------------

// NODE_INTERFACE → The public server; CONSTANTS → HTTP server bounds.
export const HTTP_IDLE_TIMEOUT_MS = 30_000;

// NODE_INTERFACE → The public server; CONSTANTS → HTTP server bounds.
export const HTTP_UNREAD_ANSWER_BYTES = 67_108_864;

// NODE_INTERFACE → The public server → "One function builds the public server,
// and every bound below is set there".
export function listenPublic(app: express.Express, port: number): Server {
  // NODE_INTERFACE → The public server — the four options Node's
  // `http.createServer` reads for the headers deadline, the request deadline,
  // the keep-alive deadline and the check cadence.
  const server = createServer(
    {
      headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
      requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
      keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
      connectionsCheckingInterval: HTTP_CHECK_INTERVAL_MS,
    },
    app,
  );
  // NODE_INTERFACE → The public server — the two bounds the server instance carries.
  server.timeout = HTTP_IDLE_TIMEOUT_MS;
  server.maxConnections = HTTP_CONNECTIONS_MAX;

  // NODE_INTERFACE → The public server → "The node holds at most
  // HTTP_UNREAD_ANSWER_BYTES (64 MiB) of answers its readers have not taken":
  // the server's own open connections, `'connection'` adds one, its `'close'`
  // drops it.
  const connections = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    connections.add(socket);
    socket.on('close', () => {
      connections.delete(socket);
    });
  });

  // Every HTTP_CHECK_INTERVAL_MS the open connections' writableLength are
  // summed; while the sum is above HTTP_UNREAD_ANSWER_BYTES the connection
  // holding the most is destroyed and its bytes leave the sum.
  const sweep = setInterval(() => {
    let sum = 0;
    for (const s of connections) sum += s.writableLength;
    while (sum > HTTP_UNREAD_ANSWER_BYTES) {
      let biggest: Socket | null = null;
      let biggestLen = -1;
      for (const s of connections) {
        if (s.destroyed) continue;
        if (s.writableLength > biggestLen) {
          biggest = s;
          biggestLen = s.writableLength;
        }
      }
      if (biggest === null) break;
      biggest.destroy();
      sum -= biggestLen;
    }
  }, HTTP_CHECK_INTERVAL_MS);
  sweep.unref();
  server.on('close', () => {
    clearInterval(sweep);
  });

  server.listen(port);
  return server;
}

// ---------------------------------------------------------------------------
// createAdminApp
// ---------------------------------------------------------------------------

export function createAdminApp(config: Config, deps: AdminDeps): Server {
  const adminApp = express();
  // NODE_INTERFACE → The public server → "No answer names the software, and
  // none is read as another type".
  adminApp.disable('x-powered-by');
  adminApp.use(noAnswerNamesTheSoftware);
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
}

// NODE_INTERFACE → Link previews → "A tagged answer replaces the shell's own
// preview tags": before the post's tags go in, every og:, twitter: and
// description the shell carries are removed.
function stripShellPreviewTags(html: string): string {
  return html
    .replace(/<meta\b[^>]*\bproperty="og:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<meta\b[^>]*\bname="twitter:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<meta\b[^>]*\bname="description"[^>]*>\s*/gi, '');
}

// NODE_INTERFACE → Link previews: the title and the tags are put in place by
// position, so no character of a value is read as a replacement pattern
// (`$&`, `` $` ``, `$'`, `$$`). `needle` occurs once; a needle absent from
// `haystack` leaves it untouched.
function spliceAt(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  if (i < 0) return haystack;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

/**
 * NODE_INTERFACE → Link previews: strips the shell's own preview tags, splices
 * `<title>Notis</title>` by position, and splices `og:title`, `description`,
 * `og:description`, `og:type` article, `og:site_name` Notis and `twitter:card`
 * summary before `</head>` by position. No `og:url` is written.
 */
function taggedShell(shellHtml: string, tags: ShellTags): string {
  const title = escapeHtml(tags.title);
  const description = escapeHtml(tags.description);
  const metaTags = [
    `<meta property="og:title" content="${title}">`,
    `<meta name="description" content="${description}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="Notis">`,
    `<meta name="twitter:card" content="summary">`,
  ].join('\n');

  const stripped = stripShellPreviewTags(shellHtml);
  const titled = spliceAt(stripped, '<title>Notis</title>', `<title>${title}</title>`);
  return spliceAt(titled, '</head>', `${metaTags}\n</head>`);
}

// ---------------------------------------------------------------------------
// Query parser — NODE_INTERFACE → HTTP API → "A query parameter is one string"
// ---------------------------------------------------------------------------

/**
 * The non-enumerable mark the parser attaches to its result when the query
 * string names one name twice. The middleware below reads it and answers 400
 * ahead of every route; no route sees it because it is a symbol property
 * (NODE_INTERFACE → HTTP API → "A query parameter is one string").
 */
const QUERY_DUP_NAME = Symbol.for('dagsocial:query-dup-name');

/**
 * Parse a URL-encoded query string into a null-prototype object mapping each
 * name to its one string value. A bracketed name — `after[]`, `author[x]` —
 * is a name of its own, which no route reads. A name given twice is marked
 * on the result with `QUERY_DUP_NAME`, which the middleware below answers
 * 400 for before any route runs (NODE_INTERFACE → HTTP API → "A query
 * parameter is one string").
 */
function parseStrictQuery(queryString: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  if (queryString === null || queryString === undefined || queryString.length === 0) return result;
  const params = new URLSearchParams(queryString);
  const seen = new Set<string>();
  let dup: string | null = null;
  for (const [name, value] of params) {
    if (seen.has(name)) {
      if (dup === null) dup = name;
      continue;
    }
    seen.add(name);
    result[name] = value;
  }
  if (dup !== null) {
    Object.defineProperty(result, QUERY_DUP_NAME, {
      value: dup,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(config: Config): express.Express {
  const app = express();

  // NODE_INTERFACE → HTTP API → "A query parameter is one string": the
  // parser yields one string per name; the middleware below answers 400 for
  // a name given twice before any route runs.
  app.set('query parser', parseStrictQuery);

  // NODE_INTERFACE → The public server → "No answer names the software, and
  // none is read as another type".
  app.disable('x-powered-by');
  app.use(noAnswerNamesTheSoftware);

  // ---- Middleware ----

  // NODE_INTERFACE → Admin Listener: every request the public app receives.
  app.use((_req, _res, next) => {
    noteHttpRequest();
    next();
  });

  // NODE_INTERFACE → Cross-origin requests
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.status(204).end();
      return;
    }
    next();
  });

  // NODE_INTERFACE → HTTP API → "A query parameter is one string": a request
  // whose query names one name twice answers 400 ahead of every route, with
  // no log line. The mark is set by `parseStrictQuery` above.
  app.use((req, res, next) => {
    const dup = (req.query as Record<string | symbol, unknown>)[QUERY_DUP_NAME];
    if (typeof dup === 'string') {
      res.status(400).json({ error: 400, reason: `query parameter ${dup} given twice` });
      return;
    }
    next();
  });

  // NODE_INTERFACE → HTTP API → "A refusal is the parser's by where it comes from":
  // every error `express.json` hands back is the parser's. A 4xx answers through
  // `bodyRefusal` here, with no log; anything else is passed to the final
  // handler, which logs and answers 500.
  // NODE_INTERFACE → HTTP API → "The node reads no compressed request body":
  // `inflate: false` refuses any `Content-Encoding` before a decompression
  // stream is created.
  const jsonParser = express.json({ limit: HTTP_BODY_MAX_BYTES, inflate: false });
  app.use((req, res, next) => {
    jsonParser(req, res, (err?: unknown) => {
      if (err === undefined || err === null) {
        next();
        return;
      }
      const refusal = bodyRefusal(err);
      if (refusal !== null) {
        res.status(refusal.status).json({
          error: refusal.status,
          reason: refusal.reason,
        });
        return;
      }
      next(err);
    });
  });

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
    // NODE_INTERFACE → HTTP API → "Hex is lowercase"
    if (!isHex64(postId)) {
      res.status(400).json({ error: 400, reason: 'id must be 64 lowercase hex characters' });
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
      }));
      return;
    }

    if (!isLivePost(result) || result.content === null) {
      res.status(200).type('html').send(shellHtml);
      return;
    }

    const authorHex = Buffer.from(result.author).toString('hex');

    // NODE_INTERFACE → Link previews
    const held = store.getUsernameByOwner(result.author);
    const title = held
      ? `@${held.name} · Notis`
      : `${authorHex.slice(0, 16)}… · Notis`;

    res.status(200).type('html').send(taggedShell(shellHtml, {
      title,
      description: shellDescription(result.content),
    }));
  });

  // ---- Shared UTXO engine deps (curried into validateTx for routes) ----

  // Admission's `held` and `owed` are the spend rule's engine inputs
  // (NODE_INTERFACE → Karma transition rules → "Engine inputs the rule needs"),
  // written once in `services/karma-admission.ts` and wired here as the
  // engine's `getKarmaValue` and `getKarmaOwed`; `handleRelayedTx` wires the
  // same two readers from the same module.
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
    getKarmaValue: admissionHeld,
    getKarmaOwed: admissionOwed(decayConfig()),
    getOwnKarmaBoxIds: admissionGetOwnKarmaBoxIds,
    // The signature memo answers an entry it holds without the rule's
    // arithmetic (NODE_INTERFACE → The signature memo).
    verifySignature: signatureMemo.verify,
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
      // MEMPOOL_INTERFACE → getHeldEntry: the one read of an entry by id,
      // the bytes a pending post's `tx` field is read from.
      getPendingUtxoTxBytesByTxId: (id: string) => store.getHeldEntry(id)?.txBytes ?? null,
      // MEMPOOL_INTERFACE → getHeldEntry: the post service's held lookup
      // (NODE_INTERFACE → Service Layer Architecture → "A transaction the
      // pool already holds is answered as held").
      getHeldEntry: store.getHeldEntry,
      getUtxoTxTreeBytes: guardStoreRead(store.getUtxoTxTreeBytes),
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

  // Backers — /backers
  app.use(
    '/backers',
    backerRoutes({
      ...utxoEngineDeps,
      getCurrentHeight: store.getCurrentHeight,
      validateTx: (tx, currentBlockHeight) =>
        validateTx(utxoEngineDeps, tx, currentBlockHeight),
      getBackerPoolBox: store.getBackerPoolBox,
      getBackerStakeBox: store.getBackerStakeBox,
      backerSupply: config.profile.backerSupply,
      creditFixedRateBlocks: config.creditFixedRateBlocks,
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
      // NODE_INTERFACE → UTXO queries → "`pending=1` answers the pending
      // view, as admission spends from it": the pool's view and admission's
      // `held` / `owed` readers reach the listings here, so the flag's
      // `effective` on `/karma` is the number admission judges a spend
      // against at `tip + 1` (NODE_INTERFACE → Karma transition rules →
      // "Engine inputs the rule needs").
      getBoxesPageWithPending,
      getBoxTotalWithPending,
      admissionHeld,
      admissionOwed: admissionOwed(decayConfig()),
      getCurrentHeight: store.getCurrentHeight,
      getUtxoEngineDeps: () => utxoEngineDeps,
      decayCfg: decayConfig(),
      getNetworkRecord: store.getNetworkRecord,
      membershipBarMultiplier: config.membershipBarMultiplier,
      getUsername: store.getUsername,
      getUsernameByOwner: store.getUsernameByOwner,
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
        // MINING_INTERFACE → The window gate: the intake answers.
        windowOpen: intakeWindowOpen,
        miningSecret: config.miningSecret,
        getUsername: store.getUsername,
      }),
    );
  }

  // Blocks + Status — mounts at /, routes include /blocks/current, /blocks/:height,
  // /blocks/:height/proof, /status
  app.use(
    '/',
    blockRoutes({
      getOrderingBlock: guardStoreRead(store.getOrderingBlock),
      getOrderingBlockHash: store.getOrderingBlockHash,
      getCurrentHeight: store.getCurrentHeight,
      getPostCount: store.countConfirmedPosts,
      getPendingPostCount: store.countPendingPosts,
      getTotalKarma: store.getTotalKarma,
      getLiquidKarma: store.getLiquidKarma,
      getTotalCredits: store.getTotalCredits,
      networkType: config.networkType,
      inviteProbationBlocks: config.inviteProbationBlocks,
      vouchCooldownBlocks: config.vouchCooldownBlocks,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      getNetworkRecord: store.getNetworkRecord,
      membershipBarMultiplier: config.membershipBarMultiplier,
      protocolVersionSchedule: config.protocolVersionSchedule,
      countUsernames: store.countUsernames,
      getBlockProof: store.getBlockProof,
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
        getCurrentHeight: store.getCurrentHeight,
      }),
      getCurrentHeight: store.getCurrentHeight,
    }),
  );

  // AVL+ proof endpoints (NODE_INTERFACE → AVL+ State Root):
  // GET /api/v1/proof/:key — one key's lookup proof.
  // GET /api/v1/range/:kind/:owner — a page of a key's holdings with its proof.
  const proverHandle = tryGetAvlProver();
  if (proverHandle) {
    registerProofEndpoint(app, proverHandle);
    registerRangeEndpoint(app, proverHandle);
  } else {
    console.warn('AVL prover not initialized — /api/v1/proof and /api/v1/range endpoints unavailable');
  }

  // ---- Error handler ----

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      // NODE_INTERFACE → HTTP API → "500 `{ error: 'internal' }` is a fault of
      // the node's".
      console.error('500 error:', err instanceof Error ? err.stack : err);
      res.status(500).json({ error: 'internal' });
    },
  );

  return app;
}
