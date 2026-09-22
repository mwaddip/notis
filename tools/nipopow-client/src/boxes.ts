import { verifyAvlLookup } from '@ergots/avltree';
import {
  AVL_KEY_LENGTH,
  boxRecordFromBytes,
  computeCandidateBoxId,
  decayCfgFor,
  effectiveKarma,
  identityRecordFromBytes,
  identityRecordKey,
} from '@dagsocial/types';
import type {
  BlockHeader,
  IdentityRecord,
  NetworkProfile,
  UserId,
} from '@dagsocial/types';
import type { PoPowHeader } from '@dagsocial/nipopow';
import type { HttpFetch } from './http.js';
import { fetchJson } from './http.js';

export interface ListedBox {
  boxId: string;
  value: string;
  lockedUntilBlock?: number;
}

export interface Listing {
  karma: { boxes: ListedBox[]; height: number; effective: string };
  credits: { boxes: ListedBox[] };
}

export type ListingResult = { ok: true; listing: Listing } | { ok: false; reason: string };

export interface Anchor {
  tip: BlockHeader;
  suffixHead: PoPowHeader;
}

export type FigureStatus = 'proven' | 'young' | 'unchecked' | 'absent' | 'unproven' | 'no-proof';

export interface FigureBox {
  boxId: string;
  boxClass: 'karma' | 'credit';
  value: bigint;
  lockedUntilBlock: number | null;
  status: FigureStatus;
  verdict: string;
}

export type RecordResult =
  | { status: 'proven'; record: IdentityRecord }
  | { status: 'absent' }
  | { status: 'unproven' | 'no-proof'; verdict: string };

export interface LedgerSums {
  proven: bigint;
  young: bigint;
  unchecked: bigint;
  absent: bigint;
}

export interface FiguresResult {
  boxes: FigureBox[];
  record: RecordResult;
  karma: LedgerSums & { effective: bigint | null };
  credits: LedgerSums;
  heightAfter: number | null;
  failed: boolean;
}

// NODE_INTERFACE → UTXO queries — one page per fetch, follow `next` to null
interface KarmaPageResponse {
  boxes: { boxId: string; value: string }[];
  next: string | null;
  height: number;
  effective: string;
}

interface CreditPageResponse {
  boxes: { boxId: string; value: string; lockedUntilBlock?: number }[];
  next: string | null;
}

interface AvlProofResponse {
  boxId: string;
  atHeight: number;
  stateRoot: string;
  proof: string;
  kind: 'box' | 'record' | 'network' | 'username' | 'holder' | null;
  value: unknown;
}

interface BlocksCurrentResponse {
  height: number;
  hash: string | null;
}

// NODE_INTERFACE → UTXO queries — /karma/:userId and /credits/:userId are paged
// by keyset, `after=<next>` on each following request until `next` is null.
// A 404 is an identity the node has never seen (empty listing); any other
// non-ok is a listing failure carrying the route and the status.
export async function fetchListing(
  nodeUrl: string,
  user: string,
  httpFetch: HttpFetch,
): Promise<ListingResult> {
  const karmaBoxes: ListedBox[] = [];
  let karmaHeight = 0;
  let karmaEffective = '0';

  const firstKarma = await fetchJson<KarmaPageResponse>(
    httpFetch,
    `${nodeUrl}/karma/${user}`,
  );
  if (firstKarma.ok) {
    for (const b of firstKarma.data.boxes) karmaBoxes.push(b);
    karmaHeight = firstKarma.data.height;
    karmaEffective = firstKarma.data.effective;
    let next: string | null = firstKarma.data.next;
    while (next !== null) {
      const r = await fetchJson<KarmaPageResponse>(
        httpFetch,
        `${nodeUrl}/karma/${user}?after=${encodeURIComponent(next)}`,
      );
      if (!r.ok) {
        return { ok: false, reason: `GET /karma/${user}?after=${next}: HTTP ${r.status}` };
      }
      for (const b of r.data.boxes) karmaBoxes.push(b);
      next = r.data.next;
    }
  } else if (firstKarma.status !== 404) {
    return { ok: false, reason: `GET /karma/${user}: HTTP ${firstKarma.status}` };
  }

  const creditsBoxes: ListedBox[] = [];
  const firstCredit = await fetchJson<CreditPageResponse>(
    httpFetch,
    `${nodeUrl}/credits/${user}`,
  );
  if (firstCredit.ok) {
    for (const b of firstCredit.data.boxes) creditsBoxes.push(b);
    let next: string | null = firstCredit.data.next;
    while (next !== null) {
      const r = await fetchJson<CreditPageResponse>(
        httpFetch,
        `${nodeUrl}/credits/${user}?after=${encodeURIComponent(next)}`,
      );
      if (!r.ok) {
        return { ok: false, reason: `GET /credits/${user}?after=${next}: HTTP ${r.status}` };
      }
      for (const b of r.data.boxes) creditsBoxes.push(b);
      next = r.data.next;
    }
  } else if (firstCredit.status !== 404) {
    return { ok: false, reason: `GET /credits/${user}: HTTP ${firstCredit.status}` };
  }

  return {
    ok: true,
    listing: {
      karma: { boxes: karmaBoxes, height: karmaHeight, effective: karmaEffective },
      credits: { boxes: creditsBoxes },
    },
  };
}

type BoxProofOutcome =
  | { kind: 'proven'; value: bigint; lockedUntilBlock: number | null }
  | { kind: 'exclusion' }
  | { kind: 'unproven'; verdict: string }
  | { kind: 'no-proof'; verdict: string };

type RecordProofOutcome =
  | { kind: 'proven'; record: IdentityRecord }
  | { kind: 'exclusion' }
  | { kind: 'unproven'; verdict: string }
  | { kind: 'no-proof'; verdict: string };

// WEB_INTERFACE → The extension → "The verified figures" — one proof, one height,
// one entity kind. Every accepted verdict comes with an AVL inclusion under a
// stateRoot the caller trusts; every other outcome is one of the four verdicts
// below.
async function proveOneBoxAtHeight(
  nodeUrl: string,
  boxId: string,
  boxClass: 'karma' | 'credit',
  userLowerHex: string,
  atHeight: number,
  expectedStateRoot: string,
  httpFetch: HttpFetch,
): Promise<BoxProofOutcome> {
  const proofRes = await fetchJson<AvlProofResponse>(
    httpFetch,
    `${nodeUrl}/api/v1/proof/${boxId}?atHeight=${atHeight}`,
  );
  if (!proofRes.ok) {
    if (proofRes.status === 0) {
      return { kind: 'no-proof', verdict: `transport failure: ${proofRes.body}` };
    }
    return { kind: 'no-proof', verdict: `HTTP ${proofRes.status}: ${proofRes.body}` };
  }
  const resp = proofRes.data;
  if (resp.stateRoot !== expectedStateRoot) {
    return { kind: 'unproven', verdict: 'stateRoot mismatch' };
  }
  // NODE_INTERFACE → Entity kinds — the AVL value carries provenance
  if (resp.kind != null && resp.kind !== 'box') {
    return { kind: 'unproven', verdict: `node returned kind '${resp.kind}' for a box id` };
  }
  const avlResult = verifyAvlLookup(
    hexToBytes(expectedStateRoot),
    base64ToBytes(resp.proof),
    { keyLength: AVL_KEY_LENGTH, valueLengthOpt: null },
    hexToBytes(boxId),
  );
  if (avlResult === null) return { kind: 'unproven', verdict: 'proof rejected' };
  if (avlResult.value === null) return { kind: 'exclusion' };

  let record;
  try {
    record = boxRecordFromBytes(avlResult.value);
  } catch {
    return { kind: 'unproven', verdict: 'value decode failed' };
  }
  const derivedId = computeCandidateBoxId(record.candidate, record.txId, record.index);
  if (derivedId !== boxId) {
    return { kind: 'unproven', verdict: 'value does not hash to the key' };
  }
  if (record.candidate.boxType !== boxClass) {
    return {
      kind: 'unproven',
      verdict: `candidate boxType '${record.candidate.boxType}' does not match listing '${boxClass}'`,
    };
  }
  // Both karma and credit carry `owner` (TYPES_INTERFACE → Layout — Boxes).
  const cand = record.candidate as { owner: Uint8Array; lockedUntilBlock?: number };
  const ownerHex = Buffer.from(cand.owner).toString('hex');
  if (ownerHex !== userLowerHex) {
    return {
      kind: 'unproven',
      verdict: `candidate owner '${ownerHex}' does not match user '${userLowerHex}'`,
    };
  }
  const lockedUntilBlock =
    boxClass === 'credit'
      ? cand.lockedUntilBlock === undefined
        ? null
        : cand.lockedUntilBlock
      : null;
  return { kind: 'proven', value: record.candidate.value, lockedUntilBlock };
}

// The record key is derived from `user` under IDENTITY_KEY_DOMAIN — the caller's
// own derivation, so the lookup proof binds the key to the value; no owner
// check applies.
async function proveRecordAtHeight(
  nodeUrl: string,
  recordKey: string,
  atHeight: number,
  expectedStateRoot: string,
  httpFetch: HttpFetch,
): Promise<RecordProofOutcome> {
  const proofRes = await fetchJson<AvlProofResponse>(
    httpFetch,
    `${nodeUrl}/api/v1/proof/${recordKey}?atHeight=${atHeight}`,
  );
  if (!proofRes.ok) {
    if (proofRes.status === 0) {
      return { kind: 'no-proof', verdict: `transport failure: ${proofRes.body}` };
    }
    return { kind: 'no-proof', verdict: `HTTP ${proofRes.status}: ${proofRes.body}` };
  }
  const resp = proofRes.data;
  if (resp.stateRoot !== expectedStateRoot) {
    return { kind: 'unproven', verdict: 'stateRoot mismatch' };
  }
  if (resp.kind != null && resp.kind !== 'record') {
    return { kind: 'unproven', verdict: `node returned kind '${resp.kind}' for a record key` };
  }
  const avlResult = verifyAvlLookup(
    hexToBytes(expectedStateRoot),
    base64ToBytes(resp.proof),
    { keyLength: AVL_KEY_LENGTH, valueLengthOpt: null },
    hexToBytes(recordKey),
  );
  if (avlResult === null) return { kind: 'unproven', verdict: 'proof rejected' };
  if (avlResult.value === null) return { kind: 'exclusion' };
  let record: IdentityRecord;
  try {
    record = identityRecordFromBytes(avlResult.value);
  } catch {
    return { kind: 'unproven', verdict: 'value decode failed' };
  }
  return { kind: 'proven', record };
}

// WEB_INTERFACE → The extension → "The verified figures" — the run's order is
// the rule: every listed box at suffixHead, then the identity record, then
// every excluded box at tip, then one /blocks/current for `heightAfter`.
export async function proveFigures(
  nodeUrl: string,
  user: string,
  listing: Listing,
  anchor: Anchor,
  profile: NetworkProfile,
  httpFetch: HttpFetch,
): Promise<FiguresResult> {
  const userLowerHex = user.toLowerCase();
  const userBytes = hexToBytes(userLowerHex) as UserId;
  const suffixHeight = anchor.suffixHead.header.height;
  const suffixStateRoot = anchor.suffixHead.header.stateRoot;
  const tipHeight = anchor.tip.height;
  const tipStateRoot = anchor.tip.stateRoot;

  const allBoxes: { listed: ListedBox; boxClass: 'karma' | 'credit' }[] = [];
  for (const b of listing.karma.boxes) allBoxes.push({ listed: b, boxClass: 'karma' });
  for (const b of listing.credits.boxes) allBoxes.push({ listed: b, boxClass: 'credit' });

  // Step 1 — every listed box at suffixHead
  const firstPass: BoxProofOutcome[] = [];
  for (const { listed, boxClass } of allBoxes) {
    firstPass.push(
      await proveOneBoxAtHeight(
        nodeUrl,
        listed.boxId,
        boxClass,
        userLowerHex,
        suffixHeight,
        suffixStateRoot,
        httpFetch,
      ),
    );
  }

  // Step 2 — the identity record at suffixHead
  const recordOutcome = await proveRecordAtHeight(
    nodeUrl,
    identityRecordKey(userBytes),
    suffixHeight,
    suffixStateRoot,
    httpFetch,
  );

  // Step 3 — every box the first pass excluded, once more at tip
  const secondPass = new Map<string, BoxProofOutcome>();
  for (let i = 0; i < allBoxes.length; i++) {
    if (firstPass[i]!.kind !== 'exclusion') continue;
    const { listed, boxClass } = allBoxes[i]!;
    secondPass.set(
      listed.boxId,
      await proveOneBoxAtHeight(
        nodeUrl,
        listed.boxId,
        boxClass,
        userLowerHex,
        tipHeight,
        tipStateRoot,
        httpFetch,
      ),
    );
  }

  // Step 4 — one GET /blocks/current
  const blocksRes = await fetchJson<BlocksCurrentResponse>(
    httpFetch,
    `${nodeUrl}/blocks/current`,
  );
  const heightAfter = blocksRes.ok ? blocksRes.data.height : null;

  // Assemble the per-box verdicts
  const boxes: FigureBox[] = [];
  let failed = false;
  for (let i = 0; i < allBoxes.length; i++) {
    const { listed, boxClass } = allBoxes[i]!;
    const first = firstPass[i]!;
    const listingValue = BigInt(listed.value);
    const listingLocked =
      boxClass === 'credit' ? listed.lockedUntilBlock ?? null : null;

    let fb: FigureBox;
    if (first.kind === 'proven') {
      fb = {
        boxId: listed.boxId,
        boxClass,
        value: first.value,
        lockedUntilBlock: first.lockedUntilBlock,
        status: 'proven',
        verdict: `proven at suffixHead (height ${suffixHeight})`,
      };
    } else if (first.kind === 'unproven') {
      fb = {
        boxId: listed.boxId,
        boxClass,
        value: listingValue,
        lockedUntilBlock: listingLocked,
        status: 'unproven',
        verdict: `unproven at suffixHead: ${first.verdict}`,
      };
      failed = true;
    } else if (first.kind === 'no-proof') {
      fb = {
        boxId: listed.boxId,
        boxClass,
        value: listingValue,
        lockedUntilBlock: listingLocked,
        status: 'no-proof',
        verdict: `no proof at suffixHead: ${first.verdict}`,
      };
    } else {
      const second = secondPass.get(listed.boxId)!;
      if (second.kind === 'proven') {
        fb = {
          boxId: listed.boxId,
          boxClass,
          value: second.value,
          lockedUntilBlock: second.lockedUntilBlock,
          status: 'young',
          verdict: `young — proven at tip (height ${tipHeight}), excluded at suffixHead`,
        };
      } else if (second.kind === 'unproven') {
        fb = {
          boxId: listed.boxId,
          boxClass,
          value: listingValue,
          lockedUntilBlock: listingLocked,
          status: 'unproven',
          verdict: `unproven at tip: ${second.verdict}`,
        };
        failed = true;
      } else if (second.kind === 'no-proof') {
        fb = {
          boxId: listed.boxId,
          boxClass,
          value: listingValue,
          lockedUntilBlock: listingLocked,
          status: 'no-proof',
          verdict: `no proof at tip: ${second.verdict}`,
        };
      } else {
        // Excluded at both — decided by heightAfter. An undecided heightAfter
        // (null) or a fallen height read as unchecked, never as a lie.
        if (heightAfter !== null && heightAfter === tipHeight) {
          fb = {
            boxId: listed.boxId,
            boxClass,
            value: listingValue,
            lockedUntilBlock: listingLocked,
            status: 'absent',
            verdict: `absent — the node lists what the chain does not hold at height ${tipHeight}`,
          };
          failed = true;
        } else {
          const why =
            heightAfter === null
              ? '/blocks/current unavailable'
              : heightAfter > tipHeight
                ? `heightAfter ${heightAfter} > tip ${tipHeight} — a block landed since the anchor`
                : `heightAfter ${heightAfter} < tip ${tipHeight} — the node's height fell`;
          fb = {
            boxId: listed.boxId,
            boxClass,
            value: listingValue,
            lockedUntilBlock: listingLocked,
            status: 'unchecked',
            verdict: `unchecked — ${why}`,
          };
        }
      }
    }
    boxes.push(fb);
  }

  // The record verdict, and whether it counts as a failure
  let record: RecordResult;
  if (recordOutcome.kind === 'proven') {
    record = { status: 'proven', record: recordOutcome.record };
  } else if (recordOutcome.kind === 'exclusion') {
    record = { status: 'absent' };
  } else if (recordOutcome.kind === 'unproven') {
    record = { status: 'unproven', verdict: recordOutcome.verdict };
    failed = true;
  } else {
    record = { status: 'no-proof', verdict: recordOutcome.verdict };
  }

  const sums = (cls: 'karma' | 'credit'): LedgerSums => {
    let proven = 0n;
    let young = 0n;
    let unchecked = 0n;
    let absent = 0n;
    for (const b of boxes) {
      if (b.boxClass !== cls) continue;
      if (b.status === 'proven') proven += b.value;
      else if (b.status === 'young') young += b.value;
      else if (b.status === 'unchecked') unchecked += b.value;
      else if (b.status === 'absent') absent += b.value;
    }
    return { proven, young, unchecked, absent };
  };
  const karmaSums = sums('karma');
  const creditsSums = sums('credit');

  // TYPES_INTERFACE → Identity record and karma valuation — one implementation
  // of the valuation shared by the node and the client; valued at the row's
  // own height, so an unchanged state reproduces the number exactly.
  let effective: bigint | null;
  if (record.status === 'proven') {
    effective = effectiveKarma(
      karmaSums.proven,
      record.record,
      listing.karma.height,
      decayCfgFor(profile),
    );
  } else if (record.status === 'absent') {
    effective = effectiveKarma(
      karmaSums.proven,
      null,
      listing.karma.height,
      decayCfgFor(profile),
    );
  } else {
    effective = null;
  }

  return {
    boxes,
    record,
    karma: { ...karmaSums, effective },
    credits: creditsSums,
    heightAfter,
    failed,
  };
}

// The command line's entry: fetch the listing and prove it.
export async function proveBoxes(
  nodeUrl: string,
  user: string,
  anchor: Anchor,
  profile: NetworkProfile,
  httpFetch: HttpFetch,
): Promise<FiguresResult> {
  const listingResult = await fetchListing(nodeUrl, user, httpFetch);
  if (!listingResult.ok) {
    return {
      boxes: [],
      record: { status: 'no-proof', verdict: `listing failed: ${listingResult.reason}` },
      karma: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, effective: null },
      credits: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n },
      heightAfter: null,
      failed: true,
    };
  }
  return proveFigures(nodeUrl, user, listingResult.listing, anchor, profile, httpFetch);
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
