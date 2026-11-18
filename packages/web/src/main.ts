import { applyPrefs, BUILD_NODES, BUILD_NETWORK, BUILD_PUBLIC, WEB_BASE } from './prefs';
import { App } from './app';
import { download } from './dom';
import { decideMode } from './mode';
import { createTabs, type Tabs } from './tabs';
import { identity } from './identity/identity';
import { bootstrapProxy } from './extension/proxy';
import { wrapTabs } from './extension/handover';
import { createPostsVerifier } from './extension/posts-verifier';
import { createPostCache, rememberedChain, type PostCacheWithStats } from './extension/post-cache';
import { postTextsFromCache } from './extension/post-texts';
import { startDebugLog } from './extension/debug-start';
import type { Api } from './api/client';
import type { WriteClient } from './api/write';
import type { HandNodeSeam, ServeSeam } from './view/settings';
import type { WaitingStorage, WaitRecorder } from './wallet/waiting';
import type { LockManager } from './locks';
import type { AppIdentity, TipVerifier, FiguresVerifier, NamesVerifier, PostsVerifier, PostResolver } from './model/state';
import type { DebugLog } from './extension/debug-log';
import type { DebugSeam } from './extension/debug-row';
import type { BuildFacts, SettingsFacts } from './extension/debug-snapshot';
import type { MeshClient } from './mesh/mesh-client';

// Theme is already on <html> from the head's theme.js; this re-applies it and
// sets the identity tint before the first render, while transitions are still
// suppressed — the bars do not exist yet, so neither can flash.
applyPrefs();

const appbar = document.getElementById('appbar');
const feed = document.getElementById('feed');
const panes = document.getElementById('panes');
if (!appbar || !feed || !panes) throw new Error('missing app shell elements');

// The identity swap point — WEB_INTERFACE → The extension. The web build's
// substitution renders this a static false, so Rollup dead-code-eliminates
// bootstrapProxy and the extension module never enters the bundle.
const isExtension = import.meta.env.VITE_IDENTITY === 'extension';
// WEB_INTERFACE → The extension → "The debug log" — the log starts before
// the proxy, so every `sign` answer the proxy records lands in the one log;
// `main.ts` records the walking of a waiting write through the `waitRecorder`
// below, hands the log to the mesh-seams module which records every mesh
// report in it, and composes the `DebugSeam` the App takes for the settings
// window's `debug` row (WEB_INTERFACE → The settings window → "The debug
// row"), whose snapshot the log's `stats` answers. The seams are the page's
// own; a build with no network reads an empty one in the `page` event.
let debugLog: DebugLog | undefined;
if (isExtension) {
  const started = startDebugLog({
    indexedDB: window.indexedDB,
    now: Date.now,
    random: Math.random,
    timers: {
      setInterval: (fn: () => void, ms: number): unknown => window.setInterval(fn, ms),
      clearInterval: (handle: unknown): void => { window.clearInterval(handle as number); },
    },
    document,
    window,
    version: chrome.runtime.getManifest().version,
    commit: import.meta.env.VITE_COMMIT ?? '',
    network: BUILD_NETWORK ?? '',
    userAgent: navigator.userAgent,
  });
  debugLog = started.log;
}
const idm: AppIdentity = isExtension
  ? await bootstrapProxy(chrome, { publicBase: BUILD_PUBLIC, debugLog })
  : identity;
// The extension asks the browser to grant access to the faucet's origin from
// within the press's own call stack, before any other asynchronous work
// (WEB_INTERFACE → The faucet step → "In the extension the press asks the
// browser for the faucet's origin first"). The web build passes nothing.
const requestFaucetOrigin = isExtension
  ? (origin: string): Promise<boolean> => chrome.permissions.request({ origins: [origin + '/*'] })
  : undefined;

const mode = decideMode(location.pathname, WEB_BASE);
// WEB_INTERFACE → The extension → "Links into the extension" — the extension build wraps the tabs
// seam with the handover, so the holder asks the background for waiting threads; the static
// `isExtension` keeps `handover.ts` out of the web bundle (build-release.sh's `chrome.` check).
const tabs: Tabs = isExtension ? wrapTabs(createTabs(), chrome) : createTabs();

let readClient: Api | undefined;
let writeClientSeam: WriteClient | undefined;
let verifier: TipVerifier | undefined;
let figuresVerifier: FiguresVerifier | undefined;
let namesVerifier: NamesVerifier | undefined;
let postsVerifier: PostsVerifier | undefined;
let postCache: PostCacheWithStats | undefined;
let postResolver: PostResolver | undefined;
let handNodeSeam: HandNodeSeam | undefined;
let serveSeam: ServeSeam | undefined;
// WEB_INTERFACE → The settings window → "The debug row" — the extension
// build composes the seam from the build, the settings' storage keys, the
// mesh client, the post cache's `stats` and the debug log, then imports
// `debug-row.ts` and hands the App a thunk that builds the row. The web
// build composes none, imports none and Rollup tree-shakes the module and
// its transitive strings (`webrtc-direct`, `notis.debug`, `notis-debug/1`)
// out of the web bundle.
let debugSeam: DebugSeam | undefined;
let debugRowBuilder: (() => HTMLElement) | undefined;
let meshClient: MeshClient | undefined;
// WEB_INTERFACE → The wallet → "A write no node answers waits". The extension
// build holds a waiting store over `window.localStorage` and the browser's
// `navigator.locks` (the same adapter the background uses); the web build
// hands none, and a write no node answers ends as a transport failure.
let waitingSeam: {
  storage: WaitingStorage;
  locks: LockManager;
  rememberedChain: () => string | null;
  recorder?: WaitRecorder;
} | undefined;

if (isExtension && BUILD_NETWORK !== null) {
  // WEB_INTERFACE → The extension → "The post check" and "The post cache" —
  // the posts verifier and the cache are handed under the extension build
  // alone, so Rollup dead-code-eliminates createPostsVerifier, createPostCache
  // and `checkPosts` from the web bundle.
  postsVerifier = createPostsVerifier();
  postCache = createPostCache();
  // WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does".
  // The module opens the remembered chain's database here, without naming the
  // chain — the chain is named by the first tip run, through `open(chain)`.
  void postCache.openRemembered();

  // WEB_INTERFACE → The extension → "The mesh is the extension's first
  // path" — the extension build starts the mesh client with the build's
  // nodes, and the seams module wraps its `fetch` and `base`/`order` as
  // the App's read client, write client, tip verifier, figures and names
  // verifiers, post resolver and hand-added-node seam. `pagehide` stops
  // the client once. A stored hand-added address re-enters as a trusted
  // by-hand node after start, so `removeByHand` can later drop it. The mesh
  // module is reached by a dynamic import so Rollup drops every byte of
  // it from the web bundle (`build-release.sh`'s mesh grep).
  const [{ startExtensionMesh, parseHandNodeAddress }, { startMeshClient }] = await Promise.all([
    import('./extension/mesh-seams'),
    import('./mesh'),
  ]);
  const { client: meshClientLocal, seams } = await startExtensionMesh({
    firstContact: [...BUILD_NODES],
    network: BUILD_NETWORK,
    agentName: 'notis-extension',
    httpFetch: fetch.bind(globalThis),
    check: postsVerifier.check.bind(postsVerifier),
    storage: window.localStorage,
    locks: {
      async request(name: string, fn: () => Promise<void>): Promise<void> {
        await navigator.locks.request(name, async () => { await fn(); });
      },
    },
    window,
    startMeshClient,
    // WEB_INTERFACE → The settings window → "The serve row",
    // → The extension → "The post cache" → "A serving read is answered
    // from it". The mesh client's serving reader answers `ModifierRequest`
    // from the cache the extension build carries.
    postTexts: postTextsFromCache(postCache),
    debugLog: debugLog!,
  });
  meshClient = meshClientLocal;
  readClient = seams.readClient;
  writeClientSeam = seams.writeClient;
  verifier = seams.tipVerifier;
  figuresVerifier = seams.figuresVerifier;
  namesVerifier = seams.namesVerifier;
  postResolver = seams.postResolver;
  handNodeSeam = seams.handNodeSeam;
  serveSeam = seams.serveSeam;
  // WEB_INTERFACE → The extension → "The debug log" — each `wait` event is
  // the write's kind renamed to `txKind` so the `wait` debug kind is the
  // only `kind` the stored event carries.
  const waitRecorder: WaitRecorder = (e) => {
    const fields: Record<string, unknown> = {
      outcome: e.outcome, txKind: e.kind, ledger: e.ledger, txId: e.txId,
    };
    if (e.message !== undefined) fields['message'] = e.message;
    if (e.cause !== undefined) fields['cause'] = e.cause;
    debugLog!.record('wait', fields);
  };
  waitingSeam = {
    storage: window.localStorage,
    locks: {
      request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        return navigator.locks.request(name, () => callback()) as Promise<T>;
      },
    },
    rememberedChain: (): string | null => rememberedChain(window.localStorage),
    recorder: waitRecorder,
  };

  // WEB_INTERFACE → The settings window → "The debug row" — compose the
  // seam the App takes. The build facts are the `page` event's own four;
  // the settings facts read each preference where it lives (the sign
  // policy and the links preference from the identity module, the rest from
  // the page's storage);
  // the mesh seam is the client's `state` and `diagnostics`; the post
  // cache's `stats` answers its own return type; the log carries `stats`
  // for the snapshot and `clear`/`list` for the row's own controls. The
  // App adds its own reader seam at the moment of a snapshot, so the
  // identity, the pending ledger, the waiting store and the last runs
  // read as they are then.
  const buildFacts = (): BuildFacts => ({
    version: chrome.runtime.getManifest().version,
    commit: import.meta.env.VITE_COMMIT ?? '',
    network: BUILD_NETWORK ?? '',
    userAgent: navigator.userAgent,
  });
  const { settingsFactsFrom } = await import('./extension/debug-snapshot');
  const settingsFacts = (): SettingsFacts => settingsFactsFrom({
    storage: window.localStorage,
    identity: idm,
    handNodeKey: (address) => {
      const parsed = parseHandNodeAddress(address);
      return 'notisId' in parsed ? parsed.notisId : null;
    },
  });
  debugSeam = {
    seams: {
      build: buildFacts,
      settings: settingsFacts,
      mesh: meshClient,
      postCache: { stats: () => postCache!.stats() },
      debugLog: { stats: () => debugLog!.stats() },
    },
    log: { clear: () => debugLog!.clear(), list: () => debugLog!.list() },
    download,
  };
  // The reader closure refers to `app` after it is constructed below —
  // safe: the thunk is called only on the settings body's first build,
  // well after construction. The import is inside the extension branch so
  // Rollup drops the module from the web bundle.
  const seam = debugSeam;
  const { debugRow } = await import('./extension/debug-row');
  debugRowBuilder = (): HTMLElement => debugRow({
    seam,
    reader: () => app!.readerFacts(),
    now: () => Date.now(),
  });
}

let app: App | undefined;
app = new App(
  readClient, writeClientSeam, idm, undefined, tabs, requestFaucetOrigin,
  verifier, figuresVerifier, namesVerifier, postsVerifier, postCache, postResolver,
  handNodeSeam, waitingSeam, serveSeam, debugRowBuilder,
);
app.start(appbar, feed, panes, mode);

// Restoring a stored preference is painted, not transitioned: drop the
// transition-suppressing class only after the first paint (HOUSE_STYLE → Motion).
requestAnimationFrame(() => document.documentElement.classList.remove('no-anim'));
