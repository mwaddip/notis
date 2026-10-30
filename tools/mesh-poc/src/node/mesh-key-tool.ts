// MESH_INTERFACE → Identity — a thin command line over `loadOrCreateNodeKey`:
// `ensure <path>` creates the key at `<path>` (mode `0600`, 48 bytes, never
// overwritten) if it does not exist, reads it if it does, and prints the
// 64-hex notisId on stdout. One line, nothing else, so a caller can read it
// without parsing a log stream. Any failure writes to stderr and exits non-zero.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadOrCreateNodeKey } from './key-store.js';
import { MeshKeyError } from '../identity.js';

async function main(argv: string[]): Promise<number> {
  if (argv.length < 2 || argv[0] !== 'ensure') {
    process.stderr.write('usage: mesh-key-tool ensure <path>\n');
    return 2;
  }
  const path = argv[1]!;
  try {
    await mkdir(dirname(path), { recursive: true });
    const key = await loadOrCreateNodeKey(path);
    process.stdout.write(key.notisId + '\n');
    return 0;
  } catch (err) {
    if (err instanceof MeshKeyError) {
      process.stderr.write(`mesh-key-tool: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`mesh-key-tool: ${(err as Error).message}\n`);
    return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exit(code); })
  .catch((e) => { process.stderr.write(`mesh-key-tool: ${(e as Error).message}\n`); process.exit(1); });
