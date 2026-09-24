// The clay handle — a pure verdict over the tool's NameResult
// (WEB_INTERFACE → The extension → "The verified names"). A handle reads as it
// reads without a verifier while no check has decided it, and under `proven`,
// `young` and `unchecked`; under `absent`, `unproven`, `no-proof` and `none` it
// is clay (→ The identity display, → The author window).
//
// Its shape is `tipVerdict`'s: pure, total by itself, no exception thrown.

import type { NameResult, NameStatus } from '@dagsocial/nipopow-client';

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
