import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';

// The package's code built for a browser (CONSENSUS_INTERFACE → Tests): from
// source, with vite, every Node built-in a module imports failing the build.
// The bundle test builds `applyBlock` this way, and a bench that replays a
// block in a browser builds its replay the same way. Node 22.18 and later
// import this module with its types stripped, so it holds only syntax that
// strips.

export const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));

// Every `@dagsocial/*` import resolves to that package's `src/index.ts`, the
// mapping every suite resolves by (ARCHITECTURE → Build and test resolution),
// so the bundle and the Node run execute one tree and no `dist` can make the
// comparison stale.
const WORKSPACE_ALIAS = Object.fromEntries(
  ['types', 'wire', 'validation', 'avltree', 'nipopow', 'consensus', 'net', 'node'].map((pkg) => [
    `@dagsocial/${pkg}`,
    `${PACKAGES_DIR}${pkg}/src/index.ts`,
  ]),
);

/**
 * Fails the build at an import of a Node built-in — `node:`-prefixed, or bare
 * as `node:module`'s `builtinModules` lists it. vite alone refuses only a named
 * import from one: a namespace or a default import builds against an empty
 * stand-in, and a bare `Buffer` or `process` builds untouched. This plugin is
 * the refusal.
 */
function refuseNodeBuiltins(): Plugin {
  const builtins = new Set(builtinModules);
  return {
    name: 'refuse-node-builtins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('node:') || builtins.has(source)) {
        throw new Error(`refuse-node-builtins: "${source}" is a Node built-in, imported by ${importer ?? 'the entry'}`);
      }
      return null;
    },
  };
}

/** Serves `code` as the module `id`, which is no file: a throwaway entry. */
export function entrySource(id: string, code: string): Plugin {
  return {
    name: 'entry-source',
    enforce: 'pre',
    resolveId: (source) => (source === id ? id : null),
    load: (loaded) => (loaded === id ? code : null),
  };
}

export interface Bundle {
  code: string;
  /** Every module the bundle holds, by id. */
  modules: string[];
}

/** `entry` as vite builds it for a browser: one IIFE, ES2022, unminified, nothing written. */
export async function buildIife(entry: string, plugins: Plugin[] = []): Promise<Bundle> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: PACKAGE_DIR,
    resolve: { alias: WORKSPACE_ALIAS },
    plugins: [refuseNodeBuiltins(), ...plugins],
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry, formats: ['iife'], name: 'ConsensusBundle' },
    },
  });
  const chunks = (Array.isArray(result) ? result : [result])
    .flatMap((output) => ('output' in output ? output.output : []))
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk');
  const [chunk] = chunks;
  if (chunks.length !== 1 || chunk === undefined) throw new Error(`the build answered ${chunks.length} chunks, not one`);
  return { code: chunk.code, modules: Object.keys(chunk.modules) };
}
