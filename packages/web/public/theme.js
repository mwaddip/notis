// Theme resolved here, before first paint — a stored dark theme must be
// painted, never transitioned into, or the page paints light and flips
// (HOUSE_STYLE → Motion). The body's ground is the only thing on screen
// before the module fills it, so this is the one preference that must land
// in <head>. The identity tint is applied by the module before it draws its
// first bar, so it needs no flash guard here.
//
// A file, not an inline script — the extension page's default CSP
// (script-src 'self') forbids inline scripts (WEB_INTERFACE → The extension),
// and the same shell serves both builds.
try {
  if (localStorage.getItem('notis.theme') === 'dark') {
    document.documentElement.setAttribute('data-t', 'dark');
  }
} catch (e) { /* private mode, blocked storage — fall through to light */ }
