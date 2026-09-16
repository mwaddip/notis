#!/usr/bin/env node
// Emit the Chrome and Firefox manifests from the shared template — one
// template, two per-browser overlays. Chrome carries the service_worker
// background and a pinned `key` (so the extension id is stable, which is
// what lets the proof address `chrome-extension://<id>/`). Firefox carries
// an event-page background and its own gecko settings.
//
// Usage:
//   emit-manifests.mjs <version> <chrome-outdir> <firefox-outdir>

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , version, chromeDir, firefoxDir] = process.argv;
if (!version || !chromeDir || !firefoxDir) {
  console.error('usage: emit-manifests.mjs <version> <chrome-outdir> <firefox-outdir>');
  process.exit(2);
}

const tpl = JSON.parse(readFileSync(join(HERE, 'manifest.template.json'), 'utf8'));
tpl.version = version;

// The Chrome build's pinned public key — makes the extension id stable, which
// is what the proof harness addresses `chrome-extension://<id>/` under. The
// value is a placeholder Ed25519 SPKI; the real key lives in the repo's build
// configuration, injected here from an env var to keep the private half out
// of the tree.
const chromeKey = process.env.NOTIS_EXTENSION_KEY;

const chrome = {
  ...tpl,
  background: { service_worker: 'background.js' },
  minimum_chrome_version: '112',
  ...(chromeKey ? { key: chromeKey } : {}),
};

const firefox = {
  ...tpl,
  background: { scripts: ['background.js'] },
  browser_specific_settings: {
    gecko: { id: 'extension@notis.fun', strict_min_version: '121.0' },
  },
};

writeFileSync(join(chromeDir, 'manifest.json'), JSON.stringify(chrome, null, 2) + '\n');
writeFileSync(join(firefoxDir, 'manifest.json'), JSON.stringify(firefox, null, 2) + '\n');

console.log(`emitted chrome manifest at ${chromeDir}/manifest.json`);
console.log(`emitted firefox manifest at ${firefoxDir}/manifest.json`);
