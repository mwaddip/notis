import { verifyAvlLookup } from '@ergots/avltree';
import {
  AVL_KEY_LENGTH,
  boxRecordFromBytes,
  computeCandidateBoxId,
} from '@dagsocial/types';
import type { PoPowHeader } from '@dagsocial/nipopow';
import type { HttpFetch } from './http.js';
import { fetchJson } from './http.js';

export type BoxClass = 'karma' | 'credit';
export type BoxStatus = 'proven' | 'unconfirmed' | 'unproven';

export interface BoxVerdict {
  boxId: string;
  boxClass: BoxClass;
  value: bigint;
  status: BoxStatus;
  verdict: string;
}

export interface BoxesResult {
  boxes: BoxVerdict[];
  karmaTotal: bigint;
  creditTotal: bigint;
  failed: boolean;
}

interface KarmaResponse {
  userId: string;
  total: string;
  boxes: { boxId: string; value: string }[];
  lastActivityBlock: number;
  lastDecayBlock: number;
  height: number;
}

interface CreditResponse {
  userId: string;
  total: string;
  boxes: { boxId: string; value: string; lockedUntilBlock?: number }[];
}

interface AvlProofResponse {
  boxId: string;
  atHeight: number;
  stateRoot: string;
  proof: string;
  kind: 'box' | 'record' | null;
  value: unknown;
}

// NODE_INTERFACE → "The AVL value carries provenance"
export async function proveBoxes(
  nodeUrl: string,
  user: string,
  suffixHead: PoPowHeader,
  httpFetch: HttpFetch,
): Promise<BoxesResult> {
  const stateRoot = suffixHead.header.stateRoot;
  const atHeight = suffixHead.header.height;

  const boxIds: { id: string; boxClass: BoxClass }[] = [];

  const karmaRes = await fetchJson<KarmaResponse>(httpFetch, `${nodeUrl}/karma/${user}`);
  if (karmaRes.ok) {
    for (const b of karmaRes.data.boxes) boxIds.push({ id: b.boxId, boxClass: 'karma' });
  } else if (karmaRes.status !== 404) {
    return failResult([{
      boxId: '', boxClass: 'karma', value: 0n, status: 'unproven',
      verdict: `karma listing failed: HTTP ${karmaRes.status}`,
    }]);
  }

  const creditRes = await fetchJson<CreditResponse>(httpFetch, `${nodeUrl}/credits/${user}`);
  if (creditRes.ok) {
    for (const b of creditRes.data.boxes) boxIds.push({ id: b.boxId, boxClass: 'credit' });
  } else if (creditRes.status !== 404) {
    return failResult([{
      boxId: '', boxClass: 'credit', value: 0n, status: 'unproven',
      verdict: `credit listing failed: HTTP ${creditRes.status}`,
    }]);
  }

  if (boxIds.length === 0) {
    return { boxes: [], karmaTotal: 0n, creditTotal: 0n, failed: false };
  }

  const verdicts: BoxVerdict[] = [];
  let failed = false;

  for (const { id, boxClass } of boxIds) {
    const v = await proveOneBox(httpFetch, nodeUrl, id, boxClass, stateRoot, atHeight);
    verdicts.push(v);
    if (v.status === 'unproven') failed = true;
  }

  let karmaTotal = 0n;
  let creditTotal = 0n;
  for (const v of verdicts) {
    if (v.status !== 'proven') continue;
    if (v.boxClass === 'karma') karmaTotal += v.value;
    else creditTotal += v.value;
  }

  return { boxes: verdicts, karmaTotal, creditTotal, failed };
}

async function proveOneBox(
  httpFetch: HttpFetch,
  nodeUrl: string,
  boxId: string,
  boxClass: BoxClass,
  stateRoot: string,
  atHeight: number,
): Promise<BoxVerdict> {
  const proofRes = await fetchJson<AvlProofResponse>(
    httpFetch,
    `${nodeUrl}/api/v1/proof/${boxId}?atHeight=${atHeight}`,
  );

  if (!proofRes.ok) {
    if (proofRes.status === 404) {
      return {
        boxId, boxClass, value: 0n, status: 'unproven',
        verdict: 'height not available — node checkpoint window does not reach suffixHead',
      };
    }
    return {
      boxId, boxClass, value: 0n, status: 'unproven',
      verdict: `proof fetch failed: HTTP ${proofRes.status}`,
    };
  }

  const resp = proofRes.data;

  if (resp.stateRoot !== stateRoot) {
    return {
      boxId, boxClass, value: 0n, status: 'unproven',
      verdict: 'unproven: stateRoot mismatch',
    };
  }

  if (resp.kind === 'record') {
    return {
      boxId, boxClass, value: 0n, status: 'unproven',
      verdict: 'unproven: node returned a record for a box id (finding)',
    };
  }

  const stateRootBytes = hexToBytes(stateRoot);
  const proofBytes = base64ToBytes(resp.proof);
  const keyBytes = hexToBytes(boxId);

  const avlResult = verifyAvlLookup(
    stateRootBytes,
    proofBytes,
    { keyLength: AVL_KEY_LENGTH, valueLengthOpt: null },
    keyBytes,
  );

  if (avlResult === null) {
    return {
      boxId, boxClass, value: 0n, status: 'unproven',
      verdict: 'unproven: proof rejected',
    };
  }

  // Absent at depth k — the box is younger than suffixHead, not a failure
  if (avlResult.value === null) {
    return {
      boxId, boxClass, value: 0n, status: 'unconfirmed',
      verdict: 'unconfirmed at depth k',
    };
  }

  // TYPES_INTERFACE → "The AVL value carries provenance"
  let record;
  try {
    record = boxRecordFromBytes(avlResult.value);
  } catch {
    return {
      boxId, boxClass, value: 0n, status: 'unproven',
      verdict: 'unproven: value decode failed',
    };
  }

  const derivedId = computeCandidateBoxId(record.candidate, record.txId, record.index);
  if (derivedId !== boxId) {
    return {
      boxId, boxClass, value: 0n, status: 'unproven',
      verdict: 'unproven: value does not hash to the key',
    };
  }

  return {
    boxId, boxClass, value: record.candidate.value, status: 'proven',
    verdict: 'proven',
  };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function failResult(boxes: BoxVerdict[]): BoxesResult {
  return { boxes, karmaTotal: 0n, creditTotal: 0n, failed: true };
}
