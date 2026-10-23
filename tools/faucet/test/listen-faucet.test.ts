import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

describe('how the faucet listens', () => {
  it('listens in listenFaucet alone, and the start calls it', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    const listening = files.filter((f) => readFileSync(join(SRC, f), 'utf8').includes('.listen('));
    expect(listening).toEqual(['server.ts']);
    const server = readFileSync(join(SRC, 'server.ts'), 'utf8');
    expect(server.split('.listen(')).toHaveLength(2);
    expect(server).toMatch(/export function listenFaucet\([^)]*\)[^{]*\{[^}]*\.listen\(/);
    expect(readFileSync(join(SRC, 'index.ts'), 'utf8')).toContain('listenFaucet(');
  });
});
