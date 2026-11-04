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
 * NET_INTERFACE → Readers → "A full node declares `NODE_CAPABILITIES`, the
 * request codes it answers — `SyncInfo` (2), `ModifierRequest` (4),
 * `GetPeers` (8), `GetHeaders` (14), `GetBlocks` (16)".
 */
export const NODE_CAPABILITIES: readonly number[] = [
  MSG_SYNC_INFO,
  MSG_MODIFIER_REQUEST,
  MSG_GET_PEERS,
  MSG_GET_HEADERS,
  MSG_GET_BLOCKS,
];

/**
 * NET_INTERFACE → Readers → "a reader declares `READER_CAPABILITIES`,
 * none".
 */
export const READER_CAPABILITIES: readonly number[] = [];

/**
 * NET_INTERFACE → Readers → "A peer's capabilities say what it serves. A
 * peer whose handshake declares `GetHeaders` (14) and `GetBlocks` (16)
 * serves the chain — a node; one that declares neither is a reader".
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
