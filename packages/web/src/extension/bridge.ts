// The extension's one content script — WEB_INTERFACE → The extension →
// "Links into the extension". Injected at document_start into the top frame
// of the build's public thread pages. It holds nothing: no key, no seed, no
// identity, no state between pages. It imports only pure modules, so it
// builds as one classic file with no `import`.
//
// Written as one exported function over its environment, so the tests drive
// the function over fakes and happy-dom; the auto-run at the foot mirrors
// `background.ts`.

import { K_LINKS, readLinksPref } from './links';
import { decideMode } from '../mode';

const HEX64_ANYCASE = /^[0-9a-fA-F]{64}$/;

/** The bridge's environment — the `chrome` surface, the page globals it reads,
 *  and the build's public base (WEB_INTERFACE → The extension → "The build's
 *  `notis-public`"). Test fakes supply their own; the auto-run reads them from
 *  the page's globals. */
export interface BridgeEnv {
  chrome: typeof chrome;
  location: { pathname: string };
  history: { length: number };
  document: EventTarget & { prerendering?: boolean };
  navigator: { userActivation?: { isActive?: boolean } | null };
  performance: { getEntriesByType(type: string): unknown[] };
  publicBase: string;
}

/** Run the bridge over `env`. WEB_INTERFACE → The extension → "A takeover
 *  needs a tab created for the link" and → "The website's control offers the
 *  thread to the extension". */
export function bridge(env: BridgeEnv): void {
  // An empty `notis-public` builds an extension with no bridge — the script
  // does nothing rather than throwing at load.
  if (env.publicBase === '') return;
  let basePath: string;
  try {
    basePath = new URL(env.publicBase).pathname;
  } catch {
    return;
  }

  // Not a thread page under the public base — nothing to do, not even a
  // listener.
  const mode = decideMode(env.location.pathname, basePath);
  if (mode.kind !== 'standalone') return;

  // A private window — nothing at all.
  if (env.chrome.extension?.inIncognitoContext === true) return;

  const id = mode.id;
  const chromeApi = env.chrome;

  // WEB_INTERFACE → The extension → "The website's control offers the thread
  // to the extension" — the listener stands on every thread page outside a
  // private window. The id is the event's `detail`, never the path's, since
  // the hosted page may have re-rooted by `pushState`.
  env.document.addEventListener('notis:open', (event) => {
    // A dead context — the extension was updated or uninstalled while the
    // script ran — must not cancel what nobody will land.
    const rid: unknown = chromeApi.runtime?.id;
    if (typeof rid !== 'string') return;
    if (!event.cancelable) return;
    // The listener reads the detail's type, not the event's constructor —
    // a page's event reaches a content script across a world boundary, where
    // the constructor is not the listener's own. A plain `Event` carries no
    // `detail`, which the `typeof` arm below refuses.
    const detail: unknown = (event as { detail?: unknown }).detail;
    if (typeof detail !== 'string') return;
    if (!HEX64_ANYCASE.test(detail)) return;
    // The reader's press is the browser's transient user activation, which a
    // page cannot forge; a timer sees `isActive` false.
    if (env.navigator.userActivation?.isActive !== true) return;
    event.preventDefault();
    void chromeApi.runtime.sendMessage({ kind: 'offered', id: detail.toLowerCase() });
  });

  // WEB_INTERFACE → The extension → "A takeover needs a tab created for the
  // link" — the cheap predicates first; the storage read is last, so a page
  // opened under `site` wakes no worker.
  if (env.history.length !== 1) return;
  const navs = env.performance.getEntriesByType('navigation');
  const first = navs[0] as { type?: unknown } | undefined;
  if (first?.type !== 'navigate') return;
  if (env.document.prerendering === true) return;

  void chromeApi.storage.local.get(K_LINKS).then((got) => {
    if (readLinksPref(got[K_LINKS]) !== 'here') return;
    void chromeApi.runtime.sendMessage({ kind: 'arrived', id });
  });
}

// Auto-run at module load — the browser injects the script at document_start,
// so the function runs against the page's globals. Tests build the module
// through this call themselves; the guard keeps them from double-running here.
if (typeof globalThis !== 'undefined' && typeof (globalThis as { chrome?: unknown }).chrome !== 'undefined') {
  bridge({
    chrome: (globalThis as unknown as { chrome: typeof chrome }).chrome,
    location: globalThis.location,
    history: globalThis.history,
    document: globalThis.document as EventTarget & { prerendering?: boolean },
    navigator: globalThis.navigator,
    performance: globalThis.performance,
    publicBase: import.meta.env.VITE_PUBLIC ?? '',
  });
}
