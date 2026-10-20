import { BatchAVLVerifier } from '@dagsocial/avltree';
import { RANGE_PAGE_MAX, TREE_KEY_LENGTH, bytesToHex, hexToBytes } from '@dagsocial/types';
import type { AnyBox } from '@dagsocial/types';
import { holdingsPage, treeStateView, verifierSession } from '@dagsocial/consensus';
import type { HoldingKind } from '@dagsocial/consensus';
import type { HttpFetch } from '@dagsocial/node-reads';
import { capped, fetchJson, isRecord, LEDGER_READ_MAX, RANGE_PAGE_READ_BYTES } from '@dagsocial/node-reads';
import { base64ToBytes, shown } from './http.js';
export type { HoldingKind };

const AVL_CFG = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null } as const;

/** `OWNER_HEX_LEN` is the hex length of an owner key — 32 bytes, 64
 *  characters. The caller supplies the key; the client lowercases it where
 *  the chain is read against (TYPES_INTERFACE → Identity). */
const OWNER_HEX_LEN = 64;
const OWNER_HEX = /^[0-9a-f]{64}$/i;

/** A well-formed `stateRoot` is the 33-byte AVL+ digest in 64 lowercase hex
 *  characters plus the one balance byte — the shape the header carries
 *  (TYPES_INTERFACE → Layout — Block; NODE_INTERFACE → HTTP API →
 *  "Hex is lowercase"). */
const STATE_ROOT_HEX = /^[0-9a-f]{66}$/;

/**
 * The outcome of one call to `proveRange`: the full range's boxes under one
 * header, or the first failure's status and verdict. A `no-proof`, `unproven`
 * or `stale` is the answer for the whole range — no box of a range that did
 * not finish is answered (WEB_INTERFACE → The extension → "The verified
 * figures"). `stale` names a `stateRoot` other than the header's: the node
 * holds another block at that height, so no proof under the anchor's root
 * backs the ledger (WEB_INTERFACE → The extension → "A `stateRoot` other than
 * the header's at `tip` is no failed proof").
 */
export type RangeResult =
  | { ok: true; boxes: AnyBox[] }
  | { ok: false; status: 'unproven' | 'no-proof' | 'stale'; verdict: string };

/**
 * NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range route" — one
 * kind's whole range at one height, page by page.
 *
 * For each page the client asks `GET /api/v1/range/<kind>/<owner>?atHeight=
 * <height>&limit=<RANGE_PAGE_MAX>`, carrying the previous page's authenticated
 * `next` as `from` after the first. For every answer: the body is an object
 * or the run is `unproven`; **the answer's `stateRoot` must be the header's
 * before the proof is read**, so a lying node that signs a wrong root cannot
 * make the verifier compute anything; `proof` is base64 and `limit` an
 * integer from 1 to the limit asked, else `unproven` with nothing further
 * read; the page is replayed with the limit the answer served, so a node
 * whose cap is lower still serves. A `BatchAVLVerifier` over the root and
 * the proof answers `null` from `digest()` when the proof fails to anchor —
 * `unproven`. The page is read by `holdingsPage(treeStateView(
 * verifierSession(v)), kind, ownerBytes, from, limit)`; a throw there is
 * `unproven`, with the throw's reason. The page's `next` comes from the
 * verified replay, never from the answer: a reader of the proof knows from
 * the proof alone whether the range ends (CONSENSUS_INTERFACE → The holdings
 * page). Keys strictly rise and each next key is authenticated, so the walk
 * ends where the range does. An `owner` that is not 64 hex is `unproven`
 * with no request made. A transport failure or a non-2xx — 404 `height not
 * available` among them — is `no-proof` for the whole range, and no box of
 * a range that did not finish is answered.
 *
 * The range is bounded at `maxBoxes` (default `LEDGER_READ_MAX`): a range
 * that runs past it ends `unproven`, the verdict naming the bound, with no
 * further page asked (WEB_INTERFACE → The extension → "The verified figures").
 */
export async function proveRange(
  nodeUrl: string,
  kind: HoldingKind,
  owner: string,
  header: { height: number; stateRoot: string },
  httpFetch: HttpFetch,
  maxBoxes: number = LEDGER_READ_MAX,
): Promise<RangeResult> {
  // An `owner` that is not 64 hex is a client-side refusal — nothing is asked
  // (as `proveName` refuses a label whose key is not 64 hex).
  if (typeof owner !== 'string' || !OWNER_HEX.test(owner)) {
    return { ok: false, status: 'unproven', verdict: `owner is not ${OWNER_HEX_LEN} hex: ${shown(owner)}` };
  }
  const ownerLower = owner.toLowerCase();
  const ownerBytes = hexToBytes(ownerLower);
  const atHeight = header.height;
  const boxes: AnyBox[] = [];
  let from: Uint8Array | null = null;

  // `rootBytes` is the 33-byte digest the verifier anchors at — a header
  // stateRoot that is not valid hex is `unproven` with nothing read.
  let rootBytes: Uint8Array;
  try {
    rootBytes = hexToBytes(header.stateRoot);
  } catch {
    return { ok: false, status: 'unproven', verdict: 'header stateRoot is not hex' };
  }

  for (;;) {
    const fromHex = from === null ? null : bytesToHex(from);
    const query = fromHex === null
      ? `?atHeight=${atHeight}&limit=${RANGE_PAGE_MAX}`
      : `?atHeight=${atHeight}&limit=${RANGE_PAGE_MAX}&from=${fromHex}`;
    const url = `${nodeUrl}/api/v1/range/${kind}/${ownerLower}${query}`;

    // CONSTANTS → Client reads — one range page.
    const res = await fetchJson<unknown>(httpFetch, url, RANGE_PAGE_READ_BYTES);
    if (!res.ok) {
      const verdict = res.status === 0
        ? `transport failure: ${capped(res.body)}`
        : `HTTP ${res.status}: ${capped(res.body)}`;
      return { ok: false, status: 'no-proof', verdict };
    }

    // The body is an object (NODE_INTERFACE → AVL+ State Root → "avl-endpoint,
    // the range route").
    const body = res.data;
    if (!isRecord(body)) {
      return { ok: false, status: 'unproven', verdict: `page body is not an object: ${shown(body)}` };
    }

    // The answer's `stateRoot` shape is checked before any comparison. A
    // well-formed root that is not the header's is `stale` — the node holds
    // another block at that height (WEB_INTERFACE → The extension → "A
    // `stateRoot` other than the header's at `tip` is no failed proof"); an
    // answer of another shape is `unproven`, as an answer of any shape ends
    // in a status (WEB_INTERFACE → The extension → "The verified figures" —
    // "A run is total").
    const answerRoot = body['stateRoot'];
    if (typeof answerRoot !== 'string' || !STATE_ROOT_HEX.test(answerRoot)) {
      return { ok: false, status: 'unproven', verdict: `page stateRoot is not a root: ${shown(answerRoot)}` };
    }
    if (answerRoot !== header.stateRoot) {
      return { ok: false, status: 'stale', verdict: `node answers another block at height ${atHeight}: stateRoot ${shown(answerRoot)}` };
    }

    const answerLimit = body['limit'];
    if (!isPageLimit(answerLimit)) {
      return { ok: false, status: 'unproven', verdict: `limit must be an integer in [1, ${RANGE_PAGE_MAX}]: ${shown(answerLimit)}` };
    }

    const proofText = body['proof'];
    if (typeof proofText !== 'string') {
      return { ok: false, status: 'unproven', verdict: `proof must be a string: ${shown(proofText)}` };
    }
    const proofBytes = base64ToBytes(proofText);
    if (proofBytes === null) {
      return { ok: false, status: 'unproven', verdict: 'proof rejected' };
    }

    const verifier = new BatchAVLVerifier(rootBytes, proofBytes, AVL_CFG);
    if (verifier.digest() === null) {
      return { ok: false, status: 'unproven', verdict: 'proof rejected' };
    }

    let page;
    try {
      page = holdingsPage(
        treeStateView(verifierSession(verifier)),
        kind,
        ownerBytes,
        from,
        answerLimit,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 'unproven', verdict: `proof refused the page: ${capped(reason)}` };
    }

    for (const b of page.boxes) boxes.push(b);
    // WEB_INTERFACE → The extension → "The verified figures" — a ledger is
    // read up to `maxBoxes`; a range that runs past it ends `unproven`, its
    // verdict naming the bound. "Runs past" is `boxes.length > maxBoxes`, or
    // `boxes.length == maxBoxes` with a `next` still standing — in which case
    // no further page is asked.
    if (boxes.length > maxBoxes) {
      return { ok: false, status: 'unproven', verdict: `range runs past the ${maxBoxes}-box bound (${boxes.length} boxes read)` };
    }
    if (page.next === null) return { ok: true, boxes };
    if (boxes.length >= maxBoxes) {
      return { ok: false, status: 'unproven', verdict: `range runs past the ${maxBoxes}-box bound: a next page still stands at the bound` };
    }
    from = page.next;
  }
}

// A page's `limit` is an integer from 1 to the limit asked
// (NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range route").
function isPageLimit(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RANGE_PAGE_MAX;
}
