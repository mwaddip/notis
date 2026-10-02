import type { Express, Request, Response } from 'express';
import {
  IDENTITY_RECORD_TAG,
  INDEX_MARKER,
  LIKE_MARKER,
  TREE_KEY_LENGTH,
  boxFromRecordBytes,
  bytesToHex,
  castCountFromBytes,
  equalBytes,
  hexToBytes,
  holderRecordFromBytes,
  identityRecordFromBytes,
  nameRecordFromBytes,
  networkRecordFromBytes,
  postRecordFromBytes,
  vouchPairBoxId,
} from '@dagsocial/types';
import { TreeInconsistencyError, holdingsPage, isSentinel, treeStateView } from '@dagsocial/consensus';
import type { HoldingKind } from '@dagsocial/consensus';
import { label } from '@ergots/avltree';
import type { AvlProverHandle } from './avl-prover.js';
import type { KeptRoot } from './recent-roots.js';
import { recordingSession } from './prover-session.js';
import {
  InconsistentStateTreeError,
  failStopIfCorruptChain,
} from '../services/corrupt-state.js';

/** The holdings-page range cap served when a client sends none or asks above it. */
export const RANGE_PAGE_MAX = 256;

/** The five kinds `/api/v1/range` serves — one each per range (CONSENSUS_INTERFACE → The holdings page). */
const HOLDING_KINDS = Object.freeze({
  karma: true, credit: true, escrow: true, vouch: true, accrual: true,
} as const);

/**
 * JSON-safe view of an entity's fields: bigint fields (box `value` /
 * `originalValue`, record `lifetimeLikesReceived`) become decimal strings —
 * JSON.stringify throws on bigint.
 */
function jsonSafeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fields)) {
    out[key] = typeof val === 'bigint' ? val.toString() : val;
  }
  return out;
}

/** What a key resolved to — NODE_INTERFACE → Entity kinds. */
interface DecodedValue {
  kind: 'box' | 'record' | 'network' | 'username' | 'holder' | 'post' | 'like' | 'index' | null;
  value: Record<string, unknown> | null;
}

/** Where a box key carries its box id — the tag, then `b32(boxId)` (TYPES_INTERFACE → The tree keys). */
const BOX_ID_AT = 1;

/**
 * The value's kind by its first byte — the discriminators of NODE_INTERFACE →
 * Entity kinds — decoded over `types`' codecs (TYPES_INTERFACE → Layout — tree
 * records): a box below `0x80`, its id the one its key carries; the record
 * kinds from `0x80`; the index kinds — the marker, a vouch pair's box id, a cast
 * count — as `index`. A byte outside every kind is a throw, which the route
 * answers as a 500.
 */
function decodeValue(key: Uint8Array, bytes: Uint8Array): DecodedValue {
  if (bytes.length === 0) throw new Error('an empty tree value');
  const tag = bytes[0]!;
  if (tag < IDENTITY_RECORD_TAG) {
    const boxId = bytesToHex(key.subarray(BOX_ID_AT, BOX_ID_AT + 32));
    return { kind: 'box', value: jsonSafeFields({ ...boxFromRecordBytes(boxId, bytes) }) };
  }
  switch (tag) {
    case IDENTITY_RECORD_TAG:
      return { kind: 'record', value: jsonSafeFields({ ...identityRecordFromBytes(bytes) }) };
    case 0x81:
      return { kind: 'network', value: jsonSafeFields({ ...networkRecordFromBytes(bytes) }) };
    case 0x82:
      return { kind: 'username', value: jsonSafeFields({ ...nameRecordFromBytes(bytes) }) };
    case 0x83:
      return { kind: 'holder', value: jsonSafeFields({ ...holderRecordFromBytes(bytes) }) };
    case 0x84:
      return { kind: 'post', value: jsonSafeFields({ ...postRecordFromBytes(bytes) }) };
    case 0x85:
      if (!equalBytes(bytes, LIKE_MARKER)) throw new Error('a like record is its marker alone');
      return { kind: 'like', value: {} };
    case 0x86:
      if (!equalBytes(bytes, INDEX_MARKER)) throw new Error('an index entry is its marker alone');
      return { kind: 'index', value: {} };
    case 0x87:
      return { kind: 'index', value: { boxId: bytesToHex(vouchPairBoxId(bytes)) } };
    case 0x88:
      return { kind: 'index', value: { count: castCountFromBytes(bytes) } };
    default:
      throw new Error(`a tree value with no kind: tag 0x${tag.toString(16)}`);
  }
}

/**
 * The answer to a resolved `atHeight`: either the ring's kept root for that
 * height or a 404 verdict. A route resolves `atHeight` before it opens any
 * cycle on the prover, so no restore has to run on a resolution failure.
 * `kept` is `null` for the live tip, where the cycle runs on the prover as
 * it stands and no restore of a different root has to happen.
 */
type HeightResolution =
  | { ok: true; atHeight: number; stateRoot: Uint8Array; kept: KeptRoot | null }
  | { ok: false };

/**
 * Resolve the height a route serves at. Without `atHeight` the route serves
 * the live tip's root through `kept: null` — no restore needed. With one, the
 * ring is asked; a miss is 404 `{ error: 'height not available' }`
 * (NODE_INTERFACE → "A proof at an older height restores a kept root"). The
 * route never calls `rollback`.
 */
function resolveHeight(
  handle: AvlProverHandle,
  atHeightRaw: unknown,
  res: Response,
): HeightResolution {
  // The live tip's block height is the version row's — the only read of
  // storage this file makes, and no `rollback`.
  const liveVersion = handle.storage.version();
  if (liveVersion === null) {
    res.status(404).json({ error: 'no state available' });
    return { ok: false };
  }
  const liveHeight = handle.storage.versionHeight(liveVersion);
  if (liveHeight === null) {
    res.status(500).json({ error: 'version height lookup failed' });
    return { ok: false };
  }

  if (atHeightRaw === undefined) {
    return { ok: true, atHeight: liveHeight, stateRoot: liveVersion, kept: null };
  }
  if (typeof atHeightRaw !== 'string' || !/^\d+$/.test(atHeightRaw)) {
    res.status(400).json({ error: 'atHeight must be a non-negative integer' });
    return { ok: false };
  }
  // Decimal digits of any length are well-formed. One past the safe-integer
  // range names no kept height — the heights the ring records come from the
  // store's version row, a safe integer — so it falls through to the ring's
  // miss and the 404 (NODE_INTERFACE → "A proof at an older height restores
  // a kept root"; → AVL+ State Root → "avl-endpoint"; → AVL+ State Root →
  // "avl-endpoint, the range route").
  const atHeight = Number(atHeightRaw);
  if (Number.isSafeInteger(atHeight) && atHeight === liveHeight) {
    return { ok: true, atHeight, stateRoot: liveVersion, kept: null };
  }
  const kept = Number.isSafeInteger(atHeight) ? handle.recentRoots.get(atHeight) : null;
  if (kept === null) {
    res.status(404).json({ error: 'height not available' });
    return { ok: false };
  }
  // The kept root's digest is 33 bytes: the root's label and the tree height.
  // The route serves it so a client can check its proof's anchor without
  // reading storage. The library's `digest()` after `restoreRoot(root,
  // treeHeight)` would answer the same bytes; we assemble them here to avoid
  // moving the prover before we have the lookups to perform under it.
  const rootLabel = label(kept.root);
  const stateRoot = new Uint8Array(33);
  stateRoot.set(rootLabel, 0);
  stateRoot[32] = kept.treeHeight;
  return { ok: true, atHeight, stateRoot, kept };
}


/**
 * Open a proof cycle on the prover at the kept root, run `body`, close the
 * cycle with `generateProof()`, and restore the live root — on every path, a
 * throw included (NODE_INTERFACE → "A proof at an older height restores a
 * kept root"). `body` may call `handle.prover.performOneOperation` (the
 * single-key route) or run the holdings-page walk through a recording
 * session (the range route): each is the cycle's recorded reads. For the live
 * tip (`kept === null`) the cycle runs on the prover as it stands, and only
 * the proof-cycle rebase at the end runs.
 */
function withCycle<T>(
  handle: AvlProverHandle,
  kept: KeptRoot | null,
  body: () => T,
): { answer: T; proof: Uint8Array } {
  const inner = handle.prover.prover;
  const savedRoot = inner.root;
  const savedHeight = inner.height;
  try {
    if (kept !== null) inner.restoreRoot(kept.root, kept.treeHeight);
    const answer = body();
    const proof = inner.generateProof();
    return { answer, proof };
  } finally {
    // The live root is restored and the route's cycle closed on every path,
    // a throw included (NODE_INTERFACE → "A proof at an older height
    // restores a kept root"). `restoreRoot` rebases the proof cycle, so no
    // recorded read of the route stays in the cycle to enter a block's
    // proof (NODE_INTERFACE → The block proof).
    inner.restoreRoot(savedRoot, savedHeight);
  }
}

/** One proof answer: the lookup under the resolved root, and its proof. */
function proofAnswer(
  handle: AvlProverHandle,
  keyHex: string,
  key: Uint8Array,
  resolved: Extract<HeightResolution, { ok: true }>,
): Record<string, unknown> {
  const { answer: lookupResult, proof } = withCycle(handle, resolved.kept, () =>
    handle.prover.performOneOperation({ tag: 'Lookup', key }),
  );
  const decoded: DecodedValue =
    lookupResult.success && lookupResult.value
      ? decodeValue(key, lookupResult.value)
      : { kind: null, value: null };
  return {
    key: keyHex,
    atHeight: resolved.atHeight,
    stateRoot: Buffer.from(resolved.stateRoot).toString('hex'),
    proof: Buffer.from(proof).toString('base64'),
    kind: decoded.kind,
    value: decoded.value,
  };
}

/**
 * `GET /api/v1/proof/:key` — a lookup proof for one tree key (NODE_INTERFACE
 * → AVL+ State Root): the key is `TREE_KEY_LENGTH` bytes as hex, echoed as
 * `key`, and any other width is a 400.
 */
export function registerProofEndpoint(app: Express, handle: AvlProverHandle): void {
  app.get('/api/v1/proof/:key', (req: Request, res: Response) => {
    const keyHex = req.params['key'];
    if (!keyHex || keyHex.length !== TREE_KEY_LENGTH * 2 || !/^[0-9a-fA-F]+$/.test(keyHex)) {
      res.status(400).json({ error: `key must be ${TREE_KEY_LENGTH * 2} hex characters` });
      return;
    }
    const key = new Uint8Array(Buffer.from(keyHex, 'hex'));
    // The two bounds — all 0x00, all 0xff — are not keys of the tree
    // (CONSENSUS_INTERFACE → The tree session, `isSentinel`), so the single-key
    // route refuses them with a 400 before it opens any cycle; nothing is
    // logged for the refusal (NODE_INTERFACE → AVL+ State Root →
    // "avl-endpoint").
    if (isSentinel(key)) {
      res.status(400).json({ error: 'key is a sentinel of the tree' });
      return;
    }

    const resolved = resolveHeight(handle, req.query['atHeight'], res);
    if (!resolved.ok) return;

    try {
      res.json(proofAnswer(handle, keyHex, key, resolved));
    } catch (err) {
      console.error('Proof endpoint error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });
}

/**
 * `GET /api/v1/range/:kind/:owner?atHeight=N&from=K&limit=L` — one page of
 * what a key holds of one kind, with its proof (NODE_INTERFACE → AVL+ State
 * Root → "avl-endpoint, the range route"). The kind, owner, from's shape,
 * limit's shape and atHeight's shape are refused before the cycle opens;
 * `pageRange`'s `RangeError` for a `from` outside the kind's range throws
 * inside the cycle, under `withCycle`'s `finally`, and the route answers 400
 * for it. `pageRange`'s `TypeError` for a kind outside the five is
 * unreachable here (`:kind` is own-property checked). The answer is
 * `{ kind, owner, atHeight, stateRoot, from, limit, proof }` — **no decoded
 * box**: a client reads the page by running `holdingsPage` over
 * `verifierSession` on the proof the node answered (CONSENSUS_INTERFACE →
 * The holdings page). The recording session's lookups are closed with
 * `generateProof` inside one synchronous call — the route records in a cycle
 * of its own (NODE_INTERFACE → The block proof).
 */
export function registerRangeEndpoint(app: Express, handle: AvlProverHandle): void {
  app.get('/api/v1/range/:kind/:owner', (req: Request, res: Response) => {
    const kindRaw = req.params['kind'] ?? '';
    // Own-property check — `holdingsPage` hands any other string to the index
    // map and throws a `TypeError`, not a refusal.
    if (!Object.prototype.hasOwnProperty.call(HOLDING_KINDS, kindRaw)) {
      res.status(400).json({ error: 'kind must be one of karma, credit, escrow, vouch, accrual' });
      return;
    }
    const kind = kindRaw as HoldingKind;

    const ownerHex = req.params['owner'] ?? '';
    if (ownerHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(ownerHex)) {
      res.status(400).json({ error: 'owner must be 64 hex characters' });
      return;
    }
    const owner = hexToBytes(ownerHex);

    const fromRaw = req.query['from'];
    let from: Uint8Array | null = null;
    let fromHex: string | null = null;
    if (fromRaw !== undefined) {
      if (typeof fromRaw !== 'string' || fromRaw.length !== TREE_KEY_LENGTH * 2 || !/^[0-9a-fA-F]+$/.test(fromRaw)) {
        res.status(400).json({ error: `from must be ${TREE_KEY_LENGTH * 2} hex characters` });
        return;
      }
      fromHex = fromRaw;
      from = hexToBytes(fromRaw);
    }

    const limitRaw = req.query['limit'];
    let limit = RANGE_PAGE_MAX;
    if (limitRaw !== undefined) {
      // Decimal digits of any length are well-formed; `limit` is served at
      // `RANGE_PAGE_MAX` where the ask is above the cap, which includes every
      // ask past the safe-integer range. `0` and the empty string stay
      // refused (NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range
      // route").
      if (typeof limitRaw !== 'string' || !/^\d+$/.test(limitRaw) || /^0+$/.test(limitRaw)) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }
      const asked = Number(limitRaw);
      limit = Number.isSafeInteger(asked) && asked <= RANGE_PAGE_MAX ? asked : RANGE_PAGE_MAX;
    }

    const resolved = resolveHeight(handle, req.query['atHeight'], res);
    if (!resolved.ok) return;

    try {
      const { proof } = withCycle(handle, resolved.kept, () => {
        const session = recordingSession(handle.prover);
        const view = treeStateView(session);
        // The page's `next` is read from the proof — a client replays
        // `holdingsPage` over `verifierSession` on the answered proof — so
        // the route answers no decoded value and no `next` field
        // (NODE_INTERFACE → AVL+ State Root, the range bullet).
        return holdingsPage(view, kind, owner, from, limit);
      });

      res.json({
        kind,
        owner: ownerHex,
        atHeight: resolved.atHeight,
        stateRoot: Buffer.from(resolved.stateRoot).toString('hex'),
        from: fromHex,
        limit,
        proof: Buffer.from(proof).toString('base64'),
      });
    } catch (err) {
      if (err instanceof RangeError) {
        // A `from` outside the kind's range for `owner`, or a limit the view
        // refuses — the caller's argument (CONSENSUS_INTERFACE → The tree
        // view, "`pageRange(range, from, limit)` is the walk as a page").
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof TreeInconsistencyError) {
        // The tree contradicts itself under the route's read — local
        // corruption, as `services/cost-estimate.ts` reads it; never a verdict
        // on the request (NODE_INTERFACE → "A proof at an older height
        // restores a kept root"; → "What the funnel's totality catch is FOR").
        failStopIfCorruptChain(
          new InconsistentStateTreeError('GET /api/v1/range', resolved.atHeight, err),
        );
      }
      console.error('Range endpoint error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });
}
