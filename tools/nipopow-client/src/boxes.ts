import { verifyAvlLookup } from '@ergots/avltree';
import {
  AVL_KEY_LENGTH,
  boxRecordFromBytes,
  bytesToHex,
  computeCandidateBoxId,
  decayCfgFor,
  effectiveKarma,
  hexToBytes,
  identityRecordFromBytes,
  identityRecordKey,
} from '@dagsocial/types';
import type {
  BlockHeader,
  DecodedBoxCandidate,
  IdentityRecord,
  NetworkProfile,
  UserId,
} from '@dagsocial/types';
import type { PoPowHeader } from '@dagsocial/nipopow';
import type { HttpFetch } from './http.js';
import { capped, fetchJson, isRecord } from './http.js';

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

// WEB_INTERFACE → The extension → "A run is total" — the paging walks a page's
// `boxes` and follows its `next`, so a page is an object with a `boxes` array
// and a `next` that is null or a row's key: text that is not empty, since no
// row's key is (NODE_INTERFACE → "Every paged response carries `next`"), and
// well-formed, the next request carrying it through `encodeURIComponent`; any
// other answer is a malformed page. Each entry is the node's claim, checked by
// proveFigures before a proof is asked for it.
function isPage(data: unknown): boolean {
  if (!isRecord(data) || !Array.isArray(data['boxes'])) return false;
  const next = data['next'];
  return next === null || (typeof next === 'string' && next !== '' && isWellFormedText(next));
}

// Text with no lone surrogate, the one thing `encodeURIComponent` throws on.
// Iterating a string yields a surrogate pair as one code point and a lone
// surrogate singly, so a code point in U+D800–U+DFFF is a lone one.
function isWellFormedText(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && cp >= 0xd800 && cp <= 0xdfff) return false;
  }
  return true;
}

// NODE_INTERFACE → UTXO queries — /karma/:userId and /credits/:userId are paged
// by keyset, `after=<next>` on each following request until `next` is null.
// A 404 is an identity the node has never seen (empty listing); any other
// non-ok, or a malformed page, is a listing failure carrying the route.
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
    if (!isPage(firstKarma.data)) {
      return { ok: false, reason: `GET /karma/${user}: malformed page` };
    }
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
        return { ok: false, reason: `GET /karma/${user}?after=${capped(next)}: HTTP ${r.status}` };
      }
      if (!isPage(r.data)) {
        return { ok: false, reason: `GET /karma/${user}?after=${capped(next)}: malformed page` };
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
    if (!isPage(firstCredit.data)) {
      return { ok: false, reason: `GET /credits/${user}: malformed page` };
    }
    for (const b of firstCredit.data.boxes) creditsBoxes.push(b);
    let next: string | null = firstCredit.data.next;
    while (next !== null) {
      const r = await fetchJson<CreditPageResponse>(
        httpFetch,
        `${nodeUrl}/credits/${user}?after=${encodeURIComponent(next)}`,
      );
      if (!r.ok) {
        return { ok: false, reason: `GET /credits/${user}?after=${capped(next)}: HTTP ${r.status}` };
      }
      if (!isPage(r.data)) {
        return { ok: false, reason: `GET /credits/${user}?after=${capped(next)}: malformed page` };
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

type KeyProofOutcome =
  | { kind: 'included'; value: Uint8Array }
  | { kind: 'exclusion' }
  | { kind: 'unproven'; verdict: string }
  | { kind: 'no-proof'; verdict: string };

type BoxAtHeight =
  | { kind: 'included'; candidate: DecodedBoxCandidate }
  | { kind: 'exclusion' }
  | { kind: 'unproven'; verdict: string }
  | { kind: 'no-proof'; verdict: string };

type BoxProofOutcome =
  | { kind: 'proven'; value: bigint; lockedUntilBlock: number | null }
  | { kind: 'exclusion' }
  | { kind: 'unproven'; verdict: string }
  | { kind: 'no-proof'; verdict: string };

type FirstPassOutcome = BoxProofOutcome | { kind: 'malformed'; verdict: string };

type RecordProofOutcome =
  | { kind: 'proven'; record: IdentityRecord }
  | { kind: 'exclusion' }
  | { kind: 'unproven'; verdict: string }
  | { kind: 'no-proof'; verdict: string };

// NODE_INTERFACE → AVL+ State Root — one key, one height, one lookup proof,
// verified against the stateRoot the caller verified under proof-of-work. The
// answer's `kind` is the node's reading, trusted only to refuse; its `value` is
// never read — the value is the one the proof carries. An answer of another
// shape — a body that is not an object, a `stateRoot` that is not the header's,
// a `proof` that is not a string — is unproven (WEB_INTERFACE → The extension →
// "A run is total"). The tool's one AVL verification.
async function proveKeyAtHeight(
  nodeUrl: string,
  key: string,
  entity: 'box' | 'record',
  atHeight: number,
  expectedStateRoot: string,
  httpFetch: HttpFetch,
): Promise<KeyProofOutcome> {
  const proofRes = await fetchJson<unknown>(
    httpFetch,
    `${nodeUrl}/api/v1/proof/${key}?atHeight=${atHeight}`,
  );
  if (!proofRes.ok) {
    if (proofRes.status === 0) {
      return { kind: 'no-proof', verdict: `transport failure: ${capped(proofRes.body)}` };
    }
    return { kind: 'no-proof', verdict: `HTTP ${proofRes.status}: ${capped(proofRes.body)}` };
  }
  const resp = isRecord(proofRes.data) ? proofRes.data : {};
  if (resp['stateRoot'] !== expectedStateRoot) {
    return { kind: 'unproven', verdict: 'stateRoot mismatch' };
  }
  // NODE_INTERFACE → Entity kinds — the AVL value carries provenance
  const kind = resp['kind'];
  if (kind != null && kind !== entity) {
    return {
      kind: 'unproven',
      verdict: `node returned kind ${shown(kind)} for a ${entity === 'box' ? 'box id' : 'record key'}`,
    };
  }
  const proof = resp['proof'];
  if (typeof proof !== 'string') return { kind: 'unproven', verdict: 'proof rejected' };
  const proofBytes = base64ToBytes(proof);
  if (proofBytes === null) return { kind: 'unproven', verdict: 'proof rejected' };
  const avlResult = verifyAvlLookup(
    hexToBytes(expectedStateRoot),
    proofBytes,
    { keyLength: AVL_KEY_LENGTH, valueLengthOpt: null },
    hexToBytes(key),
  );
  if (avlResult === null) return { kind: 'unproven', verdict: 'proof rejected' };
  if (avlResult.value === null) return { kind: 'exclusion' };
  return { kind: 'included', value: avlResult.value };
}

// NODE_INTERFACE → Entity kinds — a box at one height: included, its value
// decoded and hashed back to the key it was proven under. What the box must
// further be — its type, its owner — is each caller's check on the candidate.
export async function proveBoxAtHeight(
  nodeUrl: string,
  boxId: string,
  atHeight: number,
  expectedStateRoot: string,
  httpFetch: HttpFetch,
): Promise<BoxAtHeight> {
  const outcome = await proveKeyAtHeight(nodeUrl, boxId, 'box', atHeight, expectedStateRoot, httpFetch);
  if (outcome.kind !== 'included') return outcome;
  let record;
  try {
    record = boxRecordFromBytes(outcome.value);
  } catch {
    return { kind: 'unproven', verdict: 'value decode failed' };
  }
  const derivedId = computeCandidateBoxId(record.candidate, record.txId, record.index);
  if (derivedId !== boxId) {
    return { kind: 'unproven', verdict: 'value does not hash to the key' };
  }
  return { kind: 'included', candidate: record.candidate };
}

// WEB_INTERFACE → The extension → "The verified figures" — a listed box is
// proven when it is included, its `boxType` is the ledger it was listed under,
// its `owner` is the loaded key, and its value — and a credit box's lock — are
// the listing's, both being fixed by the box id. `listed` has passed
// checkListedBox.
async function proveListedBoxAtHeight(
  nodeUrl: string,
  listed: ListedBox,
  boxClass: 'karma' | 'credit',
  userLowerHex: string,
  atHeight: number,
  expectedStateRoot: string,
  httpFetch: HttpFetch,
): Promise<BoxProofOutcome> {
  const at = await proveBoxAtHeight(nodeUrl, listed.boxId, atHeight, expectedStateRoot, httpFetch);
  if (at.kind !== 'included') return at;
  if (at.candidate.boxType !== boxClass) {
    return {
      kind: 'unproven',
      verdict: `candidate boxType '${at.candidate.boxType}' does not match listing '${boxClass}'`,
    };
  }
  // Both karma and credit carry `owner` (TYPES_INTERFACE → Layout — Boxes).
  const cand = at.candidate as { owner: Uint8Array; lockedUntilBlock?: number };
  const ownerHex = bytesToHex(cand.owner);
  if (ownerHex !== userLowerHex) {
    return {
      kind: 'unproven',
      verdict: `candidate owner '${ownerHex}' does not match user '${userLowerHex}'`,
    };
  }
  if (at.candidate.value !== BigInt(listed.value)) {
    return {
      kind: 'unproven',
      verdict: `candidate value ${at.candidate.value} does not match listing ${capped(listed.value)}`,
    };
  }
  const lockedUntilBlock =
    boxClass === 'credit'
      ? cand.lockedUntilBlock === undefined
        ? null
        : cand.lockedUntilBlock
      : null;
  const listedLock: unknown = listed.lockedUntilBlock ?? null;
  if (boxClass === 'credit' && listedLock !== lockedUntilBlock) {
    return {
      kind: 'unproven',
      verdict: `candidate lockedUntilBlock ${lockShown(lockedUntilBlock)} does not match listing ${lockShown(listedLock)}`,
    };
  }
  return { kind: 'proven', value: at.candidate.value, lockedUntilBlock };
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
  const outcome = await proveKeyAtHeight(nodeUrl, recordKey, 'record', atHeight, expectedStateRoot, httpFetch);
  if (outcome.kind !== 'included') return outcome;
  let record: IdentityRecord;
  try {
    record = identityRecordFromBytes(outcome.value);
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

  // Step 1 — every listed box at suffixHead; an entry that is not a listed box,
  // or names an id the listing named earlier, is unproven and asks for nothing.
  // `checked` keeps each entry's own (lowercased) form, indexed with `allBoxes`,
  // for step 3 and the assembly below to reuse without re-validating.
  const firstPass: FirstPassOutcome[] = [];
  const checked: (ListedBox | null)[] = [];
  const named = new Set<string>();
  for (const { listed, boxClass } of allBoxes) {
    const check = checkListedBox(listed, named);
    if (!check.ok) {
      checked.push(null);
      firstPass.push({ kind: 'malformed', verdict: check.verdict });
      continue;
    }
    checked.push(check.listed);
    firstPass.push(
      await proveListedBoxAtHeight(
        nodeUrl,
        check.listed,
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

  // Step 3 — every box the first pass excluded, once more at tip, each kept by
  // its place in the listing
  const secondPass = new Map<number, BoxProofOutcome>();
  for (let i = 0; i < allBoxes.length; i++) {
    if (firstPass[i]!.kind !== 'exclusion') continue;
    const { boxClass } = allBoxes[i]!;
    secondPass.set(
      i,
      await proveListedBoxAtHeight(
        nodeUrl,
        checked[i]!,
        boxClass,
        userLowerHex,
        tipHeight,
        tipStateRoot,
        httpFetch,
      ),
    );
  }

  // Step 4 — one GET /blocks/current
  const heightAfter = await readHeightAfter(nodeUrl, httpFetch);

  // Assemble the per-box verdicts
  const boxes: FigureBox[] = [];
  let failed = false;
  for (let i = 0; i < allBoxes.length; i++) {
    const { listed: rawListed, boxClass } = allBoxes[i]!;
    const first = firstPass[i]!;
    if (first.kind === 'malformed') {
      boxes.push(malformedFigureBox(rawListed, boxClass, first.verdict));
      failed = true;
      continue;
    }
    const listed = checked[i]!;
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
      const second = secondPass.get(i)!;
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
        // Excluded at both — decided by heightAfter.
        const decided = excludedAtBoth(heightAfter, tipHeight);
        if (decided.absent) {
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
          fb = {
            boxId: listed.boxId,
            boxClass,
            value: listingValue,
            lockedUntilBlock: listingLocked,
            status: 'unchecked',
            verdict: `unchecked — ${decided.why}`,
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
  // own height, so an unchanged state reproduces the number exactly. A height
  // that is not a block height values nothing and fails the run.
  const valuedAt: unknown = listing.karma.height;
  let effective: bigint | null;
  if (!isBlockHeight(valuedAt)) {
    effective = null;
    failed = true;
  } else if (record.status === 'proven') {
    effective = effectiveKarma(
      karmaSums.proven,
      record.record,
      valuedAt,
      decayCfgFor(profile),
    );
  } else if (record.status === 'absent') {
    effective = effectiveKarma(
      karmaSums.proven,
      null,
      valuedAt,
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

// NODE_INTERFACE → Blocks — `GET /blocks/current` answers `{ height, hash }`; no
// answer, or one whose `height` is not a block height, leaves `heightAfter`
// unread (WEB_INTERFACE → The extension → "A run is total").
export async function readHeightAfter(nodeUrl: string, httpFetch: HttpFetch): Promise<number | null> {
  const res = await fetchJson<unknown>(httpFetch, `${nodeUrl}/blocks/current`);
  if (!res.ok || !isRecord(res.data)) return null;
  const height = res.data['height'];
  return isBlockHeight(height) ? height : null;
}

// WEB_INTERFACE → The extension → "The verified figures" — a key excluded at
// both heights is `absent` when the node's height after the run is the anchor's
// tip; a block landed since, a fallen height or an unread one leaves it
// `unchecked` — undecided reads as unchecked, never as a lie.
export function excludedAtBoth(
  heightAfter: number | null,
  tipHeight: number,
): { absent: true } | { absent: false; why: string } {
  if (heightAfter === tipHeight) return { absent: true };
  const why =
    heightAfter === null
      ? '/blocks/current unavailable'
      : heightAfter > tipHeight
        ? `heightAfter ${heightAfter} > tip ${tipHeight} — a block landed since the anchor`
        : `heightAfter ${heightAfter} < tip ${tipHeight} — the node's height fell`;
  return { absent: false, why };
}

function isBlockHeight(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export const HEX_64 = /^[0-9a-f]{64}$/i;
const DECIMAL = /^[0-9]+$/;

type ListedBoxCheck = { ok: true; listed: ListedBox } | { ok: false; verdict: string };

// An entry is asked about only when it is an object whose `boxId` is 64 hex and
// named nowhere earlier in the listing, in either ledger, and whose `value` is
// a decimal string (WEB_INTERFACE → The extension → "A run is total";
// WEB_INTERFACE → The extension → "The verified figures");
// for any other, the reason it is not, named. `named` holds every 64-hex id the
// listing named before this entry, lowercased. A checked entry's own `boxId`
// comes back lowercased too — the AVL key `hexToBytes` decodes, and the id the
// proof endpoint is asked with, are the listing's id in the one case it holds
// in the tree, never the node's own spelling of it.
function checkListedBox(listed: unknown, named: Set<string>): ListedBoxCheck {
  if (!isRecord(listed)) return { ok: false, verdict: `the listed box is not an object: ${shown(listed)}` };
  const rawBoxId = listed['boxId'];
  if (typeof rawBoxId !== 'string' || !HEX_64.test(rawBoxId)) {
    return { ok: false, verdict: `the listed boxId is not 64 hex: ${shown(rawBoxId)}` };
  }
  const boxId = rawBoxId.toLowerCase();
  if (named.has(boxId)) {
    return { ok: false, verdict: `the listed boxId is named earlier in the listing: ${shown(rawBoxId)}` };
  }
  named.add(boxId);
  const value = listed['value'];
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    return { ok: false, verdict: `the listed value is not a decimal integer: ${shown(value)}` };
  }
  return { ok: true, listed: { ...listed, boxId, value } as ListedBox };
}

// A malformed entry keeps what reads — its `boxId` where it is a string, its
// `value` where it is a decimal string, else '' and 0n; an unproven box enters
// no sum.
function malformedFigureBox(
  listed: unknown,
  boxClass: 'karma' | 'credit',
  verdict: string,
): FigureBox {
  const entry = isRecord(listed) ? listed : {};
  const boxId = entry['boxId'];
  const value = entry['value'];
  return {
    boxId: typeof boxId === 'string' ? boxId : '',
    boxClass,
    value: typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : 0n,
    lockedUntilBlock: null,
    status: 'unproven',
    verdict: `unproven: ${verdict}`,
  };
}

// A node's value as a verdict names it: a string quoted and capped, anything
// else by its kind. Never converted — a parsed object can carry a `toString`
// that is not a function, and converting it throws.
export function shown(v: unknown): string {
  if (typeof v === 'string') return `'${capped(v)}'`;
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

// A lock as a verdict names it: a number as written, no lock as `none`.
function lockShown(v: unknown): string {
  if (v === null) return 'none';
  return typeof v === 'number' ? String(v) : shown(v);
}

// NODE_INTERFACE → AVL+ State Root — the proof blob is standard base64,
// decoded here with `atob`, a global in both browsers and Node 22. It throws
// on a character outside the alphabet or on a wrong length — caught here so a
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
