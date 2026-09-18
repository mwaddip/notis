// The status corner — a dot and the chain's height, fixed at the viewport's
// bottom-right, out of the reading path (WEB_INTERFACE → The status corner). The
// state is pure: a fresh dot on a rise inside the window, clay on a stationary
// answering node, muted on a failed read or none yet.

/** The corner reads the tip every thirty seconds while the tab is visible; the
 *  bounded landing poll is a separate timer (WEB_INTERFACE → The status corner,
 *  → The wallet). */
export const CORNER_POLL_MS = 30_000;

/** The window inside which a height rise says blocks are progressing; the ten
 *  minutes named on WEB_INTERFACE → The status corner. */
export const CORNER_STALE_MS = 600_000;

export type CornerState = 'fresh' | 'stale' | 'down' | 'none';

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
}

/** The dot's colour from what the client's own reads say
 *  (WEB_INTERFACE → The status corner). */
export function cornerState(input: CornerInput): CornerState {
  if (input.lastReadOk === null) return 'none';
  if (input.lastReadOk === false) return 'down';
  if (input.lastRiseAt !== null && input.now - input.lastRiseAt <= CORNER_STALE_MS) return 'fresh';
  return 'stale';
}

/** The state's words as the corner's `title` reads them
 *  (WEB_INTERFACE → The status corner). */
export function cornerTitle(state: CornerState, tip: number | null): string {
  if (state === 'fresh') return `blocks progressing · tip ${tip ?? '—'}`;
  if (state === 'stale') return `no new block for 10 minutes · tip ${tip ?? '—'}`;
  if (state === 'down') return tip === null ? 'the node did not answer' : `the node did not answer · last tip ${tip}`;
  return 'no tip yet';
}

/** The corner is a `<button>` holding the dot and the height, rendered in place
 *  after every read (WEB_INTERFACE → The status corner). The class on the dot
 *  carries the state, so the stylesheet gives each its colour; the height renders
 *  as a mono span (`HOUSE_STYLE → Typography`: a height is machine data). */
export function renderCorner(host: HTMLButtonElement, state: CornerState, tip: number | null): void {
  host.className = 'corner';
  host.textContent = '';
  const led = document.createElement('span');
  led.className = 'led ' + state;
  host.appendChild(led);
  const value = document.createElement('span');
  value.className = 'tip mono';
  value.textContent = tip === null ? '—' : String(tip);
  host.appendChild(value);
  host.setAttribute('aria-label', 'chain status');
  host.setAttribute('title', cornerTitle(state, tip));
}
