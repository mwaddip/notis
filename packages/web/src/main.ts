import { applyPrefs, BUILD_NODES, BUILD_NETWORK, BUILD_PUBLIC, WEB_BASE } from './prefs';
import { App } from './app';
import { decideMode } from './mode';
import { createTabs, type Tabs } from './tabs';
import { identity } from './identity/identity';
import { bootstrapProxy } from './extension/proxy';
import { wrapTabs } from './extension/handover';
import { createPostsVerifier } from './extension/posts-verifier';
import { createPostCache, rememberedChain } from './extension/post-cache';
import { postTextsFromCache } from './extension/post-texts';
import type { Api } from './api/client';
import type { WriteClient } from './api/write';
import type { HandNodeSeam, ServeSeam } from './view/settings';
import type { WaitingStorage } from './wallet/waiting';
import type { LockManager } from './locks';
import type { AppIdentity, TipVerifier, FiguresVerifier, NamesVerifier, PostsVerifier, PostCache, PostResolver } from './model/state';

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
const idm: AppIdentity = isExtension ? await bootstrapProxy(chrome, { publicBase: BUILD_PUBLIC }) : identity;
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
let postCache: PostCache | undefined;
let postResolver: PostResolver | undefined;
let handNodeSeam: HandNodeSeam | undefined;
let serveSeam: ServeSeam | undefined;
// WEB_INTERFACE → The wallet → "A write no node answers waits". The extension
// build holds a waiting store over `window.localStorage` and the browser's
// `navigator.locks` (the same adapter the background uses); the web build
// hands none, and a write no node answers ends as a transport failure.
let waitingSeam: { storage: WaitingStorage; locks: LockManager; rememberedChain: () => string | null } | undefined;

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
  const [{ startExtensionMesh }, { startMeshClient }] = await Promise.all([
    import('./extension/mesh-seams'),
    import('./mesh'),
  ]);
  const { seams } = await startExtensionMesh({
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
  });
  readClient = seams.readClient;
  writeClientSeam = seams.writeClient;
  verifier = seams.tipVerifier;
  figuresVerifier = seams.figuresVerifier;
  namesVerifier = seams.namesVerifier;
  postResolver = seams.postResolver;
  handNodeSeam = seams.handNodeSeam;
  serveSeam = seams.serveSeam;
  waitingSeam = {
    storage: window.localStorage,
    locks: {
      request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        return navigator.locks.request(name, () => callback()) as Promise<T>;
      },
    },
    rememberedChain: (): string | null => rememberedChain(window.localStorage),
  };
}

new App(
  readClient, writeClientSeam, idm, undefined, tabs, requestFaucetOrigin,
  verifier, figuresVerifier, namesVerifier, postsVerifier, postCache, postResolver,
  handNodeSeam, waitingSeam, serveSeam,
).start(appbar, feed, panes, mode);

// Restoring a stored preference is painted, not transitioned: drop the
// transition-suppressing class only after the first paint (HOUSE_STYLE → Motion).
requestAnimationFrame(() => document.documentElement.classList.remove('no-anim'));
