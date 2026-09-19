import { applyPrefs, BUILD_PUBLIC, WEB_BASE } from './prefs';
import { App } from './app';
import { decideMode } from './mode';
import { createTabs } from './tabs';
import { identity } from './identity/identity';
import { bootstrapProxy } from './extension/proxy';
import type { AppIdentity } from './model/state';

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
new App(undefined, undefined, idm, undefined, createTabs(), requestFaucetOrigin).start(appbar, feed, panes, mode);

// Restoring a stored preference is painted, not transitioned: drop the
// transition-suppressing class only after the first paint (HOUSE_STYLE → Motion).
requestAnimationFrame(() => document.documentElement.classList.remove('no-anim'));
