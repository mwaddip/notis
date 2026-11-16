#!/usr/bin/env node
// TEST_STATE_INTERFACE. CLI with subcommands:
//   fingerprint [--list] [<repo-root>]
//   miner --node-api <url> --mining-secret-path <p>
//         [--interval-ms <N>] [--control-port <N>]
//   generate <state> [--cache <dir>]
//   up <state> --dir <run dir> --http-port --admin-port --p2p-port
//      --faucet-port --miner-port [--interval-ms] [--cache <dir>]
//   down --dir <run dir>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertDistFresh } from './dist-freshness.js';
import { cacheRootDir } from './cache.js';
import { computeFingerprint, fingerprintInputs } from './fingerprint.js';
import { runMiner } from './miner.js';
import { generate } from './generator.js';
import { up, down } from './loader.js';

// The CLI runs from dist/. The fingerprint reads this member's src under
// the digest, so a dist older than src runs code the fingerprint does not
// describe. The refusal is `assertDistFresh`'s, named by package and path.
function refuseStaleSelf(): void {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  try {
    assertDistFresh(['tools/test-state'], repoRoot);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}

function usage(): never {
  console.error(
    'usage:\n' +
      '  dagsocial-test-state fingerprint [--list] [<repo-root>]\n' +
      '  dagsocial-test-state miner --node-api <url> --mining-secret-path <path> ' +
      '[--interval-ms <N>] [--control-port <N>]\n' +
      '  dagsocial-test-state generate <state> [--cache <dir>]\n' +
      '  dagsocial-test-state up <state> --dir <run dir> --http-port <N> ' +
      '--admin-port <N> --p2p-port <N> --faucet-port <N> --miner-port <N> ' +
      '[--interval-ms <N>] [--cache <dir>]\n' +
      '  dagsocial-test-state down --dir <run dir>',
  );
  process.exit(2);
}

function defaultCacheRoot(): string {
  return cacheRootDir(process.env);
}

function repoRootFromCli(): string {
  // The CLI runs from dist/. dist/.. → tools/test-state, tools/test-state/../.. → repo root.
  return resolve(import.meta.dirname, '..', '..', '..');
}

function readNamedArg(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function runFingerprintCmd(args: readonly string[]): void {
  let listFlag = false;
  let rootArg: string | undefined;
  for (const a of args) {
    if (a === '--list') listFlag = true;
    else if (a.startsWith('--')) usage();
    else if (rootArg === undefined) rootArg = a;
    else usage();
  }
  const root = resolve(rootArg ?? process.cwd());
  if (listFlag) {
    for (const { path } of fingerprintInputs(root)) console.log(path);
  } else {
    console.log(computeFingerprint(root));
  }
}

async function runMinerCmd(args: readonly string[]): Promise<void> {
  const nodeApi = readNamedArg(args, '--node-api');
  const miningSecretPath = readNamedArg(args, '--mining-secret-path');
  const intervalMsStr = readNamedArg(args, '--interval-ms') ?? '6000';
  const controlPortStr = readNamedArg(args, '--control-port') ?? '0';
  if (!nodeApi || !miningSecretPath) usage();
  const intervalMs = Number(intervalMsStr);
  const controlPort = Number(controlPortStr);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.error('--interval-ms must be a positive number');
    process.exit(2);
  }
  if (!Number.isFinite(controlPort) || controlPort < 0) {
    console.error('--control-port must be a non-negative number');
    process.exit(2);
  }
  const miningSecret = readFileSync(miningSecretPath, 'utf8').trim();

  const handle = await runMiner({
    nodeApiUrl: nodeApi.replace(/\/+$/, ''),
    miningSecret,
    intervalMs,
    controlPort,
  });
  // The `miner_ready` line belongs to the CLI subcommand — a caller
  // reads it off this process's stdout to know the control port is
  // bound. `runMiner` as a library writes nothing.
  process.stdout.write(
    JSON.stringify({ event: 'miner_ready', controlPort: handle.controlPort }) + '\n',
  );
  await handle.joined;
}

async function runGenerateCmd(args: readonly string[]): Promise<void> {
  const stateName = args[0];
  if (!stateName || stateName.startsWith('--')) usage();
  const cacheRoot = readNamedArg(args.slice(1), '--cache') ?? defaultCacheRoot();
  const repoRoot = repoRootFromCli();
  const result = await generate(stateName!, { repoRoot, cacheRoot });
  console.log(JSON.stringify({
    name: result.manifest.name,
    fingerprint: result.fingerprint,
    cachePath: result.cachePath,
    tip: result.manifest.tip ?? null,
  }));
}

function readPort(args: readonly string[], flag: string): number {
  const v = readNamedArg(args, flag);
  if (v === undefined) {
    console.error(`${flag} is required`);
    process.exit(2);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    console.error(`${flag} must be a non-negative integer in [0, 65535]`);
    process.exit(2);
  }
  return n;
}

async function runUpCmd(args: readonly string[]): Promise<void> {
  const stateName = args[0];
  if (!stateName || stateName.startsWith('--')) usage();
  const dir = readNamedArg(args.slice(1), '--dir');
  if (!dir) {
    console.error('--dir is required');
    process.exit(2);
  }
  const ports = {
    http: readPort(args.slice(1), '--http-port'),
    admin: readPort(args.slice(1), '--admin-port'),
    p2p: readPort(args.slice(1), '--p2p-port'),
    faucet: readPort(args.slice(1), '--faucet-port'),
    miner: readPort(args.slice(1), '--miner-port'),
  };
  const intervalMsStr = readNamedArg(args.slice(1), '--interval-ms');
  const intervalMs = intervalMsStr !== undefined ? Number(intervalMsStr) : undefined;
  const cacheRoot = readNamedArg(args.slice(1), '--cache') ?? defaultCacheRoot();
  const repoRoot = repoRootFromCli();
  const result = await up({
    stateName: stateName!,
    runDir: resolve(dir),
    repoRoot,
    cacheRoot,
    ports,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  });
  console.log(JSON.stringify(result));
}

async function runDownCmd(args: readonly string[]): Promise<void> {
  const dir = readNamedArg(args, '--dir');
  if (!dir) {
    console.error('--dir is required');
    process.exit(2);
  }
  await down(resolve(dir));
}

async function main(): Promise<void> {
  refuseStaleSelf();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'fingerprint':
      runFingerprintCmd(rest);
      return;
    case 'miner':
      await runMinerCmd(rest);
      return;
    case 'generate':
      await runGenerateCmd(rest);
      return;
    case 'up':
      await runUpCmd(rest);
      return;
    case 'down':
      await runDownCmd(rest);
      return;
    case '-h':
    case '--help':
    default:
      usage();
  }
}

await main();
