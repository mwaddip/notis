// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { build } from 'vite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { refuseNodeBuiltins } from '../scripts/refuse-node-builtins.mjs';

// WEB_INTERFACE → The client's builds substitute nothing — vite refuses only
// a NAMED import from a Node built-in; a namespace or a default import
// passes it with a warning and fails at run time (measured on vite 5.4.21).
// Each throwaway entry below uses the import form vite itself lets through,
// so the plugin is proven on exactly what it exists to refuse.

function tempEntry(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'notis-refuse-builtins-'));
  const file = join(dir, 'entry.js');
  writeFileSync(file, code);
  return file;
}

async function buildRejection(code: string): Promise<string> {
  const entry = tempEntry(code);
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [refuseNodeBuiltins()],
      build: { write: false, lib: { entry, formats: ['es'], fileName: () => 'out.js' } },
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    rmSync(dirname(entry), { recursive: true, force: true });
  }
  throw new Error('expected the build to reject');
}

describe('refuseNodeBuiltins', () => {
  it('rejects a namespace import of a bare Node built-in', async () => {
    const message = await buildRejection(`import * as crypto from 'crypto';\nexport default crypto;\n`);
    expect(message).toContain('refuse-node-builtins');
    expect(message).toContain("'crypto'");
  });

  it('rejects a namespace import of a node:-prefixed built-in', async () => {
    const message = await buildRejection(`import * as crypto from 'node:crypto';\nexport default crypto;\n`);
    expect(message).toContain('refuse-node-builtins');
    expect(message).toContain("'node:crypto'");
  });
});
