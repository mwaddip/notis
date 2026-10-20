// WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from
// its own fields" — one total reader per route. Each takes an `unknown` body
// a node answered under its route's cap and either rebuilds a fresh DTO of
// the fields the web names, each held to its type, or answers `null` where
// the body is not the route's answer. `null` becomes `PageError` where the
// client throws, never a thrown exception out of a reader. A field the DTO
// does not name is not carried.

import {
  isHex64Lower, isNonNegSafeInt, isNonNegSafeIntOrNull, isBoxValue, isSum,
  isAuthorName, isRecord, parsePage,
} from '@dagsocial/node-reads';
import type {
  StatusResult, BlockCurrent, KarmaResult, KarmaBoxRow, CreditsResult,
  CreditBoxRow, VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult,
  BondsResult, UsernameResult, PostResult, FeedResult, FeedRow, ThreadResult,
  PostJson, WithdrawnJson, LightJson,
} from './dto';
import { readBoundRow, readWithdrawnRow } from './post-row';
import { readLightRow } from './light-page';

// A whole-byte lowercase hex string.
const HEX_WHOLE_BYTES = /^(?:[0-9a-f]{2})*$/;

// ---------------------------------------------------------------------------
// Non-paged readers
// ---------------------------------------------------------------------------

/** WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from
 *  its own fields" — a `/status` answer rebuilt as a `StatusResult`. */
export function readStatus(data: unknown): StatusResult | null {
  if (!isRecord(data)) return null;
  const {
    networkType, blockHeight, protocolVersion, postCount, pendingPosts,
    totalKarma, liquidKarma, totalCredits, inviteProbationBlocks,
    vouchCooldownBlocks, inviteBondMin, inviteBondMax, membership,
  } = data;
  if (typeof networkType !== 'string') return null;
  if (!isNonNegSafeInt(blockHeight)) return null;
  if (!isNonNegSafeInt(protocolVersion)) return null;
  if (!isNonNegSafeInt(postCount)) return null;
  if (!isNonNegSafeInt(pendingPosts)) return null;
  if (!isSum(totalKarma)) return null;
  if (!isSum(liquidKarma)) return null;
  if (!isSum(totalCredits)) return null;
  if (!isNonNegSafeInt(inviteProbationBlocks)) return null;
  if (!isNonNegSafeInt(vouchCooldownBlocks)) return null;
  // The bond bounds are box values (`CONSTANTS → Client reads`,
  // `STATUS_READ_BYTES` argument; `TYPES_INTERFACE → Box value domain`).
  if (!isBoxValue(inviteBondMin)) return null;
  if (!isBoxValue(inviteBondMax)) return null;
  if (!isRecord(membership)) return null;
  const { memberCount, memberBar, memberLikesBar } = membership;
  if (!isNonNegSafeInt(memberCount)) return null;
  if (!isNonNegSafeInt(memberBar)) return null;
  if (!isNonNegSafeInt(memberLikesBar)) return null;
  return {
    networkType, blockHeight, protocolVersion, postCount, pendingPosts,
    totalKarma, liquidKarma, totalCredits, inviteProbationBlocks,
    vouchCooldownBlocks, inviteBondMin, inviteBondMax,
    membership: { memberCount, memberBar, memberLikesBar },
  };
}

/** `/blocks/current` — a block height and its hash (or null for the genesis
 *  marker). */
export function readBlockCurrent(data: unknown): BlockCurrent | null {
  if (!isRecord(data)) return null;
  const { height, hash } = data;
  if (!isNonNegSafeInt(height)) return null;
  if (hash !== null && !isHex64Lower(hash)) return null;
  return { height, hash };
}

/** `/usernames?owner=:key` and `/usernames/:name` answer the same shape — a
 *  held name and the box that holds it. The `name` is a well-formed one
 *  (`TYPES_INTERFACE → Content limits`), never `null` on this route. */
export function readUsername(data: unknown): UsernameResult | null {
  if (!isRecord(data)) return null;
  const { name, owner, boxId, claimedAtBlock } = data;
  if (name === null || !isAuthorName(name)) return null;
  if (!isHex64Lower(owner)) return null;
  if (!isHex64Lower(boxId)) return null;
  if (!isNonNegSafeInt(claimedAtBlock)) return null;
  return { name, owner, boxId, claimedAtBlock };
}

// ---------------------------------------------------------------------------
// Row readers for each paged list
// ---------------------------------------------------------------------------

function readKarmaBox(raw: unknown): KarmaBoxRow | null {
  if (!isRecord(raw)) return null;
  const { boxId, value, income } = raw;
  if (!isHex64Lower(boxId)) return null;
  if (!isBoxValue(value)) return null;
  // The mark's domain is `true` or absent (TYPES_INTERFACE → KarmaBox); any
  // other value — `false`, a number, a string, `null` — is a refused answer,
  // not an unmarked box (WEB_INTERFACE → Reading a node's answer → "Every
  // answer is rebuilt from its own fields").
  if (income === undefined) return { boxId, value };
  if (income === true) return { boxId, value, income: true };
  return null;
}

function readCreditBox(raw: unknown): CreditBoxRow | null {
  if (!isRecord(raw)) return null;
  const { boxId, value, lockedUntilBlock } = raw;
  if (!isHex64Lower(boxId)) return null;
  if (!isBoxValue(value)) return null;
  if (lockedUntilBlock === undefined) return { boxId, value };
  if (!isNonNegSafeInt(lockedUntilBlock)) return null;
  return { boxId, value, lockedUntilBlock };
}

function readVouchByTarget(raw: unknown): VouchesTargetResult['vouches'][number] | null {
  if (!isRecord(raw)) return null;
  const { voucherId, targetId, voucherName, targetName } = raw;
  if (!isHex64Lower(voucherId)) return null;
  if (!isHex64Lower(targetId)) return null;
  if (!isAuthorName(voucherName)) return null;
  if (!isAuthorName(targetName)) return null;
  return { voucherId, targetId, voucherName, targetName };
}

function readVouchByVoucher(raw: unknown): VouchesVoucherResult['vouches'][number] | null {
  if (!isRecord(raw)) return null;
  const { boxId, value, createdAtBlock, voucherId, targetId, voucherName, targetName } = raw;
  if (!isHex64Lower(boxId)) return null;
  if (!isBoxValue(value)) return null;
  if (!isNonNegSafeInt(createdAtBlock)) return null;
  if (!isHex64Lower(voucherId)) return null;
  if (!isHex64Lower(targetId)) return null;
  if (!isAuthorName(voucherName)) return null;
  if (!isAuthorName(targetName)) return null;
  return { boxId, value, createdAtBlock, voucherId, targetId, voucherName, targetName };
}

function readVouchCooldown(raw: unknown): VouchCooldownsResult['cooldowns'][number] | null {
  if (!isRecord(raw)) return null;
  const { boxId, value, releaseAtBlock } = raw;
  if (!isHex64Lower(boxId)) return null;
  if (!isBoxValue(value)) return null;
  if (!isNonNegSafeInt(releaseAtBlock)) return null;
  return { boxId, value, releaseAtBlock };
}

function readBondRow(raw: unknown): BondsResult['bonds'][number] | null {
  if (!isRecord(raw)) return null;
  const { id, value, inviterId, inviteePublicKey, inviterName, inviteeName } = raw;
  if (!isHex64Lower(id)) return null;
  if (!isBoxValue(value)) return null;
  if (!isHex64Lower(inviterId)) return null;
  if (!isHex64Lower(inviteePublicKey)) return null;
  if (!isAuthorName(inviterName)) return null;
  if (!isAuthorName(inviteeName)) return null;
  return { id, value, inviterId, inviteePublicKey, inviterName, inviteeName };
}

// ---------------------------------------------------------------------------
// Paged readers — each applies parsePage to the main list, then rebuilds the
// rest from the body's own fields.
// ---------------------------------------------------------------------------

function mapRows<Row>(rows: unknown[], read: (r: unknown) => Row | null): Row[] | null {
  const out: Row[] = [];
  for (const r of rows) {
    const row = read(r);
    if (row === null) return null;
    out.push(row);
  }
  return out;
}

export function readKarmaResult(data: unknown, limit: number): KarmaResult | null {
  const page = parsePage<unknown>(data, 'boxes', limit);
  if (!page.ok) return null;
  if (!isRecord(data)) return null;
  const boxes = mapRows(page.rows, readKarmaBox);
  if (boxes === null) return null;
  const {
    userId, total, effective, boxCount, lastActivityBlock, lastDecayBlock,
    lifetimeLikesReceived, memberSinceBlock, memberBar, memberVouches,
    memberLikes, invitesUsed, member, invitesAvailable, height,
  } = data;
  if (!isHex64Lower(userId)) return null;
  if (!isSum(total)) return null;
  if (!isSum(effective)) return null;
  if (!isNonNegSafeInt(boxCount)) return null;
  if (!isNonNegSafeInt(lastActivityBlock)) return null;
  if (!isNonNegSafeInt(lastDecayBlock)) return null;
  if (!isSum(lifetimeLikesReceived)) return null;
  if (!isNonNegSafeInt(memberSinceBlock)) return null;
  if (!isNonNegSafeInt(memberBar)) return null;
  if (!isNonNegSafeInt(memberVouches)) return null;
  if (!isSum(memberLikes)) return null;
  if (!isNonNegSafeInt(invitesUsed)) return null;
  if (typeof member !== 'boolean') return null;
  if (!isNonNegSafeIntOrNull(invitesAvailable)) return null;
  if (!isNonNegSafeInt(height)) return null;
  return {
    userId, total, effective, boxes, boxCount, next: page.next,
    lastActivityBlock, lastDecayBlock, lifetimeLikesReceived,
    memberSinceBlock, memberBar, memberVouches, memberLikes, invitesUsed,
    member, invitesAvailable, height,
  };
}

export function readCreditsResult(data: unknown, limit: number): CreditsResult | null {
  const page = parsePage<unknown>(data, 'boxes', limit);
  if (!page.ok) return null;
  if (!isRecord(data)) return null;
  const boxes = mapRows(page.rows, readCreditBox);
  if (boxes === null) return null;
  const { userId, total, boxCount } = data;
  if (!isHex64Lower(userId)) return null;
  if (!isSum(total)) return null;
  if (!isNonNegSafeInt(boxCount)) return null;
  return { userId, total, boxes, boxCount, next: page.next };
}

export function readVouchesByTargetResult(data: unknown, limit: number): VouchesTargetResult | null {
  const page = parsePage<unknown>(data, 'vouches', limit);
  if (!page.ok) return null;
  if (!isRecord(data)) return null;
  const vouches = mapRows(page.rows, readVouchByTarget);
  if (vouches === null) return null;
  const { count } = data;
  if (!isNonNegSafeInt(count)) return null;
  return { vouches, count, next: page.next };
}

export function readVouchesByVoucherResult(data: unknown, limit: number): VouchesVoucherResult | null {
  const page = parsePage<unknown>(data, 'vouches', limit);
  if (!page.ok) return null;
  if (!isRecord(data)) return null;
  const vouches = mapRows(page.rows, readVouchByVoucher);
  if (vouches === null) return null;
  const { count } = data;
  if (!isNonNegSafeInt(count)) return null;
  return { vouches, count, next: page.next };
}

export function readVouchCooldownsResult(data: unknown, limit: number): VouchCooldownsResult | null {
  const page = parsePage<unknown>(data, 'cooldowns', limit);
  if (!page.ok) return null;
  if (!isRecord(data)) return null;
  const cooldowns = mapRows(page.rows, readVouchCooldown);
  if (cooldowns === null) return null;
  const { count } = data;
  if (!isNonNegSafeInt(count)) return null;
  return { cooldowns, count, next: page.next };
}

export function readBondsResult(data: unknown, limit: number): BondsResult | null {
  const page = parsePage<unknown>(data, 'bonds', limit);
  if (!page.ok) return null;
  if (!isRecord(data)) return null;
  const bonds = mapRows(page.rows, readBondRow);
  if (bonds === null) return null;
  const { bondCount } = data;
  if (!isNonNegSafeInt(bondCount)) return null;
  return { bonds, bondCount, next: page.next };
}

// ---------------------------------------------------------------------------
// Post reads — the single post, the feed and the thread.
// ---------------------------------------------------------------------------

/** A `/posts/:id` answer: a `bound` or `withdrawn` row, plus `confirmedAuthor`
 *  (null or 64 lowercase hex) and under `tx=1` the whole transaction's bytes
 *  (null or lowercase hex of whole bytes). */
export function readPostResult(data: unknown, withTx: boolean): PostResult | null {
  if (!isRecord(data)) return null;
  const confirmedAuthor = data['confirmedAuthor'];
  if (confirmedAuthor !== null && !isHex64Lower(confirmedAuthor)) return null;
  const kind = data['kind'];
  let row: PostJson | WithdrawnJson | null;
  if (kind === 'withdrawn') row = readWithdrawnRow(data);
  else if (kind === undefined) row = readBoundRow(data);
  else return null;
  if (row === null) return null;
  if (withTx) {
    const tx = data['tx'];
    if (tx !== null && !(typeof tx === 'string' && HEX_WHOLE_BYTES.test(tx))) return null;
    return { ...row, confirmedAuthor, tx } as PostResult;
  }
  return { ...row, confirmedAuthor } as PostResult;
}

/** A full feed row — `PostJson` or `WithdrawnJson`, as `readBoundRow` and
 *  `readWithdrawnRow` state the field rules (WEB_INTERFACE → Reading a
 *  node's answer → "A post row of a full list, and the single post read,
 *  take the checked row's field rules"). */
function readFullRow(raw: unknown): PostJson | WithdrawnJson | null {
  if (!isRecord(raw)) return null;
  if (raw['kind'] === 'withdrawn') return readWithdrawnRow(raw);
  return readBoundRow(raw);
}

/** A light row — `LightJson` or `WithdrawnJson`, as `light-page.ts` states.
 *  `readLightRow` throws `PageError`; wrap into a null-answering reader. */
function readLightOrNull(raw: unknown): LightJson | WithdrawnJson | null {
  try {
    return readLightRow(raw);
  } catch {
    return null;
  }
}

/** The feed and the author list — `GET /posts`. `posts` is a page under the
 *  limit asked; `pending` is a list at most the limit asked (no `next` of
 *  its own). */
export function readFeedResult(data: unknown, limit: number, light: boolean): FeedResult | null {
  const page = parsePage<unknown>(data, 'posts', limit);
  if (!page.ok) return null;
  if (!isRecord(data)) return null;
  const { pending, pendingCount } = data;
  if (!Array.isArray(pending)) return null;
  if (pending.length > limit) return null;
  if (!isNonNegSafeInt(pendingCount)) return null;
  const read: (r: unknown) => FeedRow | null = light ? readLightOrNull : readFullRow;
  const posts = mapRows(page.rows, read);
  if (posts === null) return null;
  const pendingOut = mapRows(pending, read);
  if (pendingOut === null) return null;
  return { posts, next: page.next, pending: pendingOut, pendingCount };
}

/** A thread — `GET /posts/:id/thread`. `descendants` is the paged list;
 *  `ancestors` and `pending` are lists at most the limit asked. */
export function readThreadResult(data: unknown, limit: number, light: boolean): ThreadResult | null {
  const page = parsePage<unknown>(data, 'descendants', limit);
  if (!page.ok) return null;
  if (!isRecord(data)) return null;
  const { post, ancestors, ancestorCount, descendantCount, pending, pendingCount } = data;
  if (!Array.isArray(ancestors)) return null;
  if (ancestors.length > limit) return null;
  if (!isNonNegSafeInt(ancestorCount)) return null;
  if (!isNonNegSafeInt(descendantCount)) return null;
  if (!Array.isArray(pending)) return null;
  if (pending.length > limit) return null;
  if (!isNonNegSafeInt(pendingCount)) return null;
  const read: (r: unknown) => FeedRow | null = light ? readLightOrNull : readFullRow;
  let subject: FeedRow | null;
  if (post === null) subject = null;
  else {
    subject = read(post);
    if (subject === null) return null;
  }
  const descendants = mapRows(page.rows, read);
  if (descendants === null) return null;
  const ancestorsOut = mapRows(ancestors, read);
  if (ancestorsOut === null) return null;
  const pendingOut = mapRows(pending, read);
  if (pendingOut === null) return null;
  return {
    post: subject,
    ancestors: ancestorsOut,
    ancestorCount,
    descendants,
    descendantCount,
    next: page.next,
    pending: pendingOut,
    pendingCount,
  };
}
