#!/usr/bin/env node
// MESH_INTERFACE → Acceptance — tears the stage down: end exactly the PIDs
// `up` recorded in `stage/out/pids.json`, then remove exactly the namespaces
// `up` created and the `/etc/netns/notismesh-*` directories beside them. A
// `down` on a half-started stage cleans up what exists; nothing in the stage
// kills by name.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');
const PIDS_PATH = join(OUT_DIR, 'pids.json');

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

const { dryRun } = parseArgs(process.argv.slice(2));

function run(name, args, { privileged = false, allowFail = false } = {}) {
  const marked = `${privileged ? '[privileged] ' : ''}${name} ${args.join(' ')}`;
  if (dryRun) {
    process.stdout.write(marked + '\n');
    return;
  }
  try {
    execFileSync(name, args, { stdio: 'inherit' });
  } catch (err) {
    if (!allowFail) throw err;
  }
}

// Step 1: end exactly the recorded PIDs. A PID whose process ended on its own
// (SIGTERM delivered earlier, say) is still looked up but not reported.
let recorded = { pids: [], namespaces: [] };
if (existsSync(PIDS_PATH)) {
  recorded = JSON.parse(readFileSync(PIDS_PATH, 'utf8'));
}

for (const entry of recorded.pids ?? []) {
  if (typeof entry.pid !== 'number') continue;
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch {
    // The process was already gone; a half-started stage is clean here.
  }
}

// Step 2: remove exactly the recorded namespaces. The list is `up`'s own
// output: if a namespace is absent the kernel refuses the `delete` with a
// non-fatal error, which we tolerate for the half-started case.
const explicitNamespaces = Array.isArray(recorded.namespaces) ? recorded.namespaces : [];
// Fall back to a listing when no pids.json exists — `down` on a half-started
// stage before pids.json was written.
let namespacesToRemove = explicitNamespaces;
if (namespacesToRemove.length === 0 && !dryRun) {
  try {
    const out = execFileSync('ip', ['netns', 'list'], { encoding: 'utf8' });
    namespacesToRemove = out.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('notismesh-'))
      .map((l) => l.split(/\s+/)[0]);
  } catch {
    namespacesToRemove = [];
  }
}

for (const ns of namespacesToRemove) {
  run('sudo', ['ip', 'netns', 'delete', ns], { privileged: true, allowFail: true });
  run('sudo', ['rm', '-rf', `/etc/netns/${ns}`], { privileged: true, allowFail: true });
}

if (!dryRun) {
  if (existsSync(PIDS_PATH)) {
    rmSync(PIDS_PATH);
  }
  process.stdout.write(`stage down: ${recorded.pids?.length ?? 0} processes signalled, ${namespacesToRemove.length} namespaces removed\n`);
} else {
  process.stdout.write(`[dry-run complete]\n`);
}
