import type { BlockHeader, OrderingBlock } from '@dagsocial/types';

export interface SyncInfo {
  tipHeight: number;
  tipHash: string;
}

export interface Inv {
  typeId: number; // 101 = ordering block header; 102 retired, never reuse
  ids: string[];
}

export interface ModifierRequest {
  typeId: number;
  ids: string[];
}

export interface ModifierResponse {
  typeId: number;
  modifiers: { id: string; data: Uint8Array }[];
}

export interface SyncState {
  phase: 'idle' | 'syncing' | 'synced';
}

/**
 * NET_INTERFACE → Sync Handler Registration — the `setPipeline` row: the
 * node's pipeline intake. `deliverHeaders` takes a page held to its shape
 * with the claim the page was asked toward and resolves `true` when the
 * pipeline took the page whole, `false` otherwise. `deliverBlocks` hands
 * a `Blocks` answer's blocks on.
 */
export interface PipelineIntake {
  deliverHeaders(peerId: string, claimHash: string, headers: BlockHeader[]): Promise<boolean>;
  deliverBlocks(peerId: string, blocks: OrderingBlock[]): Promise<void>;
}

/**
 * NET_INTERFACE → Sync Handler Registration — the `setChainView` row: the
 * node's header tree as the scheduler reads it, the one place it learns
 * anything about the chain. One question is one call — a point read or an
 * in-memory answer (ARCHITECTURE → Correct and cheap are separate
 * obligations).
 */
export interface ChainView {
  locatorFor(peerId: string): string[];
  knowsTip(peerId: string, hash: string): boolean;
  wantedBlocks(): { id: string; height: number }[];
  fullyApplied(): boolean;
  gateHeld(): void;
}
