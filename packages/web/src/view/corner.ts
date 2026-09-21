// The status corner — a dot and the chain's height, fixed at the viewport's
// bottom-right, out of the reading path (WEB_INTERFACE → The status corner). The
// state is pure: a fresh dot on a rise inside the window, clay on a stationary
// answering node, muted on a failed read or none yet; where the build carries a
// verifier, the verdict folds in beside the read — a refused verdict outranks
// everything but a failed read, then the checking, thin and stale/fresh cases
// follow the contract's order.

import type { TipVerdict } from '../model/tip-verdict';

/** The corner reads the tip every thirty seconds while the tab is visible; the
 *  bounded landing poll is a separate timer (WEB_INTERFACE → The status corner,
 *  → The wallet). */
export const CORNER_POLL_MS = 30_000;

/** The window inside which a height rise says blocks are progressing; the ten
 *  minutes named on WEB_INTERFACE → The status corner. */
export const CORNER_STALE_MS = 600_000;

export type CornerState = 'fresh' | 'stale' | 'down' | 'none' | 'checking' | 'thin' | 'refused';

export interface CornerInput {
  /** The tip the client last read; null before the first answer. */
  lastTip: number | null;
  /** When the tip last rose; null while it has not moved since the first read. */
  lastRiseAt: number | null;
  /** Whether the last read answered — false on a failure, true on an answer,
   *  null before the first read. */
  lastReadOk: boolean | null;
  /** The clock the state is judged against. */
  now: number;
  /** The verifier's last verdict — `undefined` is a build with no verifier and
   *  reads by the first paragraph of the status corner, word for word; `null`
   *  is a verifier whose first verdict has not returned; a verdict folds in
   *  beside the read (WEB_INTERFACE → The status corner). */
  verdict?: TipVerdict | null;
}

/** The dot's colour from the client's own reads and, where a verifier is handed
 *  in, the verdict beside them (WEB_INTERFACE → The status corner, → The
 *  extension → "The verified tip"). */
export function cornerState(input: CornerInput): CornerState {
  // No read has run — the corner has nothing yet.
  if (input.lastReadOk === null) return 'none';
  // The last read failed — outranks the verdict.
  if (input.lastReadOk === false) return 'down';
  // A build with no verifier follows the first paragraph of the status corner:
  // the four states, no verdict.
  if (input.verdict === undefined) {
    if (input.lastRiseAt !== null && input.now - input.lastRiseAt <= CORNER_STALE_MS) return 'fresh';
    return 'stale';
  }
  // A refused verdict outranks the rest — the full rule.
  if (input.verdict !== null && input.verdict.kind === 'refused') return 'refused';
  // The first verdict has not returned — the checking case.
  if (input.verdict === null) return 'checking';
  // A thin verdict — the heads-up.
  if (input.verdict.kind === 'thin') return 'thin';
  // A verified verdict, freshness by the rise from the first paragraph of the
  // status corner.
  if (input.lastRiseAt !== null && input.now - input.lastRiseAt <= CORNER_STALE_MS) return 'fresh';
  return 'stale';
}

/** The state's words as the corner's `title` reads them
 *  (WEB_INTERFACE → The status corner). Where the state names a verdict — thin,
 *  refused, or a verified verdict as `fresh` — the verdict carries its own
 *  wording, in the house voice (HOUSE_STYLE → Voice). A node named by its
 *  host, never by a URL; an unparsable `by` reads *another node*. */
export function cornerTitle(state: CornerState, tip: number | null, verdict?: TipVerdict | null): string {
  const t = tip ?? '—';
  if (state === 'fresh') {
    if (verdict && verdict.kind === 'verified') return `verified across ${verdict.nodes} nodes · tip ${t}`;
    return `blocks progressing · tip ${t}`;
  }
  if (state === 'stale') return `no new block for 10 minutes · tip ${t}`;
  if (state === 'down') return tip === null ? 'the node did not answer' : `the node did not answer · last tip ${tip}`;
  if (state === 'none') return 'no tip yet';
  if (state === 'checking') return `checking the chain · tip ${t}`;
  if (state === 'thin') {
    if (verdict && verdict.kind === 'thin') {
      if (verdict.reason === 'one-node') return `only one node could be checked · tip ${t}`;
      if (verdict.reason === 'too-short') return `the chain is too short to check yet · tip ${t}`;
      if (verdict.reason === 'no-proof') return `this node served no proof · tip ${t}`;
      if (verdict.reason === 'split') return `the nodes share no block to compare · tip ${t}`;
    }
    return `the chain could not be checked · tip ${t}`;
  }
  // state === 'refused'
  if (verdict && verdict.kind === 'refused') {
    if (verdict.reason === 'invalid-proof') return `this node's proof did not verify · tip ${t}`;
    if (verdict.reason === 'outworked') {
      const host = hostOf(verdict.by);
      return host === null
        ? `another node holds more work than this node · tip ${t}`
        : `${host} holds more work than this node · tip ${t}`;
    }
  }
  return `this node's proof did not verify · tip ${t}`;
}

function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The corner is a `<button>` holding the dot and the height, rendered in place
 *  after every read (WEB_INTERFACE → The status corner). The class on the dot
 *  carries the state, so the stylesheet gives each its colour; the height renders
 *  as a mono span (`HOUSE_STYLE → Typography`: a height is machine data). The
 *  height's weight rides the `.tip` span itself — a `clay` class fires only for
 *  a refused verdict, so the stylesheet's rule stays scoped to the affected
 *  element (`HOUSE_STYLE → Gold and clay are not interchangeable`). */
export function renderCorner(
  host: HTMLButtonElement,
  state: CornerState,
  tip: number | null,
  verdict?: TipVerdict | null,
): void {
  host.className = 'corner';
  host.textContent = '';
  const led = document.createElement('span');
  led.className = 'led ' + state;
  host.appendChild(led);
  const value = document.createElement('span');
  value.className = state === 'refused' ? 'tip mono clay' : 'tip mono';
  value.textContent = tip === null ? '—' : String(tip);
  host.appendChild(value);
  host.setAttribute('aria-label', 'chain status');
  host.setAttribute('title', cornerTitle(state, tip, verdict));
}
