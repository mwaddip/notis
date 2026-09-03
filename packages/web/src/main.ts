import { applyPrefs } from './prefs';
import { App } from './app';
import { identity } from './identity/identity';
import { installDevDoor } from './identity/dev-door';

// Theme is already on <html> from the inline <head> script; this re-applies it
// and sets the identity tint before the first render, while transitions are
// still suppressed — the bars do not exist yet, so neither can flash.
applyPrefs();

const appbar = document.getElementById('appbar');
const feed = document.getElementById('feed');
const panes = document.getElementById('panes');
if (!appbar || !feed || !panes) throw new Error('missing app shell elements');

// In a development build only, hang the identity module off globalThis so the
// reader can load their own key through the console (WEB_INTERFACE → The write
// surface). A production build exposes nothing.
installDevDoor(identity);

new App().start(appbar, feed, panes);

// Restoring a stored preference is painted, not transitioned: drop the
// transition-suppressing class only after the first paint (HOUSE_STYLE → Motion).
requestAnimationFrame(() => document.documentElement.classList.remove('no-anim'));
