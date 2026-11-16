// TEST_MATRIX_INTERFACE → The workspace: readWorkspace takes a TreeReader —
// a required argument, never defaulted — and reads pnpm-workspace.yaml's
// packages: list in the <dir>/* form this repo uses, then each matched
// directory holding a package.json. The disk reader is a TreeReader over a
// root directory.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Member, TreeReader, Workspace } from './types.ts';

export function readWorkspace(_tree: TreeReader): Workspace {
  return { members: [] };
}

export function diskReader(root: string): TreeReader {
  return {
    file(path) {
      try {
        return readFileSync(resolve(root, path), 'utf8');
      } catch {
        return null;
      }
    },
    dirs(path) {
      try {
        return readdirSync(resolve(root, path), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}

export type { Member, TreeReader, Workspace };
