/**
 * The single-flight runner for fork resolutions
 * (NODE_INTERFACE → Fork choice decides on verified headers →
 * "One resolution at a time").
 *
 * `handleOrderingBlock` hands non-extending blocks here through
 * `handOverForkResolution`. The runner runs at most one resolution at a time:
 * with none in flight, the delivered block starts one; with one in flight,
 * the block is kept as its delivering peer's pending block (one per peer id;
 * a later block from the same peer replaces the earlier; a block whose hash
 * matches the one running for THAT peer, or the one already pending for it,
 * is dropped). When a resolution ends, the pending blocks are handed back to
 * `handleOrderingBlock` in one synchronous run — nothing waits between the
 * resolution's end and the first dispatch, so a delivery arriving during the
 * drain cannot be stranded with `running === null` and a block pending.
 *
 * `handle-block.ts` is reached by static import both ways: neither module
 * reads the other's bindings at load time, so the cycle resolves and the
 * handler is in scope by the time the dispatch runs.
 */

import type { OrderingBlock } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import {
  resolveFork,
  dropForkResolutionMemoForPeer,
  type ForkResolutionNet,
} from './fork-resolution.js';
import { handleOrderingBlock } from './handle-block.js';
import { failStopIfCorruptChain, CorruptChainStateError } from './corrupt-state.js';

interface PendingEntry {
  block: OrderingBlock;
  hash: string;
  net: ForkResolutionNet;
  peerId: string;
}

interface RunningEntry {
  block: OrderingBlock;
  hash: string;
  net: ForkResolutionNet;
  peerId: string;
  settled: Promise<void>;
}

let running: RunningEntry | null = null;
/** One pending block per peer — NODE_INTERFACE → "One resolution at a time". */
const pendingByPeer = new Map<string, PendingEntry>();
/** FIFO order of peers with a pending entry. Rebuilt on hand-back. */
const pendingOrder: string[] = [];

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "One resolution at a time". `handleOrderingBlock` hands a non-extending
 * block here. The runner records it (starts a resolution or stores it as the
 * delivering peer's pending block) and returns nothing.
 *
 * A block whose header is outside the encodable domain has no hash to key
 * identity by. The gossip layer refuses such a block at the PoW check before
 * delivery, and `handleOrderingBlock`'s own already-held check reads
 * `blockHash` without stopping at a null answer, so a null here is a
 * delivery with no identity to compare — logged and dropped.
 */
export function handOverForkResolution(
  block: OrderingBlock,
  net: ForkResolutionNet,
  peerId: string,
): void {
  const hash = blockHash(block.header);
  if (hash === null) {
    console.warn(
      `Fork resolution: refusing a delivery whose header is outside the ` +
      `encodable domain (peer ${peerId}, height ${block.header.height})`,
    );
    return;
  }
  if (running === null) {
    startRunning({ block, hash, net, peerId });
    return;
  }
  if (running.peerId === peerId && running.hash === hash) {
    // The block that is running for THIS peer is dropped. A match from a
    // different peer is not: that is the second peer's pending block.
    return;
  }
  const pending = pendingByPeer.get(peerId);
  if (pending && pending.hash === hash) {
    // The block already pending for this peer is dropped (one pending per peer).
    return;
  }
  if (pending) {
    // A later block from the same peer replaces the earlier. The peer's
    // place in the arrival order is kept — a later block succeeds the
    // earlier, not the queue's tail.
    pendingByPeer.set(peerId, { block, hash, net, peerId });
    return;
  }
  pendingByPeer.set(peerId, { block, hash, net, peerId });
  pendingOrder.push(peerId);
}

/**
 * NODE_INTERFACE → "One resolution at a time": a disconnected peer loses its
 * pending block. NODE_INTERFACE → Re-scoring is memoised removes the memo
 * entry at the same seam — an entry a peer leaves takes its memo with it.
 * `src/index.ts`'s `net.onPeerDisconnected` registration calls this.
 */
export function onPeerDisconnectedForForkResolution(peerId: string): void {
  if (pendingByPeer.delete(peerId)) {
    const idx = pendingOrder.indexOf(peerId);
    if (idx >= 0) pendingOrder.splice(idx, 1);
  }
  dropForkResolutionMemoForPeer(peerId);
}

function startRunning(entry: PendingEntry): void {
  const settled = runResolution(entry);
  running = {
    block: entry.block,
    hash: entry.hash,
    net: entry.net,
    peerId: entry.peerId,
    settled,
  };
}

async function runResolution(entry: PendingEntry): Promise<void> {
  let outcome: 'done' | 'tip-moved' = 'done';
  let fatal = false;
  try {
    outcome = await resolveFork(entry.block, entry.net, entry.peerId);
  } catch (err) {
    if (err instanceof CorruptChainStateError) {
      // NODE_INTERFACE → "The funnel is total" and NODE_INTERFACE →
      // "An unhandled rejection is logged, and the node keeps running":
      // fail-stop for the corrupt-state family. The runner holds nothing
      // past this point — pending is cleared below.
      fatal = true;
      failStopIfCorruptChain(err);
    } else {
      // NODE_INTERFACE → "An unhandled rejection is logged, and the node keeps running":
      // the runner owns each resolution's promise, so a throw outside the
      // corrupt-state family ends this resolution without reaching the
      // process-level handler.
      const stack = err instanceof Error && err.stack ? err.stack : String(err);
      console.error(`Fork resolution ended with an unexpected error: ${stack}`);
    }
  }
  // NODE_INTERFACE → Fork choice decides on verified headers →
  // "A resolution that ends because the tip moved hands its own block back the same way".
  // The check reads pending BEFORE the drain so the rule's "unless its peer
  // has a later one pending" meets its subject.
  const samePeerHasLater = !fatal && pendingByPeer.has(entry.peerId);
  const handBacks: PendingEntry[] = fatal ? [] : drainPending();
  if (fatal) {
    // After a corrupt-state throw the runner holds nothing — pending blocks
    // are abandoned alongside the one that ran, so the idle wait rests and
    // the runner refuses no further dispatch beyond what the fail-stop
    // boundary already covers.
    pendingByPeer.clear();
    pendingOrder.length = 0;
  }
  if (!fatal && outcome === 'tip-moved' && !samePeerHasLater) {
    handBacks.unshift(entry);
  }
  // Hand back synchronously beside `running = null`. Nothing waits between
  // the drain and the first `handleOrderingBlock` call; the first dispatched
  // non-extending block reassigns `running` through `startRunning`, so an
  // outside observer resuming on this promise either sees a new resolution
  // running or sees the resting state the rule allows.
  running = null;
  for (const handBack of handBacks) {
    try {
      handleOrderingBlock(handBack.block, handBack.peerId, handBack.net);
    } catch (err) {
      failStopIfCorruptChain(err);
    }
  }
}

function drainPending(): PendingEntry[] {
  const out: PendingEntry[] = [];
  for (const peerId of pendingOrder) {
    const entry = pendingByPeer.get(peerId);
    if (entry) out.push(entry);
  }
  pendingOrder.length = 0;
  pendingByPeer.clear();
  return out;
}

/**
 * NODE_INTERFACE → "One resolution at a time": a caller waits here for every
 * launched resolution to settle, including ones started by a hand-back.
 * Nothing running is the resting state — a hand-back that chains into
 * another resolution has already reassigned `running` before the previous
 * one's promise resolves, so this loop never polls `pendingByPeer` with
 * `running === null`.
 */
export async function waitForForkResolutionIdle(): Promise<void> {
  while (running !== null) {
    try {
      await running.settled;
    } catch {
      // `runResolution` handles its own errors; a rejection here is a non-
      // family rethrow out of `failStopIfCorruptChain` during the hand-back.
      // The next iteration reads the state the throw left behind.
    }
  }
}

/**
 * Reset for the suites. Clears the runner's state without awaiting an
 * in-flight resolution — a case that leaves one running is itself a bug.
 */
export function resetForkResolutionRunner(): void {
  running = null;
  pendingByPeer.clear();
  pendingOrder.length = 0;
}
