import { loadConfig, isFaucetNetwork } from './config.js';
import { initDb, closeDb } from './store/db.js';
import { getSystemKeypair, initSystemKeypair } from './store/system.js';
import { seedGenesisState } from './services/genesis-state.js';
import { startBlockCreator, stopBlockCreator, setDagServiceForMiner } from './services/block-creator.js';
import { createApp, createAdminApp } from './server.js';
import {
  initJournal,
  emitServerStarting,
  emitServerReady,
  emitApiListening,
  emitShutdownSignalReceived,
  emitServerShuttingDown,
} from './journal.js';
import { NetNode } from '@dagsocial/net';
import * as validation from '@dagsocial/validation';
import { validateTx } from './services/utxo-engine.js';
import { admitTx } from './services/admit-tx.js';
import { setNet } from './services/net-instance.js';
import { enterDiscovery, notePeerMet } from './services/peer-readiness.js';
import { applyOrderingBlock } from './services/block-apply.js';
import { createAvlProver } from './state/avl-prover.js';
import { DagService } from './services/dag-service.js';
import { extendsOurTip, resolveFork } from './services/fork-resolution.js';
import { failStopIfCorruptChain } from './services/corrupt-state.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  getKarmaValue,
  hasActiveVouchEscrow,
  getTopologyAuthorBytes,
  getIdentityRecord,
  getPost,
  insertPost,
  getBox,
  getCurrentHeight,
  MempoolFullError,
  PendingSpendConflictError,
  getOrderingBlock,
  peerStorage,
} from './store/index.js';
import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';

const config = loadConfig();
const startTime = Date.now();

// 0. Journal
initJournal();
emitServerStarting('1.0.0', config.networkType);

// 1. Init DB
initDb(config.dbPath);

// 1a. Initialize AVL prover
//
// Ahead of genesis seeding, which commits its boxes to this tree.
//
// There is deliberately no rebuild-from-UTXO-set path here (NODE_INTERFACE →
// the SUPERSEDED note on `bootstrapAvlProver`, 2026-08-07). Such a rebuild is
// unsound: AVL+ tree shape is history-dependent, so a tree rebuilt by
// re-inserting a set forks against one grown incrementally to the same content;
// the note carries the measurement behind that. Nor
// would a rebuild be reachable — under @ergots/avltree 0.4.0 the
// PersistentBatchAVLProver constructor writes the empty-tree version to empty
// storage and throws if `version()` is still null after, so an
// empty-storage trigger is statically false. The sound restart path is the
// persisted tree the constructor loads. Operational consequence: AVL storage
// must never be wiped independently of the chain — wiping both together is
// the only supported reset.
createAvlProver();

// 1b. Init system keypair, then seed the genesis state. Must happen after DB
//     init, before any route that might need the system box.
//
//     `seedGenesisState` owns which boxes a network's genesis holds and the
//     order they reach the tree in; both are consensus-visible, so neither is
//     an artefact of this file. The faucet-bearing networks alone carry the
//     system karma and faucet credit boxes — the gate it applies is shared with
//     the /faucet mount and the /credits/faucet handler, so the three move
//     together (NODE_INTERFACE §Faucet): mounting without provisioning gives a
//     faucet with nothing to mint from.
//
//     Fail-stop in three steps: the message, then `closeDb()`, then a non-zero
//     exit — the only startup gate in this file with that shape. Closing the
//     handle before exiting is what keeps a refusal from leaving a `-wal` beside
//     a store the operator is about to inspect. Every refusal `seedGenesisState`
//     raises is a node that must not run, and each one writes a sentence for the
//     operator that a bare top-level throw would bury under a stack trace.
const systemKeypair = initSystemKeypair();
try {
  seedGenesisState(systemKeypair.publicKey);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  closeDb();
  process.exit(1);
}
if (isFaucetNetwork(config.networkType)) {
  console.log(
    `System keypair: ${Buffer.from(systemKeypair.publicKey).toString('hex').slice(0, 12)}... ` +
    `(faucet source)`,
  );
}

// 2. Create NetNode
// The three discovery knobs are passed explicitly: NET_INTERFACE.md documents
// their defaults as binding only when node supplies them — unset, net's
// internal fallbacks silently govern instead.
const net = new NetNode(
  {
    // The profile's wire magic. Required in NetConfig — net has no fallback of
    // its own (NET_INTERFACE → "Magic Bytes").
    magic: config.profile.magic,
    bootstrapPeers: config.bootstrapPeers,
    listenAddrs: config.listenAddrs,
    maxPeers: config.maxPeers,
    minPeers: parseInt(process.env['MIN_PEERS'] ?? '3', 10),
    peerDbCap: parseInt(process.env['PEER_DB_CAP'] ?? '1000', 10),
    outboundRedialCooldownMs: parseInt(process.env['OUTBOUND_REDIAL_COOLDOWN_MS'] ?? '60000', 10),
    penaltyScoreThreshold: parseInt(process.env['PENALTY_SCORE_THRESHOLD'] ?? '500', 10),
    temporalBanDurationMs: parseInt(process.env['TEMPORAL_BAN_DURATION_MS'] ?? '3600000', 10),
    penaltySafeIntervalMs: parseInt(process.env['PENALTY_SAFE_INTERVAL_MS'] ?? '120000', 10),
    syncRequestTimeoutMs: parseInt(process.env['SYNC_REQUEST_TIMEOUT_MS'] ?? '10000', 10),
  },
  validation,
  peerStorage,
);
setNet(net);

// DagService — owns canonical branch population and DAG reorg logic
const dagService = new DagService();
setDagServiceForMiner(dagService);

// 3. Register Stage 2 handlers
//
// Reserved, never to be reused: the sub-block relay handler. A post arrives as a
// transaction and is admitted by the transaction relay path below — one handler
// where there were two, and the post's karma lock is verified statefully instead
// of a PoW being re-checked.

/**
 * The ordering-block boundary.
 *
 * Being unable to hash our own stored chain is fatal, and this is where that is
 * *decided* rather than inherited. Without it the outcome would be whatever
 * `@dagsocial/net` happens to do with a rejected promise from its handler —
 * today `for (const cb of handlers) cb(block)` with nothing awaiting, so the
 * rejection goes unhandled and Node ends the process. That is the right end by
 * the wrong mechanism: this handler is `async`, which is the only reason the
 * rejection escapes gossip's empty dispatch catch at all (`net/gossip.ts:184`),
 * and the day `net` awaits its handlers the fail-stop would silently become a
 * swallow with nothing to say so.
 */
net.onOrderingBlock(async (block, fromPeerId) => {
  try {
    await handleOrderingBlock(block, fromPeerId);
  } catch (err) {
    failStopIfCorruptChain(err);
  }
});

async function handleOrderingBlock(block: OrderingBlock, fromPeerId: string): Promise<void> {
  const currentHeight = getCurrentHeight();

  // Genesis or extends our tip: apply normally
  if (currentHeight === 0 || extendsOurTip(block)) {
    applyOrderingBlock(block, dagService);
    return;
  }

  // The relaying peer is the counterparty fork resolution asks (NET_INTERFACE →
  // Pull Requests).
  await resolveFork(block, net, fromPeerId, dagService);
}

net.onTx((tx) => {
  const deps = {
    getBox,
      insertBox: () => {},
    consumeBox: () => {},
    getKarmaBox,
    getKarmaBoxes,
    // The vouch cast's minimum-balance gate (ARCHITECTURE → "Vouch boxes").
    // Relay validation has to reach the same verdict the block path will — the
    // store's getKarmaValue is the single implementation all three paths share.
    getKarmaValue,
    // The vouch cast's cooldown gate (NODE_INTERFACE → "Vouch transition
    // rules") — same rule.
    hasActiveVouchEscrow,
    vouchCooldownBlocks: config.vouchCooldownBlocks,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    // The like marker's author pin (NODE_INTERFACE → Karma transition rules) —
    // same rule again: a relayed like whose marker names the wrong author must
    // be refused here as well as at the block path.
    getTopologyAuthor: getTopologyAuthorBytes,
    // The invite-create not-already-an-account bar (NODE_INTERFACE → "Bond
    // transition rules") — same rule again: a relayed invite naming an existing
    // account must be refused here as well as at the block path.
    getIdentityRecord,
    runInTransaction: (fn: () => void) => fn(),
    isSystemBox: (boxId: string) => {
      const sysKey = getSystemKeypair();
      if (!sysKey) return false;
      const box = getBox(boxId);
      if (!box || box.boxType !== 'karma') return false;
      return Buffer.from((box as import('@dagsocial/types').KarmaBox).owner).equals(
        Buffer.from(sysKey.publicKey),
      );
    },
  };
  const currentHeight = getCurrentHeight();
  const result = validateTx(deps, tx, currentHeight);
  if (!result.valid) {
    // Boxes referenced by relayed txs may not have arrived yet via header sync.
    // The tx will be included in the ordering block that carries the boxes.
    // Only log at debug level — this is expected during normal operation.
    if (result.error?.includes('Missing or invalid owner signature') || result.error?.includes('not found')) {
      // silently skip — tx will arrive via block sync
    } else {
      console.warn(`Relayed tx rejected: ${result.error}`);
    }
    return;
  }
  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  try {
    admitTx(tx, expiresAtHeight);
  } catch (err) {
    if (err instanceof MempoolFullError) {
      console.warn(`Relayed tx dropped, mempool full: ${result.txId}`);
      return;
    }
    // A peer's transaction spending a box one of ours already spends is the
    // pool declining an entry, not this node failing. Dropping it is the whole
    // response: whichever side confirms first settles the box, and a throw here
    // would escape into net's gossip handler.
    if (err instanceof PendingSpendConflictError) {
      console.warn(`Relayed tx dropped, input spent by a pending entry: ${result.txId}`);
      return;
    }
    throw err;
  }
  console.log(`Relayed tx queued in mempool: ${result.txId}`);
});

  // Register blocks handler — bridges sync machine's pull path
  // (ModifierResponse) to the node's applyOrderingBlock pipeline.
  //
  // Same boundary as the gossip handler above, and this path needs it more: net
  // calls this inside `appendBlocks`, whose catch logs any throw as
  // `failed to decode block` and then applies the *next* block in the batch
  // (`net/src/node.ts:255-260`). A corrupt chain would be reported as a codec
  // problem and the sync would keep going over it.
  net.setBlocksHandler((block) => {
    try {
      applyOrderingBlock(block, dagService);
    } catch (err) {
      failStopIfCorruptChain(err);
    }
  });
  net.setHeadersHandler(getOrderingBlock);

// 4. Start net
//
// The try covers `net.start()` and nothing else, because "net startup failed" is
// the only verdict the catch below has. Everything that used to sit inside it —
// the discovery decision and the two handler registrations — either states
// something about this node's configuration rather than about net, or is a bug
// of ours if it throws. Under a try wide enough to hold them, anything failing
// after the discovery mark reached the catch and overwrote `searching` with
// `unavailable`, which opens the mining gate unconditionally.
try {
  await net.start();
  console.log(`Net node started, peer ID: ${net.peerId()}`);
} catch (err) {
  console.warn(`Net startup failed (continuing without networking): ${String(err)}`);
}

// Discovery opens here on both paths, and this is the only place it can.
// `net.start()` awaits every bootstrap dial and its handshake in sequence, so
// its return already IS the bootstrap-completion signal — a peer reached is
// Active by now. What the window covers is what completion leaves unfinished: a
// dial that failed, whose next attempt is on net's 30s outbound tick
// (`services/peer-readiness.ts` sizes the window from that cadence). Marking
// from here rather than from process start is what keeps the window bounding
// dial time and not store opening, AVL bootstrap or genesis seeding.
enterDiscovery(config.bootstrapPeers.length);

// The arrival half of "readiness is not latched" (`MINING_INTERFACE` → "The
// peer-readiness gate"). Readiness notices a peer *leaving* by looking, because
// net publishes no disconnect callback — but it must not depend on looking to
// know one ever arrived, or a peer that came and went between two template
// polls would leave the node believing it had never met anybody.
net.onPeerActive((_peerId: string) => notePeerMet());

// Reserved, never to be reused: `setSyncHandler` and `setPostsHandler`. Both
// served a post by id to a peer that held a `SubBlockEntry` but no content. A
// block now carries its posts inside `utxoTxs`, so a node holding the block holds
// the content — there is no placeholder state, nothing for a content sweep to
// resolve, and no id-to-post fetch whose answer a receiver could verify (a post's
// id is not a function of the post).

// 5. Start block creator (miner only) and HTTP server
if (config.nodeRole === 'miner') {
  startBlockCreator(config);
  console.log(`Node role: miner — producing ordering blocks`);
} else {
  console.log(`Node role: server — applying inbound ordering blocks`);
}

const app = createApp(config);
const adminServer = createAdminApp(config);
const server = app.listen(config.port, () => {
  // Read off the socket rather than named from config: `listen(port)` passes no
  // host, so the public API has no configured bind address — only the admin
  // server does — and which interface Node chose is a fact only the bound
  // socket holds. `address()` is an `AddressInfo` here: this is a TCP server
  // inside its own listening callback. Both events report the same read, so a
  // dual-stack host cannot get two answers to one question.
  const bound = server.address() as { address: string; port: number };
  emitApiListening(bound.address, bound.port);
  emitServerReady(
    `${bound.address}:${bound.port}`,
    `${config.adminBindAddress}:${config.adminPort}`,
    Date.now() - startTime,
  );
  console.log(`DAGsocial node listening on :${config.port}`);
});

// 6. Block application (server role) — delegated to block-apply.ts
// ---------------------------------------------------------------------------

// 7. Graceful shutdown
process.on('SIGINT', () => {
  emitShutdownSignalReceived('SIGINT');
  stopBlockCreator();
  net.stop().catch((err: unknown) => console.warn(`Net stop error: ${String(err)}`));
  closeDb();
  server.close();
  adminServer.close();
  emitServerShuttingDown('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  emitShutdownSignalReceived('SIGTERM');
  stopBlockCreator();
  net.stop().catch((err: unknown) => console.warn(`Net stop error: ${String(err)}`));
  closeDb();
  server.close();
  adminServer.close();
  emitServerShuttingDown('SIGTERM');
  process.exit(0);
});
