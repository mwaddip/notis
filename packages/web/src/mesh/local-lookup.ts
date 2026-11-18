// MESH_INTERFACE → Discovery → "A node the access point answers" — the
// mesh client's read of `http://10.78.79.1/mesh/identity`: the
// answer held to its fields, loopback addresses dropped from
// `localAddrs`, and the `noNodeAnswered` predicate the client decides
// a check's tip events by. Pure, browser-safe
// (MESH_INTERFACE → Place in the workspace): no `node:` import, no
// Node global.

import type { HttpFetch } from '@dagsocial/node-reads';
import { fetchJson, MESH_IDENTITY_READ_BYTES, isRecord } from '@dagsocial/node-reads';
import { peerIdFromNotisId, MeshKeyError } from '@dagsocial/net/browser';
import { multiaddr } from '@multiformats/multiaddr';

import type { TipEvent } from './tip-events.js';

/**
 * MESH_INTERFACE → Discovery → "A node the access point answers" — the
 * URL the client reads. Every access point answers at `10.78.79.1`, so
 * the URL is one constant whatever port an operator runs the node on,
 * since the access point's tool maps it to the node's own
 * (`NODE_INTERFACE → "A mesh node answers its identity"`). The URL names
 * an address, never a name: a browser's HTTPS-only mode upgrades a
 * plain-`http:` request to a name and leaves one to a private address
 * alone, and an address asks nothing of DNS.
 */
export const LOCAL_IDENTITY_URL = 'http://10.78.79.1/mesh/identity';

/**
 * MESH_INTERFACE → Discovery → "A node the access point answers" — the
 * outcome of one read of the identity URL. `answered`: a well-formed
 * answer, its loopback addresses dropped and at least one left.
 * `failed`: the read did not answer — a transport failure, the
 * deadline, or a non-2xx. `refused`: something answered wrongly — over
 * the cap, unparseable, or failing one of the passage's field rules.
 */
export type LocalLookupResult =
  | { result: 'answered'; notisId: string; localAddrs: string[] }
  | { result: 'failed'; message: string }
  | { result: 'refused'; reason: string };

const HEX64_RE = /^[0-9a-f]{64}$/;
const DNS_RE = /\/dns4\/|\/dns6\/|\/dnsaddr\//;

// MESH_INTERFACE → Discovery → "A node the access point answers" —
// "A loopback address is dropped — a node lists its own
// (`127.0.0.1` beside its other interfaces), and a page is never
// pointed at the reader's loopback". The check is the address's
// first network component: an IPv4 in `127.0.0.0/8`, or IPv6 `::1`.
function isLoopbackAddr(addr: string): boolean {
  const m = /^\/ip4\/([^/]+)\//.exec(addr);
  if (m !== null) {
    const ip = m[1]!;
    return /^127\./.test(ip);
  }
  const m6 = /^\/ip6\/([^/]+)\//.exec(addr);
  if (m6 !== null) {
    return m6[1] === '::1';
  }
  return false;
}

// MESH_INTERFACE → Discovery → "A node the access point answers" —
// the rule an answered address passes: it parses, carries no DNS
// component (as `config.ts`' `assertNoDns` refuses), carries
// `/webrtc-direct/`, and ends in `/p2p/<peerId>` where `<peerId>` is
// the key's.
function addressBelongsToKey(addr: string, peerIdString: string): boolean {
  if (DNS_RE.test(addr)) return false;
  if (!addr.includes('/webrtc-direct/')) return false;
  try {
    multiaddr(addr);
  } catch {
    return false;
  }
  const m = /\/p2p\/([^/]+)$/.exec(addr);
  if (m === null) return false;
  return m[1] === peerIdString;
}

/**
 * MESH_INTERFACE → Discovery → "A node the access point answers" — the
 * one read of the identity URL. The read goes through `fetchJson` (the
 * route's deadline `REQUEST_TIMEOUT_MS`, the byte cap
 * `MESH_IDENTITY_READ_BYTES`); the answer's fields are held to the
 * passage, loopback addresses dropped from `localAddrs`, `multiaddrs`
 * not read. `failed` covers a transport failure (status 0), the
 * deadline (status 0 with `timedOut`), and a non-2xx — something a
 * page's network stack reads as nothing answering. `refused` covers an
 * over-cap or unparseable 2xx (something answered wrongly) and each
 * field rule of the passage.
 */
export async function readLocalIdentity(
  httpFetch: HttpFetch,
  url: string,
): Promise<LocalLookupResult> {
  const res = await fetchJson<unknown>(httpFetch, url, MESH_IDENTITY_READ_BYTES);
  if (!res.ok) {
    if (res.status === 0) {
      return { result: 'failed', message: res.body };
    }
    // An over-cap answer reads as `body over <cap> bytes` at the 2xx
    // status; a 2xx that will not parse reads as `unparseable body:
    // …`. Both are the node answering wrongly, not a non-answer, so
    // they are `refused`. A non-2xx (a 404 while the node restarts,
    // say) is `failed`.
    if (res.status >= 200 && res.status < 300) {
      return { result: 'refused', reason: res.body };
    }
    return { result: 'failed', message: `status ${res.status}` };
  }
  const data = res.data;
  if (!isRecord(data)) {
    return { result: 'refused', reason: 'answer is not an object' };
  }
  const notisId = data['notisId'];
  if (typeof notisId !== 'string' || !HEX64_RE.test(notisId)) {
    return { result: 'refused', reason: 'notisId is not 64 lowercase hex characters' };
  }
  const peerId = data['peerId'];
  if (typeof peerId !== 'string') {
    return { result: 'refused', reason: 'peerId is not a string' };
  }
  let peerIdFromKey: string;
  try {
    peerIdFromKey = peerIdFromNotisId(notisId).toString();
  } catch (e) {
    if (e instanceof MeshKeyError) {
      return { result: 'refused', reason: `peerId derivation: ${e.message}` };
    }
    throw e;
  }
  if (peerId !== peerIdFromKey) {
    return { result: 'refused', reason: 'peerId does not match notisId' };
  }
  const localAddrs = data['localAddrs'];
  if (!Array.isArray(localAddrs) || localAddrs.length === 0) {
    return { result: 'refused', reason: 'localAddrs is not a non-empty array' };
  }
  const kept: string[] = [];
  for (const a of localAddrs) {
    if (typeof a !== 'string') {
      return { result: 'refused', reason: 'localAddrs carries a non-string entry' };
    }
    if (!addressBelongsToKey(a, peerId)) {
      return { result: 'refused', reason: `localAddrs carries an address this key does not own: ${a}` };
    }
    if (isLoopbackAddr(a)) continue;
    kept.push(a);
  }
  if (kept.length === 0) {
    return { result: 'refused', reason: 'every localAddrs address is loopback' };
  }
  // `multiaddrs` is read for nothing (the passage): a private node's
  // are relay addresses through public nodes the access point does
  // not reach.
  return { result: 'answered', notisId, localAddrs: kept };
}

/**
 * MESH_INTERFACE → Discovery → "A node the access point answers" — the
 * read runs "at the end of a check in which no node answered: every
 * node the check read failed as a transport failure". The caller
 * stamps the check's end and hands this helper the check's tip
 * events; the client runs the read only when this answers true. True
 * for none — a check that read nothing passes the predicate.
 */
export function noNodeAnswered(
  nodes: ReadonlyArray<{ event: TipEvent }>,
): boolean {
  for (const n of nodes) {
    const ev = n.event;
    if (ev.ev !== 'failure') return false;
    if (ev.kind !== 'transport') return false;
  }
  return true;
}
