/**
 * The single-flight runner for fork resolutions
 * (NODE_INTERFACE → Fork choice decides on verified headers →
 * "One resolution at a time").
 *
 * Non-extending blocks reach the runner through `handOverForkResolution`,
 * which `handle-block.ts` calls after `handleOrderingBlock`'s own arms have
 * ruled a block out of apply and out of no-op. The runner runs at most one
 * resolution at a time: with none in flight, the delivered block starts one;
 * with one in flight, the block is kept as its peer's **pending** block (one
 * per peer, a later block replacing the earlier, and a block that is the one
 * running for that peer or already pending for it dropped). When a resolution
 * ends, each pending block is handed back to `handleOrderingBlock` — the real
 * function, not a copy of its arms — in the order it arrived, and judged on
 * the tip that then stands.
 *
 * **Why the runner lives beside `fork-resolution.ts` rather than inside it.**
 * The runner reads `resolveFork`'s outcome and `handleOrderingBlock`'s call
 * surface — two seams no other caller of `resolveFork` reads — and the hand-
 * back path recurses through `handleOrderingBlock`, which imports the runner.
 * A top-level import of `handle-block.ts` from this module would complete the
 * cycle; the hand-back therefore reaches `handleOrderingBlock` through a
 * dynamic import, so the module graph stays acyclic at load time while the
 * runtime path is the one call every delivery takes.
 */

import type { OrderingBlock } from '@dagsocial/types';
import {
  resolveFork,
  dropForkResolutionMemoForPeer,
  type ForkResolutionNet,
} from './fork-resolution.js';
import { failStopIfCorruptChain, CorruptChainStateError } from './corrupt-state.js';

interface PendingEntry {
  block: OrderingBlock;
  net: ForkResolutionNet;
  peerId: string;
}

interface RunningEntry {
  block: OrderingBlock;
  net: ForkResolutionNet;
  peerId: string;
  settled: Promise<void>;
}

let running: RunningEntry | null = null;
/** One pending block per peer — NODE_INTERFACE → "One resolution at a time". */
const pendingByPeer = new Map<string, PendingEntry>();
/** FIFO order of peers with a pending entry. Rebuilt on hand-back. */
const pendingOrder: string[] = [];

function samePeerAs(a: OrderingBlock, b: OrderingBlock): boolean {
  // The block's hash is produced by apply's validator before it reaches the
  // runner, but a cheap identity check that never hashes is enough: a block
  // delivered twice carries the same reference-shape payload, so a shallow
  // comparison of header fields distinguishes "the same block again" from a
  // later one by the same peer without pulling in `blockHash`.
  if (a === b) return true;
  if (a.header.height !== b.header.height) return false;
  if (a.header.prevBlockHash !== b.header.prevBlockHash) return false;
  if (a.header.utxoTxRoot !== b.header.utxoTxRoot) return false;
  if (a.header.stateRoot !== b.header.stateRoot) return false;
  if (a.header.powNonce !== b.header.powNonce) return false;
  return a.header.createdAt === b.header.createdAt;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "One resolution at a time": `handleOrderingBlock` hands a non-extending
 * block here, and the runner answers whether it took the block (true for
 * started or pending; false for dropped). The caller still returns `false`
 * to the pull batch, as the contract requires.
 */
export function handOverForkResolution(
  block: OrderingBlock,
  net: ForkResolutionNet,
  peerId: string,
): void {
  if (running === null) {
    startRunning({ block, net, peerId });
    return;
  }
  if (samePeerAs(running.block, block)) {
    // The block that is running for this peer is dropped (one in flight is
    // enough; the running resolution scores the delivered branch already).
    return;
  }
  const pending = pendingByPeer.get(peerId);
  if (pending && samePeerAs(pending.block, block)) {
    // The block already pending for this peer is dropped (one pending
    // per peer).
    return;
  }
  if (pending) {
    // Replace the earlier pending block from the same peer. The peer's
    // place in the order is kept — a later block from the same peer
    // succeeds the earlier, not the queue's tail.
    pendingByPeer.set(peerId, { block, net, peerId });
    return;
  }
  pendingByPeer.set(peerId, { block, net, peerId });
  pendingOrder.push(peerId);
}

/**
 * NODE_INTERFACE → "One resolution at a time": a disconnected peer loses its
 * pending block and its re-score memo entry. `src/index.ts`'s
 * `net.onPeerDisconnected` registration calls this.
 */
export function onPeerDisconnectedForForkResolution(peerId: string): void {
  if (pendingByPeer.delete(peerId)) {
    const idx = pendingOrder.indexOf(peerId);
    if (idx >= 0) pendingOrder.splice(idx, 1);
  }
  // NODE_INTERFACE → "Re-scoring is memoised": the memo's entry for a peer
  // leaves with its connection, read beside the pending block.
  dropForkResolutionMemoForPeer(peerId);
}

function startRunning(entry: PendingEntry): void {
  const settled = runResolution(entry);
  running = { block: entry.block, net: entry.net, peerId: entry.peerId, settled };
}

async function runResolution(entry: PendingEntry): Promise<void> {
  let outcome: 'done' | 'tip-moved' = 'done';
  let fatal = false;
  try {
    outcome = await resolveFork(entry.block, entry.net, entry.peerId);
  } catch (err) {
    if (err instanceof CorruptChainStateError) {
      // NODE_INTERFACE → "The funnel is total" and →
      // "An unhandled rejection is logged, and the node keeps running":
      // fail-stop for the corrupt-state family. In production this exits,
      // so pending state is moot; in a suite that stubs the boundary, the
      // runner stops dispatching so the state the case asserts on is stable.
      fatal = true;
      failStopIfCorruptChain(err);
    } else {
      // NODE_INTERFACE → "An unhandled rejection is logged, and the node
      // keeps running": the runner owns each resolution's promise, so a
      // throw outside the corrupt-state family ends this resolution without
      // reaching the process-level handler.
      const stack = err instanceof Error && err.stack ? err.stack : String(err);
      console.error(`Fork resolution ended with an unexpected error: ${stack}`);
    }
  }
  // Collect the ordered hand-back list — a resolution that ended because
  // the tip moved hands its own block back the same way (NODE_INTERFACE →
  // Fork choice decides on verified headers → "A resolution that ends
  // because the tip moved hands its own block back the same way"), unless
  // its peer has a later one pending. `running` stays set to the finishing
  // entry across the import so the idle predicate — `running === null &&
  // pendingByPeer.size === 0` — never fires in the gap between the drain and
  // the dispatch of the first hand-back.
  const handBacks: PendingEntry[] = fatal ? [] : drainPending();
  if (!fatal && outcome === 'tip-moved' && !pendingByPeer.has(entry.peerId)) {
    handBacks.unshift(entry);
  }
  await handOffAndRelease(handBacks);
}

async function handOffAndRelease(handBacks: PendingEntry[]): Promise<void> {
  // The hand-back goes through `handleOrderingBlock` itself — the real
  // function, not a copy of its arms — in the order the blocks arrived
  // (NODE_INTERFACE → "One resolution at a time"). The dynamic import keeps
  // the module graph acyclic at load time while the runtime path is the one
  // every delivery takes.
  const { handleOrderingBlock } = await import('./handle-block.js');
  // Reset `running` here, synchronously, immediately before the first
  // dispatch: a hand-back that starts a resolution assigns `running` back in
  // the same tick, so an outside caller's idle predicate never observes the
  // seam.
  running = null;
  for (const entry of handBacks) {
    try {
      handleOrderingBlock(entry.block, entry.peerId, entry.net);
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
 * NODE_INTERFACE → "One resolution at a time": a caller can wait for
 * every launched resolution to settle, including ones started by a hand-back.
 * Nothing running and nothing pending is the resting state.
 */
export async function waitForForkResolutionIdle(): Promise<void> {
  // Successive resolutions chain through `handOffAndRelease`, so one trip
  // through the running promise does not suffice; loop until the state is
  // truly resting.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (running === null && pendingByPeer.size === 0) break;
    if (running !== null) {
      await running.settled;
    }
    // A hand-back promoted a pending entry to running inside the awaited
    // frame; a microtask settles it visibly before the next check.
    await Promise.resolve();
    await Promise.resolve();
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
