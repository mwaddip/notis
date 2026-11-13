// NET_INTERFACE → Readers — the capability codes a full node declares and
// the predicate that asks whether a peer's declared set serves the chain.
// Browser-safe: imports `./types.js` alone (no Node built-in, no Node
// global), so both the Node entry and the browser entry re-export it.
import {
  MSG_SYNC_INFO,
  MSG_MODIFIER_REQUEST,
  MSG_GET_PEERS,
  MSG_GET_HEADERS,
  MSG_GET_BLOCKS,
} from './types.js';

/**
 * NET_INTERFACE → Readers → "A peer's capabilities say what it serves":
 * the request codes a full node answers — `SyncInfo` (2),
 * `ModifierRequest` (4), `GetPeers` (8), `GetHeaders` (14), `GetBlocks`
 * (16).
 */
export const NODE_CAPABILITIES: readonly number[] = [
  MSG_SYNC_INFO,
  MSG_MODIFIER_REQUEST,
  MSG_GET_PEERS,
  MSG_GET_HEADERS,
  MSG_GET_BLOCKS,
];

/**
 * NET_INTERFACE → Readers → "A peer's capabilities say what it serves":
 * a reader declares no capability.
 */
export const READER_CAPABILITIES: readonly number[] = [];

/**
 * NET_INTERFACE → Readers → "A peer's capabilities say what it serves":
 * a serving reader declares `ModifierRequest` (4) alone — the one code
 * it answers.
 */
export const SERVING_READER_CAPABILITIES: readonly number[] = [MSG_MODIFIER_REQUEST];

/**
 * NET_INTERFACE → Readers → "A peer's capabilities say what it serves".
 */
export function servesChain(caps: readonly number[]): boolean {
  let hasHeaders = false;
  let hasBlocks = false;
  for (const c of caps) {
    if (c === MSG_GET_HEADERS) hasHeaders = true;
    else if (c === MSG_GET_BLOCKS) hasBlocks = true;
  }
  return hasHeaders && hasBlocks;
}

/**
 * NET_INTERFACE → Readers → "A peer is asked for a code only if it
 * declares it". True when `caps` declares `code`.
 */
export function declares(caps: readonly number[], code: number): boolean {
  for (const c of caps) if (c === code) return true;
  return false;
}
