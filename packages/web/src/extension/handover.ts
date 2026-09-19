import type { Tabs } from '../tabs';
import { K_OPEN_PREFIX } from './links';

// The page's half of the extension handover — WEB_INTERFACE → The extension → "Links into the extension".
// The holder of the workspace lock asks the background for waiting threads at two moments: when
// `claim()` resolves (this tab has just become the holder), and when `storage.onChanged` reports a
// `notis.open.` key appearing in `storage.session` while it holds. The background reads and removes
// every pending record in one step and answers their ids, which reach every registered `onOpen`
// listener in order (WEB_INTERFACE → The extension → "Both messages end in one act, landing the thread in the workspace").

const HEX64_LOWER = /^[0-9a-f]{64}$/;

/** Wrap a `Tabs` with the extension-side handover. `holds`, `heldElsewhere`, `announce` delegate
 *  untouched; `onOpen(cb)` registers `cb` with the inner tabs — for a channel delivery — and keeps
 *  it in the wrapper's own list — for waiting threads — so an id reaches a listener once, not
 *  twice. The wrapper carries the ask semantics: one in flight at a time, no retry loop, no timer,
 *  no swallowed error. */
export function wrapTabs(inner: Tabs, api: typeof chrome): Tabs {
  const listeners: Array<(id: string) => void> = [];
  let inFlight = false;
  let requeue = false;

  const deliver = (raw: unknown): void => {
    if (!Array.isArray(raw)) return;
    for (const v of raw) {
      if (typeof v !== 'string') continue;
      if (!HEX64_LOWER.test(v)) continue;
      for (const cb of listeners) cb(v);
    }
  };

  // The ask is `{ kind: 'takeOpen' }` — the background reads and removes every pending record in
  // one step and answers `{ ids }` (WEB_INTERFACE → The extension → "Both messages end in one act, landing the thread in the workspace").
  // A refused or failed ask is caught here and the records stand — no retry loop; the next
  // appearing record or the next `claim()` is the next ask. The flight's cleanup — `inFlight`
  // and the one follow-up — runs before delivery, so a throwing listener neither wedges the
  // flight nor loses the follow-up; a listener's exception is not the wrapper's to catch and
  // propagates as an unhandled rejection.
  const ask = (): void => {
    if (inFlight) { requeue = true; return; }
    inFlight = true;
    api.runtime.sendMessage({ kind: 'takeOpen' }).catch(() => null).then((answer) => {
      inFlight = false;
      const follow = requeue;
      requeue = false;
      if (follow && inner.holds()) ask();
      if (answer !== null && typeof answer === 'object' && 'ids' in answer) {
        deliver((answer as { ids: unknown }).ids);
      }
    });
  };

  // On becoming the holder, ask only when a record stands — a boot with nothing waiting wakes no
  // worker (WEB_INTERFACE → The extension → "Links into the extension").
  const askIfStanding = async (): Promise<void> => {
    const all = await api.storage.session.get(null);
    for (const k of Object.keys(all)) {
      if (k.startsWith(K_OPEN_PREFIX)) { ask(); return; }
    }
  };

  // The storage listener is registered once — a second `claim()` on the same wrapper adds no
  // second listener. A removal (no `newValue`) is not a notice; a change in the `local` area or
  // under another key is not either.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (!inner.holds()) return;
    for (const [k, change] of Object.entries(changes)) {
      if (!k.startsWith(K_OPEN_PREFIX)) continue;
      if (change.newValue === undefined) continue;
      ask();
      return;
    }
  });

  return {
    async claim(): Promise<boolean> {
      const granted = await inner.claim();
      void askIfStanding();
      return granted;
    },
    holds: () => inner.holds(),
    heldElsewhere: () => inner.heldElsewhere(),
    announce: (id: string) => inner.announce(id),
    onOpen(cb: (id: string) => void): void {
      inner.onOpen(cb);
      listeners.push(cb);
    },
  };
}
