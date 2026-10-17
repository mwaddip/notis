import type { NetNode } from '@dagsocial/net';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import type { PipelineContext } from './header-pipeline.js';
import { config } from '../config.js';
import {
  deliverBlocks,
  deliverGossipedBlock,
  deliverHeaders,
  fullyApplied,
  gateHeld,
  initIntake,
  onPeerDisconnected as intakeOnPeerDisconnected,
  wantedBlocks,
  type IntakeCallbacks,
} from './intake.js';
import {
  knowsTip,
  locatorFor,
} from './header-pipeline.js';
import {
  CorruptChainStateError,
  failStopIfCorruptChain,
} from './corrupt-state.js';
import { getCurrentHeight, getLowestJournalHeight } from '../store/index.js';
import { nowMs, retargetParams } from './difficulty.js';

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The intake owns
 * what it runs". Penalties, "best chain moved" events and `needHeaders` asks
 * leave the intake through callbacks the wiring injects — here, net's own
 * methods.
 */
export function createIntakeCallbacks(net: NetNode): IntakeCallbacks {
  return {
    penalize: (peerId, kind, reason) => net.penalizePeer(peerId, kind, reason),
    chainMoved: () => net.chainMoved(),
    needHeaders: (peerId) => net.needHeaders(peerId),
  };
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers. The context the
 * intake and the pipeline read: schedule, params, nowMs, maxReorgDepth,
 * genesisId, lowestJournalHeight and the applied-tip height. `genesisId` is
 * the empty string on networks that do not pin block 1.
 */
export function createPipelineContext(): PipelineContext {
  return {
    params: retargetParams(),
    schedule: config.protocolVersionSchedule,
    nowMs,
    maxReorgDepth: config.maxReorgDepth,
    genesisId: config.profile.genesisId,
    lowestJournalHeight: () => getLowestJournalHeight(),
    appliedTipHeight: () => getCurrentHeight(),
  };
}

/**
 * NODE_INTERFACE → Sync handlers (pull-path) → "setChainView(view)": each
 * answer is a point read or an in-memory answer, and the reads that decode
 * a stored row hand a corrupt-state error to `failStopIfCorruptChain`.
 */
function wrapCorrupt<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    try {
      return fn(...args);
    } catch (err) {
      if (err instanceof CorruptChainStateError) failStopIfCorruptChain(err);
      throw err;
    }
  };
}

export interface ChainViewSurface {
  locatorFor(peerId: string): string[];
  knowsTip(peerId: string, hash: string): boolean;
  wantedBlocks(): { id: string; height: number }[];
  fullyApplied(): boolean;
  gateHeld(): void;
}

export function createChainView(): ChainViewSurface {
  return {
    locatorFor: wrapCorrupt(locatorFor),
    knowsTip: wrapCorrupt(knowsTip),
    wantedBlocks: wrapCorrupt(wantedBlocks),
    fullyApplied,
    gateHeld,
  };
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". The gossip registration hands a block to the intake's gossiped
 * entry; a corrupt-state error out of the item reaches `failStopIfCorruptChain`,
 * as the pull registration's `setPipeline` seam does.
 */
export function wireNet(net: NetNode): void {
  initIntake(createIntakeCallbacks(net), createPipelineContext());

  // NODE_INTERFACE → Sync handlers (pull-path) → "setPipeline(intake)" /
  // "setChainView(view)".
  const pipelineIntake = {
    deliverHeaders: (peerId: string, claimHash: string, headers: BlockHeader[]) =>
      runItem(() => deliverHeaders(peerId, claimHash, headers)),
    deliverBlocks: (peerId: string, blocks: OrderingBlock[]) =>
      runItem(() => deliverBlocks(peerId, blocks)),
  };
  net.setPipeline(pipelineIntake);
  net.setChainView(createChainView());

  // NODE_INTERFACE → Relay handlers (mempool-based) → "onOrderingBlock(block,
  // fromPeerId)": gossip past Stage 1 enters the intake.
  net.onOrderingBlock((block, fromPeerId) => {
    runItem(() => deliverGossipedBlock(fromPeerId, block)).catch(() => {});
  });

  // NODE_INTERFACE → Fork choice decides on verified headers → "One intake,
  // one at a time": a peer that has gone takes its pending block, its presync
  // and its memo entry with it.
  net.onPeerDisconnected((peerId) => {
    try {
      intakeOnPeerDisconnected(peerId);
    } catch (err) {
      if (err instanceof CorruptChainStateError) failStopIfCorruptChain(err);
      throw err;
    }
  });
}

/**
 * A single intake item runs inside this wrapper so a `CorruptChainStateError`
 * out of admission, binding, staging, the funnel or `reorg` reaches the
 * fail-stop seam; every other error ends the item logged and the node runs on
 * (NODE_INTERFACE → "An unhandled rejection is logged, and the node keeps
 * running").
 */
async function runItem<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CorruptChainStateError) failStopIfCorruptChain(err);
    const stack = err instanceof Error && err.stack ? err.stack : String(err);
    console.error(`Pipeline item ended with an unexpected error: ${stack}`);
    throw err;
  }
}
