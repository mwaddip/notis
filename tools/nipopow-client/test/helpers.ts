import {
  PROTOCOL_VERSION,
  EMPTY_STATE_ROOT,
  GENESIS_PREV_BLOCK_HASH,
  interlinkRoot,
  updateInterlinks,
  TREE_KEY_LENGTH,
  boxKey,
  boxRecordBytes,
  bytesToHex,
  computeCandidateBoxId,
  identityKey,
  identityRecordBytes,
  protocolVersionAt,
  RETARGET_HALFLIFE_BLOCKS,
  NETWORK_PROFILES,
  profileFor,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  BlockHeader,
  BoxCandidate,
  CreditBox,
  KarmaBox,
  NetworkRecord,
  TxId,
  NetworkProfile,
  ProtocolEra,
  IdentityRecord,
  UserId,
} from '@dagsocial/types';
import type { Anchor } from '../src/boxes.js';
import {
  verifyOrderingBlockPoW,
  blockHash,
  level as headerLevel,
  levelOfHit,
  powHit,
  orderingPowTarget,
  asertTargetBits,
} from '@dagsocial/validation';
import type { RetargetParams } from '@dagsocial/validation';
import {
  proveWithReader,
  encodeNipopowProof,
} from '@dagsocial/nipopow';
import type { PoPowHeader, PopowHeaderReader } from '@dagsocial/nipopow';
import { BatchAVLProver } from '@ergots/avltree';
import {
  holdingsPage,
  seedTreeWrites,
  treeStateView,
} from '@dagsocial/consensus';
import type { HoldingKind, TreeLookup, TreeSession } from '@dagsocial/consensus';
import type { HttpFetch } from '../src/http.js';

export const DEVNET_POW_TARGET_BITS = 3072;
const DEVNET_IDEAL_MS = 60_000;
const DEFAULT_ANCHOR_STAMP = 1_000_000;

function retargetForAnchor(anchorBits: number, idealMs: number): RetargetParams {
  return {
    anchorBits,
    idealMs,
    halflifeMs: RETARGET_HALFLIFE_BLOCKS * idealMs,
    floorBits: NETWORK_PROFILES.devnet.orderingBlockPowTargetFloorBits,
    ceilingBits: NETWORK_PROFILES.devnet.orderingBlockPowTargetCeilingBits,
  };
}

function solveHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

function solveForLevel(header: BlockHeader, minLevel: number, anchorBits: number): number {
  const target = orderingPowTarget(anchorBits);
  if (target === null) throw new Error('invalid target');
  for (let nonce = 0; ; nonce++) {
    const candidate = { ...header, powNonce: nonce };
    if (!verifyOrderingBlockPoW(candidate)) continue;
    const hit = powHit(candidate);
    if (hit === null) continue;
    const lvl = levelOfHit(hit, target);
    if (lvl !== null && lvl >= minLevel) return nonce;
  }
}

export interface MinedChain {
  headers: BlockHeader[];
  interlinksPerHeader: string[][];
  popowHeaders: PoPowHeader[];
  anchorStamp: number;
}

// Headers follow the ASERT schedule; stamps are on schedule so bits stay at the anchor's.
// TYPES_INTERFACE → Version — with a schedule each header stamps the era at its height, else PROTOCOL_VERSION.
export function buildMinedChain(opts: {
  count: number;
  anchorBits?: number;
  anchorStamp?: number;
  idealMs?: number;
  forceLevels?: Map<number, number>;
  stateRoot?: string;
  validatorId?: Uint8Array;
  schedule?: readonly ProtocolEra[];
}): MinedChain {
  const { count, forceLevels, schedule } = opts;
  const anchorBits = opts.anchorBits ?? DEVNET_POW_TARGET_BITS;
  const idealMs = opts.idealMs ?? DEVNET_IDEAL_MS;
  const anchorStamp = opts.anchorStamp ?? DEFAULT_ANCHOR_STAMP;
  const stateRoot = opts.stateRoot ?? EMPTY_STATE_ROOT;
  const validatorId = opts.validatorId ?? new Uint8Array(32);
  const retarget = retargetForAnchor(anchorBits, idealMs);
  const headers: BlockHeader[] = [];
  const interlinksPerHeader: string[][] = [];
  const popowHeaders: PoPowHeader[] = [];
  let prevHash = GENESIS_PREV_BLOCK_HASH;
  let prevInterlinks: string[] = [];
  let prevLevel: number = Infinity;

  for (let i = 0; i < count; i++) {
    const height = i + 1;
    const expected = height === 1
      ? []
      : updateInterlinks(prevInterlinks, prevHash, prevLevel);

    const createdAt = anchorStamp + idealMs * (height - 1);
    const bits = height === 1
      ? anchorBits
      : asertTargetBits(retarget, anchorStamp, headers[i - 1]!);

    const version = schedule ? protocolVersionAt(schedule, height) : PROTOCOL_VERSION;
    if (version === null) throw new Error(`no era covers height ${height}`);

    const header: BlockHeader = {
      protocolVersion: version,
      height,
      prevBlockHash: prevHash,
      utxoTxRoot: '00'.repeat(32),
      stateRoot,
      validatorId,
      powNonce: 0,
      powTargetBits: bits,
      createdAt,
      interlinkRoot: interlinkRoot(expected),
      adProofsRoot: '00'.repeat(32),
    };

    const wantLevel = forceLevels?.get(height);
    if (wantLevel !== undefined && wantLevel > 0) {
      header.powNonce = solveForLevel(header, wantLevel, anchorBits);
    } else {
      header.powNonce = solveHeaderPow(header);
    }

    const hash = blockHash(header);
    if (hash === null) throw new Error(`unhashable at height ${height}`);
    const lvl = headerLevel(header, anchorBits);
    if (lvl === null) throw new Error(`null level at height ${height}`);

    headers.push(header);
    interlinksPerHeader.push(expected);
    popowHeaders.push({ header, interlinks: expected });

    prevHash = hash;
    prevInterlinks = expected;
    prevLevel = lvl;
  }
  return { headers, interlinksPerHeader, popowHeaders, anchorStamp };
}

function makeReader(chain: MinedChain): PopowHeaderReader {
  const byHash = new Map<string, PoPowHeader>();
  const byHeight = new Map<number, PoPowHeader>();
  for (const ph of chain.popowHeaders) {
    const hash = blockHash(ph.header);
    if (hash !== null) byHash.set(hash, ph);
    byHeight.set(ph.header.height, ph);
  }
  return {
    chainHeight: () => chain.headers.length,
    popowHeaderByHash: (hash: string) => byHash.get(hash) ?? null,
    popowHeaderAtHeight: (height: number) => byHeight.get(height) ?? null,
    lastHeaders: (n: number) => {
      const start = Math.max(0, chain.headers.length - n);
      return chain.headers.slice(start);
    },
    headersAfter: (height: number, n: number) => {
      const result: BlockHeader[] = [];
      for (let h = height + 1; h <= Math.min(height + n, chain.headers.length); h++) {
        const ph = byHeight.get(h);
        if (ph) result.push(ph.header);
      }
      return result;
    },
  };
}

export function devnetProfile(): NetworkProfile {
  return profileFor('devnet');
}

export function devnetProfileWithGenesisId(chain: MinedChain): NetworkProfile {
  const gHash = blockHash(chain.headers[0]!);
  if (gHash === null) throw new Error('unhashable genesis');
  return { ...profileFor('devnet'), genesisId: gHash } as NetworkProfile;
}

export function clockAfterChain(chain: MinedChain): () => number {
  const tipStamp = chain.headers[chain.headers.length - 1]!.createdAt;
  return () => tipStamp + 1;
}

export function proofHexForChain(chain: MinedChain, m: number, k: number): string {
  const reader = makeReader(chain);
  const proof = proveWithReader(reader, { m, k });
  const bytes = encodeNipopowProof(proof);
  return Buffer.from(bytes).toString('hex');
}

export function suffixHeadForChain(chain: MinedChain, m: number, k: number): PoPowHeader {
  const reader = makeReader(chain);
  const proof = proveWithReader(reader, { m, k });
  return proof.suffixHead;
}

// TYPES_INTERFACE → The tree keys — the one place a test turns a box id (or
// anything shaped like one: absent, gone, a fake key standing in for a real
// box) into the key the endpoint now serves proofs under and `verifyAvlLookup`
// verifies against.
export function boxProofKeyHex(boxId: string): string {
  return bytesToHex(boxKey(hexToBytes(boxId)));
}

// TYPES_INTERFACE → The tree keys — an identity's proof key, hex.
export function identityProofKeyHex(identityId: UserId): string {
  return bytesToHex(identityKey(identityId));
}

export interface AvlFixture {
  digest: string;
  entries: Map<string, { proof: Uint8Array; value: Uint8Array }>;
}

export function buildAvlFixture(
  boxes: { candidate: BoxCandidate; txId: TxId; index: number }[],
): AvlFixture {
  const prover = new BatchAVLProver(TREE_KEY_LENGTH, null);
  const entries = new Map<string, { proof: Uint8Array; value: Uint8Array }>();

  for (const box of boxes) {
    const boxId = computeCandidateBoxId(box.candidate, box.txId, box.index);
    const keyHex = boxProofKeyHex(boxId);
    const keyBytes = hexToBytes(keyHex);
    const valueBytes = boxRecordBytes(box.candidate, box.txId, box.index);
    prover.performOneOperation({ tag: 'Insert', key: keyBytes, value: valueBytes });
    prover.generateProof();
    entries.set(keyHex, { proof: new Uint8Array(0), value: valueBytes });
  }

  for (const [keyHex] of entries) {
    const keyBytes = hexToBytes(keyHex);
    prover.performOneOperation({ tag: 'Lookup', key: keyBytes });
    const proof = prover.generateProof();
    const entry = entries.get(keyHex)!;
    entries.set(keyHex, { proof: Uint8Array.from(proof), value: entry.value });
  }

  const digestHex = Buffer.from(prover.digest()).toString('hex');
  return { digest: digestHex, entries };
}

export function buildMismatchedAvlFixture(
  fakeKey: string,
  candidate: BoxCandidate,
  txId: TxId,
  index: number,
): AvlFixture {
  const prover = new BatchAVLProver(TREE_KEY_LENGTH, null);
  const keyHex = boxProofKeyHex(fakeKey);
  const keyBytes = hexToBytes(keyHex);
  const valueBytes = boxRecordBytes(candidate, txId, index);
  prover.performOneOperation({ tag: 'Insert', key: keyBytes, value: valueBytes });
  prover.generateProof();
  prover.performOneOperation({ tag: 'Lookup', key: keyBytes });
  const proof = prover.generateProof();
  const entries = new Map<string, { proof: Uint8Array; value: Uint8Array }>();
  entries.set(keyHex, { proof: Uint8Array.from(proof), value: valueBytes });
  return { digest: Buffer.from(prover.digest()).toString('hex'), entries };
}

export function buildAvlExclusionProof(
  presentBoxes: { candidate: BoxCandidate; txId: TxId; index: number }[],
  absentKey: string,
): { digest: string; proof: Uint8Array } {
  const prover = new BatchAVLProver(TREE_KEY_LENGTH, null);
  for (const box of presentBoxes) {
    const boxId = computeCandidateBoxId(box.candidate, box.txId, box.index);
    const keyBytes = hexToBytes(boxProofKeyHex(boxId));
    const valueBytes = boxRecordBytes(box.candidate, box.txId, box.index);
    prover.performOneOperation({ tag: 'Insert', key: keyBytes, value: valueBytes });
    prover.generateProof();
  }
  prover.performOneOperation({ tag: 'Lookup', key: hexToBytes(boxProofKeyHex(absentKey)) });
  const proof = prover.generateProof();
  return { digest: Buffer.from(prover.digest()).toString('hex'), proof: Uint8Array.from(proof) };
}

export interface FakeNode {
  url: string;
  fetch: HttpFetch;
}

export function createFakeNode(opts: {
  url: string;
  chain: MinedChain;
  m: number;
  k: number;
  avl?: AvlFixture;
  karmaBoxes?: { userId: string; boxes: { boxId: string; value: number }[] };
  creditBoxes?: { userId: string; boxes: { boxId: string; value: number; lockedUntilBlock?: number }[] };
  overrideProofHex?: string;
  overrideAvlResponses?: Map<string, unknown>;
}): FakeNode {
  const {
    url, chain, m, k, avl, karmaBoxes, creditBoxes,
    overrideProofHex, overrideAvlResponses,
  } = opts;

  const proofHex = overrideProofHex ?? proofHexForChain(chain, m, k);
  const suffixHead = suffixHeadForChain(chain, m, k);

  const httpFetch: HttpFetch = async (reqUrl: string) => {
    const path = reqUrl.replace(url, '');

    if (path === `/nipopow/proof/${m}/${k}`) {
      return jsonResponse(200, { proof: proofHex });
    }

    const karmaMatch = path.match(/^\/karma\/([0-9a-f]{64})$/);
    if (karmaMatch) {
      const userId = karmaMatch[1]!;
      if (karmaBoxes && karmaBoxes.userId === userId) {
        return jsonResponse(200, {
          userId,
          total: karmaBoxes.boxes.reduce((s, b) => s + b.value, 0),
          boxes: karmaBoxes.boxes,
          lastActivityBlock: 0,
          lastDecayBlock: 0,
          height: chain.headers.length,
        });
      }
      return jsonResponse(404, { error: 'not found' });
    }

    const creditMatch = path.match(/^\/credits\/([0-9a-f]{64})$/);
    if (creditMatch) {
      const userId = creditMatch[1]!;
      if (creditBoxes && creditBoxes.userId === userId) {
        return jsonResponse(200, {
          userId,
          total: creditBoxes.boxes.reduce((s, b) => s + b.value, 0),
          boxes: creditBoxes.boxes,
        });
      }
      return jsonResponse(404, { error: 'not found' });
    }

    const avlMatch = path.match(/^\/api\/v1\/proof\/([0-9a-f]{130})\?atHeight=(\d+)$/);
    if (avlMatch) {
      const key = avlMatch[1]!;
      const atHeight = Number(avlMatch[2]!);

      if (overrideAvlResponses?.has(key)) {
        const override = overrideAvlResponses.get(key)!;
        return jsonResponse(200, override);
      }

      if (!avl) return jsonResponse(404, { error: 'no AVL' });

      const entry = avl.entries.get(key);
      if (!entry) {
        return jsonResponse(200, {
          key,
          atHeight,
          stateRoot: avl.digest,
          proof: Buffer.from(new Uint8Array(0)).toString('base64'),
          kind: null,
          value: null,
        });
      }

      return jsonResponse(200, {
        key,
        atHeight,
        stateRoot: suffixHead.header.stateRoot,
        proof: Buffer.from(entry.proof).toString('base64'),
        kind: 'box',
        value: null,
      });
    }

    return jsonResponse(404, { error: 'not found' });
  };

  return { url, fetch: httpFetch };
}

export function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// A minimal Anchor for figures tests — proveFigures reads only .header.height,
// .header.stateRoot on suffixHead and .height, .stateRoot on tip.
export function makeAnchor(
  tipHeight: number,
  tipStateRoot: string,
  suffixHeight: number,
  suffixStateRoot: string,
): Anchor {
  const bare = (h: number, sr: string): BlockHeader => ({
    protocolVersion: PROTOCOL_VERSION,
    height: h,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: sr,
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: DEVNET_POW_TARGET_BITS,
    createdAt: 1_000_000,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  });
  return {
    tip: bare(tipHeight, tipStateRoot),
    suffixHead: { header: bare(suffixHeight, suffixStateRoot), interlinks: [] },
  };
}

export interface AvlInsertion {
  keyHex: string;
  valueBytes: Uint8Array;
}

export interface AvlEntry {
  proof: Uint8Array;
  value: Uint8Array | null;
}

export interface AvlBuild {
  digest: string;
  entries: Map<string, AvlEntry>;
}

// Build an AVL tree with the given insertions, then produce a lookup proof for
// each insertion (inclusion) and for each extra key (exclusion). One tree, one
// digest, proofs for every key the caller will ask about.
export function buildAvlWithInsertions(
  insertions: AvlInsertion[],
  extraLookups: string[] = [],
): AvlBuild {
  const prover = new BatchAVLProver(TREE_KEY_LENGTH, null);
  for (const ins of insertions) {
    prover.performOneOperation({
      tag: 'Insert',
      key: hexToBytes(ins.keyHex),
      value: ins.valueBytes,
    });
    prover.generateProof();
  }
  const entries = new Map<string, AvlEntry>();
  for (const ins of insertions) {
    prover.performOneOperation({ tag: 'Lookup', key: hexToBytes(ins.keyHex) });
    const proof = prover.generateProof();
    entries.set(ins.keyHex, { proof: Uint8Array.from(proof), value: ins.valueBytes });
  }
  for (const key of extraLookups) {
    prover.performOneOperation({ tag: 'Lookup', key: hexToBytes(key) });
    const proof = prover.generateProof();
    entries.set(key, { proof: Uint8Array.from(proof), value: null });
  }
  return { digest: Buffer.from(prover.digest()).toString('hex'), entries };
}

export function boxInsertion(candidate: BoxCandidate, txId: TxId, index: number): AvlInsertion {
  return {
    keyHex: boxProofKeyHex(computeCandidateBoxId(candidate, txId, index)),
    valueBytes: boxRecordBytes(candidate, txId, index),
  };
}

export function recordInsertion(userBytes: UserId, record: IdentityRecord): AvlInsertion {
  return {
    keyHex: identityProofKeyHex(userBytes),
    valueBytes: identityRecordBytes(record),
  };
}

// A minimal AVL proof response in the endpoint's own shape — `stateRoot`,
// `proof` base64, `kind`, `value` — as `GET /api/v1/proof/:key` serves it
// (NODE_INTERFACE → AVL+ State Root). The test wires it per request so
// proveFigures reads what the node would return.
export function avlProofJson(
  boxIdOrKey: string,
  atHeight: number,
  stateRoot: string,
  proofBytes: Uint8Array,
  kind: 'box' | 'record' | 'network' | 'username' | 'holder' | null,
  value: unknown,
): unknown {
  return {
    boxId: boxIdOrKey,
    atHeight,
    stateRoot,
    proof: Buffer.from(proofBytes).toString('base64'),
    kind,
    value,
  };
}

// ---------------------------------------------------------------------------
// A real prover's state, for the range route and the single-key route.
//
// Each test building range proofs seeds a `BatchAVLProver` with
// `seedTreeWrites` (CONSENSUS_INTERFACE → The tree writes →
// "`seedTreeWrites(boxes, records, network)` is genesis"), then draws proofs
// from it: the range route runs
// `holdingsPage` over a recording session and generates the proof; the
// single-key route performs the lookup and generates the proof. Both close
// one `generateProof()` cycle a request, so the prover stays at a cycle
// boundary between requests (NODE_INTERFACE → The block proof).
// ---------------------------------------------------------------------------

/** A deterministic `TxId` for a seeded fixture box — the candidate's bytes, hashed. */
export function fixtureTxId(candidate: AnyBoxCandidate, nonce: number): TxId {
  const label = `${JSON.stringify(valuesFor(candidate))}:${nonce}`;
  const h = Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64);
  return h as TxId;
}

function valuesFor(c: AnyBoxCandidate): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    out[k] = v instanceof Uint8Array ? bytesToHex(v) : typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}

/**
 * Add `txId`, `index` and `id` to a candidate so `seedTreeWrites` can place
 * it in the tree. `txId` is derived from the candidate and a nonce, so every
 * seeded box's id is unique within one fixture.
 */
export function storedBox<T extends AnyBox>(
  candidate: AnyBoxCandidate,
  nonce: number,
  index = 0,
): T {
  const txId = fixtureTxId(candidate, nonce);
  const id = computeCandidateBoxId(candidate, txId, index);
  return { ...candidate, id, txId, index } as unknown as T;
}

/**
 * `karmaBoxFor` and `creditBoxFor` are terse helpers for the common cases.
 */
export function karmaBoxFor(owner: UserId, value: bigint, nonce: number, createdAtBlock = 1): KarmaBox {
  return storedBox<KarmaBox>({ boxType: 'karma', value, createdAtBlock, owner }, nonce);
}

export function creditBoxFor(owner: UserId, value: bigint, nonce: number, createdAtBlock = 1, lockedUntilBlock?: number): CreditBox {
  const base: AnyBoxCandidate = { boxType: 'credit', value, createdAtBlock, owner, ...(lockedUntilBlock !== undefined ? { lockedUntilBlock } : {}) };
  return storedBox<CreditBox>(base, nonce);
}

/**
 * A recording session over `prover` — each lookup is
 * `performLookupWithNeighbors`, so it joins the proof the prover makes at
 * the next `generateProof()` (CONSENSUS_INTERFACE → The tree session).
 * `null` neighbours are the sentinels: all `0x00` below the first key, all
 * `0xff` past the last. A `{ success: false }` is a throw.
 */
export function recordingSession(prover: BatchAVLProver): TreeSession {
  return {
    lookup(key: Uint8Array): TreeLookup {
      const answer = prover.performLookupWithNeighbors(key);
      if (!answer.success) throw new Error(`the prover refuses the lookup of ${bytesToHex(key)}`);
      const nextKey = answer.nextKey ?? new Uint8Array(TREE_KEY_LENGTH).fill(0xff);
      return answer.found
        ? { found: true, value: answer.value, nextKey }
        : { found: false, prevKey: answer.prevKey ?? new Uint8Array(TREE_KEY_LENGTH), nextKey };
    },
  };
}

export interface HoldingsFixture {
  prover: BatchAVLProver;
  stateRoot: string;
}

/**
 * Build a `BatchAVLProver` with `seedTreeWrites`' writes applied and its
 * proof cycle closed. The prover is at a cycle boundary ready for the next
 * proof call. The returned `stateRoot` is the 33-byte digest hex: the root
 * label and the tree height.
 */
export function buildHoldingsFixture(opts: {
  boxes?: readonly AnyBox[];
  records?: ReadonlyArray<{ identityId: Uint8Array; record: IdentityRecord }>;
  network?: NetworkRecord;
}): HoldingsFixture {
  const writes = seedTreeWrites(
    opts.boxes ?? [],
    opts.records ?? [],
    opts.network ?? { memberCount: 0 },
  );
  const prover = new BatchAVLProver(TREE_KEY_LENGTH, null);
  for (const w of writes) {
    const r = prover.performOneOperation(w);
    if (!r.success) throw new Error(`seedTreeWrites refused ${w.tag} of ${bytesToHex(w.key)}`);
  }
  prover.generateProof();
  return { prover, stateRoot: Buffer.from(prover.digest()).toString('hex') };
}

/**
 * The range route's answer, as `GET /api/v1/range/:kind/:owner` serves it
 * (NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range route"):
 * `holdingsPage` run
 * over a recording session, then `generateProof()` to close the cycle. The
 * answer carries `{ kind, owner, atHeight, stateRoot, from, limit, proof }`
 * — no decoded box, no `next`.
 */
export function rangeAnswerFromProver(
  prover: BatchAVLProver,
  stateRoot: string,
  atHeight: number,
  kind: HoldingKind,
  owner: UserId,
  from: Uint8Array | null,
  limit: number,
): unknown {
  const session = recordingSession(prover);
  const view = treeStateView(session);
  holdingsPage(view, kind, owner, from, limit);
  const proof = prover.generateProof();
  return {
    kind,
    owner: bytesToHex(owner),
    atHeight,
    stateRoot,
    from: from === null ? null : bytesToHex(from),
    limit,
    proof: Buffer.from(proof).toString('base64'),
  };
}

/**
 * The single-key proof route's answer, as `GET /api/v1/proof/:key` serves it
 * (NODE_INTERFACE → AVL+ State Root). The lookup is performed on the prover
 * through `performLookupWithNeighbors` (identical directional bits to
 * `Lookup`), and `generateProof()` closes the cycle.
 */
export function singleKeyAnswerFromProver(
  prover: BatchAVLProver,
  stateRoot: string,
  atHeight: number,
  key: Uint8Array,
  entity: 'box' | 'record' | 'network' | 'username' | 'holder' | 'post' | 'like' | 'index' | null,
): unknown {
  prover.performOneOperation({ tag: 'Lookup', key });
  const proof = prover.generateProof();
  return {
    key: bytesToHex(key),
    atHeight,
    stateRoot,
    proof: Buffer.from(proof).toString('base64'),
    kind: entity,
    value: null,
  };
}

/**
 * A test fetch serving a prover's state at `suffixHead` AND at `tip` — one
 * prover per height, since the client reads the range at both heights.
 * `heightAfter` names what `GET /blocks/current` answers (`null` for no
 * answer). The route table:
 *   - `GET /api/v1/range/:kind/:owner?atHeight=N` → the right prover's page
 *   - `GET /api/v1/proof/:key?atHeight=N` → the right prover's single key
 *   - `GET /blocks/current` → `{ height: heightAfter, hash: null }` or 503
 * Everything else is a 404. `calls` is the list of request URLs for
 * assertions.
 */
export interface TwoHeightNode {
  fetch: HttpFetch;
  calls: string[];
}
export interface TwoHeightState {
  suffix: HoldingsFixture;
  suffixHeight: number;
  tip: HoldingsFixture;
  tipHeight: number;
  heightAfter: number | null;
}

export function twoHeightNode(state: TwoHeightState): TwoHeightNode {
  const calls: string[] = [];
  const pickFixture = (h: number): HoldingsFixture | null => {
    if (h === state.suffixHeight) return state.suffix;
    if (h === state.tipHeight) return state.tip;
    return null;
  };
  const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
    const u = new URL(reqUrl);
    calls.push(`${u.pathname}${u.search}`);

    if (u.pathname === '/blocks/current') {
      if (state.heightAfter === null) return jsonResponse(503, { error: 'service unavailable' });
      return jsonResponse(200, { height: state.heightAfter, hash: null });
    }

    const rangeMatch = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/([0-9a-f]{64})$/);
    if (rangeMatch) {
      const kind = rangeMatch[1] as HoldingKind;
      const ownerHex = rangeMatch[2]!;
      const atHeight = Number(u.searchParams.get('atHeight'));
      const fix = pickFixture(atHeight);
      if (fix === null) return jsonResponse(404, { error: 'height not available' });
      const limitRaw = u.searchParams.get('limit');
      const limit = limitRaw === null ? 256 : Number(limitRaw);
      const fromHex = u.searchParams.get('from');
      const from = fromHex === null ? null : hexToBytes(fromHex);
      return jsonResponse(
        200,
        rangeAnswerFromProver(fix.prover, fix.stateRoot, atHeight, kind, hexToBytes(ownerHex) as UserId, from, limit),
      );
    }

    const keyMatch = u.pathname.match(/^\/api\/v1\/proof\/([0-9a-f]+)$/);
    if (keyMatch) {
      const keyHex = keyMatch[1]!;
      const atHeight = Number(u.searchParams.get('atHeight'));
      const fix = pickFixture(atHeight);
      if (fix === null) return jsonResponse(404, { error: 'height not available' });
      const kind = keyHex.startsWith('02') ? 'record' : 'box';
      return jsonResponse(200, singleKeyAnswerFromProver(fix.prover, fix.stateRoot, atHeight, hexToBytes(keyHex), kind));
    }

    return jsonResponse(404, { error: 'not found' });
  };
  return { fetch, calls };
}
