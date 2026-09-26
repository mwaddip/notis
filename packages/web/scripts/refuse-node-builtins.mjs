// WEB_INTERFACE → "A Node built-in fails every build". vite refuses only a
// NAMED import from a Node built-in; a namespace or a default import passes
// it with a warning and fails at run time (measured on vite 5.4.21) — this
// plugin throws for every import form alike, naming the id and the importer.
import { builtinModules } from 'node:module';

const BUILTIN_NAMES = new Set(builtinModules);

function isNodeBuiltin(id) {
  return id.startsWith('node:') || BUILTIN_NAMES.has(id);
}

/**
 * A vite plugin whose `resolveId` throws for any Node built-in a module in
 * the bundle imports, `node:`-prefixed or bare. `apply: 'build'` scopes the
 * refusal to `vite build` alone: vitest runs test files through the same
 * `vite.config.ts` and imports Node built-ins directly as the escape hatch to
 * real Node behaviour a mirror test needs.
 * WEB_INTERFACE → The client's builds substitute nothing
 */
export function refuseNodeBuiltins() {
  return {
    name: 'refuse-node-builtins',
    enforce: 'pre',
    apply: 'build',
    resolveId(id, importer) {
      if (isNodeBuiltin(id)) {
        throw new Error(`refuse-node-builtins: '${id}' is a Node built-in, imported by ${importer ?? '(the entry)'}`);
      }
      return null;
    },
  };
}
