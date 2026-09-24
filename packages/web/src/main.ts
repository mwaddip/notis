import { applyPrefs, BUILD_NODES, BUILD_NETWORK, BUILD_PUBLIC, WEB_BASE } from './prefs';
import { App } from './app';
import { decideMode } from './mode';
import { createTabs, type Tabs } from './tabs';
import { identity } from './identity/identity';
import { bootstrapProxy } from './extension/proxy';
import { wrapTabs } from './extension/handover';
import { createTipVerifier } from './extension/tip-verifier';
import { createFiguresVerifier } from './extension/figures-verifier';
import { createNamesVerifier } from './extension/names-verifier';
import type { AppIdentity, TipVerifier, FiguresVerifier, NamesVerifier } from './model/state';

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
new App(undefined, undefined, idm, undefined, tabs, requestFaucetOrigin, verifier, figuresVerifier, namesVerifier).start(appbar, feed, panes, mode);

// Restoring a stored preference is painted, not transitioned: drop the
// transition-suppressing class only after the first paint (HOUSE_STYLE → Motion).
requestAnimationFrame(() => document.documentElement.classList.remove('no-anim'));
