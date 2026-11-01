#!/usr/bin/env node
// MESH_INTERFACE → Acceptance — brings the stage up: create every
// `notismesh-<host>` namespace, wire them via veth pairs created inside the
// namespaces themselves, apply nft rules per NAT type, lift the
// per-namespace unprivileged-port floor where the stage needs port 53 / 80 /
// 443, create every mesh node's key, start the Notis nodes and their mesh
// nodes as the invoking user under the Node that is running `up`, run the
// miner inside `pub1`'s namespace, wait until every honest node is at height
// ≥ 50, cut `hostile-lagging` off, and write `stage/out/pids.json` and
// `stage/out/browser/config.json`.
//
// The host is never touched outside `notismesh-*` namespaces, their nft
// rules, and `/etc/netns/notismesh-*/resolv.conf`. Every veth is created
// inside its namespace (both ends placed at creation), so no host-visible
// interface survives a crash between `add` and `set netns`. Every stage
// process runs as the invoking user with Node 24's absolute path.
//
// `--dry-run` prints every command `up` would run, marks the privileged
// ones, generates throwaway Ed25519 keys inline for the config preview,
// creates no namespace, writes nothing under `stage/out/`, and starts no
// process.

import { mkdirSync, writeFileSync, existsSync, readFileSync, openSync, fstatSync, readSync, closeSync, renameSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { CommandLog, isProcessAlive } from './lib/commands.mjs';
import { readTopology, natRouters, publicMeshHosts } from './lib/topology.mjs';
import { buildPageConfig, peerIdStringOf } from './lib/config.mjs';
import { generateStageCerts } from './lib/pebble-certs.mjs';
import { buildPebbleConfig } from './lib/pebble-config.mjs';
import { descendantPids } from './lib/measure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const OUT_DIR = join(HERE, 'out');
const CACHE_DIR = join(HERE, 'cache');
const TOPOLOGY_PATH = join(HERE, 'topology.json');

// MESH_INTERFACE → Acceptance — "every stage process ... Node that is
// running `up`". `process.execPath` is Node 24's absolute path on this
// machine; `env` passes it through `sudo -u` without going near sudo's
// `secure_path` (which would resolve `node` to the host's older binary).
const NODE_ABS = process.execPath;
const INVOKING_USER = process.env.SUDO_USER ?? process.env.USER;
if (!INVOKING_USER) {
  process.stderr.write('refusing to start: USER is unset — the stage runs its processes as the invoking user, and sudo -u needs a name\n');
  process.exit(2);
}

// MESH_INTERFACE → Acceptance — Pebble v2.8.0's linux-amd64 release as the
// tar.gz archive the project publishes; the inner binary is at
// `pebble-linux-amd64/linux/amd64/pebble`. The SHA-256 was computed by
// downloading the archive once (see `prompts/mesh-poc-t9-REPORT.md` for
// the URL and the command).
const PEBBLE_VERSION = 'v2.8.0';
const PEBBLE_URL = `https://github.com/letsencrypt/pebble/releases/download/${PEBBLE_VERSION}/pebble-linux-amd64.tar.gz`;
const PEBBLE_SHA256 = '34595d915bbc2fc827affb3f58593034824df57e95353b031c8d5185724485ce';
const PEBBLE_INNER_PATH = 'pebble-linux-amd64/linux/amd64/pebble';

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const keepOnFailure = argv.includes('--keep-on-failure');
  let simulateFailureAfter = null;
  for (const a of argv) {
    const m = /^--simulate-failure-after=(\d+)$/.exec(a);
    if (m) simulateFailureAfter = Number(m[1]);
  }
  return { dryRun, keepOnFailure, simulateFailureAfter };
}

function nsOf(host) {
  return `notismesh-${host}`;
}

function assertNoStageNamespaces(dryRun) {
  if (dryRun) return;
  const out = execFileSync('ip', ['netns', 'list'], { encoding: 'utf8' });
  const stale = out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((l) => l.startsWith('notismesh-'));
  if (stale.length > 0) {
    process.stderr.write(`refusing to start: these notismesh-* namespaces already exist: ${stale.join(', ')}\n`);
    process.stderr.write(`run 'pnpm --filter @dagsocial/mesh-poc stage:down' first\n`);
    process.exit(2);
  }
}

// MESH_INTERFACE → Acceptance — "every stage process ... as the invoking
// user ... the Node that is running `up`". `userNode(args, env)` is one
// `sudo -u <user> -- env ...` wrap, so every spawn line in the dry-run says
// which user and which Node binary; the host's older `/usr/bin/node`, which
// `secure_path` would resolve to under a plain `sudo node`, never runs.
function userEnv(env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) out.push(`${k}=${v}`);
  return out;
}
function userWrap(ns, env, binary = NODE_ABS) {
  // `sudo ip netns exec <ns> sudo -u <user> -- env <VARS> <binary>` runs
  // `<binary>` in `<ns>` as `<user>`. The outer `sudo` enters the
  // namespace (root is required); the inner `-u <user>` drops privilege
  // before `env` and the binary start. The default binary is Node 24's
  // absolute path, so a bare `userWrap(ns, env)` is the common case.
  return [
    'sudo', 'ip', 'netns', 'exec', ns,
    'sudo', '-u', INVOKING_USER, '--',
    'env', ...userEnv(env),
    binary,
  ];
}

// MESH_INTERFACE → Acceptance — every wait the exec path performs is
// recorded (printed, in dry-run) so a reader sees what the real `up` is
// going to block on. The exec path runs the actual poll beside this
// record; the dry-run only prints.
function recordWait(description) {
  const line = `[wait] ${description}`;
  log.records.push(line);
  if (dryRun) process.stdout.write(line + '\n');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `check` until it returns truthy or the deadline passes. `check` may
 * throw; a throw is treated as "not yet". A pass is immediate. On timeout
 * the last error (if any) is surfaced beside the description.
 */
async function pollUntil(description, check, { timeoutMs, pollMs = 2000 }) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await check();
      if (r !== undefined && r !== null && r !== false) return r;
    } catch (err) {
      lastErr = err;
    }
    await sleep(pollMs);
  }
  const detail = lastErr ? `: ${lastErr.message}` : '';
  throw new Error(`${description} timed out after ${timeoutMs}ms${detail}`);
}

/**
 * Run `argv` inside `ns` as the invoking user and return stdout. The
 * `sudo` wrap is the same `userWrap` the long-lived processes use, so
 * the exec path's checks run under the same privilege as the services.
 */
function execIn(ns, argv, { timeoutMs = 10_000 } = {}) {
  const full = [
    'ip', 'netns', 'exec', ns,
    'sudo', '-u', INVOKING_USER, '--',
    ...argv,
  ];
  return execFileSync('sudo', full, { encoding: 'utf8', timeout: timeoutMs });
}

/**
 * Read the last `maxLines` lines of a text file. Returns an empty string
 * when the file is absent, so a wait that fires before its child wrote
 * anything prints "<no output>" instead of a stack trace.
 */
function tailLog(logPath, maxLines = 20) {
  if (!logPath || !existsSync(logPath)) return '';
  const text = readFileSync(logPath, 'utf8');
  const lines = text.split('\n');
  const trailing = lines.length > 0 && lines[lines.length - 1] === '' ? 1 : 0;
  const start = Math.max(0, lines.length - trailing - maxLines);
  return lines.slice(start, lines.length - trailing).join('\n');
}

/**
 * Wait with `pollUntil` and tail the related process's log on failure, so
 * a timeout points at the cause rather than at the timeout itself.
 */
async function waitWithTail(description, check, logPath, options) {
  try {
    await pollUntil(description, check, options);
  } catch (err) {
    const tail = tailLog(logPath, 20);
    const header = logPath ? `--- last 20 lines of ${logPath} ---` : '';
    const body = tail === '' ? '<no output>' : tail;
    const detail = logPath ? `\n${header}\n${body}` : '';
    throw new Error(`${err.message}${detail}`);
  }
}

/**
 * Read the LATEST JSON identity line from `logPath` that satisfies
 * `predicate(parsed)`. The mesh node (`src/node/main.ts`) writes one
 * line to stdout when it starts listening, and reprints the line on
 * every `self:peer:update` — a public role's listen address verifies,
 * a private role's circuit-relay reservation lands. The predicate
 * picks the first line that carries what the stage needs: for a public
 * role, any identity; for a private role, an identity whose
 * `multiaddrs` carries a `/p2p-circuit` address.
 *
 * The caller passes the child so this helper can fail fast when the
 * mesh node exits before writing a satisfying line.
 */
async function readMeshIdentityUntil(child, logPath, predicate, { timeoutMs }) {
  let exited = false;
  let exitCode = null;
  if (child !== null) {
    child.once('exit', (code) => { exited = true; exitCode = code; });
  }
  const start = Date.now();
  let offset = 0;
  let buf = '';
  while (Date.now() - start < timeoutMs) {
    if (existsSync(logPath)) {
      const fd = openSync(logPath, 'r');
      try {
        const size = fstatSync(fd).size;
        if (size > offset) {
          const chunk = Buffer.alloc(size - offset);
          readSync(fd, chunk, 0, chunk.length, offset);
          offset = size;
          buf += chunk.toString('utf8');
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line === '' || line[0] !== '{') continue;
            try {
              const parsed = JSON.parse(line);
              if (typeof parsed.notisId !== 'string') continue;
              if (predicate(parsed)) return parsed;
            } catch { /* not the JSON identity line, keep reading */ }
          }
        }
      } finally {
        closeSync(fd);
      }
    }
    if (exited) {
      throw new Error(`mesh process exited (code ${exitCode}) before printing its identity line`);
    }
    await sleep(100);
  }
  throw new Error('timed out');
}

// MESH_INTERFACE → NAT — "A `private` node announces its relay
// reservations alone", and a browser reaches it through
// `/p2p-circuit/webrtc/p2p/<priv>`. The latest identity line for a
// private role has to carry at least one `/p2p-circuit/webrtc/p2p/`
// address so the stage's `identities.json` names an address a browser
// can dial. A public role passes on the first non-empty identity.
function identityPredicateForMeshRole(meshRole) {
  if (meshRole === 'private') {
    return (parsed) => Array.isArray(parsed.multiaddrs)
      && parsed.multiaddrs.some((m) => typeof m === 'string' && m.includes('/p2p-circuit/webrtc/p2p/'));
  }
  return () => true;
}

/**
 * Per-host, per-description log path: `stage/out/<host>/<description>.log`.
 * The description tail of a `host:tag` spawn becomes the file name
 * (`mesh:pub1` → `stage/out/pub1/mesh.log`); a hostless description lands
 * in `stage/out/logs/<description>.log`.
 */
function logPathFor(description) {
  const colon = description.indexOf(':');
  if (colon >= 0) {
    const tag = description.slice(0, colon);
    const host = description.slice(colon + 1);
    return join(OUT_DIR, host, `${tag}.log`);
  }
  return join(OUT_DIR, 'logs', `${description}.log`);
}

// -----------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------

const { dryRun, keepOnFailure, simulateFailureAfter } = parseArgs(process.argv.slice(2));
const log = new CommandLog({ dryRun });

// MESH_INTERFACE → Acceptance — track what `up` has created so a failure
// can roll back exactly what it did. `createdNamespaces` holds every
// `notismesh-*` namespace in creation order; `createdEtcNetnsPaths` holds
// every `/etc/netns/notismesh-*` directory. `log.pids` already tracks
// spawned processes.
const createdNamespaces = [];
const createdEtcNetnsPaths = [];

// Wrap `log.shell` so every `ip netns add` and `mkdir -p /etc/netns/...`
// is recorded in the state. A `--simulate-failure-after=N` option
// (dry-run only) raises after the N-th log entry — the catch below runs
// the same teardown the exec path runs on a real failure.
const originalShell = log.shell.bind(log);
const originalSpawn = log.spawn.bind(log);
let stepsCount = 0;
function countedStep() {
  stepsCount += 1;
  if (dryRun && simulateFailureAfter !== null && stepsCount > simulateFailureAfter) {
    throw new Error(`simulated failure after step ${simulateFailureAfter}`);
  }
}
log.shell = (name, argv, opts) => {
  countedStep();
  originalShell(name, argv, opts);
  // Track what up has created, in order, so the teardown is exact.
  if (name === 'sudo' && argv[0] === 'ip' && argv[1] === 'netns' && argv[2] === 'add') {
    createdNamespaces.push(argv[3]);
  }
  if (name === 'sudo' && argv[0] === 'mkdir' && argv[1] === '-p' && typeof argv[2] === 'string' && argv[2].startsWith('/etc/netns/notismesh-')) {
    createdEtcNetnsPaths.push(argv[2]);
  }
};
// MESH_INTERFACE → Acceptance — write `pids.json` after every spawn,
// not only once at the end. A `--keep-on-failure` run (or any crash
// mid-up) must leave `pids.json` naming every live process so
// `down` can SIGTERM each; otherwise `down` falls back to each
// namespace's `ip netns pids` list.
const PIDS_PATH = join(OUT_DIR, 'pids.json');
function writePidsJson() {
  if (dryRun) return;
  mkdirSync(dirname(PIDS_PATH), { recursive: true });
  writeFileSync(PIDS_PATH, JSON.stringify({
    pids: log.pids,
    namespaces: [...createdNamespaces],
  }, null, 2));
}
log.spawn = (argvFull, opts) => {
  countedStep();
  const r = originalSpawn(argvFull, opts);
  writePidsJson();
  return r;
};

assertNoStageNamespaces(dryRun);

const topology = readTopology(TOPOLOGY_PATH);

// MESH_INTERFACE → Acceptance — nothing a scenario reads may come from
// an earlier run. Rotate `stage/out/` to `stage/out.prev/` (replacing
// any older `.prev`) before writing a single key, cert or log file.
// `stage/cache/` (Pebble tarball + binary, SHA-pinned) is left in
// place — it costs nothing to re-use and nothing in a scenario reads
// it.
const OUT_DIR_PREV = `${OUT_DIR}.prev`;
const rotateLine = `rotate ${OUT_DIR} → ${OUT_DIR_PREV} (replacing any older .prev)`;
log.records.push(rotateLine);
if (dryRun) {
  process.stdout.write(rotateLine + '\n');
} else {
  if (existsSync(OUT_DIR_PREV)) {
    rmSync(OUT_DIR_PREV, { recursive: true, force: true });
  }
  if (existsSync(OUT_DIR)) {
    renameSync(OUT_DIR, OUT_DIR_PREV);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Roll back what `up` created, in reverse order. In exec mode the kills
 * and deletes run for real; in dry-run (triggered by
 * `--simulate-failure-after=<N>`) they print the commands that would run,
 * so a reader can see the teardown without any state change.
 */
function teardown(cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const line = `[failure] ${reason}`;
  log.records.push(line);
  process.stdout.write(line + '\n');
  if (keepOnFailure) {
    process.stdout.write('[kept on failure] stage left as-is; run stage:down to clean up\n');
    return;
  }
  process.stdout.write('[teardown] rolling back what up created\n');
  // 1) End every recorded tree. SIGSTOP on a leaf makes `sudo -u`'s
  //    job-control relay suspend the wrapper too (sudo's tcsetpgrp
  //    wait path), so SIGTERM on the recorded outer pid alone cannot
  //    pass through a stopped wrapper. CONT first (so a stopped
  //    wrapper relays the next signal), then TERM to the whole tree,
  //    and KILL deepest-first so no descendant survives its wrapper.
  for (const entry of log.pids) {
    const tree = [entry.pid, ...descendantPids(entry.pid)];
    const deepestFirst = [...tree].reverse();
    const contLine = `kill -CONT ${tree.join(' ')}  # ${entry.description} (tree of ${entry.pid})`;
    const termLine = `kill -TERM ${tree.join(' ')}  # ${entry.description} (tree of ${entry.pid})`;
    const killLine = `kill -KILL ${deepestFirst.join(' ')}  # ${entry.description} (deepest-first)`;
    log.records.push(contLine, termLine, killLine);
    process.stdout.write(contLine + '\n');
    process.stdout.write(termLine + '\n');
    process.stdout.write(killLine + '\n');
    if (!dryRun) {
      for (const pid of tree) { try { process.kill(pid, 'SIGCONT'); } catch { /* already gone */ } }
      for (const pid of tree) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
      // Teardown runs on `up`'s error path; it does not wait on
      // children — `down` is the gate that polls. Deepest-first
      // SIGKILL is sent at once so no descendant survives.
      for (const pid of deepestFirst) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  }
  // 2) Delete every namespace up created, in reverse order.
  for (const ns of [...createdNamespaces].reverse()) {
    const l = `[privileged] sudo ip netns delete ${ns}`;
    log.records.push(l);
    process.stdout.write(l + '\n');
    if (!dryRun) {
      try {
        execFileSync('sudo', ['ip', 'netns', 'delete', ns], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (teardownErr) {
        const stderr = decodeTeardownStderr(teardownErr);
        // `ip netns delete` prints "Cannot remove ... No such file or
        // directory" when the namespace is already gone. Any other
        // error is a real problem and is reported.
        if (/No such file or directory|Cannot remove namespace file/i.test(stderr)) continue;
        process.stderr.write(`teardown: ip netns delete ${ns} failed: ${stderr || teardownErr.message}\n`);
      }
    }
  }
  // 3) Remove every /etc/netns/<ns>/ directory up created.
  for (const path of createdEtcNetnsPaths) {
    const l = `[privileged] sudo rm -rf ${path}`;
    log.records.push(l);
    process.stdout.write(l + '\n');
    if (!dryRun) {
      try {
        // `rm -rf` is quiet on a missing path; any error is a real
        // problem (permission denied, say) and must be reported.
        execFileSync('sudo', ['rm', '-rf', path], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (teardownErr) {
        const stderr = decodeTeardownStderr(teardownErr);
        process.stderr.write(`teardown: sudo rm -rf ${path} failed: ${stderr || teardownErr.message}\n`);
      }
    }
  }
  process.stdout.write(`[teardown complete] ${log.pids.length} PID(s), ${createdNamespaces.length} namespace(s), ${createdEtcNetnsPaths.length} /etc/netns path(s)\n`);
}

function decodeTeardownStderr(err) {
  const raw = err?.stderr;
  if (raw === null || raw === undefined) return '';
  const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  return s.replace(/\s+$/, '');
}

try {

// -----------------------------------------------------------------------
// Phase 1: namespaces and the internet bridge
// -----------------------------------------------------------------------

const bridgeNs = nsOf('bridge');
const bridgeIf = topology.internet.bridgeName;

log.shell('sudo', ['ip', 'netns', 'add', bridgeNs], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'add', bridgeIf, 'type', 'bridge'], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'addr', 'add', `${topology.internet.gateway}/24`, 'dev', bridgeIf], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', bridgeIf, 'up'], { privileged: true });
log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', 'lo', 'up'], { privileged: true });

// One namespace per host. Veth pairs are created inside the destination
// namespace (`ip -n <ns-A> link add X peer name Y netns <ns-B>` places both
// ends at creation), so a crash between the add and a `set netns` leaves
// nothing behind on the host.
for (const [name, host] of Object.entries(topology.hosts)) {
  const ns = nsOf(name);
  log.shell('sudo', ['ip', 'netns', 'add', ns], { privileged: true });
  log.shell('sudo', ['ip', '-n', ns, 'link', 'set', 'lo', 'up'], { privileged: true });

  if (host.role === 'nat') {
    // Outside: veth from the bridge namespace to this NAT router. The add
    // is run inside `bridgeNs` so `v-<veth>-o` lives there; `netns <ns>`
    // places the peer end inside the NAT namespace at creation. The names
    // use `host.veth` (short token) so each one fits IFNAMSIZ − 1 bytes.
    const outVeth = `v-${host.veth}-o`;
    const outPeer = `vp-${host.veth}-o`;
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'add', outVeth, 'type', 'veth', 'peer', 'name', outPeer, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', outVeth, 'master', bridgeIf, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.outsideAddr}/24`, 'dev', outPeer], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', outPeer, 'up'], { privileged: true });

    // Inside bridge inside the NAT namespace itself — holds the gateway
    // address, every private host behind this NAT connects to it. The
    // bridge lives entirely inside `<ns>`.
    const innerBr = `br-${host.veth}-in`;
    log.shell('sudo', ['ip', '-n', ns, 'link', 'add', innerBr, 'type', 'bridge'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.insideGateway}/24`, 'dev', innerBr], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', innerBr, 'up'], { privileged: true });

    log.shell('sudo', ['ip', 'netns', 'exec', ns, 'sysctl', '-w', 'net.ipv4.ip_forward=1'], { privileged: true });
    continue;
  }

  if (host.parent === undefined) {
    // Plain host on the internet bridge.
    const veth = `v-${host.veth}`;
    const peer = `vp-${host.veth}`;
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'add', veth, 'type', 'veth', 'peer', 'name', peer, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', bridgeNs, 'link', 'set', veth, 'master', bridgeIf, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.addr}/24`, 'dev', peer], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', peer, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'route', 'add', 'default', 'via', topology.internet.gateway], { privileged: true });
  } else {
    // Private host behind a NAT router. The outer end of the veth lives
    // inside the parent NAT namespace, bridged to its inside bridge; the
    // inner end lives inside this host's namespace.
    const parent = topology.hosts[host.parent];
    const parentNs = nsOf(host.parent);
    const innerBr = `br-${parent.veth}-in`;
    const veth = `v-${host.veth}`;
    const peer = `vp-${host.veth}`;
    log.shell('sudo', ['ip', '-n', parentNs, 'link', 'add', veth, 'type', 'veth', 'peer', 'name', peer, 'netns', ns], { privileged: true });
    log.shell('sudo', ['ip', '-n', parentNs, 'link', 'set', veth, 'master', innerBr, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'addr', 'add', `${host.addr}/24`, 'dev', peer], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'link', 'set', peer, 'up'], { privileged: true });
    log.shell('sudo', ['ip', '-n', ns, 'route', 'add', 'default', 'via', parent.insideGateway], { privileged: true });
  }
}

// -----------------------------------------------------------------------
// Phase 2: nft NAT rules per router
// -----------------------------------------------------------------------

for (const { name, host } of natRouters(topology)) {
  const ns = nsOf(name);
  const outsideIf = `vp-${host.veth}-o`;
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', 'nat'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', 'nat', 'POSTROUTING', '{', 'type', 'nat', 'hook', 'postrouting', 'priority', '100', ';', '}'], { privileged: true });
  if (host.nat === 'symmetric') {
    // nft(8): the `fully-random` flag triggers
    // `NF_NAT_RANGE_PROTO_RANDOM_FULLY` in the kernel — a 32-bit
    // pseudo-random port per (source, destination) tuple, which STUN
    // reads as "address and port-dependent" (= symmetric) mapping.
    log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', 'nat', 'POSTROUTING', 'oifname', outsideIf, 'masquerade', 'fully-random'], { privileged: true });
  } else {
    // nft(8): plain `masquerade` preserves the client's source port
    // on the first outbound packet of a flow unless conntrack already
    // holds the (source IP, source port, destination IP, destination
    // port) tuple — then it picks another port to avoid the clash.
    // The input chain below drops every inbound packet to the
    // outside interface that is not reply traffic, so a probe from
    // outside never establishes a conntrack entry, and the first
    // outbound from the inside to the same remote keeps the port.
    // A given internal (source IP, source port) then sees the same
    // external (ip, port) whatever address it is dialling, which STUN
    // reads as "endpoint-independent" mapping.
    log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', 'nat', 'POSTROUTING', 'oifname', outsideIf, 'masquerade'], { privileged: true });
  }
  // MESH_INTERFACE → NAT — "A browser reaches a private node over
  // WebRTC signalled through the relay". For the ICE check to find a
  // matching tuple, the outbound masquerade must keep the source
  // port; it does so under plain `masquerade` only when no conntrack
  // entry already holds the (src, dst) pair. The input chain enforces
  // that invariant: policy drop, reply traffic accepted (ct state
  // established,related), and anything arriving from an interface
  // other than the outside one accepted (the inside bridge still
  // reaches the router for its own services).
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', 'filter'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', 'filter', 'input', '{', 'type', 'filter', 'hook', 'input', 'priority', '0', ';', 'policy', 'drop', ';', '}'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', 'filter', 'input', 'ct', 'state', 'established,related', 'accept'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', 'filter', 'input', 'iifname', '!=', outsideIf, 'accept'], { privileged: true });
}

// -----------------------------------------------------------------------
// Phase 3: unprivileged port floors, resolv.conf, DNS witness counter
// -----------------------------------------------------------------------

// MESH_INTERFACE → Acceptance — a stage process runs as the invoking user;
// pub1 binds TCP 443 (WSS) and 80 (ACME http-01), dns-log binds 53. Lifting
// `net.ipv4.ip_unprivileged_port_start` to 0 is a per-namespace sysctl in
// Linux ≥ 4.11 — the kernel registers it under `init_net.sysctl` with
// `net_namespace_list` scope — and this stage runs on kernel 6.8, well above
// that. Nothing is set outside a namespace.
const unprivPortHosts = ['pub1', 'dns-log', 'browser'];
for (const name of unprivPortHosts) {
  if (topology.hosts[name] === undefined) continue;
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf(name), 'sysctl', '-w', 'net.ipv4.ip_unprivileged_port_start=0'], { privileged: true });
}

const browserHost = topology.hosts.browser;
const dnsLogHost = topology.hosts['dns-log'];
if (browserHost && dnsLogHost) {
  const resolvConfPath = `/etc/netns/${nsOf('browser')}/resolv.conf`;
  log.shell('sudo', ['mkdir', '-p', `/etc/netns/${nsOf('browser')}`], { privileged: true });
  log.shell('sudo', ['sh', '-c', `echo nameserver ${dnsLogHost.addr} > ${resolvConfPath}`], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'table', 'ip', 'dns_witness'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'chain', 'ip', 'dns_witness', 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'rule', 'ip', 'dns_witness', 'out', 'udp', 'dport', '{', '53', ',', '853', '}', 'counter'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('browser'), 'nft', 'add', 'rule', 'ip', 'dns_witness', 'out', 'tcp', 'dport', '{', '53', ',', '853', '}', 'counter'], { privileged: true });
}

// -----------------------------------------------------------------------
// Phase 4: mesh keys and notisIds
// -----------------------------------------------------------------------

const meshKeyTool = join(PACKAGE_ROOT, 'dist', 'node', 'mesh-key-tool.js');
const hostsWithMesh = Object.entries(topology.hosts).filter(([, h]) => h.mesh !== undefined);
const notisIds = {};

for (const [name] of hostsWithMesh) {
  const keyPath = join(OUT_DIR, name, 'mesh.key');
  // The real run invokes the key tool and reads the printed notisId; the
  // dry-run shows the command but computes a throwaway id inline so the
  // config preview below has a plausible shape without writing anything to
  // disk.
  log.shell(NODE_ABS, [meshKeyTool, 'ensure', keyPath]);
  if (dryRun) {
    const seed = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(seed);
    notisIds[name] = bytesToHex(pub);
  } else {
    const r = spawnSync(NODE_ABS, [meshKeyTool, 'ensure', keyPath], { encoding: 'utf8' });
    if (r.status !== 0) {
      process.stderr.write(`mesh-key-tool exit ${r.status}: ${r.stderr}\n`);
      process.exit(1);
    }
    notisIds[name] = r.stdout.trim();
  }
}

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// -----------------------------------------------------------------------
// Phase 5: Pebble
// -----------------------------------------------------------------------

const pebbleHost = topology.hosts.pebble;
const pebbleArchive = join(CACHE_DIR, 'pebble-linux-amd64.tar.gz');
const pebbleBin = join(CACHE_DIR, PEBBLE_INNER_PATH);
if (pebbleHost) {
  // Download, verify, extract — all three on the host as the user; nothing
  // the stage runs as root. The v2.8.0 tarball records the binary at
  // mode 0644 (`tar tvzf` shows `-rw-r--r--`), so chmod it 0755 after
  // extraction, else `env` refuses with "Permission denied".
  log.shell('sh', ['-c', `test -f ${pebbleArchive} || curl -L ${PEBBLE_URL} -o ${pebbleArchive}`]);
  log.shell('sh', ['-c', `echo "${PEBBLE_SHA256}  ${pebbleArchive}" | sha256sum --check`]);
  log.shell('tar', ['xzf', pebbleArchive, '-C', CACHE_DIR]);
  log.shell('chmod', ['0755', pebbleBin]);
}

const pebbleConfigPath = join(OUT_DIR, 'pebble-config.json');
const pebbleRootPath = join(OUT_DIR, 'pebble-root.pem');
const stageCaPath = join(OUT_DIR, 'stage-ca.pem');
const stageCaKeyPath = join(OUT_DIR, 'stage-ca-key.pem');
const pebbleServerCertPath = join(OUT_DIR, 'pebble-server-cert.pem');
const pebbleServerKeyPath = join(OUT_DIR, 'pebble-server-key.pem');
const pebbleListenPort = pebbleHost ? Number(pebbleHost.pebble.listen.split(':').pop()) : 0;
const pebbleManagementPort = pebbleHost ? Number(pebbleHost.pebble.managementListen.split(':').pop()) : 0;

if (pebbleHost) {
  // MESH_INTERFACE → The IP certificate — the v2.8.0 tarball holds the
  // Pebble binary and nothing else; the stage generates its own CA and a
  // Pebble server cert whose SAN names Pebble's IP, so pub1's ACME HTTPS
  // client has something it can verify through `--cacert <stage-ca>`.
  // Dry-run records the plan; exec mode writes the certs beside the
  // config.
  const certPlan = `[cert] stage-ca.pem, pebble-server-cert.pem (SAN=ip:${pebbleHost.addr}), pebble-server-key.pem under ${OUT_DIR}`;
  log.records.push(certPlan);
  if (dryRun) process.stdout.write(certPlan + '\n');
  else {
    await generateStageCerts({ outDir: OUT_DIR, pebbleIp: pebbleHost.addr });
  }

  if (!dryRun) {
    writeFileSync(pebbleConfigPath, JSON.stringify(buildPebbleConfig({
      listenAddress: `${pebbleHost.addr}:${pebbleListenPort}`,
      managementListenAddress: `${pebbleHost.addr}:${pebbleManagementPort}`,
      httpChallengePort: pebbleHost.pebble.httpChallengePort,
      certificatePath: pebbleServerCertPath,
      privateKeyPath: pebbleServerKeyPath,
    }), null, 2));
  }

  // PEBBLE_WFE_NONCEREJECT=0 turns off Pebble's 5 % random nonce
  // rejection. acme-client v5 retries badNonce per RFC 8555 §6.5, so
  // the rejection does not break correctness, but switching it off
  // keeps the stage deterministic — a cert issuance either succeeds or
  // fails for a reason the test can act on.
  log.spawn(userWrap(nsOf('pebble'), { PEBBLE_VA_NOSLEEP: '1', PEBBLE_WFE_NONCEREJECT: '0' }, pebbleBin).concat(['-config', pebbleConfigPath]), { description: 'pebble', logPath: logPathFor('pebble') });
  recordWait(`pebble answers https://${pebbleHost.addr}:${pebbleListenPort}/dir`);
  if (!dryRun) {
    await waitWithTail(
      'pebble directory',
      async () => {
        execIn(nsOf('browser'), [
          'curl', '-sf', '--cacert', stageCaPath, '--max-time', '5',
          `https://${pebbleHost.addr}:${pebbleListenPort}/dir`,
        ], { timeoutMs: 8_000 });
        return true;
      },
      logPathFor('pebble'),
      { timeoutMs: 60_000, pollMs: 1_000 },
    );
  }
}

// -----------------------------------------------------------------------
// Phase 6: dns-log server
// -----------------------------------------------------------------------

const dnsLogScript = join(HERE, 'dns-log.mjs');
if (dnsLogHost) {
  log.spawn(userWrap(nsOf('dns-log'), {
    DNS_LOG_PATH: join(OUT_DIR, 'dns.log'),
    DNS_LOG_BIND: dnsLogHost.addr,
    DNS_LOG_PORT: String(dnsLogHost.dnsPort),
  }).concat([dnsLogScript]), { description: 'dns-log', logPath: logPathFor('dns-log') });
}

// -----------------------------------------------------------------------
// Phase 7: Notis nodes, mesh nodes, hostile upstreams
// -----------------------------------------------------------------------

const notisNodeEntry = join(REPO_ROOT, 'packages', 'node', 'dist', 'index.js');
const minerScript = join(REPO_ROOT, 'packages', 'node', 'scripts', 'miner.mjs');
const meshNodeEntry = join(PACKAGE_ROOT, 'dist', 'node', 'main.js');
const hostileUpstreamScript = join(HERE, 'hostile-upstream.mjs');

const pub1Host = topology.hosts.pub1;
const pub1Base = `http://${pub1Host.addr}:${pub1Host.node.httpPort}`;

// Each public mesh node prints one JSON line on stdout (`{notisId, peerId,
// multiaddrs}`) when it is listening. Exec mode captures this line to
// write the real multiaddrs (with WebRTC-direct certhash) into
// `config.json`; dry-run uses the shape `buildPageConfig` computes from
// the topology alone.
const meshIdentityPromises = {};

// Notis nodes come first — their p2p port is what the mesh nodes'
// upstream URL points at (through 127.0.0.1 inside each namespace).
for (const [name, host] of Object.entries(topology.hosts)) {
  if (host.node === undefined) continue;
  const ns = nsOf(name);
  const dbPath = join(OUT_DIR, name, 'notis.db');
  const notisEnv = {
    NETWORK_TYPE: 'devnet',
    NODE_ROLE: host.node.role,
    PORT: String(host.node.httpPort),
    ADMIN_PORT: String(host.node.httpPort + 1),
    DB_PATH: dbPath,
    LISTEN_ADDRS: `/ip4/${host.addr}/tcp/${host.node.p2pPort}`,
    BOOTSTRAP_PEERS: `/ip4/${pub1Host.addr}/tcp/${pub1Host.node.p2pPort}`,
    MINING_SECRET: 'stage-mining-secret',
  };
  log.spawn(userWrap(ns, notisEnv).concat([notisNodeEntry]), { description: `notis:${name}`, logPath: logPathFor(`notis:${name}`) });
}

// MESH_INTERFACE → NAT — "A relay that does not answer never stops a
// private node ... is tried again on the node list's retry cadence".
// Private mesh nodes tolerate a relay that is down at start. The
// stage still orders startup so a run measures the scenarios, not a
// startup race: every public mesh node is spawned first (its own
// `/ip4/<own>/tcp/<port>` listening is in place by its identity
// line), then the private mesh nodes — their `/p2p-circuit` listens
// reserve on the first attempt.
function startMeshNodeForHost(name, host) {
  const ns = nsOf(name);
  const meshStateDir = join(OUT_DIR, name);
  const meshKeyPath = join(meshStateDir, 'mesh.key');
  let upstream;
  const hostileListenPort = 7000;
  if (host.mesh.upstreamMode !== undefined) {
    // The hostile upstream forwards to its OWN Notis node on 127.0.0.1
    // (the hostile host carries one, bootstrapped from pub1); pub1's
    // HTTP binds pub1's namespace loopback alone and is not reachable
    // from a different namespace.
    if (host.node === undefined) {
      throw new Error(`hostile host ${name} needs a Notis node of its own for the upstream to forward to`);
    }
    log.spawn(userWrap(ns, {
      MODE: host.mesh.upstreamMode,
      PORT: String(hostileListenPort),
      PUB1_BASE: `http://127.0.0.1:${host.node.httpPort}`,
    }).concat([hostileUpstreamScript]), { description: `hostile-upstream:${name}`, logPath: logPathFor(`hostile-upstream:${name}`) });
    upstream = `http://127.0.0.1:${hostileListenPort}`;
  } else if (host.node !== undefined) {
    upstream = `http://127.0.0.1:${host.node.httpPort}`;
  } else {
    return;
  }
  // MESH_INTERFACE → Discovery / Transports — a mesh node bootstraps
  // from OTHER public mesh nodes' TCP addresses, each named with its
  // `/p2p/<peer id>` derived from the key file created in Phase 4. A
  // public mesh node skips itself in its own bootstrap list.
  const bootstrapAddrs = [];
  for (const { name: pubName, host: pubHost } of publicMeshHosts(topology)) {
    if (pubName === name) continue;
    const pubPeerId = peerIdStringOf(notisIds[pubName]);
    bootstrapAddrs.push(`/ip4/${pubHost.addr}/tcp/${pubHost.mesh.tcpPort}/p2p/${pubPeerId}`);
  }
  // MESH_INTERFACE → NAT — "A private node ... takes relay
  // reservations on public nodes". libp2p 3.5's circuit-relay
  // listener (`@libp2p/circuit-relay-v2/src/transport/listener.ts`)
  // reserves on a named relay when the listen address names it, and
  // does a non-deterministic RelayDiscovery walk when the listen
  // address is bare `/p2p-circuit`. One specific listen address per
  // public relay bootstraps gives the browser a relay-path through
  // each public node deterministically.
  const circuitListens = [];
  const stunServers = [];
  if (host.mesh.role === 'private') {
    for (const { name: pubName, host: pubHost } of publicMeshHosts(topology)) {
      if (pubName === name) continue;
      const pubPeerId = peerIdStringOf(notisIds[pubName]);
      circuitListens.push(`/ip4/${pubHost.addr}/tcp/${pubHost.mesh.tcpPort}/p2p/${pubPeerId}/p2p-circuit`);
      // MESH_INTERFACE → NAT — "every STUN server is a mesh node
      // named by IP". A private node gathers ICE candidates against
      // the public mesh nodes' STUN by IP for its WebRTC
      // reservations.
      if (pubHost.mesh.stunPort !== undefined) {
        stunServers.push(`stun:${pubHost.addr}:${pubHost.mesh.stunPort}`);
      }
    }
  }
  const meshEnv = {
    MESH_KEY_PATH: meshKeyPath,
    MESH_NETWORK: 'devnet',
    MESH_ROLE: host.mesh.role,
    MESH_STATE_DIR: meshStateDir,
    MESH_UPSTREAM: upstream,
    // MESH_INTERFACE → NAT — "A public node announces its listen
    // addresses from the start" with concrete-port WebRTC-direct and
    // TCP addresses on its own IP; a private node listens on its own
    // (NAT-inside) IP with concrete ports AND on one
    // /ip4/<pub>/tcp/<port>/p2p/<pub-peer>/p2p-circuit per public
    // relay it bootstraps from.
    MESH_LISTEN: [
      `/ip4/${host.addr}/udp/${host.mesh.webrtcPort}/webrtc-direct`,
      `/ip4/${host.addr}/tcp/${host.mesh.tcpPort}`,
      ...circuitListens,
    ].join(','),
    MESH_BOOTSTRAP: bootstrapAddrs.join(','),
    ...(host.mesh.stunPort !== undefined ? { MESH_STUN: `${host.addr}:${host.mesh.stunPort}` } : {}),
    ...(stunServers.length > 0 ? { MESH_STUN_SERVERS: stunServers.join(',') } : {}),
    ...(host.mesh.wss !== undefined ? {
      MESH_WSS: `${host.addr}:${host.mesh.wss.port}`,
      MESH_ACME_DIRECTORY: `https://${pebbleHost.addr}:${pebbleListenPort}/dir`,
      MESH_ACME_CHALLENGE_PORT: String(host.mesh.wss.acmeChallengePort),
      // MESH_INTERFACE → The IP certificate — pub1 trusts the stage
      // CA alone through its node TLS store: pub1's ACME HTTPS to
      // Pebble verifies against the CA that signed Pebble's TLS. The
      // Pebble issuing root is the browser's business (installed in
      // its NSS db), not pub1's.
      NODE_EXTRA_CA_CERTS: stageCaPath,
    } : {}),
  };
  const meshLogPath = logPathFor(`mesh:${name}`);
  const meshChild = log.spawn(userWrap(ns, meshEnv).concat([meshNodeEntry]), { description: `mesh:${name}`, logPath: meshLogPath });
  if (!dryRun) {
    // The mesh node's stdout is a file; tail it until the first JSON
    // identity line that satisfies its role's predicate (a public
    // node: any identity; a private node: an identity whose multiaddrs
    // carries a /p2p-circuit address — the mesh node reprints its
    // identity on self:peer:update when the relay reservation lands).
    // A mesh node that dies before writing one fails the stage at
    // once, with the log tail named.
    const predicate = identityPredicateForMeshRole(host.mesh.role);
    // A private node needs more time: it has to connect to a public
    // node, request a reservation, and wait for the relay to grant
    // one. 120 s covers the slowest of these on the stage.
    const identityTimeoutMs = host.mesh.role === 'private' ? 120_000 : 60_000;
    // MESH_INTERFACE → NAT — the private node reserves on each
    // circuit listen address. A timeout here is "none of these
    // reserved in time"; the error message names the relays the node
    // was told to try so a reader sees what the attempt was.
    const circuitListensSnapshot = [...circuitListens];
    meshIdentityPromises[name] = readMeshIdentityUntil(meshChild, meshLogPath, predicate, { timeoutMs: identityTimeoutMs })
      .catch((err) => {
        const tail = tailLog(meshLogPath, 20);
        const body = tail === '' ? '<no output>' : tail;
        const relaysDetail = circuitListensSnapshot.length > 0
          ? `\n--- circuit listens the node was told to reserve on ---\n${circuitListensSnapshot.join('\n')}`
          : '';
        throw new Error(`mesh:${name} identity line not read: ${err.message}${relaysDetail}\n--- last 20 lines of ${meshLogPath} ---\n${body}`);
      });
  }
}

async function awaitMeshIdentities(whichRole) {
  if (dryRun) return {};
  const entries = Object.entries(meshIdentityPromises).filter(([name]) => {
    const host = topology.hosts[name];
    return host?.mesh?.role === whichRole;
  });
  const settled = await Promise.allSettled(
    entries.map(async ([name, p]) => [name, await p]),
  );
  const failures = settled.filter((s) => s.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(failures.map((f) => f.reason?.message ?? String(f.reason)).join('\n\n'));
  }
  return Object.fromEntries(settled.map((s) => s.value));
}

// Public mesh nodes first: start every public one (hostile-* hosts
// have mesh.role === 'public' per the dial-ability requirement — see
// `topology.json`), then wait for their identity lines.
for (const [name, host] of Object.entries(topology.hosts)) {
  if (host.mesh?.role === 'public') startMeshNodeForHost(name, host);
}
recordWait('each public mesh node prints its identity line (notisId, peerId, multiaddrs with /certhash/)');
let meshIdentities = {};
if (!dryRun) {
  Object.assign(meshIdentities, await awaitMeshIdentities('public'));
}

// Private mesh nodes next: start every private one; their /p2p-circuit
// listens reserve on the publics that are now up.
for (const [name, host] of Object.entries(topology.hosts)) {
  if (host.mesh?.role === 'private') startMeshNodeForHost(name, host);
}
recordWait('each private mesh node announces a /p2p-circuit address (relay reservation lands)');
if (!dryRun) {
  Object.assign(meshIdentities, await awaitMeshIdentities('private'));
}

// -----------------------------------------------------------------------
// Phase 8: miner inside pub1, wait for height, cut off hostile-lagging
// -----------------------------------------------------------------------

// MESH_INTERFACE → Acceptance — the miner reads `pub1`'s HTTP; pub1's HTTP
// binds pub1's namespace loopback, so the miner runs inside notismesh-pub1.
// `MINER_PCT=100` while the chain reaches height 50; after the height
// wait the boot miner is replaced by a `miner-steady` at
// `MINER_PCT=10`, which keeps the chain growing so `hostile-lagging`
// falls further behind without burning a core for the whole run.
const minerBootChild = log.spawn(userWrap(nsOf('pub1'), {
  NODE_URL: `http://127.0.0.1:${pub1Host.node.httpPort}`,
  MINING_SECRET: 'stage-mining-secret',
  MINER_PCT: '100',
}).concat([minerScript]), { description: 'miner-boot', logPath: logPathFor('miner-boot') });

const honestHeightTargetHost = ['pub1', 'pub2', 'priv1', 'priv2', 'lan1'];
recordWait(`every honest node reads /blocks/current.height >= 50: ${honestHeightTargetHost.join(', ')}`);
if (!dryRun) {
  // Each honest node is polled inside its own namespace as the user —
  // the host has no route into the stage, and the user has no privilege
  // beyond what `ip netns exec` grants in that namespace.
  const HEIGHT_TARGET = 50;
  await Promise.all(honestHeightTargetHost.map(async (name) => {
    const host = topology.hosts[name];
    const port = host.node.httpPort;
    let lastHeight = null;
    await waitWithTail(
      `height on ${name}`,
      async () => {
        const stdout = execIn(nsOf(name), [
          'curl', '-sf', '--max-time', '5',
          `http://127.0.0.1:${port}/blocks/current`,
        ], { timeoutMs: 8_000 });
        const data = JSON.parse(stdout);
        if (typeof data.height !== 'number') return false;
        lastHeight = data.height;
        return data.height >= HEIGHT_TARGET;
      },
      logPathFor(`notis:${name}`),
      { timeoutMs: 600_000, pollMs: 2_000 },
    ).catch((err) => {
      throw new Error(`${name}: last height ${lastHeight} — ${err.message}`);
    });
  }));
}

// MESH_INTERFACE → Acceptance — stop the 100 %-duty boot miner and
// restart at `MINER_PCT=10`, chosen so the chain still grows at ~1
// block per 10 s on this devnet (the miner script's duty cycle is a
// percentage of CPU time, so 10 % keeps roughly one block in flight
// per 10 s on a single core). A seven-hour run at that duty uses
// ~0.1 cores on average rather than one full core.
if (!dryRun && minerBootChild !== null) {
  try { process.kill(minerBootChild.pid, 'SIGTERM'); } catch { /* already gone */ }
  // Drop the boot miner's pid from the recorded list so `down` does
  // not try to signal it a second time.
  const idx = log.pids.findIndex((e) => e.description === 'miner-boot');
  if (idx >= 0) log.pids.splice(idx, 1);
}
log.spawn(userWrap(nsOf('pub1'), {
  NODE_URL: `http://127.0.0.1:${pub1Host.node.httpPort}`,
  MINING_SECRET: 'stage-mining-secret',
  MINER_PCT: '10',
}).concat([minerScript]), { description: 'miner-steady', logPath: logPathFor('miner-steady') });

// MESH_INTERFACE → The client's node list — `hostile-lagging`'s mesh node
// stays up and reachable; only its Notis node is cut off from the other
// Notis nodes' p2p port, so scenario 6b's "behind, never blacklisted" sees
// a mesh node that serves a valid proof of a lighter chain. The cut is
// applied AFTER the height wait, so the lagging node is behind from a
// synced start.
const laggingHost = topology.hosts['hostile-lagging'];
if (laggingHost) {
  const laggingP2pPort = laggingHost.node.p2pPort;
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('hostile-lagging'), 'nft', 'add', 'table', 'ip', 'lag_cut'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('hostile-lagging'), 'nft', 'add', 'chain', 'ip', 'lag_cut', 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('hostile-lagging'), 'nft', 'add', 'rule', 'ip', 'lag_cut', 'out', 'tcp', 'dport', String(laggingP2pPort), 'drop'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('hostile-lagging'), 'nft', 'add', 'chain', 'ip', 'lag_cut', 'in', '{', 'type', 'filter', 'hook', 'input', 'priority', '0', ';', '}'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', nsOf('hostile-lagging'), 'nft', 'add', 'rule', 'ip', 'lag_cut', 'in', 'tcp', 'sport', String(laggingP2pPort), 'drop'], { privileged: true });
}

// -----------------------------------------------------------------------
// Phase 9: Pebble root install, browser host, config.json, pids.json
// -----------------------------------------------------------------------

const browserProfileHome = join(OUT_DIR, 'browser', 'home');
const browserProfileDir = join(OUT_DIR, 'browser', 'profile');
const pageServeDir = join(PACKAGE_ROOT, 'dist-page');
const chromiumBin = '/home/mwaddip/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

// MESH_INTERFACE → The IP certificate — the root Pebble answers from its
// management API. The host has no route into the stage, so the fetch
// runs inside `notismesh-browser` as the user (natC's masquerade reaches
// the internet segment). The out path lives in `stage/out/`, which the
// user already owns.
const browserNssDir = join(browserProfileHome, '.pki', 'nssdb');
log.shell('sudo', [
  'ip', 'netns', 'exec', nsOf('browser'),
  'sudo', '-u', INVOKING_USER, '--',
  'curl', '-sf', '--cacert', stageCaPath, '--max-time', '15',
  `https://${pebbleHost.addr}:${pebbleManagementPort}/roots/0`,
  '-o', pebbleRootPath,
]);

// MESH_INTERFACE → The IP certificate — pub1's mesh node trusts only
// the stage CA (`NODE_EXTRA_CA_CERTS=stage-ca.pem`); its ACME HTTPS to
// Pebble verifies against the CA that signed Pebble's TLS. Pebble's
// own issuing root (`pebble-root.pem`) is the browser's business: the
// certificate Pebble issues to pub1 verifies on the browser's path
// through the NSS db certutil populates below.

// `certutil -d sql:<home>/.pki/nssdb -A -n pebble-root -t "C,,"` installs
// the root into the NSS db Chromium reads when `HOME` is set to that
// profile. The three trust-attribute fields are TLS, email, object
// signing; `C,,` is "trusted CA for SSL servers" (no trust for email,
// no trust for object signing). `,,` means NO trust at all, which
// Chromium reads as `net::ERR_CERT_AUTHORITY_INVALID` on the first WSS
// dial. `libnss3-tools` provides certutil.
log.shell('sh', ['-c', `which certutil >/dev/null || { echo "certutil (libnss3-tools) not installed on this machine — install it before stage:up" >&2; exit 1; }`]);
log.shell('mkdir', ['-p', browserNssDir]);
// Create the NSS database only when it is absent (`cert9.db` is the SQL
// backend's file). An unconditional `certutil -N` plus `|| true` would
// swallow a real failure; this test lets one fail.
log.shell('sh', ['-c', `test -f ${join(browserNssDir, 'cert9.db')} || certutil -N -d sql:${browserNssDir} --empty-password`]);
log.shell('certutil', ['-A', '-d', `sql:${browserNssDir}`, '-n', 'pebble-root', '-t', 'C,,', '-i', pebbleRootPath]);
// Read back the installed trust. The `-n <nickname>` form prints the
// trust in WORDS ("Certificate Trust Flags: / SSL Flags: / Valid CA /
// Trusted CA") — it never prints `C,,`. The LIST form (no `-n`)
// prints a table whose rows read `pebble-root   C,,`; grep against
// THAT, anchored to our nickname so another row's `C,,` cannot
// satisfy the check.
log.shell('sh', ['-c', `certutil -L -d sql:${browserNssDir} | grep -E '^pebble-root[[:space:]]+C,,' >/dev/null || { echo "pebble-root in NSS db but trust is not C,, (list-form row) — Chromium will refuse the IP cert as ERR_CERT_AUTHORITY_INVALID" >&2; exit 1; }`]);

// MESH_INTERFACE → Discovery — `config.json` is written from the keys'
// real notisIds and the mesh nodes' printed multiaddrs (which carry
// each WebRTC-direct cert's hash). The identities were awaited right
// after the mesh spawn so a dead mesh node fails fast; here we read
// the stored multiaddrs for the public nodes alone — the ones a
// browser dials. Dry-run uses the topology shape and an in-process
// ephemeral key for the peer id; no placeholder lands in a written file.
const configPath = join(OUT_DIR, 'browser', 'config.json');
let realMultiaddrs;
if (!dryRun) {
  realMultiaddrs = {};
  for (const { name } of publicMeshHosts(topology)) {
    const identity = meshIdentities[name];
    if (identity !== undefined) realMultiaddrs[name] = identity.multiaddrs ?? [];
  }
}
// MESH_INTERFACE → Acceptance — exec-mode `buildPageConfig` demands real
// mesh identities; dry-run opts into a /certhash/ placeholder. A
// placeholder in a REAL config.json leaks to the browser as a
// SyntaxError on dial — the opt-in guards against that.
const pageConfig = buildPageConfig(topology, notisIds, realMultiaddrs, { dryRun });

if (!dryRun) {
  mkdirSync(dirname(configPath), { recursive: true });
  const configBody = JSON.stringify(pageConfig, null, 2);
  writeFileSync(configPath, configBody);
  // MESH_INTERFACE → Acceptance — "Every scenario writes the config
  // it needs at its start — the stage's default when it needs no
  // variant — and never reads a previous scenario's". The canonical
  // default is kept alongside `config.json` so a no-variant scenario
  // can copy it before opening a page; a variant scenario builds its
  // variant from this same bytes-for-bytes copy.
  writeFileSync(join(dirname(configPath), 'config.default.json'), configBody);
  // MESH_INTERFACE → Acceptance — a scenario reads a node's HTTP
  // directly from its own namespace and compares the probe byte for
  // byte. It needs the host↔notisId mapping to find the right ns.
  // `stage/out/identities.json` is the simplest answer: `{ host:
  // { notisId, meshRole, httpPort? } }`, one row per host up spawned
  // a mesh node for.
  const identitiesPath = join(OUT_DIR, 'identities.json');
  const identitiesOut = {};
  for (const [host, hostConfig] of Object.entries(topology.hosts)) {
    const id = notisIds[host];
    if (typeof id !== 'string') continue;
    identitiesOut[host] = {
      notisId: id,
      meshRole: hostConfig.mesh?.role ?? null,
      addr: hostConfig.addr ?? null,
      httpPort: hostConfig.node?.httpPort ?? null,
      // MESH_INTERFACE → Acceptance 6 — s6's seeds dial by printed
      // multiaddr. Every mesh host's identity line (not just the public
      // anchors) lands here so the scenario can read what the mesh node
      // actually listens on, including the hostile ones.
      multiaddrs: meshIdentities[host]?.multiaddrs ?? [],
    };
  }
  writeFileSync(identitiesPath, JSON.stringify(identitiesOut, null, 2));
}

// Serve the page over plain HTTP on the browser host's loopback. A tiny
// static server is enough; the browser dials it over `http://localhost`,
// and loads `config.json` from the same origin.
const pageServerScript = join(HERE, 'page-server.mjs');
log.spawn(userWrap(nsOf('browser'), {
  SERVE_DIR: pageServeDir,
  CONFIG_PATH: configPath,
  PAGE_PORT: String(browserHost.httpPort),
}).concat([pageServerScript]), { description: 'page-server', logPath: logPathFor('page-server') });

recordWait(`page server answers http://localhost:${browserHost.httpPort}/config.json`);
if (!dryRun) {
  await waitWithTail(
    'page-server /config.json',
    () => {
      execIn(nsOf('browser'), [
        'curl', '-sf', '--max-time', '5',
        `http://localhost:${browserHost.httpPort}/config.json`,
      ], { timeoutMs: 8_000 });
      return true;
    },
    logPathFor('page-server'),
    { timeoutMs: 30_000, pollMs: 500 },
  );
}

// Chromium under the throwaway profile. `HOME` points to the browser
// host's private directory so Chromium reads the NSS db we populated
// above; no flag, no system store — the root is scoped to this launch.
//
// The quiet switches are taken from Playwright's
// `packages/playwright-core/src/server/chromium/chromiumSwitches.ts`
// (its `chromiumSwitches` function) and Puppeteer's
// `packages/puppeteer-core/src/node/ChromeLauncher.ts` (its
// `defaultArgs`). Both tools pass this set by default to silence
// Chromium's housekeeping (sync, safebrowsing, component updates,
// metrics, translate, media routing, optimization hints, DNS
// resolution for first-party-sets, HTTPS upgrades, …) so scenario 1's
// DNS witness measures the PAGE alone and not the browser.
const CHROMIUM_QUIET_FLAGS = [
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-domain-reliability',
  '--disable-extensions',
  '--disable-features=AcceptCHFrame,AutoExpandDetailsElement,AvoidUnnecessaryBeforeUnloadCheckSync,CertificateTransparencyComponentUpdater,DialMediaRouteProvider,FirstPartySets,HttpsUpgrades,LazyFrameLoading,LensOverlay,MediaRouter,OptimizationHints,PaintHolding,PlzDedicatedWorker,PrivacySandboxSettings4,Translate',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-search-engine-choice-screen',
  '--disable-sync',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-service-autorun',
  '--password-store=basic',
  '--use-mock-keychain',
];
// MESH_INTERFACE → Acceptance — scenario 1: the browser's resolver answers
// no name. Chromium's own name resolver sees `MAP * ~NOTFOUND` and refuses
// every host but the ones in `EXCLUDE`, so the page (`http://localhost`)
// resolves, and so does every public IP literal in the stage's internet
// segment (`EXCLUDE 11.100.0.*`, derived from `topology.internet.subnet`).
// Chromium's `MAP * ~NOTFOUND` matches an IP-literal host too, so without
// the subnet EXCLUDE the browser refuses every anchor address with
// `net::ERR_NAME_NOT_RESOLVED`.
const internetSubnetPrefix = topology.internet.subnet.replace(/\.0\/\d+$/, '.*');
const CHROMIUM_HOST_RESOLVER_RULES = `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE ${internetSubnetPrefix}`;
log.spawn(userWrap(nsOf('browser'), { HOME: browserProfileHome, DISPLAY: process.env.DISPLAY ?? ':0' }, chromiumBin).concat([
  '--headless=new',
  `--user-data-dir=${browserProfileDir}`,
  ...CHROMIUM_QUIET_FLAGS,
  CHROMIUM_HOST_RESOLVER_RULES,
  '--remote-debugging-port=9222',
  `http://localhost:${browserHost.httpPort}/`,
]), { description: 'chromium', logPath: logPathFor('chromium') });

recordWait('chromium CDP answers http://127.0.0.1:9222/json/version');
if (!dryRun) {
  await waitWithTail(
    'chromium CDP',
    () => {
      execIn(nsOf('browser'), [
        'curl', '-sf', '--max-time', '5',
        'http://127.0.0.1:9222/json/version',
      ], { timeoutMs: 8_000 });
      return true;
    },
    logPathFor('chromium'),
    { timeoutMs: 60_000, pollMs: 1_000 },
  );
}

// MESH_INTERFACE → Acceptance — live-check before `stage up:` prints.
// Every long-lived process on `log.pids` is confirmed alive with
// `process.kill(pid, 0)`; every one that serves something is reached
// through its namespace with `curl` and must answer. A failed check
// surfaces here, not seven hours later when a scenario drives it.
const liveListenerChecks = (() => {
  const checks = [];
  for (const [name, host] of Object.entries(topology.hosts)) {
    if (host.mesh?.upstreamMode !== undefined) {
      // Hostile upstream listens on 127.0.0.1:7000 inside its own ns.
      checks.push({
        description: `hostile-upstream:${name}`,
        ns: nsOf(name),
        url: 'http://127.0.0.1:7000/nipopow/proof/24/20',
        logPath: logPathFor(`hostile-upstream:${name}`),
      });
    }
  }
  return checks;
})();
log.records.push(`[live-check] ${log.pids.length} PID(s) alive; ${liveListenerChecks.length} hostile-upstream listener(s) answer`);
if (dryRun) {
  process.stdout.write(`[live-check] ${log.pids.length} PID(s) alive; ${liveListenerChecks.length} hostile-upstream listener(s) answer\n`);
} else {
  for (const entry of log.pids) {
    const r = isProcessAlive(entry.pid);
    if (!r.alive) {
      const tail = tailLog(entry.logPath, 20);
      const body = tail === '' ? '<no output>' : tail;
      throw new Error(`${entry.description} (pid ${entry.pid}) is not alive: ${r.reason}\n--- last 20 lines of ${entry.logPath} ---\n${body}`);
    }
  }
  for (const chk of liveListenerChecks) {
    try {
      execIn(chk.ns, ['curl', '-sf', '--max-time', '5', chk.url], { timeoutMs: 8_000 });
    } catch (err) {
      const tail = tailLog(chk.logPath, 20);
      const body = tail === '' ? '<no output>' : tail;
      throw new Error(`${chk.description} did not answer ${chk.url}: ${(err).message}\n--- last 20 lines of ${chk.logPath} ---\n${body}`);
    }
  }
}

if (dryRun) {
  process.stdout.write(`\n[would write] ${configPath}:\n${JSON.stringify(pageConfig, null, 2)}\n`);
  // MESH_INTERFACE → Acceptance — the canonical default is written
  // alongside the active config; scenarios copy it when they need no
  // variant. Showing the write in the dry-run lets a reader see that
  // the stage keeps both.
  process.stdout.write(`\n[would write] ${join(dirname(configPath), 'config.default.json')}: (bytes-for-bytes copy of config.json)\n`);
  process.stdout.write(`\n[dry-run complete] ${log.privilegedCount} privileged command(s) listed; no namespace, file or process was created.\n`);
} else {
  // Final rewrite catches any state change since the last spawn (the
  // created-namespace list may have grown too).
  writePidsJson();
  process.stdout.write(`stage up: ${log.pids.length} processes, ${createdNamespaces.length} namespaces\n`);
}

} catch (err) {
  teardown(err);
  if (!dryRun) process.exit(1);
}
