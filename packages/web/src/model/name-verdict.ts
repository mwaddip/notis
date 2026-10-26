// The clay handle and the send's answer — pure verdicts over the tool's
// NameResult (WEB_INTERFACE → The extension → "The verified names"). A handle
// reads as it reads without a verifier while no check has decided it, and under
// `proven`, `young` and `unchecked`; under `absent`, `unproven`, `no-proof` and
// `none` it is clay (→ The identity display, → The author window). A send to a
// handle goes to the key the proven box names at `suffixHead`, `k` deep, or
// refuses in the row — a send under `young` is refused, since the tip's
// `stateRoot` stands beneath its own header alone (NIPOPOW_INTERFACE → The
// trust model, rule 4).
//
// Their shape is `tipVerdict`'s: pure, total by itself, no exception thrown.

import type { NameResult, NameStatus } from '@dagsocial/nipopow-client';
import { isHex64 } from '@dagsocial/types';

// The table decides every NameStatus — its type holds the union whole — and a
// status outside it at run time reads as no check.
const CLAY: Readonly<Record<NameStatus, boolean>> = {
  proven: false,
  young: false,
  unchecked: false,
  absent: true,
  unproven: true,
  'no-proof': true,
  none: true,
};

// `@` is the written form of a name, never part of one (ARCHITECTURE →
// Usernames), and no hex digit — so neither a key nor a well-formed name holds
// it (TYPES_INTERFACE → Content limits).
const PAIR_SEPARATOR = '@';

/** The key a check's result is held under — a label is a key and the name a row
 *  carries beside it (WEB_INTERFACE → The extension → "The verified names").
 *  The key lowercased: one key whatever the case of its hex. The name as the row
 *  shows it: a label's name is compared byte for byte, so `Bob` and `bob` are
 *  two pairs. */
export function namePair(key: string, name: string): string {
  return key.toLowerCase() + PAIR_SEPARATOR + name;
}

/** True when the handle reads clay under the check held for its pair —
 *  `undefined` when no check has decided it. */
export function nameIsClay(result: NameResult | undefined): boolean {
  if (result === undefined) return false;
  return CLAY[result.status] === true;
}

/** The send row's answer to a typed handle's check (WEB_INTERFACE → The wallet
 *  window → "The `send` row"): under `proven` the proven box's owner and its
 *  name as committed, under `young` the refusal `send to a key instead` — the
 *  tip's `stateRoot` binds the name under one block of work alone
 *  (NIPOPOW_INTERFACE → The trust model, rule 4) — and under every other
 *  status the row's refusal, an `unchecked` here being the check the press made
 *  after its one tip run. `handle` is `@` and the name as the reader typed it.
 *  A proven result with no key and name to send to, or a status outside the
 *  table, refuses as an answer that did not verify — decided here, never on
 *  what the tool is known to fill. */
export function recipientVerdict(
  result: NameResult,
  handle: string,
): { key: string; name: string } | { refusal: string } {
  switch (result.status) {
    case 'proven':
      if (isHex64(result.owner) && typeof result.name === 'string') {
        return { key: result.owner, name: result.name };
      }
      break;
    case 'young':
      return { refusal: `${handle} is too new to send to by name — send to a key instead.` };
    case 'none':
      return { refusal: 'no one holds that name.' };
    case 'unchecked':
      return { refusal: `${handle} is too new to check yet.` };
    case 'no-proof':
      return { refusal: `the node served no proof for ${handle}.` };
  }
  return { refusal: `this node's answer for ${handle} did not verify.` };
}
