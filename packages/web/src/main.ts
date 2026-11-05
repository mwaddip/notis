import { applyPrefs, BUILD_NODE_BASES, BUILD_ANCHORS, BUILD_NETWORK, BUILD_PUBLIC, WEB_BASE, prefs } from './prefs';
import { App } from './app';
import { decideMode } from './mode';
import { createTabs, type Tabs } from './tabs';
import { identity } from './identity/identity';
import { bootstrapProxy } from './extension/proxy';
import { wrapTabs } from './extension/handover';
import { createFiguresVerifier } from './extension/figures-verifier';
import { createNamesVerifier } from './extension/names-verifier';
import { createPostsVerifier } from './extension/posts-verifier';
import { createPostCache, rememberedChain } from './extension/post-cache';
import { createPostResolver } from './extension/post-resolver';
import type { Api } from './api/client';
import type { WriteClient } from './api/write';
import type { HandNodeSeam } from './view/settings';
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

// WEB_INTERFACE → The extension → "The post check" — the posts verifier is
// handed under the extension build alone, so Rollup dead-code-eliminates
// createPostsVerifier and `checkPosts` from the web bundle.
const postsVerifier: PostsVerifier | undefined = isExtension && BUILD_NETWORK !== null
  ? createPostsVerifier()
  : undefined;
// WEB_INTERFACE → The extension → "The post cache" — the cache is built
// under the same static condition.
const postCache: PostCache | undefined = isExtension && BUILD_NETWORK !== null
  ? createPostCache()
  : undefined;
if (postCache) {
  const chain = rememberedChain();
  if (chain !== null) void postCache.open(chain);
}

let readClient: Api | undefined;
let writeClientSeam: WriteClient | undefined;
let verifier: TipVerifier | undefined;
let figuresVerifier: FiguresVerifier | undefined;
let namesVerifier: NamesVerifier | undefined;
let postResolver: PostResolver | undefined;
let handNodeSeam: HandNodeSeam | undefined;

if (isExtension && BUILD_NETWORK !== null && postsVerifier !== undefined) {
  // WEB_INTERFACE → The extension → "The mesh is the extension's first
  // path" — the extension build starts the mesh client with the build's
  // anchors, and the seams module wraps its `fetch` and `base`/`order` as
  // the App's read client, write client, tip verifier, figures and names
  // verifiers, post resolver and hand-added-node seam. `pagehide` stops
  // the client once. A stored hand-added address re-enters as a by-hand
  // anchor after start, so `removeByHand` can later drop it. The mesh
  // module is reached by a dynamic import so Rollup drops every byte of
  // it from the web bundle (`build-release.sh`'s mesh grep).
  const [{ startExtensionMesh }, { startMeshClient }] = await Promise.all([
    import('./extension/mesh-seams'),
    import('./mesh'),
  ]);
  const { seams } = await startExtensionMesh({
    anchors: [...BUILD_ANCHORS],
    network: BUILD_NETWORK,
    agentName: 'notis-extension',
    httpFetch: fetch.bind(globalThis),
    check: postsVerifier.check.bind(postsVerifier),
    storage: window.localStorage,
    window,
    startMeshClient,
  });
  readClient = seams.readClient;
  writeClientSeam = seams.writeClient;
  verifier = seams.tipVerifier;
  figuresVerifier = seams.figuresVerifier;
  namesVerifier = seams.namesVerifier;
  postResolver = seams.postResolver;
  handNodeSeam = seams.handNodeSeam;
} else if (isExtension && BUILD_NETWORK !== null) {
  // An extension build with a network but no posts verifier is a defect; keep
  // the figures/names paths off so the App does not receive one without the
  // other. The condition above folds `postsVerifier !== undefined`.
  figuresVerifier = createFiguresVerifier({ network: BUILD_NETWORK, fetch: fetch.bind(globalThis) });
  namesVerifier = createNamesVerifier({ fetch: fetch.bind(globalThis) });
  postResolver = createPostResolver({
    nodes: (): string[] => [prefs.node, ...BUILD_NODE_BASES].filter((b) => b !== ''),
    fetch: fetch.bind(globalThis),
    check: (): never => { throw new Error('a posts verifier is handed without a post resolver'); },
  });
}

new App(
  readClient, writeClientSeam, idm, undefined, tabs, requestFaucetOrigin,
  verifier, figuresVerifier, namesVerifier, postsVerifier, postCache, postResolver,
  handNodeSeam,
).start(appbar, feed, panes, mode);

// Restoring a stored preference is painted, not transitioned: drop the
// transition-suppressing class only after the first paint (HOUSE_STYLE → Motion).
requestAnimationFrame(() => document.documentElement.classList.remove('no-anim'));
