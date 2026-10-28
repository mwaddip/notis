// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { build, createServer } from 'vite';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WEB_SECURITY_POLICY,
  webSecurityPolicyPlugin,
} from '../scripts/content-security-policy.mjs';

// WEB_INTERFACE → The client is served from the node's own origin —
// the six-tag shell, the policy meta a web build writes after the charset
// tag and before `<base>`, and the four build configs that each refuse a
// Node built-in. Each case enters through the real entry: `build` over the
// config file, `createServer`'s `transformIndexHtml`, or the plugin called
// directly. Vite's dev server injects client styles inline, so the policy
// is build-only (apply: 'build') — the dev-server case holds that line.

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const VITE_CONFIG = resolve(WEB_DIR, 'vite.config.ts');
const VITE_EXT_CONFIG = resolve(WEB_DIR, 'vite.extension.config.ts');
const VITE_BG_CONFIG = resolve(WEB_DIR, 'vite.background.config.ts');
const VITE_BRIDGE_CONFIG = resolve(WEB_DIR, 'vite.bridge.config.ts');

// WEB_INTERFACE → The client is served from the node's own origin →
// "The deployment is six tags in the shell's head, and nothing in the
// bundle's bytes" — vite.config.ts sets its defaults on `process.env` when
// the module is evaluated, so a test building through it in a worker must
// save and restore every `VITE_*` variable it reads, or later files in the
// worker read them.
const VITE_VARS = [
  'VITE_WEB_BASE',
  'VITE_API_BASE',
  'VITE_FAUCET_BASE',
  'VITE_NODES',
  'VITE_PUBLIC',
  'VITE_PUBLIC_ORIGIN',
  'VITE_NETWORK',
  'VITE_IDENTITY',
  'NOTIS_NODE',
  'NOTIS_FAUCET',
  'NOTIS_EXT_OUTDIR',
];

let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const k of VITE_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of VITE_VARS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function dropDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

async function buildWithRealConfig(configFile: string): Promise<string> {
  const out = freshDir('notis-shell-policy-');
  try {
    await build({
      configFile,
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true },
    });
    const indexHtmlPath = join(out, 'index.html');
    return readFileSync(indexHtmlPath, 'utf8');
  } finally {
    dropDir(out);
  }
}

async function buildNamespaceCryptoRejection(configFile: string): Promise<string> {
  const dir = freshDir('notis-refuse-config-');
  const entry = join(dir, 'entry.js');
  writeFileSync(entry, `import * as crypto from 'node:crypto';\nexport default crypto;\n`);
  const outDir = join(dir, 'out');
  try {
    await build({
      configFile,
      logLevel: 'silent',
      build: {
        write: false,
        emptyOutDir: false,
        outDir,
        // Override the config's own `rollupOptions.input` so the throwaway
        // entry is what rollup builds; the config's plugins run as its own
        // build would run them.
        rollupOptions: { input: entry },
        lib: { entry, formats: ['es'], fileName: () => 'out.js' },
      },
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    dropDir(dir);
  }
  throw new Error('expected the build to reject');
}

type TransformHandler = (html: string, ctx: { filename?: string; path: string }) => string;

function pluginHandler(): TransformHandler {
  const plugin = webSecurityPolicyPlugin() as unknown as {
    transformIndexHtml:
      | TransformHandler
      | { handler: TransformHandler };
  };
  const t = plugin.transformIndexHtml;
  return typeof t === 'function' ? t : t.handler;
}

describe('web build — the shell the build writes', () => {
  // Every case in this block reads the one shell a build with no VITE_
  // variable set emits, so one build serves them all; a per-case build would
  // run vite once per case and under load those builds reach the default
  // 5 s per-case timeout. The 90 s hook timeout is the whole block's build
  // budget — vite's work, not any case's — and the `beforeEach` env clear
  // leaves the file's other blocks untouched.
  let shell: string;
  beforeAll(async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of VITE_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      shell = await buildWithRealConfig(VITE_CONFIG);
    } finally {
      for (const k of VITE_VARS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 90_000);

  it('holds no %VITE_ placeholder when every VITE_ variable is unset', () => {
    // Control: the shell was emitted and names the title tag we expect.
    expect(shell).toContain('<title>Notis</title>');
    expect(shell).not.toMatch(/%VITE_[A-Z_]+%/);
  });

  it('writes notis-nodes as the empty JSON array when VITE_NODES is unset', () => {
    expect(shell).toContain('<title>Notis</title>');
    expect(shell).toMatch(/<meta name="notis-nodes" content=['"]\[\]['"]/);
  });

  it('writes notis-public empty when VITE_PUBLIC is unset', () => {
    expect(shell).toContain('<title>Notis</title>');
    expect(shell).toMatch(/<meta name="notis-public" content=""/);
  });

  it('carries exactly one Content-Security-Policy meta', () => {
    expect(shell).toContain('<title>Notis</title>');
    const matches = shell.match(/http-equiv="Content-Security-Policy"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('writes the policy meta with the module\'s string as its content', () => {
    expect(shell).toContain('<title>Notis</title>');
    expect(shell).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${WEB_SECURITY_POLICY}">`,
    );
  });

  it('places the policy meta after <meta charset="utf-8"> and before <base', () => {
    const charset = shell.indexOf('<meta charset="utf-8">');
    const policy = shell.indexOf('http-equiv="Content-Security-Policy"');
    const base = shell.indexOf('<base ');
    expect(charset).toBeGreaterThan(-1);
    expect(base).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(charset);
    expect(policy).toBeLessThan(base);
  });
});

describe('vite dev server — transformIndexHtml over the real shell', () => {
  // One vite createServer and transformIndexHtml, outside the first block's
  // build budget. 60 s covers the dev server's cold start under load.
  it('carries no Content-Security-Policy meta in the transformed shell', async () => {
    const indexHtmlPath = resolve(WEB_DIR, 'index.html');
    const rawShell = readFileSync(indexHtmlPath, 'utf8');
    // Control: the raw shell on disk carries no policy meta.
    expect(rawShell).not.toMatch(/http-equiv=["']Content-Security-Policy["']/i);
    const server = await createServer({
      configFile: VITE_CONFIG,
      root: WEB_DIR,
      logLevel: 'silent',
      server: { middlewareMode: true },
    });
    try {
      const transformed = await server.transformIndexHtml('/index.html', rawShell);
      // Control: the dev server actually ran its transform (the shell loads
      // the vite client).
      expect(transformed).toContain('@vite/client');
      expect(transformed).not.toMatch(/http-equiv=["']Content-Security-Policy["']/i);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe('extension pages build — the shell its config emits', () => {
  // One vite build (its own config, its own emitted shell), outside the first
  // block's build budget. 60 s covers the extension pages build under load.
  it('carries no Content-Security-Policy meta', async () => {
    const out = freshDir('notis-ext-shell-');
    try {
      await build({
        configFile: VITE_EXT_CONFIG,
        logLevel: 'silent',
        build: { outDir: out, emptyOutDir: true },
      });
      const shellPath = join(out, 'index.html');
      // Control: the config emitted a shell.
      expect(existsSync(shellPath)).toBe(true);
      const shell = readFileSync(shellPath, 'utf8');
      expect(shell).toContain('<title>Notis</title>');
      expect(shell).not.toMatch(/http-equiv=["']Content-Security-Policy["']/i);
    } finally {
      dropDir(out);
    }
  }, 60_000);
});

describe('webSecurityPolicyPlugin — the plugin\'s own refusals', () => {
  it('refuses a shell with no <meta charset="utf-8"> and names the reason', () => {
    const handler = pluginHandler();
    const shell = '<!doctype html><html><head><title>x</title></head></html>';
    let message = '';
    try {
      handler(shell, { filename: 'x.html', path: '/x.html' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/charset/i);
  });

  it('refuses a shell that already carries a Content-Security-Policy meta and names the reason', () => {
    const handler = pluginHandler();
    const shell =
      '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="x"></head></html>';
    let message = '';
    try {
      handler(shell, { filename: 'x.html', path: '/x.html' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/already carries a Content-Security-Policy/i);
  });
});

describe('refuseNodeBuiltins — each build config refuses a namespace import of node:crypto', () => {
  // Each case drives its own config through a build to the plugin's refusal,
  // so each case runs its own vite build. 60 s is the per-case budget under
  // load — the default 5 s is below vite's cold-start cost in a loaded run.
  it('vite.config.ts refuses', async () => {
    const message = await buildNamespaceCryptoRejection(VITE_CONFIG);
    expect(message).toContain('refuse-node-builtins');
    expect(message).toContain("'node:crypto'");
  }, 60_000);

  it('vite.extension.config.ts refuses', async () => {
    const message = await buildNamespaceCryptoRejection(VITE_EXT_CONFIG);
    expect(message).toContain('refuse-node-builtins');
    expect(message).toContain("'node:crypto'");
  }, 60_000);

  it('vite.background.config.ts refuses', async () => {
    const message = await buildNamespaceCryptoRejection(VITE_BG_CONFIG);
    expect(message).toContain('refuse-node-builtins');
    expect(message).toContain("'node:crypto'");
  }, 60_000);

  it('vite.bridge.config.ts refuses', async () => {
    const message = await buildNamespaceCryptoRejection(VITE_BRIDGE_CONFIG);
    expect(message).toContain('refuse-node-builtins');
    expect(message).toContain("'node:crypto'");
  }, 60_000);
});
