#!/usr/bin/env node
// MESH_INTERFACE → Acceptance — tears the stage down: end exactly the PIDs
// `up` recorded in `stage/out/pids.json`, then remove exactly the namespaces
// `up` created and the `/etc/netns/notismesh-*` directories beside them. A
// `down` on a half-started stage cleans up what exists; nothing in the stage
// kills by name.
//
// `--dry-run` prints every command `down` would run, marks the privileged
// ones, and reads `ip netns list` for a half-started stage (read-only) so
// the preview shows the real namespaces.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');
const PIDS_PATH = join(OUT_DIR, 'pids.json');

const dryRun = process.argv.slice(2).includes('--dry-run');

function logShell(line, { privileged = false } = {}) {
  const marked = `${privileged ? '[privileged] ' : ''}${line}`;
  process.stdout.write(marked + '\n');
}

function run(name, args, { privileged = false, allowFail = false } = {}) {
  const line = `${name} ${args.join(' ')}`;
  if (dryRun) {
    logShell(line, { privileged });
    return;
  }
  try {
    execFileSync(name, args, { stdio: 'inherit' });
  } catch (err) {
    if (!allowFail) throw err;
  }
}

// Step 1: read the recorded PIDs and namespaces; a half-started stage with
// no pids.json falls back to `ip netns list` (read-only, no privilege) so
// `down` still cleans up what exists.
let recorded = { pids: [], namespaces: [] };
if (existsSync(PIDS_PATH)) {
  recorded = JSON.parse(readFileSync(PIDS_PATH, 'utf8'));
}

const explicitNamespaces = Array.isArray(recorded.namespaces) ? recorded.namespaces : [];
let namespacesToRemove = explicitNamespaces;
if (namespacesToRemove.length === 0) {
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

// Step 2: SIGTERM every recorded PID. In dry-run we show which PIDs we would
// signal; a PID whose process ended on its own is logged but not reported.
for (const entry of recorded.pids ?? []) {
  if (typeof entry.pid !== 'number') continue;
  if (dryRun) {
    logShell(`kill -TERM ${entry.pid}  # ${entry.description ?? ''}`);
    continue;
  }
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch {
    // Already gone — a half-started stage is clean here.
  }
}

// Step 3: remove exactly the namespaces `up` recorded (or the ones `ip netns
// list` showed on fallback); `/etc/netns/<ns>` beside each.
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
  const privilegedCount = namespacesToRemove.length * 2;
  process.stdout.write(`[dry-run complete] ${recorded.pids?.length ?? 0} PID(s) would be signalled; ${privilegedCount} privileged command(s) would remove ${namespacesToRemove.length} namespace(s) and /etc/netns/notismesh-*.\n`);
}
