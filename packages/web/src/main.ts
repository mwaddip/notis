import { applyPrefs, BUILD_NODES, BUILD_NETWORK, BUILD_PUBLIC, WEB_BASE, prefs } from './prefs';
import { App } from './app';
import { decideMode } from './mode';
import { createTabs, type Tabs } from './tabs';
import { identity } from './identity/identity';
import { bootstrapProxy } from './extension/proxy';
import { wrapTabs } from './extension/handover';
import { createTipVerifier } from './extension/tip-verifier';
import { createFiguresVerifier } from './extension/figures-verifier';
import { createNamesVerifier } from './extension/names-verifier';
import { createPostsVerifier } from './extension/posts-verifier';
import { createPostCache, rememberedChain } from './extension/post-cache';
import { createPostResolver } from './extension/post-resolver';
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
// WEB_INTERFACE → The extension → "The verified tip" — the verifier is handed
// to the App by the extension build alone; an extension with an empty
// `notis-network` is handed none, exactly as the web build. The static
// `isExtension` keeps `tip-verifier.ts` out of the web bundle
// (build-release.sh's `nipopow/proof` check).
const verifier: TipVerifier | undefined = isExtension && BUILD_NETWORK !== null
  ? createTipVerifier({
      network: BUILD_NETWORK,
      nodes: BUILD_NODES,
      fetch: fetch.bind(globalThis),
      now: Date.now,
    })
  : undefined;
// WEB_INTERFACE → The extension → "The verified figures" — the figures verifier
// is handed to the App under the same static condition as the tip verifier, so
// the web build's substitution renders this a static false and Rollup dead-
// code-eliminates createFiguresVerifier (build-release.sh's `api/v1/proof`
// check).
const figuresVerifier: FiguresVerifier | undefined = isExtension && BUILD_NETWORK !== null
  ? createFiguresVerifier({
      network: BUILD_NETWORK,
      fetch: fetch.bind(globalThis),
    })
  : undefined;
// WEB_INTERFACE → The extension → "The verified names" — the names verifier is
// handed to the App under the same static condition, so Rollup dead-code-
// eliminates createNamesVerifier from the web bundle (build-release.sh's
// `api/v1/proof` check).
const namesVerifier: NamesVerifier | undefined = isExtension && BUILD_NETWORK !== null
  ? createNamesVerifier({ fetch: fetch.bind(globalThis) })
  : undefined;
// WEB_INTERFACE → The extension → "The post check" — the posts verifier is
// handed under the same static condition as the three others, so Rollup
// dead-code-eliminates createPostsVerifier and `checkPosts` from the web
// bundle (build-release.sh's `notis.posts.` check refuses the post cache's
// IndexedDB prefix in the bundle; this verifier itself leaves no literal to
// key on).
const postsVerifier: PostsVerifier | undefined = isExtension && BUILD_NETWORK !== null
  ? createPostsVerifier()
  : undefined;
// WEB_INTERFACE → The extension → "The post cache" — the cache is built
// under the same static condition as the four verifiers, so Rollup dead-
// code-eliminates `createPostCache` and the IndexedDB name's `notis.posts.`
// prefix from the web bundle (build-release.sh refuses it there). The last
// chain's name opens the cache before the first tip run returns and where
// none does.
const postCache: PostCache | undefined = isExtension && BUILD_NETWORK !== null
  ? createPostCache()
  : undefined;
if (postCache) {
  const chain = rememberedChain();
  if (chain !== null) void postCache.open(chain);
}
// WEB_INTERFACE → The extension → "The resolve" — the resolver is handed
// under the same static condition as the four verifiers and the cache, so
// Rollup dead-code-eliminates `createPostResolver` and `posts/batch` from
// the web bundle (build-release.sh refuses it there). `nodes()` is read at
// each call since the reading node changes under the reader; the posts
// verifier is created under the same condition and so is defined here.
const postResolver: PostResolver | undefined = isExtension && BUILD_NETWORK !== null && postsVerifier !== undefined
  ? createPostResolver({
      nodes: (): string[] => [prefs.node, ...BUILD_NODES].filter((b) => b !== ''),
      fetch: fetch.bind(globalThis),
      check: postsVerifier.check.bind(postsVerifier),
    })
  : undefined;
new App(undefined, undefined, idm, undefined, tabs, requestFaucetOrigin, verifier, figuresVerifier, namesVerifier, postsVerifier, postCache, postResolver).start(appbar, feed, panes, mode);

// Restoring a stored preference is painted, not transitioned: drop the
// transition-suppressing class only after the first paint (HOUSE_STYLE → Motion).
requestAnimationFrame(() => document.documentElement.classList.remove('no-anim'));
