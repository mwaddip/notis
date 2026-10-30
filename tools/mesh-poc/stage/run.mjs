#!/usr/bin/env node
// MESH_INTERFACE → Acceptance — the entry point for the six scenarios.
// `stage:run [s1 ... s6]` runs the named scenarios in the order given
// (default: all six, in order). Each scenario writes
// `stage/out/scenarios/<name>.json` with every step's verdict and the
// measurement it rests on, and a per-scenario fault log. `--dry-run`
// prints every fault each scenario would apply inside `notismesh-*`
// namespaces (and its removal), and skips the real work; nothing on
// the host is touched.
//
// The driver (`./cdp.mjs`) is the one path to Chromium: `evaluate` and
// `pollEvaluate`, over `127.0.0.1:9222` inside `notismesh-browser`. A
// real scenario calls them via `execIn(ns, [NODE_ABS, cdp.mjs, 'eval',
// url, expr])`; a dry-run skips every call.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTopology } from './lib/topology.mjs';
import * as s1 from './scenarios/s1-no-name.mjs';
import * as s2 from './scenarios/s2-nat.mjs';
import * as s3 from './scenarios/s3-node-goes-away.mjs';
import * as s4 from './scenarios/s4-transport-cut.mjs';
import * as s5 from './scenarios/s5-impersonation.mjs';
import * as s6 from './scenarios/s6-hostile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const OUT_DIR = join(HERE, 'out');
const SCENARIOS_OUT_DIR = join(OUT_DIR, 'scenarios');
const TOPOLOGY_PATH = join(HERE, 'topology.json');
const PIDS_PATH = join(OUT_DIR, 'pids.json');

const SCENARIOS = {
  s1,
  s2,
  s3,
  s4,
  s5,
  s6,
};

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const names = argv.filter((a) => !a.startsWith('--'));
  return { dryRun, names };
}

async function main(argv) {
  const { dryRun, names } = parseArgs(argv);
  const toRun = names.length === 0 ? Object.keys(SCENARIOS) : names;
  for (const name of toRun) {
    if (SCENARIOS[name] === undefined) {
      process.stderr.write(`stage:run: unknown scenario ${JSON.stringify(name)}; known: ${Object.keys(SCENARIOS).join(', ')}\n`);
      process.exit(2);
    }
  }

  const topology = readTopology(TOPOLOGY_PATH);
  const invokingUser = process.env.SUDO_USER ?? process.env.USER;
  if (!invokingUser) {
    process.stderr.write('stage:run: USER is unset — the scenarios run their faults inside stage namespaces\n');
    process.exit(2);
  }
  const nodeBin = process.execPath;
  const meshMain = join(PACKAGE_ROOT, 'dist', 'node', 'main.js');

  // Scenarios ride on top of `stage:up`'s run: `pids.json` holds every
  // process `up` recorded, so a scenario can look up pub1's mesh pid or
  // argv when it needs to signal it. In dry-run `pids.json` may be
  // absent (no stage up yet) — that is tolerated.
  let pids = null;
  try {
    pids = JSON.parse(readFileSync(PIDS_PATH, 'utf8'));
  } catch {
    pids = null;
  }

  if (!dryRun) {
    mkdirSync(SCENARIOS_OUT_DIR, { recursive: true });
  }

  const cdpScript = join(HERE, 'cdp.mjs');

  for (const name of toRun) {
    const scenario = SCENARIOS[name];
    if (dryRun) process.stdout.write(`[scenario:${name}] start\n`);
    const result = await scenario.run({
      dryRun,
      topology,
      pids,
      invokingUser,
      nodeBin,
      meshMain,
      cdpScript,
      outDir: OUT_DIR,
    });
    if (!dryRun) {
      writeFileSync(
        join(SCENARIOS_OUT_DIR, `${name}.json`),
        JSON.stringify(result, null, 2),
      );
    }
    if (dryRun) process.stdout.write(`[scenario:${name}] end (${result.steps.length} step(s); every verdict is skipped under --dry-run)\n`);
  }
  if (dryRun) process.stdout.write(`[dry-run complete] ${toRun.length} scenario(s) listed; no namespace, process, file or fault was created.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`stage:run: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
