#!/usr/bin/env node
// NODE_INTERFACE → "The packages carry the node as one bundle, beside the native modules it loads." — builds the one tree the .deb, the tarball and the Windows installer carry.
// Usage: node scripts/bundle-node.mjs --out <dir> [--faucet] [--node-exe <path>]
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: null, faucet: false, nodeExe: process.execPath };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--faucet') out.faucet = true;
    else if (a === '--node-exe') out.nodeExe = argv[++i];
    else die(`unknown argument: ${a}`);
  }
  if (!out.out) die('missing --out <dir>');
  out.out = path.resolve(out.out);
  return out;
}

function die(msg) {
  console.error(`bundle-node: ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Refuses to run when a dist entry it bundles is missing — NODE_INTERFACE → "The packages carry the node as one bundle, beside the native modules it loads."
// ---------------------------------------------------------------------------

const ENTRIES = [
  { name: 'node',              src: 'packages/node/dist/index.js',            dst: 'dist/node.js' },
  { name: 'miner-consolidate', src: 'packages/node/dist/miner-consolidate.js', dst: 'dist/miner-consolidate.js' },
];
if (args.faucet) {
  ENTRIES.push({ name: 'faucet', src: 'tools/faucet/dist/index.js', dst: 'dist/faucet.js' });
}

for (const e of ENTRIES) {
  const p = path.join(REPO, e.src);
  if (!existsSync(p)) die(`${e.src} is missing — run pnpm build before bundling`);
}

// ---------------------------------------------------------------------------
// The three native modules the bundles leave external — NODE_INTERFACE → "The packages carry the node as one bundle, beside the native modules it loads.".
// Each resolves from the package that imports it (not from the repo root), so a dependency the importer declares cannot be hidden by a hoist.
// ---------------------------------------------------------------------------

const NATIVES = ['better-sqlite3', 'node-datachannel', 'cbor-extract'];
const BUILTIN_NAMES = new Set(builtinModules);

// `packages/node` carries better-sqlite3 and cbor-x; `packages/net` carries @libp2p/webrtc. Each native's importer is the workspace member that depends on it, not a transitive chain. The two resolver forms carry each importer's own package.json where the dependency exports it, and otherwise walk up from a resolved entry — @libp2p/webrtc's exports map leaves package.json out.
const NATIVE_IMPORTERS = {
  'better-sqlite3':   path.join(REPO, 'packages/node/package.json'),
  'node-datachannel': pkgJsonOf(path.join(REPO, 'packages/net/package.json'),  '@libp2p/webrtc'),
  'cbor-extract':     pkgJsonOf(path.join(REPO, 'packages/node/package.json'), 'cbor-x'),
};

function pkgJsonOf(fromPkgJson, name) {
  const req = createRequire(fromPkgJson);
  try {
    return req.resolve(`${name}/package.json`);
  } catch {}
  // Fall back: resolve the package's main entry, then walk upward until the directory has a package.json whose name is this one. @libp2p/webrtc exports '.' but not './package.json'.
  const entry = req.resolve(name);
  let dir = path.dirname(entry);
  while (true) {
    const p = path.join(dir, 'package.json');
    if (existsSync(p)) {
      const info = readJson(p);
      if (info.name === name) return p;
    }
    const parent = path.dirname(dir);
    if (parent === dir) die(`cannot locate package.json for ${name} from ${fromPkgJson}`);
    dir = parent;
  }
}

function resolveFrom(fromPkgJson, spec) {
  return createRequire(fromPkgJson).resolve(spec);
}

// ---------------------------------------------------------------------------
// Prepare the output tree
// ---------------------------------------------------------------------------

rmSync(args.out, { recursive: true, force: true });
mkdirSync(path.join(args.out, 'dist'), { recursive: true });
mkdirSync(path.join(args.out, 'scripts'), { recursive: true });
mkdirSync(path.join(args.out, 'node_modules'), { recursive: true });

// ---------------------------------------------------------------------------
// Bundle each entry — ESM, node24, the three natives external. Any warning fails the build.
// A banner gives bundled CommonJS a real `require`; the binding is named so nothing in the bundle can collide with it.
// ---------------------------------------------------------------------------

const BANNER_CODE = [
  "import { createRequire as __notisCreateRequire } from 'node:module';",
  "const require = __notisCreateRequire(import.meta.url);",
].join(' ');

// `ws` carries optional native accelerators it loads with `require()` inside a try/catch; bundling with the tree's three externals alone leaves the bare names as external imports the tree does not carry. The plugin inlines a stub that throws MODULE_NOT_FOUND, so `ws`'s catch sees the same error it would on a host without them and takes its pure-JS path.
const OPTIONAL_STUBS = new Set(['bufferutil', 'utf-8-validate']);
const optionalStubPlugin = {
  name: 'notis-optional-stubs',
  setup(build) {
    build.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (arg) => ({
      path: arg.path, namespace: 'notis-optional-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'notis-optional-stub' }, (arg) => ({
      contents: `const e = new Error("Cannot find module '${arg.path}'"); e.code = 'MODULE_NOT_FOUND'; throw e;`,
      loader: 'js',
    }));
  },
};

const metafiles = {};
for (const e of ENTRIES) {
  const result = await esbuild.build({
    entryPoints: [path.join(REPO, e.src)],
    outfile: path.join(args.out, e.dst),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    minify: false,
    sourcemap: false,
    external: NATIVES,
    plugins: [optionalStubPlugin],
    banner: { js: BANNER_CODE },
    logLevel: 'silent',
    metafile: true,
    absWorkingDir: REPO,
    allowOverwrite: false,
  });
  if (result.warnings.length) {
    for (const w of result.warnings) console.error(`esbuild warning in ${e.name}: ${w.text}`);
    die(`${e.name} bundle produced ${result.warnings.length} warning(s)`);
  }
  metafiles[e.name] = result.metafile;
}

// ---------------------------------------------------------------------------
// Enforce NODE_INTERFACE → "A bundle imports nothing the tree does not carry." — every external import must be a Node built-in or one of the three natives.
// ---------------------------------------------------------------------------

function externalImports(metafile, entryOutput) {
  const exts = new Set();
  const out = metafile.outputs[entryOutput];
  if (!out) throw new Error(`metafile has no entry for ${entryOutput}`);
  for (const imp of out.imports ?? []) {
    if (imp.external) exts.add(imp.path);
  }
  return exts;
}

function isBuiltin(spec) {
  if (spec.startsWith('node:')) return true;
  return BUILTIN_NAMES.has(spec);
}

function isAllowedNativeImport(spec) {
  // `node-datachannel/polyfill` is a subpath of a native, not a second package.
  for (const n of NATIVES) {
    if (spec === n) return true;
    if (spec.startsWith(`${n}/`)) return true;
  }
  return false;
}

for (const e of ENTRIES) {
  const outKey = path.relative(REPO, path.join(args.out, e.dst)).replaceAll(path.sep, '/');
  const exts = externalImports(metafiles[e.name], outKey);
  for (const spec of exts) {
    if (isBuiltin(spec)) continue;
    if (isAllowedNativeImport(spec)) continue;
    die(`${e.name} imports ${spec}, which is neither a Node built-in nor one of ${NATIVES.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Copy packages/node/scripts/{miner.mjs,gen-miner-key.mjs} byte-identical
// ---------------------------------------------------------------------------

for (const name of ['miner.mjs', 'gen-miner-key.mjs']) {
  copyFileSync(path.join(REPO, 'packages/node/scripts', name), path.join(args.out, 'scripts', name));
}

// ---------------------------------------------------------------------------
// Copy the three native modules with what each loads, at the installed versions, the build platform's binary alone.
// Each resolved from its importer (see NATIVE_IMPORTERS). Leaves out source maps, declaration files, .md files but LICEN[CS]E, source trees, other platforms' binaries.
// ---------------------------------------------------------------------------

const RUNTIME_FILE_EXTS_OUT = new Set(['.map', '.d.ts', '.d.cts', '.d.mts', '.ts', '.tsx']);
function keepFile(p) {
  const base = path.basename(p);
  if (base.endsWith('.map')) return false;
  if (base.endsWith('.d.ts') || base.endsWith('.d.cts') || base.endsWith('.d.mts')) return false;
  const ext = path.extname(base).toLowerCase();
  if (RUNTIME_FILE_EXTS_OUT.has(ext)) return false;
  if (/\.md$/i.test(base)) {
    // Keep licence/copying/notice files that live at a package root; drop every other .md.
    return /^(LICEN[CS]E|COPYING|NOTICE)([._-].*)?$/i.test(base);
  }
  return true;
}

function copyPackageTree(srcPkgDir, dstPkgDir, opts = {}) {
  const { skipDirs = new Set(), filter } = opts;
  function walk(from, to) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const s = path.join(from, name);
      const t = path.join(to, name);
      const st = statSync(s);
      if (st.isDirectory()) {
        if (skipDirs.has(name)) continue;
        if (name === 'node_modules') continue;
        walk(s, t);
      } else if (st.isFile()) {
        if (!keepFile(s)) continue;
        if (filter && !filter(path.relative(srcPkgDir, s))) continue;
        copyFileSync(s, t);
      }
    }
  }
  walk(srcPkgDir, dstPkgDir);
}

function pkgRootOf(resolvedPkgJsonPath) {
  return path.dirname(realpathSync(resolvedPkgJsonPath));
}

// Resolve a dependency's package.json through either pkgJsonOf form — a dependency whose `exports` leaves package.json out is resolved by walking up from its entry.
function resolveDepPkgJson(fromPkgJson, name) {
  return pkgJsonOf(fromPkgJson, name);
}

// better-sqlite3: lib/, binding.js, package.json, LICENSE, and the build platform's one prebuild. No deps/, src/, binding.gyp, no other platforms' prebuilds.
const bsq3Root = pkgRootOf(resolveDepPkgJson(NATIVE_IMPORTERS['better-sqlite3'], 'better-sqlite3'));
{
  const dst = path.join(args.out, 'node_modules/better-sqlite3');
  copyPackageTree(bsq3Root, dst, {
    skipDirs: new Set(['deps', 'src', 'prebuilds']),
    filter: (rel) => rel !== 'binding.gyp',
  });
  // Pick the one prebuild the running platform loads (lib/binding.js chooses linuxmusl on musl).
  const target = selectBsq3PrebuildName();
  const srcPre = path.join(bsq3Root, 'prebuilds', `${target}.node`);
  if (!existsSync(srcPre)) die(`better-sqlite3 has no prebuild for ${target} at ${srcPre}`);
  mkdirSync(path.join(dst, 'prebuilds'), { recursive: true });
  copyFileSync(srcPre, path.join(dst, 'prebuilds', `${target}.node`));
}

function selectBsq3PrebuildName() {
  // Mirrors better-sqlite3/lib/binding.js — NODE_INTERFACE → "The packages carry the node as one bundle, beside the native modules it loads.".
  if (process.platform === 'linux') {
    const header = process.report.getReport().header;
    const musl = !header.glibcVersionRuntime;
    return `${musl ? 'linuxmusl' : 'linux'}-${process.arch}`;
  }
  return `${process.platform}-${process.arch}`;
}

// node-datachannel: the dist tree (cjs/esm/types), its root files, plus detect-libc and the build platform's @node-datachannel/<platform> package.
const ndcPkgJson = resolveDepPkgJson(NATIVE_IMPORTERS['node-datachannel'], 'node-datachannel');
const ndcRoot = pkgRootOf(ndcPkgJson);
{
  const dst = path.join(args.out, 'node_modules/node-datachannel');
  // Keep only what the module loads at runtime from its own tree: the dist/ outputs and the package.json/LICENSE. Drop the source tree, configs and README.
  copyPackageTree(ndcRoot, dst, {
    skipDirs: new Set(['src']),
    filter: (rel) => {
      if (rel === 'package.json') return true;
      if (rel.startsWith('dist/')) return true;
      // Keep LICENSE at root; keepFile already filtered .md but allow licence markdowns.
      const base = path.basename(rel);
      if (/^(LICEN[CS]E|COPYING|NOTICE)([._-].*)?$/i.test(base)) return true;
      return false;
    },
  });
}

// detect-libc — the one dependency node-datachannel loads at runtime.
{
  const detectRoot = pkgRootOf(resolveDepPkgJson(ndcPkgJson, 'detect-libc'));
  copyPackageTree(detectRoot, path.join(args.out, 'node_modules/detect-libc'));
}

// The build platform's @node-datachannel/<platform> subpackage.
{
  const sub = ndcPlatformPackage();
  const subRoot = pkgRootOf(resolveDepPkgJson(ndcPkgJson, sub));
  copyPackageTree(subRoot, path.join(args.out, 'node_modules', sub));
}

function ndcPlatformPackage() {
  // Mirrors node-datachannel's getPackageName — NODE_INTERFACE → "The packages carry the node as one bundle, beside the native modules it loads.".
  const { platform, arch } = process;
  if (platform === 'linux') {
    const glibc = process.report.getReport().header.glibcVersionRuntime != null;
    const libc = glibc ? 'gnu' : 'musl';
    if (arch === 'x64') return `@node-datachannel/linux-x64-${libc}`;
    if (arch === 'arm64') return `@node-datachannel/linux-arm64-${libc}`;
  } else if (platform === 'darwin') {
    if (arch === 'arm64') return '@node-datachannel/darwin-arm64';
    if (arch === 'x64') return '@node-datachannel/darwin-x64';
  } else if (platform === 'win32') {
    if (arch === 'x64') return '@node-datachannel/win32-x64-msvc';
    if (arch === 'arm64') return '@node-datachannel/win32-arm64-msvc';
  }
  die(`node-datachannel: no subpackage for ${platform}-${arch}`);
}

// cbor-extract: the loader (index.js), its node-gyp-build-optional-packages dependency and detect-libc (both loaded at runtime), plus the build platform's @cbor-extract/cbor-extract-<platform> subpackage.
const cbxPkgJson = resolveDepPkgJson(NATIVE_IMPORTERS['cbor-extract'], 'cbor-extract');
const cbxRoot = pkgRootOf(cbxPkgJson);
{
  copyPackageTree(cbxRoot, path.join(args.out, 'node_modules/cbor-extract'), {
    skipDirs: new Set(['src', 'bin']),
    filter: (rel) => rel !== 'binding.gyp',
  });
}
const gypPkgJson = resolveDepPkgJson(cbxPkgJson, 'node-gyp-build-optional-packages');
{
  copyPackageTree(pkgRootOf(gypPkgJson), path.join(args.out, 'node_modules/node-gyp-build-optional-packages'));
}
// node-gyp-build-optional-packages loads detect-libc on Linux — keep it available at the top level so a nested resolution reaches the same one. The node-datachannel branch above already placed it when the chain depends on it; copy here only if missing.
if (!existsSync(path.join(args.out, 'node_modules/detect-libc'))) {
  const detectRoot = pkgRootOf(resolveDepPkgJson(gypPkgJson, 'detect-libc'));
  copyPackageTree(detectRoot, path.join(args.out, 'node_modules/detect-libc'));
}
{
  const sub = cbxPlatformPackage();
  const subRoot = pkgRootOf(resolveDepPkgJson(cbxPkgJson, sub));
  copyPackageTree(subRoot, path.join(args.out, 'node_modules', sub));
}

function cbxPlatformPackage() {
  // Mirrors node-gyp-build-optional-packages' naming — NODE_INTERFACE → "The packages carry the node as one bundle, beside the native modules it loads.".
  const { platform, arch } = process;
  return `@cbor-extract/cbor-extract-${platform}-${arch}`;
}

// ---------------------------------------------------------------------------
// Load each native from <out> alone, so a tree that lacks a package one of them loads fails here. cbor-extract must load its binary (not fall back).
// NODE_INTERFACE → "A bundle imports nothing the tree does not carry." — the second half.
// ---------------------------------------------------------------------------

writeFileSync(path.join(args.out, 'package.json'), JSON.stringify({
  name: 'dagsocial',
  version: readJson(path.join(REPO, 'package.json')).version,
  private: true,
  type: 'module',
}, null, 2) + '\n');

{
  const req = createRequire(path.join(args.out, 'package.json'));
  for (const name of NATIVES) {
    try {
      const mod = req(name);
      if (!mod) die(`${name} loaded from <out> as ${typeof mod}`);
      if (name === 'cbor-extract') {
        if (typeof mod.extractStrings !== 'function') die('cbor-extract loaded but has no extractStrings — JS fallback, not the native binary');
      }
    } catch (err) {
      die(`${name} does not load from <out>: ${err && err.message ? err.message : err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Repository LICENSE and THIRD-PARTY-LICENSES — NODE_INTERFACE → "The tree carries the licence of everything it carries."
// Enumerates every package whose files any bundle included, from the metafiles' input paths.
// ---------------------------------------------------------------------------

copyFileSync(path.join(REPO, 'LICENSE'), path.join(args.out, 'LICENSE'));

const licensed = new Map(); // key: name@version -> { name, version, text }
for (const e of ENTRIES) {
  for (const inputPath of Object.keys(metafiles[e.name].inputs)) {
    if (inputPath.startsWith('(disabled):')) continue;
    const abs = path.resolve(REPO, inputPath);
    const pkg = nearestPackageJson(abs);
    if (!pkg) continue;
    const info = readJson(pkg);
    if (!info.name) continue;
    if (info.name.startsWith('@dagsocial/')) continue; // the repository's own, covered by LICENSE.
    const key = `${info.name}@${info.version ?? '0.0.0'}`;
    if (licensed.has(key)) continue;
    const dir = path.dirname(pkg);
    const text = readLicenceText(dir, info);
    licensed.set(key, { name: info.name, version: info.version ?? '0.0.0', text });
  }
}

function nearestPackageJson(from) {
  let dir = path.dirname(from);
  while (true) {
    const p = path.join(dir, 'package.json');
    if (existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readLicenceText(dir, info) {
  for (const name of readdirSync(dir)) {
    if (/^(LICEN[CS]E|COPYING|NOTICE)([._-].*)?$/i.test(name)) {
      const p = path.join(dir, name);
      if (statSync(p).isFile()) return readFileSync(p, 'utf8');
    }
  }
  return `License: ${typeof info.license === 'string' ? info.license : JSON.stringify(info.license ?? 'UNKNOWN')}\n`;
}

{
  const sorted = Array.from(licensed.values()).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const parts = [`THIRD-PARTY-LICENSES\n\nThis tree bundles the packages below. Each section carries the package's own licence text, or the licence its package.json names where it ships none.\n\n${sorted.length} packages.\n`];
  for (const row of sorted) {
    parts.push(`\n${'='.repeat(78)}\n${row.name}@${row.version}\n${'='.repeat(78)}\n\n${row.text.endsWith('\n') ? row.text : row.text + '\n'}`);
  }
  writeFileSync(path.join(args.out, 'THIRD-PARTY-LICENSES'), parts.join(''));
}

// ---------------------------------------------------------------------------
// NODE_INTERFACE → "A package build runs the node it built." — starts <out>/dist/node.js on devnet, waits for GET /blocks/current to answer with a height.
// ---------------------------------------------------------------------------

await startNodeAndWait(args.out, args.nodeExe);
console.log(`bundle-node: ${args.out}`);

async function startNodeAndWait(outDir, nodeExe) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dagsocial-bundle-check-'));
  // Any ports but 3000 and 3001 (the user's own node may be on 3000). A fresh ephemeral range picks one above 20000, both >= three apart so admin does not collide.
  const port = pickEphemeralPort();
  const adminPort = port + 1;
  const env = {
    ...process.env,
    NETWORK_TYPE: 'devnet',
    DB_PATH: path.join(stateDir, 'node.db'),
    NODE_KEY_PATH: path.join(stateDir, 'node.key'),
    ADMIN_BIND_ADDRESS: '127.0.0.1',
    LISTEN_ADDRS: '/ip4/127.0.0.1/tcp/0',
    BOOTSTRAP_PEERS: '',
    PORT: String(port),
    ADMIN_PORT: String(adminPort),
  };
  const logChunks = [];
  const child = spawn(nodeExe, [path.join(outDir, 'dist/node.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => logChunks.push(b));
  child.stderr.on('data', (b) => logChunks.push(b));
  const deadline = Date.now() + 60_000;
  let ok = false;
  try {
    while (Date.now() < deadline) {
      await sleep(500);
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/blocks/current`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const body = await res.json();
          if (typeof body.height === 'number') { ok = true; break; }
        }
      } catch {}
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGINT');
      await new Promise((r) => child.once('exit', r));
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
  if (!ok) {
    const out = Buffer.concat(logChunks).toString('utf8');
    process.stderr.write(out);
    die('the built node did not answer GET /blocks/current under 60 s');
  }
}

function pickEphemeralPort() {
  // 21000 is well above the user's 3000/3001 ceiling, well below the ephemeral range Linux assigns above 32768. Deterministic per run, PID-salted so two parallel checks do not collide.
  return 21000 + (process.pid % 1000) * 4;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
