#!/usr/bin/env node
// Emit the Chrome and Firefox manifests from the shared template — one
// template, two per-browser overlays. Chrome carries the service_worker
// background and a pinned `key` (so the extension id is stable, which is
// what lets the proof address `chrome-extension://<id>/`). Firefox carries
// an event-page background and its own gecko settings.
//
// Usage:
//   emit-manifests.mjs <version> <chrome-outdir> <firefox-outdir> <public-base> <faucet-base>
//
// The public base is the build's `notis-public` — the empty string emits no
// `content_scripts` key and ships no bridge; a non-empty value derives the
// bridge's match pattern (WEB_INTERFACE → The extension → "The manifest").
//
// The faucet base is the build's `notis-faucet` — the empty string emits no
// `optional_host_permissions` key on either manifest; a non-empty value
// derives the one host (origin only, port dropped) that both manifests
// declare (WEB_INTERFACE → The extension → "The manifest").

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchPatternFor, originPatternFor } from './match-pattern.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , version, chromeDir, firefoxDir, publicBase, faucetBase] = process.argv;
if (
  !version ||
  !chromeDir ||
  !firefoxDir ||
  publicBase === undefined ||
  faucetBase === undefined
) {
  console.error(
    'usage: emit-manifests.mjs <version> <chrome-outdir> <firefox-outdir> <public-base> <faucet-base>',
  );
  process.exit(2);
}
const bridgePattern = matchPatternFor(publicBase);
const contentScripts = bridgePattern
  ? [{ matches: [bridgePattern], js: ['bridge.js'], run_at: 'document_start' }]
  : null;
const optionalHost = originPatternFor(faucetBase);
const optionalHosts = optionalHost ? [optionalHost] : null;

const tpl = JSON.parse(readFileSync(join(HERE, 'manifest.template.json'), 'utf8'));
tpl.version = version;

// Chrome's `manifest.key` is a base64 RSA SPKI *public* key: it is public by
// nature, and it belongs in the tree so every build derives the same
// extension id. The private half is needed by nothing we do — unpacked
// loading and the proof harness compute the id from the public key alone,
// as `sha256(DER)` mapped `0-9a-f` → `a-p` on its first 32 hex chars.
// NOTIS_EXTENSION_KEY overrides at build time if a fork wants its own id.
const DEFAULT_CHROME_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0m2QfexgOKo7VGSOhQBEYOv/3/U7ug3EO7eXiUW3zTKgWPA10iz4lZ9GX4puIhmT8vgVyCnouruglTz4Fb7GiUXaq9gZwZP/LRlJrte61OqIlSYxtlaUDImADIUU/1AzD9Uzoff6OgxGfiiMjQPTWE6xIP+su7L5emPvPkJQWXVvVuoYra3N6Rfr/c8OwIL86E/gYHp+bWnbBKpkRNc6g1u8h+OK0Vei/BnSH2HcmpGSlAqAMYaKvrUhkxL4bHu5d/HGNYLMDs2VpuoXWMjg5+SMTsB07no+lATU6+J2dnPKY5Rc/VQsRTdFhAjG1gxrmk17s7fT5oYBs4NqwcHOgwIDAQAB';
const chromeKey = process.env.NOTIS_EXTENSION_KEY ?? DEFAULT_CHROME_KEY;

const chrome = {
  ...tpl,
  background: { service_worker: 'background.js' },
  minimum_chrome_version: '112',
  ...(contentScripts ? { content_scripts: contentScripts } : {}),
  ...(optionalHosts ? { optional_host_permissions: optionalHosts } : {}),
  key: chromeKey,
};

// Firefox 140 is the first release with the built-in consent screen for
// `data_collection_permissions`; an add-on installable below it owes a
// consent screen of its own. 142 is the same release on Android, stated
// so the desktop floor admits no Android build without it — the extension
// supports no Android. `optional_host_permissions` (from 128) and
// content-script hosts granted at install (past 127) both hold at 140.
// The id and the `update_url` are constants of this overlay, the same in
// every build: an installed copy reads the `update_url` it was installed
// with and learns no other.
// WEB_INTERFACE → The extension → "The manifest".
const firefox = {
  ...tpl,
  background: { scripts: ['background.js'] },
  ...(contentScripts ? { content_scripts: contentScripts } : {}),
  ...(optionalHosts ? { optional_host_permissions: optionalHosts } : {}),
  browser_specific_settings: {
    gecko: {
      id: 'extension@notis.fun',
      strict_min_version: '140.0',
      update_url: 'https://raw.githubusercontent.com/mwaddip/notis/updates/firefox/updates.json',
      data_collection_permissions: {
        required: ['personalCommunications', 'financialAndPaymentInfo'],
      },
    },
    gecko_android: { strict_min_version: '142.0' },
  },
};

writeFileSync(join(chromeDir, 'manifest.json'), JSON.stringify(chrome, null, 2) + '\n');
writeFileSync(join(firefoxDir, 'manifest.json'), JSON.stringify(firefox, null, 2) + '\n');

console.log(`emitted chrome manifest at ${chromeDir}/manifest.json`);
console.log(`emitted firefox manifest at ${firefoxDir}/manifest.json`);
