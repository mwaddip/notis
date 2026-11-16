import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The barrel resolves CLOCK_OFFSET_PRELOAD from its own directory with an
// extra `..`, `src`, so src/index.ts and dist/index.js both land on the one
// preload file at tools/test-state/src/clock-offset-preload.mjs. This case
// loads the built dist/index.js directly and reads the resolved path.
describe('clock preload', () => {
  it('CLOCK_OFFSET_PRELOAD resolves to an existing file when the barrel loads from dist/', async () => {
    const packageRoot = resolve(import.meta.dirname, '..');
    const distBarrel = join(packageRoot, 'dist', 'index.js');
    expect(existsSync(distBarrel), 'build tools/test-state before running this case').toBe(true);
    const barrel = (await import(pathToFileURL(distBarrel).href)) as {
      CLOCK_OFFSET_PRELOAD: string;
    };
    expect(barrel.CLOCK_OFFSET_PRELOAD).toMatch(/[/\\]src[/\\]clock-offset-preload\.mjs$/);
    expect(existsSync(barrel.CLOCK_OFFSET_PRELOAD)).toBe(true);
  });
});
