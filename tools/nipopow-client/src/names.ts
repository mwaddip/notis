import { bytesToHex, canonicalUsernameBytes, firstDifference, isValidUsernameBytes } from '@dagsocial/types';
import type { DecodedBoxCandidate } from '@dagsocial/types';
import type { Anchor } from './boxes.js';
import { HEX_64, excludedAtBoth, proveBoxAtHeight, readHeightAfter, shown } from './boxes.js';
import type { HttpFetch } from './http.js';
import { capped, fetchJson, isRecord } from './http.js';

/**
 * WEB_INTERFACE → The extension → "The verified names" — a label is a key and
 * the name a row carries beside it, as the row shows it; a typed handle is a
 * name alone, without its leading `@`.
 */
export type NameClaim =
  | { key: string; name: string }
  | { name: string };

export type NameStatus = 'proven' | 'young' | 'unchecked' | 'absent' | 'unproven' | 'no-proof' | 'none';

export interface NameResult {
  status: NameStatus;
  /** The proven box's owner, lowercase hex — under `proven` and `young` alone, else null. */
  owner: string | null;
  /** The proven box's name as typed — under `proven` and `young` alone, else null. */
  name: string | null;
  /** The box the lookup's answer named, lowercase — null with no answer, or one naming no 64-hex id. */
  boxId: string | null;
  /** `/blocks/current`'s height, read only when the box is excluded at both heights. */
  heightAfter: number | null;
  verdict: string;
}

/**
 * WEB_INTERFACE → The extension → "The verified names" — the check's order is
 * the rule: the lookup, read inside the check and so after the anchor; the box
 * its answer names at suffixHead, once more at tip when excluded there, and one
 * `GET /blocks/current` when excluded at both; then the checks on the proven
 * value. A claim or an answer of any shape ends in a status, never a throw
 * (WEB_INTERFACE → The extension → "A check is total"). A label whose key is
 * not 64 hex, or whose name is not a well-formed name, is unproven — no box can
 * carry it; a typed handle that is not a well-formed name is none — no one can
 * hold it; neither asks the node anything.
 */
export async function proveName(
  nodeUrl: string,
  claim: NameClaim,
  anchor: Anchor,
  httpFetch: HttpFetch,
): Promise<NameResult> {
  // TYPES_INTERFACE → Content limits — a name is well-formed by its UTF-8 bytes;
  // a name that is not a string encodes as nothing, which no name is
  const claimed: unknown = claim.name;
  const typed = new TextEncoder().encode(typeof claimed === 'string' ? claimed : '');
  const wellFormed = isValidUsernameBytes(typed);

  // The lookup — NODE_INTERFACE → Usernames
  let lookupUrl: string;
  if ('key' in claim) {
    const key: unknown = claim.key;
    if (typeof key !== 'string' || !HEX_64.test(key)) {
      return unanswered('unproven', `unproven: the label's key is not 64 hex: ${shown(key)}`);
    }
    if (!wellFormed) {
      return unanswered('unproven', `unproven: the label's name is not a well-formed name: ${shown(claimed)}`);
    }
    lookupUrl = `${nodeUrl}/usernames?owner=${key.toLowerCase()}`;
  } else {
    if (typeof claimed !== 'string' || !wellFormed) {
      return unanswered('none', `none — no one holds ${shown(claimed)}: it is not a well-formed name`);
    }
    lookupUrl = `${nodeUrl}/usernames/${encodeURIComponent(claimed)}`;
  }
  const lookup = await fetchJson<unknown>(httpFetch, lookupUrl);
  if (!lookup.ok) {
    if (lookup.status === 404) {
      return unanswered('none', 'key' in claim
        ? 'none — the node answers that this key holds no name'
        : `none — the node answers that no one holds ${shown(claimed)}`);
    }
    return unanswered('no-proof', lookup.status === 0
      ? `no answer to the lookup: transport failure: ${capped(lookup.body)}`
      : `no answer to the lookup: HTTP ${lookup.status}: ${capped(lookup.body)}`);
  }
  const answer = isRecord(lookup.data) ? lookup.data : {};
  const answeredBoxId = answer['boxId'];
  if (typeof answeredBoxId !== 'string' || !HEX_64.test(answeredBoxId)) {
    return unanswered('unproven', `unproven: the lookup's boxId is not 64 hex: ${shown(answeredBoxId)}`);
  }
  const boxId = answeredBoxId.toLowerCase();
  const pointed = (status: NameStatus, verdict: string, heightAfter: number | null = null): NameResult =>
    ({ status, owner: null, name: null, boxId, heightAfter, verdict });

  // The box at suffixHead, and at tip when excluded there
  const suffixHeight = anchor.suffixHead.header.height;
  const tipHeight = anchor.tip.height;
  const atSuffix = await proveBoxAtHeight(nodeUrl, boxId, suffixHeight, anchor.suffixHead.header.stateRoot, httpFetch);
  if (atSuffix.kind === 'unproven') return pointed('unproven', `unproven at suffixHead: ${atSuffix.verdict}`);
  if (atSuffix.kind === 'no-proof') return pointed('no-proof', `no proof at suffixHead: ${atSuffix.verdict}`);
  if (atSuffix.kind === 'included') {
    const checked = checkName(atSuffix.candidate, claim, typed, answer['owner']);
    if (!checked.ok) return pointed('unproven', `unproven at suffixHead: ${checked.refusal}`);
    return {
      status: 'proven', owner: checked.owner, name: checked.name, boxId, heightAfter: null,
      verdict: `proven at suffixHead (height ${suffixHeight})`,
    };
  }
  const atTip = await proveBoxAtHeight(nodeUrl, boxId, tipHeight, anchor.tip.stateRoot, httpFetch);
  if (atTip.kind === 'unproven') return pointed('unproven', `unproven at tip: ${atTip.verdict}`);
  if (atTip.kind === 'no-proof') return pointed('no-proof', `no proof at tip: ${atTip.verdict}`);
  if (atTip.kind === 'included') {
    const checked = checkName(atTip.candidate, claim, typed, answer['owner']);
    if (!checked.ok) return pointed('unproven', `unproven at tip: ${checked.refusal}`);
    return {
      status: 'young', owner: checked.owner, name: checked.name, boxId, heightAfter: null,
      verdict: `young — proven at tip (height ${tipHeight}), excluded at suffixHead`,
    };
  }

  // Excluded at both — one GET /blocks/current decides
  const heightAfter = await readHeightAfter(nodeUrl, httpFetch);
  const decided = excludedAtBoth(heightAfter, tipHeight);
  if (decided.absent) {
    return pointed(
      'absent',
      `absent — the node points at a box the chain does not hold at height ${tipHeight}`,
      heightAfter,
    );
  }
  return pointed('unchecked', `unchecked — ${decided.why}`, heightAfter);
}

type Checked = { ok: true; owner: string; name: string } | { ok: false; refusal: string };

// WEB_INTERFACE → The extension → "The verified names" — the proven value is a
// username box; for a label, its owner the label's key and its name the
// label's name byte for byte, the name being shown as typed; for a typed
// handle, its name's canonical form the typed name's and its owner the
// lookup's `owner` — the key a send goes to is the one the chain holds. The
// lookup's own `name` is never read: the result carries the proven one.
function checkName(
  candidate: DecodedBoxCandidate,
  claim: NameClaim,
  typed: Uint8Array,
  answeredOwner: unknown,
): Checked {
  if (candidate.boxType !== 'username') {
    return { ok: false, refusal: `candidate boxType '${candidate.boxType}' is not username` };
  }
  const owner = bytesToHex(candidate.owner);
  // TYPES_INTERFACE → Content limits — the codec bounds a name's length and
  // checks none of its bytes; the alphabet is consensus's check, which this
  // tool does not run on a proven box, so a refusal names it through `capped`.
  const name = new TextDecoder().decode(candidate.name);
  if ('key' in claim) {
    const key = claim.key.toLowerCase();
    if (owner !== key) {
      return { ok: false, refusal: `candidate owner '${owner}' does not match the label's key '${key}'` };
    }
    if (firstDifference(candidate.name, typed) !== -1) {
      return { ok: false, refusal: `candidate name '${capped(name)}' does not match the label's name '${claim.name}'` };
    }
    return { ok: true, owner, name };
  }
  if (firstDifference(canonicalUsernameBytes(candidate.name), canonicalUsernameBytes(typed)) !== -1) {
    return { ok: false, refusal: `candidate name '${capped(name)}' is not the typed name '${claim.name}'` };
  }
  const expected = typeof answeredOwner === 'string' ? answeredOwner.toLowerCase() : null;
  if (owner !== expected) {
    return {
      ok: false,
      refusal: `candidate owner '${owner}' does not match the lookup's owner ${shown(answeredOwner)}`,
    };
  }
  return { ok: true, owner, name };
}

function unanswered(status: NameStatus, verdict: string): NameResult {
  return { status, owner: null, name: null, boxId: null, heightAfter: null, verdict };
}
