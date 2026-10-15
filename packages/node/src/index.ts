import { loadConfig } from './config.js';
import { initDb, closeDb } from './store/db.js';
import { setMempoolCap } from './store/mempool.js';
import { seedGenesisState } from './services/genesis-state.js';
import { getNetworkRecord } from './store/identity-records.js';
import { startBlockCreator, stopBlockCreator } from './services/block-creator.js';
import { createApp, createAdminApp } from './server.js';
import {
  initJournal,
  emitServerStarting,
  emitServerReady,
  emitApiListening,
  emitShutdownSignalReceived,
  emitServerShuttingDown,
  emitPeerConnected,
  emitPeerDisconnected,
  emitPeerPenalised,
  emitSyncComplete,
} from './journal.js';
import { NetNode } from '@dagsocial/net';
import * as validation from '@dagsocial/validation';
import { countedVerifyOrderingBlockPoW } from './metrics.js';
import { setNet } from './services/net-instance.js';
import { enterDiscovery, notePeerMet } from './services/peer-readiness.js';
import { createAvlProver } from './state/avl-prover.js';
import { handleOrderingBlock, pullBlocksHandler } from './services/handle-block.js';
import { onPeerDisconnectedForForkResolution } from './services/fork-resolution-runner.js';
import { handleRelayedTx } from './services/handle-tx.js';
import {
  failStopIfCorruptChain,
  guardStoreRead,
  handleUnhandledRejection,
} from './services/corrupt-state.js';
import { scheduledPowTargetBits } from './services/difficulty.js';
import {
  getPost,
  isLivePost,
  setPostBody,
  getMissingBodies,
  getStillPlaceholderIds,
  getCurrentHeight,
  getOrderingBlock,
  getOrderingBlockHash,
  getHeightByBlockHash,
  getHeaderAt,
  peerStorage,
  getKarmaOwners,
} from './store/index.js';
import { initBackfill } from './services/backfill.js';

const config = loadConfig();
const startTime = Date.now();

// NODE_INTERFACE → "An unhandled rejection is logged, and the node keeps running":
// one process-level handler receives every promise rejection nothing else
// handled — the corrupt-state family is fail-stop, every other reason is
// logged with its stack. An uncaught synchronous exception has no handler
// here: Node's default stands and the process exits.
process.on('unhandledRejection', handleUnhandledRejection);

// 0. Journal
initJournal();
emitServerStarting('1.0.0', config.networkType);

// 1. Init DB
initDb(config.dbPath);
// MEMPOOL_INTERFACE → Size cap — reject, never evict
setMempoolCap(config.maxMempoolEntries);

// 1a. Initialize AVL prover
//
// Ahead of genesis seeding, which commits its boxes to this tree.
//
// There is deliberately no rebuild-from-UTXO-set path here (NODE_INTERFACE →
// AVL+ State Root → "AVL+ tree shape is history-dependent"). Such a rebuild is
// unsound: AVL+ tree shape is history-dependent, so a tree rebuilt by
// re-inserting a set forks against one grown incrementally to the same content.
// Nor would a rebuild be reachable — under @dagsocial/avltree the
// PersistentBatchAVLProver constructor writes the empty-tree version to empty
// storage and throws if `version()` is still null after, so an
// empty-storage trigger is statically false. The sound restart path is the
// persisted tree the constructor loads. Operational consequence: AVL storage
// must never be wiped independently of the chain — wiping both together is
// the only supported reset.
createAvlProver();

// 1b. Seed the genesis state. Must happen after DB init, before any route that
//     might read a genesis box.
//
//     `seedGenesisState` owns which boxes a network's genesis holds and the
//     order they reach the tree in; both are consensus-visible, so neither is
//     an artefact of this file. It takes no parameter: the faucet identity it
//     may seed is `profile.faucetPublicKey`, and this node holds no secret key
//     to go with it.
//
//     Fail-stop in three steps: the message, then `closeDb()`, then a non-zero
//     exit — the only startup gate in this file with that shape. Closing the
//     handle before exiting is what keeps a refusal from leaving a `-wal` beside
//     a store the operator is about to inspect. Every refusal `seedGenesisState`
//     raises is a node that must not run, and each one writes a sentence for the
//     operator that a bare top-level throw would bury under a stack trace.
try {
  seedGenesisState();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  closeDb();
  process.exit(1);
}

// NODE_INTERFACE → "The genesis state root is checked fail-stop"
// A chain with no root has N = 0 and no member can ever be set.
{
  const nr = getNetworkRecord();
  if (nr.memberCount === 0) {
    console.error(
      `Network "${config.networkType}" has memberCount = 0 after seeding — no root ` +
      'exists, so no member can ever be set and the network cannot function. ' +
      'Add at least one genesis committee key or a faucet identity to the profile.',
    );
    closeDb();
    process.exit(1);
  }
}

// 2. Create NetNode
// The three discovery knobs are passed explicitly: NET_INTERFACE documents
// their defaults as binding only when node supplies them — unset, net's
// internal fallbacks silently govern instead.
const net = new NetNode(
  {
    // The profile's wire magic. Required in NetConfig — net has no fallback of
    // its own (NET_INTERFACE → "Magic Bytes").
    magic: config.profile.magic,
    // The profile's era table, supplied like `magic` — the handshake, tx
    // validator and boundary sweep read the era from it (NET_INTERFACE → Config).
    protocolVersionSchedule: config.profile.protocolVersionSchedule,
    // NODE_INTERFACE → Configuration
    orderingBlockPowTargetFloorBits: config.orderingBlockPowTargetFloorBits,
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
  { ...validation, verifyOrderingBlockPoW: countedVerifyOrderingBlockPoW },
  peerStorage,
);
setNet(net);

// 2a. Karma membership — seeded from the store; block application and reorg
// move it after each commit (NODE_INTERFACE → Post transactions → "The set
// moves after a commit, never inside a transaction").
net.setKarmaMembers(getKarmaOwners());

// 3. Register Stage 2 handlers

// Both gossip and pull converge on `handleOrderingBlock` (NODE_INTERFACE →
// Relay handlers / Sync handlers). Each registration wraps the call in
// `failStopIfCorruptChain`. A block that does not extend the tip goes to the
// fork-resolution runner, which owns each resolution's promise and each
// hand-back (NODE_INTERFACE → Fork choice decides on verified headers →
// "One resolution at a time").
net.onOrderingBlock((block, fromPeerId) => {
  try {
    handleOrderingBlock(block, fromPeerId, net);
  } catch (err) {
    failStopIfCorruptChain(err);
  }
});

// Relayed transactions are validated and admitted by `handleRelayedTx`
// (NODE_INTERFACE → Relay handlers).
net.onTx(handleRelayedTx);

net.setBlocksHandler(pullBlocksHandler(net));

// The provider `net` reads stored blocks through (NODE_INTERFACE → Sync
// handlers). `guardStoreRead` wraps the read in `failStopIfCorruptChain`: a
// stored row that does not decode stops the node rather than failing every
// handshake and query as a peer's fault inside `net`'s contained catches.
const guardedGetOrderingBlock = guardStoreRead(getOrderingBlock);
net.setHeadersHandler(guardedGetOrderingBlock);

// NODE_INTERFACE → Sync handlers: the header stored at a height, decoded and
// no body read — what a served `GetHeaders` reads. Wrapped in
// `guardStoreRead` like the block provider.
net.setHeaderProvider(guardStoreRead(getHeaderAt));

// NODE_INTERFACE → Sync handlers: the scheduled-target provider decodes a
// stored header, so `guardStoreRead` promotes a corrupt row to a fail-stop.
net.setScheduledTargetProvider(guardStoreRead(scheduledPowTargetBits));

// The tip height net advertises in handshakes and SyncInfo — the store's
// MAX(height), unwrapped: it decodes no row (NODE_INTERFACE → Sync handlers).
net.setChainHeightProvider(getCurrentHeight);

// NODE_INTERFACE → Sync handlers: the block_hash column, unwrapped — a column
// read decodes no row, so there is nothing for failStopIfCorruptChain to promote.
net.setBlockIdProvider(getOrderingBlockHash);
net.setHeightByBlockIdProvider(getHeightByBlockHash);

// The seam the net layer serves a stored body through — what a served
// `MODIFIER_POST_BODY` response carries (NET_INTERFACE → Sync Handler
// Registration). The body a placeholder's row holds, or `null` when the row
// has none or is withdrawn.
net.setPostBodyProvider((id: string) => {
  const result = getPost(id);
  if (!isLivePost(result)) return null;
  return result.content;
});

initBackfill({
  requestPostBodies: (wanted, peerId) => net.requestPostBodies(wanted.map(w => ({ id: w.id, contentHash: Buffer.from(w.contentHash, 'hex') })), peerId),
  getConnectedPeers: () => net.getConnectedPeers(),
  setPostBody,
  getMissingBodies,
  getStillPlaceholderIds,
});

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
net.onPeerActive((peerId: string, direction: 'inbound' | 'outbound') => {
  notePeerMet();
  emitPeerConnected(peerId, direction);
});
net.onPeerDisconnected((peerId: string, reason: string) => {
  // NODE_INTERFACE → "One resolution at a time": the runner's pending block
  // and the re-score memo leave with the peer.
  onPeerDisconnectedForForkResolution(peerId);
  emitPeerDisconnected(peerId, reason);
});
net.onPeerPenalised((peerId: string, kind: string, detail: string | null) => {
  emitPeerPenalised(peerId, kind, detail);
});

let lastSyncCompleteAt = startTime;
net.onSyncComplete(() => {
  const now = Date.now();
  emitSyncComplete(getCurrentHeight(), now - lastSyncCompleteAt);
  lastSyncCompleteAt = now;
});

// 5. Start block creator (miner only) and HTTP server
if (config.nodeRole === 'miner') {
  startBlockCreator(config);
  console.log(`Node role: miner — producing ordering blocks`);
} else {
  console.log(`Node role: server — applying inbound ordering blocks`);
}

const app = createApp(config);
const adminServer = createAdminApp(config, {
  getConnectedPeers: () => net.getConnectedPeers(),
  syncPhase: () => net.syncPhase(),
  protocolVersionSchedule: config.protocolVersionSchedule,
});
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
