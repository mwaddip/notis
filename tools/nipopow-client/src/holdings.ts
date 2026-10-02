import { BatchAVLVerifier } from '@ergots/avltree';
import { TREE_KEY_LENGTH, bytesToHex, hexToBytes } from '@dagsocial/types';
import type { AnyBox } from '@dagsocial/types';
import { holdingsPage, treeStateView, verifierSession } from '@dagsocial/consensus';
import type { HoldingKind } from '@dagsocial/consensus';
import type { HttpFetch } from './http.js';
import { capped, fetchJson, isRecord, shown } from './http.js';

/**
 * One page of what a key holds of one kind, verified against the header's
 * `stateRoot` and read by replaying `holdingsPage` over the proof the node
 * answered (NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range
 * route"; CONSENSUS_INTERFACE → The holdings page). The limit a client sends
 * is a cap: a node may answer with any limit from 1 to RANGE_PAGE_MAX, and
 * the page is replayed with the limit the answer served.
 */
const RANGE_PAGE_MAX = 256;

const AVL_CFG = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null } as const;

/**
 * The outcome of one call to `proveRange`: the full range's boxes under one
 * header, or the first failure's status and verdict. A `no-proof` or
 * `unproven` is the answer for the whole range — no box of a range that did
 * not finish is answered (WEB_INTERFACE → The extension → "The verified
 * figures").
 */
export type RangeResult =
  | { ok: true; boxes: AnyBox[] }
  | { ok: false; status: 'unproven' | 'no-proof'; verdict: string };

/**
 * The outcome of one call to `proveHoldings`: a record from each asked kind
 * to its proven boxes, or the first failure. A ledger not asked for carries
 * `undefined` in the result.
 */
export type HoldingsResult =
  | { ok: true; boxes: Record<HoldingKind, AnyBox[] | undefined> }
  | { ok: false; status: 'unproven' | 'no-proof'; verdict: string };

/**
 * NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range route" — one
 * kind's whole range at one height, page by page.
 *
 * For each page the client asks `GET /api/v1/range/<kind>/<owner>?atHeight=
 * <height>&limit=256`, carrying the previous page's authenticated `next` as
 * `from` after the first. For every answer: the body is an object or the run
 * is `unproven`; **the answer's `stateRoot` must be the header's before the
 * proof is read**, so a lying node that signs a wrong root cannot make the
 * verifier compute anything; `proof` is base64 and `limit` an integer from 1
 * to RANGE_PAGE_MAX, else `unproven` with nothing further read; the page is
 * replayed with the limit the answer served, so a node whose cap is lower
 * still serves. A `BatchAVLVerifier` over the root and the proof answers
 * `null` from `digest()` when the proof fails to anchor — `unproven`. The
 * page is read by `holdingsPage(treeStateView(verifierSession(v)), kind,
 * ownerBytes, from, limit)`; a throw there is `unproven`, with the throw's
 * reason. The page's `next` comes from the verified replay, never from the
 * answer: a reader of the proof knows from the proof alone whether the range
 * ends (CONSENSUS_INTERFACE → The holdings page). Keys strictly rise and
 * each next key is authenticated, so the walk ends where the range does and
 * needs no page cap. A transport failure or a non-2xx — 404 `height not
 * available` among them — is `no-proof` for the whole range, and no box of
 * a range that did not finish is answered.
 */
export async function proveRange(
  nodeUrl: string,
  kind: HoldingKind,
  owner: string,
  header: { height: number; stateRoot: string },
  httpFetch: HttpFetch,
): Promise<RangeResult> {
  const ownerBytes = hexToBytes(owner.toLowerCase());
  const atHeight = header.height;
  const boxes: AnyBox[] = [];
  let from: Uint8Array | null = null;

  for (;;) {
    const fromHex = from === null ? null : bytesToHex(from);
    const query = fromHex === null
      ? `?atHeight=${atHeight}&limit=${RANGE_PAGE_MAX}`
      : `?atHeight=${atHeight}&limit=${RANGE_PAGE_MAX}&from=${fromHex}`;
    const url = `${nodeUrl}/api/v1/range/${kind}/${owner.toLowerCase()}${query}`;

    const res = await fetchJson<unknown>(httpFetch, url);
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

    // The answer's `stateRoot` is the header's before the proof is read.
    const answerRoot = body['stateRoot'];
    if (answerRoot !== header.stateRoot) {
      return { ok: false, status: 'unproven', verdict: 'stateRoot mismatch' };
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

    // The answer's `stateRoot` is the 33-byte digest the verifier anchors at
    // (NODE_INTERFACE → AVL+ State Root).
    let rootBytes: Uint8Array;
    try {
      rootBytes = hexToBytes(header.stateRoot);
    } catch {
      return { ok: false, status: 'unproven', verdict: 'header stateRoot is not hex' };
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
    if (page.next === null) return { ok: true, boxes };
    from = page.next;
  }
}

/**
 * NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range route" — the
 * key's holdings of several kinds at one height, in the order given. The
 * first failure answers the run; no later kind is read.
 */
export async function proveHoldings(
  nodeUrl: string,
  owner: string,
  kinds: readonly HoldingKind[],
  header: { height: number; stateRoot: string },
  httpFetch: HttpFetch,
): Promise<HoldingsResult> {
  const boxes: Record<HoldingKind, AnyBox[] | undefined> = {
    karma: undefined,
    credit: undefined,
    escrow: undefined,
    vouch: undefined,
    accrual: undefined,
  };
  for (const kind of kinds) {
    const r = await proveRange(nodeUrl, kind, owner, header, httpFetch);
    if (!r.ok) return r;
    boxes[kind] = r.boxes;
  }
  return { ok: true, boxes };
}

// A page's `limit` is an integer from 1 to RANGE_PAGE_MAX
// (NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range route").
function isPageLimit(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RANGE_PAGE_MAX;
}

// NODE_INTERFACE → AVL+ State Root — the proof blob is standard base64,
// decoded with `atob`, a global in both browsers and Node 22. It throws on a
// character outside the alphabet or on a wrong length — caught here so a
// malformed blob from a lying node is a refused proof, `null`, never an
// exception out of the library.
function base64ToBytes(b64: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
