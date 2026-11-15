#!/usr/bin/env node
// Builds the one tree the .deb, the tarball and the Windows installer carry
// (NODE_INTERFACE → "The packages carry the node as one bundle, beside the
// native modules it loads.").
// Usage: node scripts/bundle-node.mjs --out <dir> [--faucet] [--node-exe <path>]
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
// The repository's real path — every metafile input, every package directory
// the script copies, and every node_modules an undeclared import could walk
// up to lies under it. A path outside is a dependency the tree does not carry
// but that silently rode in from `/home/mwaddip/node_modules` or elsewhere
// (NODE_INTERFACE → "A bundle imports nothing the tree does not carry.").
const REPO_REAL = realpathSync(REPO);

function underRepo(p) {
  const real = realpathSync(p);
  const rel = path.relative(REPO_REAL, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

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
// Refuses to run when a dist entry it bundles is missing (NODE_INTERFACE →
// "The packages carry the node as one bundle, beside the native modules it
// loads.").
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
// The three native modules the bundles leave external (NODE_INTERFACE →
// "The packages carry the node as one bundle, beside the native modules it
// loads."). Each resolves from the package that imports it, so a dependency
// the importer declares cannot be hidden by a hoist.
// ---------------------------------------------------------------------------

const NATIVES = ['better-sqlite3', 'node-datachannel', 'cbor-extract'];
const BUILTIN_NAMES = new Set(builtinModules);

// `packages/node` imports better-sqlite3 and cbor-x directly; `cbor-extract`
// is carried transitively through `cbor-x`. `node-datachannel` is carried
// through `@libp2p/webrtc`, which `packages/net` depends on.
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
  // Fall back: resolve the package's main entry, then walk upward until the
  // directory has a package.json whose name is this one. @libp2p/webrtc's
  // `exports` map holds '.' and no './package.json'.
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

// ---------------------------------------------------------------------------
// Prepare the output tree
// ---------------------------------------------------------------------------

rmSync(args.out, { recursive: true, force: true });
mkdirSync(path.join(args.out, 'dist'), { recursive: true });
mkdirSync(path.join(args.out, 'scripts'), { recursive: true });
mkdirSync(path.join(args.out, 'node_modules'), { recursive: true });

// ---------------------------------------------------------------------------
// Bundle each entry — ESM, node24, the three natives external. Any warning
// fails the build. A banner gives bundled CommonJS a real `require`; its
// binding is named so nothing in the bundle collides with it.
// ---------------------------------------------------------------------------

const BANNER_CODE = [
  "import { createRequire as __notisCreateRequire } from 'node:module';",
  "const require = __notisCreateRequire(import.meta.url);",
].join(' ');

// `ws` carries optional native accelerators it loads with `require()` inside
// a try/catch. The plugin inlines a stub that throws MODULE_NOT_FOUND, so
// `ws` takes its pure-JS path and the bundle imports nothing outside the
// three natives and Node built-ins.
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
// Every external import must be a Node built-in or one of the three natives
// (NODE_INTERFACE → "A bundle imports nothing the tree does not carry.").
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
  // Every file input lies under the repository's real path. A dependency the
  // tree does not declare but that resolved above the repo is caught here
  // rather than by the build happening to run under /tmp.
  for (const inputPath of Object.keys(metafiles[e.name].inputs)) {
    if (inputPath.includes(':')) continue;
    const abs = path.resolve(REPO, inputPath);
    if (!existsSync(abs)) die(`${e.name} input ${inputPath} does not exist`);
    if (!underRepo(abs)) die(`${e.name} input ${inputPath} resolves outside the repository`);
  }
}

// ---------------------------------------------------------------------------
// Copy packages/node/scripts/{miner.mjs,gen-miner-key.mjs} byte-identical
// ---------------------------------------------------------------------------

for (const name of ['miner.mjs', 'gen-miner-key.mjs']) {
  copyFileSync(path.join(REPO, 'packages/node/scripts', name), path.join(args.out, 'scripts', name));
}

// ---------------------------------------------------------------------------
// Copy the three native modules with what each loads, at the installed
// versions, the build platform's binary alone. Each resolves from its
// importer (see NATIVE_IMPORTERS). Leaves out source maps, declaration
// files, .md files but LICEN[CS]E, source trees, other platforms' binaries.
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
  const root = path.dirname(realpathSync(resolvedPkgJsonPath));
  if (!underRepo(root)) {
    die(`${resolvedPkgJsonPath} resolves to ${root}, outside the repository`);
  }
  return root;
}

// Resolve a dependency's package.json through either pkgJsonOf form — a
// dependency whose `exports` leaves package.json out is resolved by walking
// up from its entry.
function resolveDepPkgJson(fromPkgJson, name) {
  return pkgJsonOf(fromPkgJson, name);
}

// better-sqlite3: lib/, binding.js, package.json, LICENSE, and the build
// platform's one prebuild. No deps/, src/, binding.gyp, no other platforms'
// prebuilds.
const bsq3Root = pkgRootOf(resolveDepPkgJson(NATIVE_IMPORTERS['better-sqlite3'], 'better-sqlite3'));
{
  const dst = path.join(args.out, 'node_modules/better-sqlite3');
  copyPackageTree(bsq3Root, dst, {
    skipDirs: new Set(['deps', 'src', 'prebuilds']),
    filter: (rel) => rel !== 'binding.gyp',
  });
  const target = selectBsq3PrebuildName();
  const srcPre = path.join(bsq3Root, 'prebuilds', `${target}.node`);
  if (!existsSync(srcPre)) die(`better-sqlite3 has no prebuild for ${target} at ${srcPre}`);
  mkdirSync(path.join(dst, 'prebuilds'), { recursive: true });
  copyFileSync(srcPre, path.join(dst, 'prebuilds', `${target}.node`));
}

function selectBsq3PrebuildName() {
  // Mirrors better-sqlite3/lib/binding.js: linuxmusl on musl, linux-<arch>
  // otherwise.
  if (process.platform === 'linux') {
    const header = process.report.getReport().header;
    const musl = !header.glibcVersionRuntime;
    return `${musl ? 'linuxmusl' : 'linux'}-${process.arch}`;
  }
  return `${process.platform}-${process.arch}`;
}

// node-datachannel: the dist tree (cjs/esm/types), the package.json, every
// root licence/copying/notice file, and the build platform's
// @node-datachannel/<platform> subpackage plus the detect-libc it loads.
const ndcPkgJson = resolveDepPkgJson(NATIVE_IMPORTERS['node-datachannel'], 'node-datachannel');
const ndcRoot = pkgRootOf(ndcPkgJson);
{
  const dst = path.join(args.out, 'node_modules/node-datachannel');
  copyPackageTree(ndcRoot, dst, {
    skipDirs: new Set(['src']),
    filter: (rel) => {
      if (rel === 'package.json') return true;
      if (rel.startsWith('dist/')) return true;
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
  // Mirrors node-datachannel's getPackageName — platform + arch + the libc
  // family on Linux.
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

// cbor-extract: the loader (index.js), its node-gyp-build-optional-packages
// dependency and detect-libc (both loaded at runtime), plus the build
// platform's @cbor-extract/cbor-extract-<platform> subpackage.
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
// node-gyp-build-optional-packages loads detect-libc on Linux. The
// node-datachannel branch above already placed it; copy here only if
// missing, so a tree without libp2p-webrtc still carries the one dependency
// cbor-extract reads at runtime.
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
  // Mirrors node-gyp-build-optional-packages' naming — platform + arch.
  const { platform, arch } = process;
  return `@cbor-extract/cbor-extract-${platform}-${arch}`;
}

// ---------------------------------------------------------------------------
// Load each native from <out> alone, so a tree that lacks a package one of
// them loads fails here. cbor-extract must load its binary (not fall back).
// NODE_INTERFACE → "A bundle imports nothing the tree does not carry." —
// the second half.
// ---------------------------------------------------------------------------

writeFileSync(path.join(args.out, 'package.json'), JSON.stringify({
  name: 'dagsocial',
  version: readJson(path.join(REPO, 'package.json')).version,
  private: true,
  type: 'module',
}, null, 2) + '\n');

// Load each native from <out> alone and reach its binary. better-sqlite3's
// .node file loads only when a database opens, so open an in-memory one and
// close it. cbor-extract's binary rides on its loader's own require, so
// extractStrings being a function is enough — the JS path has no such
// function. Every require.cache key the load adds lies under <out>'s real
// path, else fail naming it: a dependency the tree lacks must not be found
// in a node_modules above the output.
const OUT_REAL = realpathSync(args.out);
{
  const req = createRequire(path.join(args.out, 'package.json'));
  const beforeKeys = new Set(Object.keys(req.cache));
  for (const name of NATIVES) {
    let mod;
    try {
      mod = req(name);
    } catch (err) {
      die(`${name} does not load from <out>: ${err && err.message ? err.message : err}`);
    }
    if (!mod) die(`${name} loaded from <out> as ${typeof mod}`);
    if (name === 'better-sqlite3') {
      try {
        const db = new mod(':memory:');
        db.close();
      } catch (err) {
        die(`better-sqlite3 loads but cannot open a database: ${err && err.message ? err.message : err}`);
      }
    } else if (name === 'cbor-extract') {
      if (typeof mod.extractStrings !== 'function') {
        die('cbor-extract loaded but has no extractStrings — JS fallback, not the native binary');
      }
    }
  }
  for (const key of Object.keys(req.cache)) {
    if (beforeKeys.has(key)) continue;
    const real = realpathSync(key);
    const rel = path.relative(OUT_REAL, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      die(`load check reached ${key} (${real}), outside <out>`);
    }
  }
}

// ---------------------------------------------------------------------------
// Repository LICENSE and THIRD-PARTY-LICENSES (NODE_INTERFACE → "The tree
// carries the licence of everything it carries."). Enumerates every package
// whose files any bundle included, from the metafiles' input paths.
// ---------------------------------------------------------------------------

copyFileSync(path.join(REPO, 'LICENSE'), path.join(args.out, 'LICENSE'));

const licensed = new Map(); // key: name@version -> { name, version, files: [{ name, text }] }
const repoRootPkgName = readJson(path.join(REPO, 'package.json')).name;
for (const e of ENTRIES) {
  for (const inputPath of Object.keys(metafiles[e.name].inputs)) {
    // A metafile input is a real file on disk when its key is a plain path; a
    // plugin-provided module is namespaced as `<namespace>:<name>` and walks up
    // to no package of its own. Skip anything that is not a file input.
    if (inputPath.includes(':')) continue;
    const abs = path.resolve(REPO, inputPath);
    const pkg = nearestPackageJson(abs);
    if (!pkg) continue;
    const info = readJson(pkg);
    if (!info.name) continue;
    // The repository's own packages — the `@dagsocial/*` members and the root
    // `dagsocial` package — are covered by LICENSE. Listing them here would
    // double-count (nothing in the tree is third-party about them).
    if (info.name.startsWith('@dagsocial/')) continue;
    if (info.name === repoRootPkgName) continue;
    const key = `${info.name}@${info.version ?? '0.0.0'}`;
    if (licensed.has(key)) continue;
    const dir = path.dirname(pkg);
    const files = readLicenceFiles(dir, info);
    licensed.set(key, { name: info.name, version: info.version ?? '0.0.0', files });
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

// Every root file whose name starts with LICEN[CS]E, COPYING or NOTICE (any
// case) — the full set, so a package shipping LICENSE and NOTICE keeps both,
// and a dual-licenced one shipping LICENSE-MIT and LICENSE-APACHE keeps both.
// Sorted by code units so two readers of one directory read the same order.
function readLicenceFiles(dir, info) {
  const names = readdirSync(dir)
    .filter((n) => /^(LICEN[CS]E|COPYING|NOTICE)([._-].*)?$/i.test(n))
    .filter((n) => statSync(path.join(dir, n)).isFile())
    .sort();
  if (names.length === 0) {
    const license = typeof info.license === 'string'
      ? info.license
      : JSON.stringify(info.license ?? 'UNKNOWN');
    return [{ name: 'package.json', text: `License: ${license}\n` }];
  }
  return names.map((n) => ({ name: n, text: readFileSync(path.join(dir, n), 'utf8') }));
}

{
  // Code units, never `localeCompare` — the builder's locale would otherwise
  // sort two hosts' output differently.
  const sorted = Array.from(licensed.values()).sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    if (a.version < b.version) return -1;
    if (a.version > b.version) return 1;
    return 0;
  });
  const bar = '='.repeat(78);
  const parts = [
    'THIRD-PARTY-LICENSES\n\n',
    "This tree bundles the packages below. Each section carries the package's own licence files, or the licence its package.json names where it ships none.\n\n",
    `${sorted.length} packages.\n`,
  ];
  for (const row of sorted) {
    parts.push(`\n${bar}\n${row.name}@${row.version}\n${bar}\n`);
    for (const f of row.files) {
      parts.push(`\n--- ${f.name} ---\n\n${f.text.endsWith('\n') ? f.text : f.text + '\n'}`);
    }
  }
  writeFileSync(path.join(args.out, 'THIRD-PARTY-LICENSES'), parts.join(''));
}

// ---------------------------------------------------------------------------
// NODE_INTERFACE → "A package build runs the node it built." — starts
// <out>/dist/node.js on devnet with PORT=0 and ADMIN_PORT=0, reads the bound
// API port off the node's `api_listening` journal line, and waits for
// GET /blocks/current to answer with a height.
// ---------------------------------------------------------------------------

// Every variable packages/node/src/config.ts reads whose presence in the
// inherited environment would change a plain devnet start. The check empties
// each one on the child's env, then sets the few the check itself names.
const CONFIG_ENV_VARS = [
  'NETWORK_TYPE', 'DB_PATH', 'PORT', 'ADMIN_PORT', 'ADMIN_BIND_ADDRESS',
  'NODE_KEY_PATH', 'NODE_ROLE', 'WEB_SHELL_PATH',
  'BLOCK_BODY_BUDGET_BYTES', 'MAX_MEMPOOL_ENTRIES', 'MIN_FEE_RATE_PER_BYTE',
  'MINING_SECRET',
  'MAX_PROOF_HISTORY', 'PROOF_RETENTION_BLOCKS', 'PROOF_RETENTION_BYTES',
  'PROOF_WINDOW_BLOCKS', 'PROOF_WINDOW_NODES',
  'BOOTSTRAP_PEERS', 'LISTEN_ADDRS',
  'MAX_PEERS', 'MAX_READERS', 'MIN_PEERS', 'PEER_DB_CAP',
  'OUTBOUND_REDIAL_COOLDOWN_MS', 'PENALTY_SCORE_THRESHOLD',
  'TEMPORAL_BAN_DURATION_MS', 'PENALTY_DECAY_INTERVAL_MS',
  'SYNC_REQUEST_TIMEOUT_MS',
  'MESH_ROLE', 'MESH_LISTEN', 'MESH_ANNOUNCE', 'MESH_STUN',
  'MESH_STUN_SERVERS', 'MESH_WSS', 'MESH_ACME_DIRECTORY',
  'MESH_ACME_CHALLENGE_PORT',
];

await startNodeAndWait(args.out, args.nodeExe);
console.log(`bundle-node: ${args.out}`);

async function startNodeAndWait(outDir, nodeExe) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dagsocial-bundle-check-'));
  const env = { ...process.env };
  for (const name of CONFIG_ENV_VARS) delete env[name];
  Object.assign(env, {
    NETWORK_TYPE: 'devnet',
    NODE_ROLE: 'server',
    DB_PATH: path.join(stateDir, 'node.db'),
    NODE_KEY_PATH: path.join(stateDir, 'node.key'),
    ADMIN_BIND_ADDRESS: '127.0.0.1',
    LISTEN_ADDRS: '/ip4/127.0.0.1/tcp/0',
    BOOTSTRAP_PEERS: '',
    PORT: '0',
    ADMIN_PORT: '0',
  });
  const logChunks = [];
  const child = spawn(nodeExe, [path.join(outDir, 'dist/node.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The exit promise is taken at spawn: a child that exits before the
  // timeout's `once('exit')` is attached would otherwise hang the cleanup.
  const exited = new Promise((r) => child.once('exit', r));
  let logBuffered = '';
  child.stdout.on('data', (b) => {
    logChunks.push(b);
    logBuffered += b.toString('utf8');
  });
  child.stderr.on('data', (b) => { logChunks.push(b); });
  const deadline = Date.now() + 60_000;
  let ok = false;
  let boundPort = null;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (boundPort === null) boundPort = readBoundPort(logBuffered);
      if (boundPort !== null) {
        try {
          const res = await fetch(`http://127.0.0.1:${boundPort}/blocks/current`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) {
            const body = await res.json();
            if (typeof body.height === 'number') { ok = true; break; }
          }
        } catch {}
      }
      await sleep(250);
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      // SIGKILL if SIGTERM does not land within 10 s — a node that will not
      // quit does not keep the bundler running.
      const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(killer);
    } else {
      await exited;
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
  if (!ok) {
    process.stderr.write(Buffer.concat(logChunks).toString('utf8'));
    die('the built node did not answer GET /blocks/current under 60 s');
  }
}

function readBoundPort(stdoutText) {
  // Every journal event is one JSON line on stdout; `api_listening` carries
  // the actual bound port the node's listener read off the socket.
  for (const line of stdoutText.split('\n')) {
    if (!line.includes('"event":"api_listening"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.port === 'number' && obj.port > 0) return obj.port;
    } catch {}
  }
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
