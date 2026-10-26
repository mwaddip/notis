import {
  interlinkRoot,
  isHex64,
  MAX_INTERLINKS,
} from '@dagsocial/types';
import type { BlockHeader, ProtocolEra } from '@dagsocial/types';
import {
  asertTargetBits,
  blockHash,
  verifyCreatedAtBound,
  verifyCreatedAtOrder,
  verifyHeaderFieldDomains,
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
} from '@dagsocial/validation';
import type { RetargetParams } from '@dagsocial/validation';
import { decodeNipopowProof } from './codec.js';
import type { PoPowHeader, NipopowProof } from './codec.js';

type VerifyCode =
  | 'parse-failed' | 'shape' | 'anchor' | 'domain' | 'version'
  | 'target' | 'pow' | 'time' | 'clock' | 'interlinks' | 'heights' | 'connections';

export type VerifyResult =
  | { ok: true; headers: BlockHeader[]; tip: BlockHeader; tipHeight: number; suffixHead: PoPowHeader }
  | { ok: false; reason: VerifyCode; index?: number };

// NIPOPOW_INTERFACE → verifyProof
export interface VerifyProfile {
  retarget: RetargetParams;
  maxFutureDriftMs: number;
  nowMs: number;
  genesisId: string;
  protocolVersionSchedule: readonly ProtocolEra[];   // TYPES_INTERFACE → Version
}

function fail(reason: VerifyCode, index?: number): VerifyResult {
  return index !== undefined ? { ok: false, reason, index } : { ok: false, reason };
}

function isHeader(h: unknown): h is BlockHeader {
  return h !== null && typeof h === 'object' && 'height' in h && 'prevBlockHash' in h;
}

function isPoPowHeader(ph: unknown): ph is PoPowHeader {
  return ph !== null && typeof ph === 'object' &&
    'header' in ph && isHeader((ph as PoPowHeader).header) &&
    'interlinks' in ph && Array.isArray((ph as PoPowHeader).interlinks);
}

// NIPOPOW_INTERFACE → verifyProof
export function verifyProof(
  proof: Uint8Array | NipopowProof,
  params: { m: number; k: number },
  profile: VerifyProfile,
): VerifyResult {
  let p: NipopowProof;
  if (proof instanceof Uint8Array) {
    try {
      p = decodeNipopowProof(proof);
    } catch {
      return fail('parse-failed');
    }
  } else {
    p = proof;
  }

  // Rule 1: shape — m and k equal params.m and params.k, each at least 1;
  // prefix non-empty; suffixTail.length === k − 1 (NIPOPOW_INTERFACE → verifyProof)
  // Per-element shape checks so that null/non-object never throws (M-5)
  try {
    if (!Number.isInteger(params.m) || params.m < 1) return fail('shape');
    if (!Number.isInteger(params.k) || params.k < 1) return fail('shape');
    if (typeof p.m !== 'number' || p.m !== params.m) return fail('shape');
    if (typeof p.k !== 'number' || p.k !== params.k) return fail('shape');
    if (!Array.isArray(p.prefix) || p.prefix.length === 0) return fail('shape');
    for (let i = 0; i < p.prefix.length; i++) {
      if (!isPoPowHeader(p.prefix[i])) return fail('shape');
    }
    if (!isPoPowHeader(p.suffixHead)) return fail('shape');
    if (!Array.isArray(p.suffixTail) || p.suffixTail.length !== p.k - 1) return fail('shape');
    for (let i = 0; i < p.suffixTail.length; i++) {
      if (!isHeader(p.suffixTail[i])) return fail('shape');
    }
  } catch {
    return fail('shape');
  }

  // Flatten: prefix ++ [suffixHead] ++ suffixTail
  const allPoPow: PoPowHeader[] = [...p.prefix, p.suffixHead];
  const allHeaders: BlockHeader[] = [
    ...p.prefix.map(ph => ph.header),
    p.suffixHead.header,
    ...p.suffixTail,
  ];

  // Rule 2: anchor
  const first = p.prefix[0]!;
  if (first.header.height !== 1) return fail('anchor', 0);
  if (!Array.isArray(first.interlinks) || first.interlinks.length !== 0) return fail('anchor', 0);
  const genesisHash = blockHash(first.header);
  if (genesisHash === null) return fail('domain', 0);
  if (profile.genesisId !== '' && genesisHash !== profile.genesisId) return fail('anchor', 0);
  for (let i = 1; i < allPoPow.length; i++) {
    const ph = allPoPow[i]!;
    if (!Array.isArray(ph.interlinks) || ph.interlinks.length === 0) return fail('anchor', i);
    if (ph.interlinks[0] !== genesisHash) return fail('anchor', i);
  }

  const { floorBits, ceilingBits } = profile.retarget;

  // Rule 3: every header — domain, version, band target, pow
  for (let i = 0; i < allHeaders.length; i++) {
    const h = allHeaders[i]!;
    const domResult = verifyHeaderFieldDomains(h);
    if (!domResult.valid) return fail('domain', i);
    // VALIDATION_INTERFACE → Protocol Version — declared equals the era at the header's height
    if (!verifyProtocolVersion(h.protocolVersion, h.height, profile.protocolVersionSchedule)) {
      return fail('version', i);
    }
    if (h.powTargetBits < floorBits || h.powTargetBits > ceilingBits) return fail('target', i);
    if (!verifyOrderingBlockPoW(h)) return fail('pow', i);
  }

  // Rule 3 continued: the schedule check across the flattened sequence.
  // Block 1 carries profile.retarget.anchorBits; every other element whose
  // prevBlockHash is the blockHash of the element before it carries
  // asertTargetBits(profile.retarget, t_a, previous).
  // NIPOPOW_INTERFACE → verifyProof
  const t_a = first.header.createdAt;
  const suffixStartIdx = p.prefix.length;
  if (allHeaders[0]!.powTargetBits !== profile.retarget.anchorBits) {
    return fail('target', 0);
  }
  for (let i = 1; i < allHeaders.length; i++) {
    const prev = allHeaders[i - 1]!;
    const cur = allHeaders[i]!;
    const prevHash = blockHash(prev);
    if (prevHash !== null && cur.prevBlockHash === prevHash) {
      const scheduled = asertTargetBits(profile.retarget, t_a, {
        height: prev.height,
        createdAt: prev.createdAt,
      });
      if (cur.powTargetBits !== scheduled) {
        return fail('target', i);
      }
    }
  }

  // Rule 3 continued: time — createdAt strictly increasing
  // VALIDATION_INTERFACE → verifyCreatedAtOrder
  for (let i = 1; i < allHeaders.length; i++) {
    if (!verifyCreatedAtOrder(allHeaders[i]!, allHeaders[i - 1]!)) {
      return fail('time', i);
    }
  }

  // Rule 3 continued: clock — tip's future bound
  // VALIDATION_INTERFACE → verifyCreatedAtBound
  const tip = allHeaders[allHeaders.length - 1]!;
  if (!verifyCreatedAtBound(tip, profile.nowMs, profile.maxFutureDriftMs)) {
    return fail('clock', allHeaders.length - 1);
  }

  // Rule 4: every PoPowHeader — interlinkRoot
  // Shape-check the vector before interlinkRoot sees it (M-5: interlinkRoot
  // throws on a malformed vector; a verdict, never a throw)
  for (let i = 0; i < allPoPow.length; i++) {
    const ph = allPoPow[i]!;
    if (!Array.isArray(ph.interlinks)) return fail('interlinks', i);
    if (ph.interlinks.length > MAX_INTERLINKS) return fail('interlinks', i);
    if (!ph.interlinks.every(isHex64)) {
      return fail('interlinks', i);
    }
    try {
      if (interlinkRoot(ph.interlinks) !== ph.header.interlinkRoot) return fail('interlinks', i);
    } catch {
      return fail('interlinks', i);
    }
  }

  // Rule 5: heights strictly increase across the flattened sequence, and an element
  // whose prevBlockHash is the blockHash of the element before it sits exactly one
  // height above it (NIPOPOW_INTERFACE → verifyProof)
  for (let i = 1; i < allHeaders.length; i++) {
    if (allHeaders[i]!.height <= allHeaders[i - 1]!.height) return fail('heights', i);
    const prevHash = blockHash(allHeaders[i - 1]!);
    if (prevHash !== null && allHeaders[i]!.prevBlockHash === prevHash) {
      if (allHeaders[i]!.height !== allHeaders[i - 1]!.height + 1) return fail('heights', i);
    }
  }

  // Rule 6: connections, strict adjacency
  // NIPOPOW_INTERFACE → verifyProof
  for (let i = 1; i < allPoPow.length; i++) {
    const cur = allPoPow[i]!;
    const prevPh = allPoPow[i - 1]!;
    const prevPhHash = blockHash(prevPh.header);
    if (prevPhHash === null) return fail('connections', i);
    const inInterlinks = Array.isArray(cur.interlinks) && cur.interlinks.includes(prevPhHash);
    const isPrevBlock = cur.header.prevBlockHash === prevPhHash;
    if (!inInterlinks && !isPrevBlock) return fail('connections', i);
  }
  // Suffix tail: parent-linked from suffixHead
  let prevTailHash = blockHash(p.suffixHead.header);
  if (prevTailHash === null) return fail('connections', suffixStartIdx);
  for (let i = 0; i < p.suffixTail.length; i++) {
    const tailH = p.suffixTail[i]!;
    if (tailH.prevBlockHash !== prevTailHash) return fail('connections', suffixStartIdx + 1 + i);
    const h = blockHash(tailH);
    if (h === null) return fail('connections', suffixStartIdx + 1 + i);
    prevTailHash = h;
  }

  return {
    ok: true,
    headers: allHeaders,
    tip,
    tipHeight: tip.height,
    suffixHead: p.suffixHead,
  };
}
