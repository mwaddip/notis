#!/usr/bin/env node
// MESH_INTERFACE → Acceptance — tears the stage down: end exactly the PIDs
// `up` recorded in `stage/out/pids.json` AND whatever still lives inside
// each `notismesh-*` namespace, then remove the namespaces and their
// `/etc/netns/<ns>/` directories. A `down` on a half-started stage cleans
// up what exists; nothing in the stage kills by name.
//
// Each recorded pid is a `sudo ip netns exec ... sudo -u user -- node ...`
// wrapper tree. SIGSTOP on a leaf makes `sudo -u`'s job-control relay
// suspend the wrapper itself (sudo's tcsetpgrp wait path), so SIGTERM on
// the recorded outer pid alone cannot pass through a stopped wrapper and
// the inner children orphan to init. The sequence here reverses that:
// SIGCONT first (so a stopped wrapper can relay the next signal), then
// SIGTERM to the whole tree, wait, and SIGKILL deepest-first (so no
// descendant survives its wrapper's reaping). Before deleting each
// namespace, `ip netns pids <ns>` reads whatever is still inside; the
// same CONT/TERM/KILL runs over those remnants and each one is reported
// by pid and command. A namespace is deleted only once `ip netns pids`
// reads empty.
//
// `--dry-run` prints every command `down` would run (privileged ones
// marked) and the policy lines a reader needs to see the exec path's
// shape.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { descendantPids } from './lib/measure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// `MESH_STAGE_OUT_DIR` lets the test suite point `down.mjs` at a
// controlled fixture under a tmp dir; otherwise the script reads its
// own `stage/out/`.
const OUT_DIR = process.env.MESH_STAGE_OUT_DIR ?? join(HERE, 'out');
const PIDS_PATH = join(OUT_DIR, 'pids.json');

const dryRun = process.argv.slice(2).includes('--dry-run');

const SIGNALLED_WAIT_MS = 10_000;
const SIGNALLED_POLL_MS = 200;

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

// `kill(pid, sig)` is cheap and uid-aware; `kill(pid, 0)` with EPERM
// reads as "still alive, owned by root" (the stage's spawns run through
// `sudo -u` so leaves are user-owned, wrappers are root-owned). On
// EPERM, fall back to `sudo kill -<signal> <pid>`; on ESRCH, return
// `gone`.
function signalPid(pid, sig) {
  try {
    process.kill(pid, sig);
    return 'sent';
  } catch (err) {
    const code = err?.code ?? '';
    if (code === 'ESRCH') return 'gone';
    if (code === 'EPERM') {
      try {
        execFileSync('sudo', ['kill', `-${sig.replace(/^SIG/, '')}`, String(pid)]);
        return 'sent';
      } catch { return 'gone'; }
    }
    return 'gone';
  }
}

function isAliveFor(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → gone. EPERM → alive but owned by root (sudo outer).
    return (err?.code ?? '') === 'EPERM';
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + SIGNALLED_WAIT_MS;
  while (isAliveFor(pid) && Date.now() < deadline) {
    const sleepFor = Math.min(SIGNALLED_POLL_MS, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, sleepFor));
  }
  return !isAliveFor(pid);
}

// A tree snapshot: the recorded pid plus every descendant via /proc,
// deepest first on the KILL pass so no descendant survives its
// reaping wrapper.
function treeOf(pid) {
  const descendants = descendantPids(pid);
  return [pid, ...descendants];
}
function deepestFirst(pids) {
  return [...pids].reverse();
}

// Read /proc/<pid>/cmdline (user-owned pids). Returns null when
// unavailable (gone, or root-owned without read permission). Used to
// name a remnant pid in the per-namespace report.
function cmdlineOf(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const cmd = raw.replace(/\0/g, ' ').trim();
    return cmd === '' ? null : cmd;
  } catch { return null; }
}

async function endTree(rootPid, description) {
  // CONT the whole tree so a stopped wrapper can relay the next signal.
  // TERM the whole tree; wait up to the deadline; KILL deepest-first
  // for whatever is still alive.
  const tree = treeOf(rootPid);
  if (dryRun) {
    logShell(`kill -CONT ${tree.join(' ')}  # ${description} (tree of ${rootPid})`);
    logShell(`kill -TERM ${tree.join(' ')}  # ${description} (tree of ${rootPid})`);
    logShell(`wait ≤ ${SIGNALLED_WAIT_MS} ms`);
    logShell(`kill -KILL ${deepestFirst(tree).join(' ')}  # ${description} (deepest-first)`);
    return;
  }
  for (const pid of tree) signalPid(pid, 'SIGCONT');
  const termed = [];
  for (const pid of tree) {
    if (signalPid(pid, 'SIGTERM') === 'sent') termed.push(pid);
  }
  for (const pid of termed) {
    const exited = await waitForExit(pid);
    if (!exited) {
      process.stderr.write(`stage:down: ${description} (pid ${pid}) did not exit on SIGTERM within ${SIGNALLED_WAIT_MS}ms; sending SIGKILL\n`);
    }
  }
  // Deepest-first SIGKILL — descendants before ancestors — so no
  // descendant survives after its wrapper is reaped.
  for (const pid of deepestFirst(tree)) {
    if (isAliveFor(pid)) signalPid(pid, 'SIGKILL');
  }
}

async function endNamespaceRemnants(ns) {
  if (dryRun) {
    logShell(`ip netns pids ${ns}`, { privileged: true });
    logShell(`# → signal CONT/TERM each remaining pid, wait ≤ ${SIGNALLED_WAIT_MS} ms, SIGKILL remnants deepest-first; delete only when empty`);
    return;
  }
  // `ip netns pids` names a given namespace's pids; `sudo` because
  // stage spawns reach the namespace through `sudo ip netns exec`.
  function listPids() {
    try {
      const out = execFileSync('sudo', ['ip', 'netns', 'pids', ns], { encoding: 'utf8' });
      const pids = [];
      for (const line of out.split('\n')) {
        const n = Number(line.trim());
        if (Number.isInteger(n) && n > 0) pids.push(n);
      }
      return pids;
    } catch (err) {
      process.stderr.write(`stage:down: could not read pids in ${ns}: ${err?.message ?? err}\n`);
      return [];
    }
  }
  const remaining = listPids();
  if (remaining.length === 0) return;
  for (const pid of remaining) {
    const cmd = cmdlineOf(pid) ?? '(unknown)';
    process.stderr.write(`stage:down: ${ns} still holds pid ${pid} after recorded teardown — command: ${cmd}\n`);
  }
  for (const pid of remaining) signalPid(pid, 'SIGCONT');
  const termed = [];
  for (const pid of remaining) {
    if (signalPid(pid, 'SIGTERM') === 'sent') termed.push(pid);
  }
  for (const pid of termed) {
    await waitForExit(pid);
  }
  const stillAlive = listPids();
  for (const pid of deepestFirst(stillAlive)) {
    const cmd = cmdlineOf(pid) ?? '(unknown)';
    process.stderr.write(`stage:down: ${ns} pid ${pid} did not exit on SIGTERM within ${SIGNALLED_WAIT_MS}ms; sending SIGKILL — command: ${cmd}\n`);
    signalPid(pid, 'SIGKILL');
  }
}

// Step 1: read the recorded PIDs and namespaces.
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

// Step 2: end every recorded tree. In dry-run we print the three
// shell lines per tree (CONT, TERM, wait-then-KILL deepest-first).
for (const entry of recorded.pids ?? []) {
  if (typeof entry.pid !== 'number') continue;
  const description = entry.description ?? '<unnamed>';
  await endTree(entry.pid, description);
}

// Step 3: for each namespace, end whatever `ip netns pids` still
// holds (CONT/TERM/wait/KILL + report), then delete the namespace
// and its `/etc/netns/<ns>/` beside it. The delete runs only once
// the namespace reads empty.
for (const ns of namespacesToRemove) {
  await endNamespaceRemnants(ns);
  run('sudo', ['ip', 'netns', 'delete', ns], { privileged: true, allowFail: true });
  run('sudo', ['rm', '-rf', `/etc/netns/${ns}`], { privileged: true, allowFail: true });
}

if (!dryRun) {
  if (existsSync(PIDS_PATH)) {
    rmSync(PIDS_PATH);
  }
  process.stdout.write(`stage down: ${recorded.pids?.length ?? 0} tree(s) ended, ${namespacesToRemove.length} namespace(s) removed\n`);
} else {
  const privilegedCount = namespacesToRemove.length * 2;
  process.stdout.write(`[dry-run complete] ${recorded.pids?.length ?? 0} tree(s) would be ended; ${privilegedCount} privileged command(s) would remove ${namespacesToRemove.length} namespace(s) and /etc/netns/notismesh-*.\n`);
}
