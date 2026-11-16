#!/usr/bin/env node
// TEST_STATE_INTERFACE. CLI with subcommands:
//   fingerprint [--list] [<repo-root>]  — the 32-byte digest, or the input paths
//   miner --node-api <url> --mining-secret-path <p>
//         [--interval-ms <N>] [--control-port <N>]  — one miner driving one node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertDistFresh } from './dist-freshness.js';
import { computeFingerprint, fingerprintInputs } from './fingerprint.js';
import { runMiner } from './miner.js';

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
      '[--interval-ms <N>] [--control-port <N>]',
  );
  process.exit(2);
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
  await handle.joined;
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
    case '-h':
    case '--help':
    default:
      usage();
  }
}

await main();
