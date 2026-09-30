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
  holderRecordFromBytes,
  identityRecordFromBytes,
  nameRecordFromBytes,
  networkRecordFromBytes,
  postRecordFromBytes,
  vouchPairBoxId,
} from '@dagsocial/types';
import type { AvlProverHandle } from './avl-prover.js';

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

/** One proof answer: the lookup at the prover's current version, and its proof. */
function proofAnswer(
  handle: AvlProverHandle,
  keyHex: string,
  key: Uint8Array,
  atHeight: number,
  version: Uint8Array,
): Record<string, unknown> {
  const lookupResult = handle.prover.performOneOperation({ tag: 'Lookup', key });
  const proof = handle.prover.prover.generateProof();
  const decoded: DecodedValue =
    lookupResult.success && lookupResult.value
      ? decodeValue(key, lookupResult.value)
      : { kind: null, value: null };
  return {
    key: keyHex,
    atHeight,
    stateRoot: Buffer.from(version).toString('hex'),
    proof: Buffer.from(proof).toString('base64'),
    kind: decoded.kind,
    value: decoded.value,
  };
}

/**
 * `GET /api/v1/proof/:key` — a lookup proof for one tree key (NODE_INTERFACE →
 * AVL+ State Root): the key is `TREE_KEY_LENGTH` bytes as hex, echoed as `key`,
 * and any other width is a 400.
 */
export function registerProofEndpoint(app: Express, handle: AvlProverHandle): void {
  app.get('/api/v1/proof/:key', (req: Request, res: Response) => {
    const keyHex = req.params['key'];
    const atHeight = req.query['atHeight']
      ? parseInt(req.query['atHeight'] as string, 10)
      : null;

    // Validate atHeight if provided
    if (atHeight !== null && (!Number.isInteger(atHeight) || atHeight < 0)) {
      res.status(400).json({ error: 'atHeight must be a non-negative integer' });
      return;
    }

    if (!keyHex || keyHex.length !== TREE_KEY_LENGTH * 2 || !/^[0-9a-fA-F]+$/.test(keyHex)) {
      res.status(400).json({ error: `key must be ${TREE_KEY_LENGTH * 2} hex characters` });
      return;
    }

    const key = new Uint8Array(Buffer.from(keyHex, 'hex'));

    try {
      // Determine which version to query
      let version: Uint8Array;
      if (atHeight !== null) {
        const v = handle.storage.versionAtOrBeforeHeight(atHeight);
        // Strict height matching: only accept if a checkpoint exists at
        // exactly the requested height.
        if (!v || handle.storage.versionHeight(v) !== atHeight) {
          res.status(404).json({ error: 'height not available' });
          return;
        }
        version = v;
      } else {
        const v = handle.storage.version();
        if (!v) {
          res.status(404).json({ error: 'no state available' });
          return;
        }
        version = v;
      }

      // Get the block height for this version
      const blockHeight = handle.storage.versionHeight(version);
      if (blockHeight === null) {
        res.status(500).json({ error: 'version height lookup failed' });
        return;
      }

      // Save current version so we can restore after
      const currentVersion = handle.prover.digest();

      // Only rollback if the target version differs from current
      if (Buffer.from(currentVersion).equals(Buffer.from(version))) {
        res.json(proofAnswer(handle, keyHex, key, blockHeight, version));
        return;
      }

      // NODE_INTERFACE → "The historical window restores under finally"
      handle.prover.rollback(version);

      try {
        res.json(proofAnswer(handle, keyHex, key, blockHeight, version));
      } catch (err) {
        console.error('Proof endpoint error:', err);
        res.status(500).json({ error: 'internal error' });
      } finally {
        handle.prover.rollback(currentVersion);
      }
    } catch (err) {
      console.error('Proof endpoint error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });
}
