// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// WEB_INTERFACE → The extension → "The manifest".
// The emitter is a Node script the build shell calls; no gated test runs the
// shell, so this file is the one that reads emitted manifests. Every case
// spawns the emitter under a fresh mkdtemp pair, parses the two files, and
// asserts what the contract states.

const EMITTER = fileURLToPath(new URL('../extension/emit-manifests.mjs', import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL('../extension/manifest.template.json', import.meta.url));
const TEMPLATE_KEYS = Object.keys(JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')));

const VERSION = '9.9.9';

// The full object stated in the script (build-extension.sh) and in the
// emitter's Firefox overlay is written out here on purpose: a check that
// reads the emitter's own constant proves nothing.
const EXPECTED_BSS = {
  gecko: {
    id: 'extension@notis.fun',
    strict_min_version: '140.0',
    update_url: 'https://raw.githubusercontent.com/mwaddip/notis/updates/firefox/updates.json',
    data_collection_permissions: {
      required: ['personalCommunications', 'financialAndPaymentInfo'],
    },
  },
  gecko_android: { strict_min_version: '142.0' },
};

const DEFAULT_CHROME_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0m2QfexgOKo7VGSOhQBEYOv/3/U7ug3EO7eXiUW3zTKgWPA10iz4lZ9GX4puIhmT8vgVyCnouruglTz4Fb7GiUXaq9gZwZP/LRlJrte61OqIlSYxtlaUDImADIUU/1AzD9Uzoff6OgxGfiiMjQPTWE6xIP+su7L5emPvPkJQWXVvVuoYra3N6Rfr/c8OwIL86E/gYHp+bWnbBKpkRNc6g1u8h+OK0Vei/BnSH2HcmpGSlAqAMYaKvrUhkxL4bHu5d/HGNYLMDs2VpuoXWMjg5+SMTsB07no+lATU6+J2dnPKY5Rc/VQsRTdFhAjG1gxrmk17s7fT5oYBs4NqwcHOgwIDAQAB';

interface Emitted {
  chrome: Record<string, unknown>;
  firefox: Record<string, unknown>;
  chromeDir: string;
  firefoxDir: string;
  cleanup: () => void;
}

function emit(argv: readonly string[], envOverrides: Record<string, string> = {}): Emitted {
  const chromeDir = mkdtempSync(join(tmpdir(), 'notis-emit-chrome-'));
  const firefoxDir = mkdtempSync(join(tmpdir(), 'notis-emit-firefox-'));
  // Strip NOTIS_EXTENSION_KEY so every case runs against the default key —
  // one case below overrides on purpose.
  const env = { ...process.env };
  delete env.NOTIS_EXTENSION_KEY;
  Object.assign(env, envOverrides);
  const r = spawnSync('node', [EMITTER, VERSION, chromeDir, firefoxDir, ...argv], {
    encoding: 'utf8',
    env,
  });
  if (r.status !== 0) {
    rmSync(chromeDir, { recursive: true, force: true });
    rmSync(firefoxDir, { recursive: true, force: true });
    throw new Error(`emitter exited ${r.status}: ${r.stderr}`);
  }
  const chrome = JSON.parse(readFileSync(join(chromeDir, 'manifest.json'), 'utf8'));
  const firefox = JSON.parse(readFileSync(join(firefoxDir, 'manifest.json'), 'utf8'));
  return {
    chrome,
    firefox,
    chromeDir,
    firefoxDir,
    cleanup: () => {
      rmSync(chromeDir, { recursive: true, force: true });
      rmSync(firefoxDir, { recursive: true, force: true });
    },
  };
}

function assertTemplateCoverage(manifest: Record<string, unknown>): void {
  // Every key of the template appears in the output.
  for (const k of TEMPLATE_KEYS) {
    expect(manifest, `template key ${k} missing`).toHaveProperty(k);
  }
}

function assertCommonInvariants(m: Emitted): void {
  expect(m.chrome.version).toBe(VERSION);
  expect(m.firefox.version).toBe(VERSION);
  expect(m.chrome.key).toBe(DEFAULT_CHROME_KEY);
  expect(m.chrome.minimum_chrome_version).toBe('112');
  expect(m.firefox.background).toEqual({ scripts: ['background.js'] });
  expect(m.chrome.background).toEqual({ service_worker: 'background.js' });
  // Firefox's browser_specific_settings is exactly the object above.
  expect(m.firefox.browser_specific_settings).toEqual(EXPECTED_BSS);
  // Chrome carries no browser_specific_settings key.
  expect('browser_specific_settings' in m.chrome).toBe(false);
  assertTemplateCoverage(m.chrome);
  assertTemplateCoverage(m.firefox);
}

describe('emit-manifests — testnet bases', () => {
  const publicBase = 'https://notis.fun/web/';
  const faucetBase = 'https://notis.fun/testnet/faucet';
  const m = emit([publicBase, faucetBase]);

  it('common invariants hold', () => {
    assertCommonInvariants(m);
  });

  it('optional_host_permissions equals [<origin>/*] on both manifests', () => {
    const expected = ['https://notis.fun/*'];
    expect(m.chrome.optional_host_permissions).toEqual(expected);
    expect(m.firefox.optional_host_permissions).toEqual(expected);
  });

  it('content_scripts pins the bridge match on both manifests', () => {
    const expected = [
      { matches: ['https://notis.fun/web/p/*'], js: ['bridge.js'], run_at: 'document_start' },
    ];
    expect(m.chrome.content_scripts).toEqual(expected);
    expect(m.firefox.content_scripts).toEqual(expected);
  });

  m.cleanup();
});

describe('emit-manifests — proof devnet bases', () => {
  const publicBase = 'http://localhost:19760/web/';
  const faucetBase = 'http://127.0.0.1:19750/faucet';
  const m = emit([publicBase, faucetBase]);

  it('common invariants hold', () => {
    assertCommonInvariants(m);
  });

  it('optional_host_permissions drops the port on both manifests', () => {
    const expected = ['http://127.0.0.1/*'];
    expect(m.chrome.optional_host_permissions).toEqual(expected);
    expect(m.firefox.optional_host_permissions).toEqual(expected);
  });

  it('content_scripts drops the port on both manifests', () => {
    const expected = [
      { matches: ['http://localhost/web/p/*'], js: ['bridge.js'], run_at: 'document_start' },
    ];
    expect(m.chrome.content_scripts).toEqual(expected);
    expect(m.firefox.content_scripts).toEqual(expected);
  });

  m.cleanup();
});

describe('emit-manifests — empty faucet base', () => {
  const m = emit(['https://notis.fun/web/', '']);

  it('common invariants hold', () => {
    assertCommonInvariants(m);
  });

  it('neither manifest carries optional_host_permissions', () => {
    expect('optional_host_permissions' in m.chrome).toBe(false);
    expect('optional_host_permissions' in m.firefox).toBe(false);
  });

  it('content_scripts is still emitted (public base non-empty)', () => {
    const expected = [
      { matches: ['https://notis.fun/web/p/*'], js: ['bridge.js'], run_at: 'document_start' },
    ];
    expect(m.chrome.content_scripts).toEqual(expected);
    expect(m.firefox.content_scripts).toEqual(expected);
  });

  m.cleanup();
});

describe('emit-manifests — empty public base', () => {
  const m = emit(['', 'https://notis.fun/testnet/faucet']);

  it('common invariants hold', () => {
    assertCommonInvariants(m);
  });

  it('neither manifest carries content_scripts', () => {
    expect('content_scripts' in m.chrome).toBe(false);
    expect('content_scripts' in m.firefox).toBe(false);
  });

  it('optional_host_permissions is still emitted (faucet base non-empty)', () => {
    const expected = ['https://notis.fun/*'];
    expect(m.chrome.optional_host_permissions).toEqual(expected);
    expect(m.firefox.optional_host_permissions).toEqual(expected);
  });

  m.cleanup();
});

describe('emit-manifests — NOTIS_EXTENSION_KEY override', () => {
  const overrideKey = 'test-override-key-value';
  const m = emit(
    ['https://notis.fun/web/', 'https://notis.fun/testnet/faucet'],
    { NOTIS_EXTENSION_KEY: overrideKey },
  );

  it("chrome carries the override under `key`", () => {
    expect(m.chrome.key).toBe(overrideKey);
  });

  it("firefox carries no `key`", () => {
    expect('key' in m.firefox).toBe(false);
  });

  m.cleanup();
});

describe('emit-manifests — missing fifth argument', () => {
  it('exits 2 and prints the usage line naming all five arguments', () => {
    const chromeDir = mkdtempSync(join(tmpdir(), 'notis-emit-chrome-'));
    const firefoxDir = mkdtempSync(join(tmpdir(), 'notis-emit-firefox-'));
    try {
      const r = spawnSync(
        'node',
        [EMITTER, VERSION, chromeDir, firefoxDir, 'https://notis.fun/web/'],
        { encoding: 'utf8' },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/usage: emit-manifests\.mjs/);
      expect(r.stderr).toMatch(/<faucet-base>/);
    } finally {
      rmSync(chromeDir, { recursive: true, force: true });
      rmSync(firefoxDir, { recursive: true, force: true });
    }
  });
});
