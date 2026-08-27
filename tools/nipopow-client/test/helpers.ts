import {
  PROTOCOL_VERSION,
  EMPTY_STATE_ROOT,
  GENESIS_PREV_BLOCK_HASH,
  interlinkRoot,
  updateInterlinks,
  AVL_KEY_LENGTH,
  boxRecordBytes,
  computeCandidateBoxId,
} from '@dagsocial/types';
import type { BlockHeader, BoxCandidate, TxId } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  blockHash,
  level as headerLevel,
  levelOfHit,
  powHit,
  orderingPowTarget,
} from '@dagsocial/validation';
import {
  proveWithReader,
  encodeNipopowProof,
} from '@dagsocial/nipopow';
import type { PoPowHeader, PopowHeaderReader } from '@dagsocial/nipopow';
import { BatchAVLProver } from '@ergots/avltree';
import type { HttpFetch } from '../src/http.js';

export const DEVNET_POW_TARGET_BITS = 3072;

function solveHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

function solveForLevel(header: BlockHeader, minLevel: number): number {
  const target = orderingPowTarget(header.powTargetBits);
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
}

export function buildMinedChain(opts: {
  count: number;
  powTargetBits?: number;
  forceLevels?: Map<number, number>;
  stateRoot?: string;
  validatorId?: Uint8Array;
}): MinedChain {
  const { count, forceLevels } = opts;
  const powTargetBits = opts.powTargetBits ?? DEVNET_POW_TARGET_BITS;
  const stateRoot = opts.stateRoot ?? EMPTY_STATE_ROOT;
  const validatorId = opts.validatorId ?? new Uint8Array(32);
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
    const header: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: prevHash,
      utxoTxRoot: '00'.repeat(32),
      stateRoot,
      validatorId,
      powNonce: 0,
      powTargetBits,
      createdAt: i,
      interlinkRoot: interlinkRoot(expected),
    };

    const wantLevel = forceLevels?.get(height);
    if (wantLevel !== undefined && wantLevel > 0) {
      header.powNonce = solveForLevel(header, wantLevel);
    } else {
      header.powNonce = solveHeaderPow(header);
    }

    const hash = blockHash(header);
    if (hash === null) throw new Error(`unhashable at height ${height}`);
    const lvl = headerLevel(header);
    if (lvl === null) throw new Error(`null level at height ${height}`);

    headers.push(header);
    interlinksPerHeader.push(expected);
    popowHeaders.push({ header, interlinks: expected });

    prevHash = hash;
    prevInterlinks = expected;
    prevLevel = lvl;
  }
  return { headers, interlinksPerHeader, popowHeaders };
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

export function devnetProfile() {
  return {
    expectedTarget: (_height: number) => DEVNET_POW_TARGET_BITS,
    genesisId: '',
    protocolVersion: PROTOCOL_VERSION,
  };
}

export function devnetProfileWithGenesisId(chain: MinedChain) {
  const gHash = blockHash(chain.headers[0]!);
  if (gHash === null) throw new Error('unhashable genesis');
  return {
    expectedTarget: (_height: number) => DEVNET_POW_TARGET_BITS,
    genesisId: gHash,
    protocolVersion: PROTOCOL_VERSION,
  };
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

export interface AvlFixture {
  digest: string;
  entries: Map<string, { proof: Uint8Array; value: Uint8Array }>;
}

export function buildAvlFixture(
  boxes: { candidate: BoxCandidate; txId: TxId; index: number }[],
): AvlFixture {
  const prover = new BatchAVLProver(AVL_KEY_LENGTH, null);
  const entries = new Map<string, { proof: Uint8Array; value: Uint8Array }>();

  for (const box of boxes) {
    const boxId = computeCandidateBoxId(box.candidate, box.txId, box.index);
    const keyBytes = hexToBytes(boxId);
    const valueBytes = boxRecordBytes(box.candidate, box.txId, box.index);
    prover.performOneOperation({ tag: 'Insert', key: keyBytes, value: valueBytes });
    prover.generateProof();
    entries.set(boxId, { proof: new Uint8Array(0), value: valueBytes });
  }

  for (const [boxId] of entries) {
    const keyBytes = hexToBytes(boxId);
    prover.performOneOperation({ tag: 'Lookup', key: keyBytes });
    const proof = prover.generateProof();
    const entry = entries.get(boxId)!;
    entries.set(boxId, { proof: Uint8Array.from(proof), value: entry.value });
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
  const prover = new BatchAVLProver(AVL_KEY_LENGTH, null);
  const keyBytes = hexToBytes(fakeKey);
  const valueBytes = boxRecordBytes(candidate, txId, index);
  prover.performOneOperation({ tag: 'Insert', key: keyBytes, value: valueBytes });
  prover.generateProof();
  prover.performOneOperation({ tag: 'Lookup', key: keyBytes });
  const proof = prover.generateProof();
  const entries = new Map<string, { proof: Uint8Array; value: Uint8Array }>();
  entries.set(fakeKey, { proof: Uint8Array.from(proof), value: valueBytes });
  return { digest: Buffer.from(prover.digest()).toString('hex'), entries };
}

export function buildAvlExclusionProof(
  presentBoxes: { candidate: BoxCandidate; txId: TxId; index: number }[],
  absentKey: string,
): { digest: string; proof: Uint8Array } {
  const prover = new BatchAVLProver(AVL_KEY_LENGTH, null);
  for (const box of presentBoxes) {
    const boxId = computeCandidateBoxId(box.candidate, box.txId, box.index);
    const keyBytes = hexToBytes(boxId);
    const valueBytes = boxRecordBytes(box.candidate, box.txId, box.index);
    prover.performOneOperation({ tag: 'Insert', key: keyBytes, value: valueBytes });
    prover.generateProof();
  }
  prover.performOneOperation({ tag: 'Lookup', key: hexToBytes(absentKey) });
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

    const avlMatch = path.match(/^\/api\/v1\/proof\/([0-9a-f]{64})\?atHeight=(\d+)$/);
    if (avlMatch) {
      const boxId = avlMatch[1]!;
      const atHeight = Number(avlMatch[2]!);

      if (overrideAvlResponses?.has(boxId)) {
        const override = overrideAvlResponses.get(boxId)!;
        return jsonResponse(200, override);
      }

      if (!avl) return jsonResponse(404, { error: 'no AVL' });

      const entry = avl.entries.get(boxId);
      if (!entry) {
        return jsonResponse(200, {
          boxId,
          atHeight,
          stateRoot: avl.digest,
          proof: Buffer.from(new Uint8Array(0)).toString('base64'),
          kind: null,
          value: null,
        });
      }

      return jsonResponse(200, {
        boxId,
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

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
