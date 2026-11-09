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
import { loadNodeKey } from '@dagsocial/net';
import { CommandLog, isProcessAlive } from './lib/commands.mjs';
import { readTopology, natRouters, publicMeshHosts, hostsBehindBrowserNat } from './lib/topology.mjs';
import { buildPageConfig, buildIdentitiesOut, peerIdStringOf } from './lib/config.mjs';
import { generateStageCerts } from './lib/pebble-certs.mjs';
import { buildPebbleConfig } from './lib/pebble-config.mjs';
import { descendantPids, restartFromEntry } from './lib/measure.mjs';
import {
  partnerOf,
  pairBootstrapAddr,
  buildPairCutArgs,
} from './lib/hostile-fork-pair.mjs';
import {
  buildForkCutArgs,
  buildForkMinerSpawn,
  buildHonestSideIsolationArgs,
  forkHostBootstrapPeers,
} from './lib/hostile-fork-single.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const OUT_DIR = join(HERE, 'out');
const CACHE_DIR = join(HERE, 'cache');
const TOPOLOGY_PATH = join(HERE, 'topology.json');

// MESH_INTERFACE → Acceptance — every stage process spawns on the Node
// that is running this script, so a dry-run writes the Node binary it
// will run. `process.execPath` is Node 24's absolute path on this
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
// `pebble-linux-amd64/linux/amd64/pebble`. The SHA-256 is the archive's at
// `PEBBLE_URL`.
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

// MESH_INTERFACE → Acceptance — every stage process runs as the
// invoking user, on the Node that is running this script.
// `userNode(args, env)` is one `sudo -u <user> -- env ...` wrap, so
// every spawn line in the dry-run says which user and which Node binary;
// the host's older `/usr/bin/node`, which `secure_path` would resolve
// to under a plain `sudo node`, never runs.
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
/**
 * Walk a `notis:<host>.log` file and keep track of every peer-id that
 * has a `peer:connect` line NOT followed by a matching
 * `peer:disconnect` — the set of peers the host still reports
 * connected. A shape the admin API does not expose directly (no
 * `/peers` route), so on a cut-leak failure the Phase 8b check names
 * these ids so a reader of the error sees which hosts leaked.
 *
 * Returns `[]` when the log file does not exist. The log format is
 * `[net] peer:connect <peerIdString> (total=N)` and
 * `[net] peer:disconnect <peerIdString> (total=N)`.
 */
function standingConnectedPeerIds(logPath) {
  if (!logPath || !existsSync(logPath)) return [];
  const text = readFileSync(logPath, 'utf8');
  const connected = new Set();
  const connectRe = /\[net\] peer:connect ([A-Za-z0-9]+)/;
  const disconnectRe = /\[net\] peer:disconnect ([A-Za-z0-9]+)/;
  for (const line of text.split('\n')) {
    let m = connectRe.exec(line);
    if (m) { connected.add(m[1]); continue; }
    m = disconnectRe.exec(line);
    if (m) { connected.delete(m[1]); }
  }
  return [...connected];
}

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
 * `predicate(parsed)`. The integrated Notis node writes one JSON
 * line to stdout when its mesh starts listening, and reprints the line
 * on every `self:peer:update` — a public role's listen address verifies,
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
// Phase 4: node keys and notisIds
// -----------------------------------------------------------------------

// NET_INTERFACE → "The node key" — `loadNodeKey(path)` reads the 48-byte
// secretKey at `path`, or writes a fresh key with mode 0600 opened
// exclusively; the publicKey (the 32-byte notisId) is derived from the
// file's seed. Each host that runs the mesh takes its node key here so
// every peer id is known before `config.json` and `BOOTSTRAP_PEERS` name
// one another's `/p2p/<peer id>` trailers.
const hostsWithMesh = Object.entries(topology.hosts).filter(([, h]) => h.mesh !== undefined);
const notisIds = {};

for (const [name] of hostsWithMesh) {
  const keyPath = join(OUT_DIR, name, 'node.key');
  const line = `[phase 4] loadNodeKey ${keyPath}`;
  log.records.push(line);
  if (dryRun) {
    process.stdout.write(line + '\n');
    // Dry-run: compute a throwaway notisId inline so the config preview
    // has a plausible shape without writing anything to disk.
    const seed = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(seed);
    notisIds[name] = bytesToHex(pub);
  } else {
    mkdirSync(dirname(keyPath), { recursive: true });
    const { publicKey } = await loadNodeKey(keyPath);
    notisIds[name] = bytesToHex(publicKey);
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
// Phase 7: one Notis node per host, the hostile-upstream redirect lie
// -----------------------------------------------------------------------

// NODE_INTERFACE → Configuration → "A mesh node prints its identity line" —
// one node per host: the node reads its `MESH_*` env for the mesh role; its
// `.mesh` state directory sits beside `DB_PATH`, its mesh endpoint forwards
// to `http://127.0.0.1:<PORT>`, its identity line is one JSON object on
// stdout with `{notisId, peerId, multiaddrs, localAddrs}` reprinted on
// change. `pids.json` keys `notis:<host>` alone.
const notisNodeEntry = join(REPO_ROOT, 'packages', 'node', 'dist', 'index.js');
const minerScript = join(REPO_ROOT, 'packages', 'node', 'scripts', 'miner.mjs');
const hostileUpstreamScript = join(HERE, 'hostile-upstream.mjs');
const hostileGossipScript = join(HERE, 'hostile-gossip.mjs');

const pub1Host = topology.hosts.pub1;

// Capture identity lines from each host's `notis.log` (the node's one JSON
// line with a `notisId` key, reprinted on change). The publisher host
// runs no Notis node — its identity line comes from `hostile-gossip.mjs`
// instead, reading the same `node.key`.
const meshIdentityPromises = {};

// MESH_INTERFACE → Acceptance — "a hostile host's lie outside the node
// it runs". For each `hostile-malformed` / `hostile-invalid`: an `nft nat
// output` rule in its namespace redirects `127.0.0.1:<nodePort>` to the
// interposer's port, so the node's own mesh-endpoint forward
// (`httpBase = http://127.0.0.1:<PORT>`) lands on the interposer. The rule
// is added BEFORE the node spawns.
const INTERPOSER_PORT = 7000;
const hostileUpstreamNames = ['hostile-malformed', 'hostile-invalid'];
for (const name of hostileUpstreamNames) {
  const host = topology.hosts[name];
  if (host === undefined || host.mesh?.upstreamMode === undefined) continue;
  const ns = nsOf(name);
  const port = String(host.node.httpPort);
  // The table name is `nat` — "nat" as a word on every rule line, so a
  // reader (and the dry-run test) can single it out from the chain's
  // `type nat hook output` alone.
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', 'nat'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', 'nat', 'out', '{', 'type', 'nat', 'hook', 'output', 'priority', '-100', ';', '}'], { privileged: true });
  log.shell('sudo', ['ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', 'nat', 'out', 'ip', 'daddr', '127.0.0.1', 'tcp', 'dport', port, 'redirect', 'to', `:${INTERPOSER_PORT}`], { privileged: true });
}

// Start the interposer on each hostile-upstream host BEFORE the node, so
// the node's first mesh-endpoint forward lands on a live listener. The
// interposer forwards to the node at the namespace's own address — the
// `ip daddr 127.0.0.1` redirect does not match `<host.addr>`, so the
// interposer reaches the node's real HTTP listener (`listenPublic` binds
// all interfaces, `server.listen(port)` with no host).
for (const name of hostileUpstreamNames) {
  const host = topology.hosts[name];
  if (host === undefined || host.mesh?.upstreamMode === undefined) continue;
  log.spawn(userWrap(nsOf(name), {
    MODE: host.mesh.upstreamMode,
    PORT: String(INTERPOSER_PORT),
    PUB1_BASE: `http://${host.addr}:${host.node.httpPort}`,
  }).concat([hostileUpstreamScript]), {
    description: `hostile-upstream:${name}`,
    logPath: logPathFor(`hostile-upstream:${name}`),
  });
}

// MESH_INTERFACE → Acceptance 8 — the hostile fork pair's `lag_cut` runs
// BEFORE either pair host's Notis node spawns, so the pair's p2p port
// never sees a packet from an honest host. The pair's Notis env below
// names the partner alone in `BOOTSTRAP_PEERS` (never pub1), so the pair
// never dials an honest node either.
const laggingHostCfg = topology.hosts['hostile-lagging'];
const malformedHostCfg = topology.hosts['hostile-malformed'];
if (laggingHostCfg && malformedHostCfg) {
  for (const { argv } of buildPairCutArgs(topology)) {
    log.shell(argv[0], argv.slice(1), { privileged: true });
  }
}

// Spawn one Notis node per host. For every non-pair mesh host the env
// carries the `MESH_*` settings the node reads at load
// (`NODE_INTERFACE → Configuration`). The one exception is `hostile-publisher`:
// its one mesh entity is `hostile-gossip.mjs` (a libp2p host built from
// `@dagsocial/net`'s pieces, publishing bad blocks on the gossip topic),
// so no Notis node runs on that host — nothing there needs a chain or
// its HTTP API. The publisher reads the host's `node.key` directly, so
// the identity under `notisIds[name]` matches the addresses it announces.
function spawnNotisForHost(name, host) {
  const ns = nsOf(name);
  const dbPath = join(OUT_DIR, name, 'notis.db');
  const nodeKeyPath = join(OUT_DIR, name, 'node.key');

  // MESH_INTERFACE → Discovery / NAT — a non-pair node seeds to every
  // OTHER public mesh node with its `/p2p/<peerId>` trailer; a pair
  // host (`hostile-lagging`, `hostile-malformed`) names the partner's
  // bare-TCP addr alone, so the pair starts from genesis with no path
  // to the honest chain. `hostile-fork` names pub1 alone — it syncs
  // the honest chain from pub1 before Phase 8b cuts its p2p port and
  // starts its own miner (`stage/lib/hostile-fork-single.mjs`).
  const partner = partnerOf(name);
  let bootstrapPeers;
  if (partner !== null) {
    bootstrapPeers = pairBootstrapAddr(topology, name);
  } else if (name === 'hostile-fork' || name === 'hostile-fork-peer') {
    const pub1Host = topology.hosts['pub1'];
    const pub1PeerId = peerIdStringOf(notisIds['pub1']);
    const pub1Addr = `/ip4/${pub1Host.addr}/tcp/${pub1Host.node.p2pPort}/p2p/${pub1PeerId}`;
    bootstrapPeers = forkHostBootstrapPeers(pub1Addr);
  } else {
    const seeds = [];
    for (const { name: pubName, host: pubHost } of publicMeshHosts(topology)) {
      if (pubName === name) continue;
      const pubPeerId = peerIdStringOf(notisIds[pubName]);
      seeds.push(`/ip4/${pubHost.addr}/tcp/${pubHost.node.p2pPort}/p2p/${pubPeerId}`);
    }
    bootstrapPeers = seeds.join(',');
  }

  const notisEnv = {
    NETWORK_TYPE: 'devnet',
    NODE_ROLE: host.node.role,
    PORT: String(host.node.httpPort),
    ADMIN_PORT: String(host.node.httpPort + 1),
    DB_PATH: dbPath,
    NODE_KEY_PATH: nodeKeyPath,
    LISTEN_ADDRS: `/ip4/${host.addr}/tcp/${host.node.p2pPort}`,
    BOOTSTRAP_PEERS: bootstrapPeers,
    MINING_SECRET: 'stage-mining-secret',
  };

  // MESH_INTERFACE → NAT → "A public node announces its listen addresses
  // from the start" with concrete-port WebRTC-direct and TCP addresses on
  // its own IP; a private node listens on its own IP with the same shape,
  // and its circuit listens are derived by `net` from the connection it
  // holds to each seed (`MESH_INTERFACE → NAT`). The node reads
  // `MESH_LISTEN` as one comma-separated list.
  const isMeshHost = host.mesh !== undefined && host.mesh.publisher !== true;
  if (isMeshHost) {
    notisEnv.MESH_ROLE = host.mesh.role;
    notisEnv.MESH_LISTEN = [
      `/ip4/${host.addr}/udp/${host.mesh.webrtcPort}/webrtc-direct`,
      `/ip4/${host.addr}/tcp/${host.mesh.tcpPort}`,
    ].join(',');
    if (host.mesh.stunPort !== undefined) {
      notisEnv.MESH_STUN = `${host.addr}:${host.mesh.stunPort}`;
    }
    if (host.mesh.role === 'private') {
      // MESH_INTERFACE → NAT → "Every STUN server is a mesh node named
      // by IP". A private node gathers ICE candidates against the
      // public mesh nodes' STUN by IP for its WebRTC reservations.
      const stunServers = [];
      for (const { name: pubName, host: pubHost } of publicMeshHosts(topology)) {
        if (pubName === name) continue;
        if (pubHost.mesh.stunPort !== undefined) {
          stunServers.push(`stun:${pubHost.addr}:${pubHost.mesh.stunPort}`);
        }
      }
      if (stunServers.length > 0) {
        notisEnv.MESH_STUN_SERVERS = stunServers.join(',');
      }
    }
    if (host.mesh.wss !== undefined) {
      notisEnv.MESH_WSS = `${host.addr}:${host.mesh.wss.port}`;
      notisEnv.MESH_ACME_DIRECTORY = `https://${pebbleHost.addr}:${pebbleListenPort}/dir`;
      notisEnv.MESH_ACME_CHALLENGE_PORT = String(host.mesh.wss.acmeChallengePort);
      // MESH_INTERFACE → The IP certificate — the node trusts the stage
      // CA alone through its TLS store; its ACME HTTPS to Pebble verifies
      // against the CA that signed Pebble's TLS.
      notisEnv.NODE_EXTRA_CA_CERTS = stageCaPath;
    }
  }

  const notisLogPath = logPathFor(`notis:${name}`);
  const child = log.spawn(userWrap(ns, notisEnv).concat([notisNodeEntry]), { description: `notis:${name}`, logPath: notisLogPath });

  if (isMeshHost && !dryRun) {
    // NODE_INTERFACE → "A mesh node prints its identity line" —
    // the node writes one JSON identity line once its addresses are
    // announced, and again on every change. The predicate picks the
    // first line that matches the role: any identity for public, one
    // whose `multiaddrs` carries `/p2p-circuit/webrtc/p2p/` for private
    // (so the stage's `identities.json` names an address a browser can
    // dial).
    const predicate = identityPredicateForMeshRole(host.mesh.role);
    const identityTimeoutMs = host.mesh.role === 'private' ? 120_000 : 60_000;
    meshIdentityPromises[name] = readMeshIdentityUntil(child, notisLogPath, predicate, { timeoutMs: identityTimeoutMs })
      .catch((err) => {
        const tail = tailLog(notisLogPath, 20);
        const body = tail === '' ? '<no output>' : tail;
        throw new Error(`notis:${name} identity line not read: ${err.message}\n--- last 20 lines of ${notisLogPath} ---\n${body}`);
      });
  }
}

// MESH_INTERFACE → NAT → "A public node announces its listen addresses
// from the start" / MINING_INTERFACE → The peer-readiness gate — a node
// that seeds from another dials its seed on boot. A dial on a listener
// that is not up yet lands on `ECONNREFUSED`, and `net` redials a seed
// only at its next outbound tick, 30 s on, after a 60 s cooldown. The
// ordered spawn below starts each seed before the nodes that seed from
// it, with the seed's identity line awaited between so the dependent
// dials a listener that is live.
//
// - pub1 and pub2 are each other's seed; start pub1, await its identity,
//   then pub2 — pub2 dials pub1 on boot and connects at once, pub1 picks
//   up pub2 on its own retry cadence.
// - MESH_INTERFACE → Acceptance 8 / MINING_INTERFACE → The peer-readiness
//   gate — the hostile fork pair's hosts seed each other alone. Start
//   `hostile-malformed` first: it carries no miner so it boots quickly;
//   `hostile-lagging` second, so its miner finds an Active peer at once
//   instead of waiting out the dial cooldown with no template produced.
const serialNotisOrder = ['pub1', 'pub2', 'hostile-malformed', 'hostile-lagging'];
const meshIdentities = {};
for (const name of serialNotisOrder) {
  const host = topology.hosts[name];
  if (host === undefined || host.node === undefined) continue;
  spawnNotisForHost(name, host);
  recordWait(`${name} prints its identity line (notisId, peerId, multiaddrs)`);
  if (!dryRun && meshIdentityPromises[name] !== undefined) {
    meshIdentities[name] = await meshIdentityPromises[name];
  }
}

// Every remaining node seeds from the publics; the publics are up by
// this point, so their spawns dial a listener that is live. The publisher
// host is skipped: its one mesh entity is `hostile-gossip.mjs`, spawned
// below — nothing on that host needs a chain or an HTTP API, so a Notis
// node beside the publisher would hold a SECOND identity on one host
// (two keys, two peer ids; the page config entry's `notisId` would be
// one key's and its addresses the other key's).
for (const [name, host] of Object.entries(topology.hosts)) {
  if (host.node === undefined) continue;
  if (serialNotisOrder.includes(name)) continue;
  if (host.mesh?.publisher === true) continue;
  spawnNotisForHost(name, host);
}

// MESH_INTERFACE → Acceptance 6 → "A mesh node publishing a block that
// fails its checks is blacklisted with its evidence" — the publisher host
// runs `hostile-gossip.mjs` as its one mesh entity (a libp2p host built
// from `@dagsocial/net`'s pieces). No Notis node runs on this host, so
// the publisher's libp2p alone listens on the mesh ports.
for (const [name, host] of Object.entries(topology.hosts)) {
  if (host.mesh?.publisher !== true) continue;
  const ns = nsOf(name);
  // ONE identity per host — the publisher reads the same `node.key`
  // Phase 4 populated, so `notisIds[name]` (from `node.key`) matches
  // the peer id in every address this process announces.
  const meshKeyPath = join(OUT_DIR, name, 'node.key');
  const bootstrapAddrs = [];
  for (const { name: pubName, host: pubHost } of publicMeshHosts(topology)) {
    if (pubName === name) continue;
    const pubPeerId = peerIdStringOf(notisIds[pubName]);
    bootstrapAddrs.push(`/ip4/${pubHost.addr}/tcp/${pubHost.mesh.tcpPort}/p2p/${pubPeerId}`);
  }
  const meshEnv = {
    MESH_KEY_PATH: meshKeyPath,
    MESH_NETWORK: 'devnet',
    MESH_ROLE: host.mesh.role,
    MESH_LISTEN: [
      `/ip4/${host.addr}/udp/${host.mesh.webrtcPort}/webrtc-direct`,
      `/ip4/${host.addr}/tcp/${host.mesh.tcpPort}`,
    ].join(','),
    MESH_BOOTSTRAP: bootstrapAddrs.join(','),
  };
  const logPath = logPathFor(`hostile-gossip:${name}`);
  const child = log.spawn(userWrap(ns, meshEnv).concat([hostileGossipScript]), { description: `hostile-gossip:${name}`, logPath });
  if (!dryRun) {
    const predicate = identityPredicateForMeshRole(host.mesh.role);
    meshIdentityPromises[name] = readMeshIdentityUntil(child, logPath, predicate, { timeoutMs: 60_000 })
      .catch((err) => {
        const tail = tailLog(logPath, 20);
        const body = tail === '' ? '<no output>' : tail;
        throw new Error(`hostile-gossip:${name} identity line not read: ${err.message}\n--- last 20 lines of ${logPath} ---\n${body}`);
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

recordWait('each public mesh node prints its identity line (notisId, peerId, multiaddrs with /certhash/)');
if (!dryRun) {
  Object.assign(meshIdentities, await awaitMeshIdentities('public'));
}

recordWait('each private mesh node announces a /p2p-circuit address (relay reservation lands)');
if (!dryRun) {
  Object.assign(meshIdentities, await awaitMeshIdentities('private'));
}

// -----------------------------------------------------------------------
// Phase 8: miners inside pub1 and hostile-lagging, wait for height
// -----------------------------------------------------------------------

// MESH_INTERFACE → Acceptance — the miner reads `pub1`'s HTTP; pub1's HTTP
// binds pub1's namespace loopback, so the miner runs inside notismesh-pub1.
// `MINER_PCT=100` while the chain reaches height 50; after the height
// wait the boot miner is replaced by a `miner-steady` at
// `MINER_PCT=2`, a 2 % duty cycle that keeps the chain growing while
// leaving the stage's checks ample room to measure, so `hostile-lagging`
// falls further behind without burning a core for the whole run.
const minerBootChild = log.spawn(userWrap(nsOf('pub1'), {
  NODE_URL: `http://127.0.0.1:${pub1Host.node.httpPort}`,
  MINING_SECRET: 'stage-mining-secret',
  MINER_PCT: '100',
}).concat([minerScript]), { description: 'miner-boot', logPath: logPathFor('miner-boot') });

// MESH_INTERFACE → Acceptance 8 — a node on another chain has its
// proof read when its tip moves, with the client's own, and the
// client's tip stays the honest chain's. The pair's chain grows from
// genesis, starting the moment the pair's Notis nodes come up — the
// pair cut landed BEFORE spawn, so no honest block ever lands on either
// pair host. `miner-lagging-boot` runs at `MINER_PCT=100` until the
// pair's node reads height ≥ 50 (as the honest boot does on pub1),
// then is replaced by `miner-lagging` at `MINER_PCT=1` — half the
// honest chain's steady duty, so the pair's chain stays lighter
// however long the run goes.
const minerLaggingBootChild = laggingHostCfg !== undefined
  ? log.spawn(userWrap(nsOf('hostile-lagging'), {
      NODE_URL: `http://127.0.0.1:${laggingHostCfg.node.httpPort}`,
      MINING_SECRET: 'stage-mining-secret',
      MINER_PCT: '100',
    }).concat([minerScript]), { description: 'miner-lagging-boot', logPath: logPathFor('miner-lagging-boot') })
  : null;

// MESH_INTERFACE → Acceptance 6 — a later phase or step reads a chain
// from every honest node AND from each hostile-upstream host (the
// interposer reads its own node's `/nipopow/proof/*` and
// `/blocks/current`, forwarding every other route; the pair miner is
// read through `hostile-malformed` too, since it rides the pair chain
// from genesis). The gate holds every host on its own chain:
//   - honest: pub1, pub2, priv1, priv2, lan1 — their `BOOTSTRAP_PEERS`
//     names the publics, so they grow the honest chain;
//   - honest via its own interposer: hostile-invalid — the node runs
//     honest, seeding from the publics; its interposer rewrites only
//     the two mesh routes;
//   - pair: hostile-lagging (the miner) and hostile-malformed (its
//     partner) — each names the other alone in `BOOTSTRAP_PEERS`
//     (`hostile-fork-pair.mjs`), so the pair runs its own chain from
//     genesis.
const honestHeightTargetHost = ['pub1', 'pub2', 'priv1', 'priv2', 'lan1'];
if (topology.hosts['hostile-invalid']?.node !== undefined) honestHeightTargetHost.push('hostile-invalid');
// MESH_INTERFACE → Acceptance 6 — `hostile-fork` + `hostile-fork-peer`
// seed from pub1 alone and sync the honest chain; Phase 8b cuts both
// with each other as accept-partner after the height wait, so each
// must reach the honest height first. `lan1-peer` also syncs from
// pub1 like lan1; s7 step 4 pairs them with each other across its
// own cut.
if (topology.hosts['hostile-fork']?.node !== undefined) honestHeightTargetHost.push('hostile-fork');
if (topology.hosts['hostile-fork-peer']?.node !== undefined) honestHeightTargetHost.push('hostile-fork-peer');
if (topology.hosts['lan1-peer']?.node !== undefined) honestHeightTargetHost.push('lan1-peer');
const pairHeightTargetHost = laggingHostCfg !== undefined ? ['hostile-lagging'] : [];
if (laggingHostCfg !== undefined && malformedHostCfg !== undefined) pairHeightTargetHost.push('hostile-malformed');
recordWait(`every honest node reads /blocks/current.height >= 50: ${honestHeightTargetHost.join(', ')}`);
if (pairHeightTargetHost.length > 0) {
  recordWait(`the pair's node reads /blocks/current.height >= 50: ${pairHeightTargetHost.join(', ')}`);
}
if (!dryRun) {
  // Each node is polled inside its own namespace as the user. The URL
  // reads `http://<host.addr>:<port>` rather than `http://127.0.0.1`
  // so the hostile-upstream hosts' `ip daddr 127.0.0.1 ... redirect to
  // :7000` rule does not intercept the poll — the gate confirms each
  // node's own `/blocks/current`, not the interposer's `LIE_HASH`
  // reply (`hostile-upstream.mjs` → `blocksCurrentBody`).
  const HEIGHT_TARGET = 50;
  await Promise.all([...honestHeightTargetHost, ...pairHeightTargetHost].map(async (name) => {
    const host = topology.hosts[name];
    const port = host.node.httpPort;
    let lastHeight = null;
    await waitWithTail(
      `height on ${name}`,
      async () => {
        const stdout = execIn(nsOf(name), [
          'curl', '-sf', '--max-time', '5',
          `http://${host.addr}:${port}/blocks/current`,
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
// restart at `MINER_PCT=2`: a 2 % duty cycle keeps the chain growing
// without burning a core, and leaves blocks spread over seconds, not
// milliseconds, so each check the stage runs sees a settled view
// between arrivals. Devnet's difficulty target sits at its ceiling
// (`orderingBlockPowTargetCeilingBits`), so the duty cycle alone
// paces the chain. The ratio to `miner-lagging` matters: the honest
// chain's duty is twice the pair's chain, so the honest tip stays
// the heavier chain.
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
  MINER_PCT: '2',
}).concat([minerScript]), { description: 'miner-steady', logPath: logPathFor('miner-steady') });

// MESH_INTERFACE → Acceptance 8 — stop the pair's 100 %-duty boot
// miner and restart at `MINER_PCT=1`, half the honest chain's steady
// duty. The pair's chain stays strictly lighter however long the run
// goes. The two chains share no block, so `compareProofs` answers
// `incomparable / no-common-ancestor` (NIPOPOW_INTERFACE →
// compareProofs); `resolveTip` keeps the client's own tip's proof,
// handed to it first (MESH_INTERFACE → The client's node list →
// "A check"), and the lagging node's tip, not on the client's chain,
// reads `behind` (→ The client's node list). `down` ends the recorded
// tree the same way it ends `miner-steady`.
if (!dryRun && minerLaggingBootChild !== null) {
  try { process.kill(minerLaggingBootChild.pid, 'SIGTERM'); } catch { /* already gone */ }
  const idx = log.pids.findIndex((e) => e.description === 'miner-lagging-boot');
  if (idx >= 0) log.pids.splice(idx, 1);
}
if (laggingHostCfg !== undefined) {
  log.spawn(userWrap(nsOf('hostile-lagging'), {
    NODE_URL: `http://127.0.0.1:${laggingHostCfg.node.httpPort}`,
    MINING_SECRET: 'stage-mining-secret',
    MINER_PCT: '1',
  }).concat([minerScript]), { description: 'miner-lagging', logPath: logPathFor('miner-lagging') });
}

// -----------------------------------------------------------------------
// Phase 8b: hostile-fork pair — cut from the honest chain, mine lighter
// -----------------------------------------------------------------------

// MESH_INTERFACE → Acceptance 6 — "A page with an honest kept chain
// whose reachable nodes all serve the hostile chain keeps its own and
// says no node continues it." `hostile-fork` + `hostile-fork-peer`
// seeded from pub1 alone (`forkHostBootstrapPeers`) and synced to
// pub1's height at Phase 8's wait. Now both namespaces install a
// `fork_cut` table with accept rules for the partner's TCP p2p
// traffic AHEAD of the drop-everything rule on the p2p port
// (`buildForkCutArgs(..., { partner })`). After the cut, no block
// flows between the honest nodes and the fork pair, each pair host
// keeps the other as its one Active peer
// (MINING_INTERFACE → The peer-readiness gate), and `miner-fork`
// inside `hostile-fork`'s namespace at `MINER_PCT=100` mines a FEW
// blocks of the fork — `FORK_BLOCKS_PAST_CUT = 3`, enough to show a
// real fork off the honest chain — then the miner is stopped by PID
// so the fork stays strictly lighter than the honest chain, which
// keeps growing at `MINER_PCT=2`. Phase 8b then waits for pub1 to
// reach `forkHeightAtStop + HONEST_LEAD_OVER_FORK` before finishing,
// so the honest chain is reliably heavier than the frozen fork tip
// by the time any scenario reads either. The record
// `stage/out/fork-pair-cut.json` carries the heights the scenarios
// use. The mesh listener (WebRTC-direct UDP) stays open, so s6
// step 1 reaches `hostile-fork` as a known node at its WebRTC-
// direct address.
const hostileForkHostCfg = topology.hosts['hostile-fork'];
const hostileForkPeerHostCfg = topology.hosts['hostile-fork-peer'];
// MESH_INTERFACE → Acceptance 6 / MINING_INTERFACE → The peer-readiness
// gate — the fork pair stops at `cut + FORK_BLOCKS_PAST_CUT` (3), the
// stage's usual pace (`MINER_PCT=1`) so ASERT does not raise the
// fork's target bits (fast mining would make 3 fork blocks outweigh
// the honest segment above the cut, as main's second run showed:
// `forkBlocksPastCut 32` at `MINER_PCT=100`, 47 honest blocks lost
// the compare). `HONEST_LEAD_OVER_FORK` (20) is wide enough that the
// honest chain's work above the cut clearly exceeds the fork's three
// slow-paced blocks — at the same ASERT-steady difficulty each block
// weighs about the same, and 20 > 3 by a margin that holds through
// usual drift.
const FORK_BLOCKS_PAST_CUT = 3;
const HONEST_LEAD_OVER_FORK = 20;
const natCCfg = topology.hosts.natC;
const browserAddrForPublicFork = natCCfg?.outsideAddr;
if (hostileForkHostCfg !== undefined && hostileForkPeerHostCfg !== undefined) {
  if (typeof browserAddrForPublicFork !== 'string') {
    throw new Error('Phase 8b: topology.hosts.natC.outsideAddr must be a string (the browser\'s NAT address as seen from a public fork host)');
  }
  const forkPartner = { addr: hostileForkPeerHostCfg.addr };
  const peerPartner = { addr: hostileForkHostCfg.addr };
  // Read pub1's pre-cut height; this is the common ancestor the fork
  // and the honest chain share once the cut lands.
  let cutHeight = null;
  if (!dryRun) {
    const text = execIn(nsOf('pub1'), [
      'curl', '-sf', '--max-time', '5',
      `http://${pub1Host.addr}:${pub1Host.node.httpPort}/blocks/current`,
    ], { timeoutMs: 8_000 });
    cutHeight = JSON.parse(text).height;
    if (typeof cutHeight !== 'number') {
      throw new Error(`Phase 8b: pub1 /blocks/current.height is not a number before fork cut`);
    }
  }
  for (const { argv } of buildForkCutArgs(topology, 'hostile-fork', {
    partner: forkPartner,
    browserAddr: browserAddrForPublicFork,
  })) {
    log.shell(argv[0], argv.slice(1), { privileged: true });
  }
  for (const { argv } of buildForkCutArgs(topology, 'hostile-fork-peer', {
    partner: peerPartner,
    browserAddr: browserAddrForPublicFork,
  })) {
    log.shell(argv[0], argv.slice(1), { privileged: true });
  }
  // After the cut, every connection either fork host opened BEFORE
  // the cut stays `open` until libp2p's keepalive gives up — a
  // `policy drop` chain stops packets but does not close the TCP
  // state, and an earlier `waitWithTail` of
  // `peers_connected == 1` within 60 s timed out with 4 peers
  // still named. The remedy is deterministic: stop both pair nodes
  // by their recorded PIDs and respawn them from the same argv /
  // env / store, so no connection made before the cut survives.
  // After the restart each pair node bootstraps from its one
  // allowed peer alone, and the `peers_connected == 1` check
  // reads the fresh connection state.
  // MESH_INTERFACE → Acceptance 6 — the fork pair's cut accepts the
  // browser's natC outside address (`11.100.0.103`) so the page can
  // still reach the fork over mesh. Every host that shares natC with
  // the browser — `lan1`, `lan1-peer` by the topology — emits its
  // packets through the same NAT, which SNATs them to the same
  // outside address; from the fork's view those packets arrive from
  // `11.100.0.103` too and the cut cannot tell them apart from the
  // browser's. Earlier run measured exactly that: the fork reconnected
  // to `lan1` and `lan1-peer` after the restart. The remedy writes
  // the cut on the HONEST SIDE in each such host's namespace
  // (`buildHonestSideIsolationArgs`), BEFORE the fork restart so the
  // honest side cannot dial in during the restart window either.
  const honestBehindBrowserNat = hostsBehindBrowserNat(topology);
  const forkPairAddrs = [hostileForkHostCfg.addr, hostileForkPeerHostCfg.addr];
  for (const hostName of honestBehindBrowserNat) {
    for (const { argv } of buildHonestSideIsolationArgs(hostName, { forkAddrs: forkPairAddrs })) {
      log.shell(argv[0], argv.slice(1), { privileged: true });
    }
  }

  recordWait(`notis:hostile-fork and notis:hostile-fork-peer restarted on the same store after the cut; /health peers_connected reads 1 (the partner alone) within 60 s`);
  if (!dryRun) {
    const forkEntry = log.pids.find((e) => e.description === 'notis:hostile-fork');
    const peerEntry = log.pids.find((e) => e.description === 'notis:hostile-fork-peer');
    if (!forkEntry) throw new Error('Phase 8b: pids record has no notis:hostile-fork');
    if (!peerEntry) throw new Error('Phase 8b: pids record has no notis:hostile-fork-peer');
    // Stop both pair nodes.
    for (const entry of [forkEntry, peerEntry]) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    // Give each wrapper up to 10 s to exit; if it is still alive,
    // SIGKILL — a stuck process under the old PID holds the port
    // and the respawn would fail to bind.
    for (const entry of [forkEntry, peerEntry]) {
      const stopDeadline = Date.now() + 10_000;
      while (Date.now() < stopDeadline) {
        try { process.kill(entry.pid, 0); } catch { break; } // ESRCH → dead
        await sleep(200);
      }
      try { process.kill(entry.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    // Respawn each on the same argv / env / store; `restartFromEntry`
    // rewrites the entry's `pid` in-place AND rewrites pids.json so
    // `down` signals the live process.
    for (const entry of [forkEntry, peerEntry]) {
      restartFromEntry(entry, { pidsPath: PIDS_PATH });
    }
    // Now verify the cut: each pair node's `/health` reads
    // `peers_connected == 1` within 60 s. On failure, name every
    // peer id the node reports in its latest `peer:connect`/
    // `peer:disconnect` stream so the next run says which hosts
    // leaked.
    for (const name of ['hostile-fork', 'hostile-fork-peer']) {
      const host = topology.hosts[name];
      const adminPort = host.node.httpPort + 1;
      const logPath = logPathFor(`notis:${name}`);
      let lastPeersConnected = null;
      await pollUntil(
        `${name} /health peers_connected == 1 after cut + restart`,
        async () => {
          try {
            const text = execIn(nsOf(name), [
              'curl', '-sf', '--max-time', '5',
              `http://127.0.0.1:${adminPort}/health`,
            ], { timeoutMs: 8_000 });
            const data = JSON.parse(text);
            if (typeof data.peers_connected !== 'number') return false;
            lastPeersConnected = data.peers_connected;
            return data.peers_connected === 1;
          } catch {
            // The node may still be coming up after restart; keep polling.
            return false;
          }
        },
        { timeoutMs: 60_000, pollMs: 1_000 },
      ).catch((err) => {
        const connected = standingConnectedPeerIds(logPath);
        const tail = tailLog(logPath, 20);
        const connectedText = connected.length === 0
          ? '<no standing peer:connect lines>'
          : connected.join(', ');
        throw new Error(
          `Phase 8b: ${name} cut leak — last peers_connected ${lastPeersConnected} (expected 1); ` +
          `standing connected peer ids: ${connectedText}\n` +
          `--- last 20 lines of ${logPath} ---\n${tail === '' ? '<no output>' : tail}\n` +
          `${err.message}`,
        );
      });
    }
  }
  const forkSpawn = buildForkMinerSpawn(topology, 'hostile-fork', {
    minerScript,
    minerPct: 1,
    invokingUser: INVOKING_USER,
    miningSecret: 'stage-mining-secret',
    nodeBin: NODE_ABS,
  });
  const minerForkChild = log.spawn(
    forkSpawn.argv,
    { description: 'miner-fork', logPath: logPathFor('miner-fork') },
  );

  // Wait for the fork to reach `cutHeight + FORK_BLOCKS_PAST_CUT`,
  // stopping the miner on the FIRST poll that reads the target so
  // no further blocks land past it. Previous MINER_PCT=100 shape
  // produced blocks faster than the 1 s poll could catch: the stop
  // came 32 blocks late and the fork outweighed the honest segment
  // above the cut.
  recordWait(`hostile-fork reads /blocks/current.height >= cutHeight + ${FORK_BLOCKS_PAST_CUT}; miner-fork stops on the first poll that reads the target`);
  recordWait(`pub1 reads /blocks/current.height >= forkHeightAtStop + ${HONEST_LEAD_OVER_FORK} (the honest chain's lead over the frozen fork)`);
  let forkHeightAtStop = cutHeight;
  let pub1HeightAfterLead = cutHeight;
  if (!dryRun && cutHeight !== null && minerForkChild !== null) {
    const forkTarget = cutHeight + FORK_BLOCKS_PAST_CUT;
    await waitWithTail(
      `hostile-fork fork-pair cut height`,
      async () => {
        const text = execIn(nsOf('hostile-fork'), [
          'curl', '-sf', '--max-time', '5',
          `http://${hostileForkHostCfg.addr}:${hostileForkHostCfg.node.httpPort}/blocks/current`,
        ], { timeoutMs: 8_000 });
        const h = JSON.parse(text).height;
        if (typeof h !== 'number') return false;
        forkHeightAtStop = h;
        return h >= forkTarget;
      },
      logPathFor('miner-fork'),
      { timeoutMs: 300_000, pollMs: 500 },
    );
    try { process.kill(minerForkChild.pid, 'SIGTERM'); } catch { /* already gone */ }
    const idx = log.pids.findIndex((e) => e.description === 'miner-fork');
    if (idx >= 0) log.pids.splice(idx, 1);
    const pub1Target = forkHeightAtStop + HONEST_LEAD_OVER_FORK;
    await waitWithTail(
      `pub1 leads the frozen fork by ${HONEST_LEAD_OVER_FORK} blocks`,
      async () => {
        const text = execIn(nsOf('pub1'), [
          'curl', '-sf', '--max-time', '5',
          `http://${pub1Host.addr}:${pub1Host.node.httpPort}/blocks/current`,
        ], { timeoutMs: 8_000 });
        const h = JSON.parse(text).height;
        if (typeof h !== 'number') return false;
        pub1HeightAfterLead = h;
        return h >= pub1Target;
      },
      logPathFor('notis:pub1'),
      { timeoutMs: 600_000, pollMs: 1_000 },
    );
    writeFileSync(
      join(OUT_DIR, 'fork-pair-cut.json'),
      JSON.stringify({
        cutHeight,
        forkHeightAtStop,
        forkBlocksPastCut: forkHeightAtStop - cutHeight,
        pub1HeightAfterLead,
        honestLeadOverFork: pub1HeightAfterLead - forkHeightAtStop,
      }, null, 2),
    );
  }
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
  // MESH_INTERFACE → Acceptance — every scenario writes the config it
  // needs at its start — the stage's default when it needs no variant
  // — and reads no previous scenario's. The canonical default is kept
  // alongside `config.json` so a no-variant scenario
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
  const identitiesOut = buildIdentitiesOut(topology, notisIds, meshIdentities);
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
// MESH_INTERFACE → Block gossip → "A router scores its peers by
// gossipsub's defaults" — the IP colocation penalty counts every peer
// behind one NAT address for an hour, so a Chromium start page that
// loads the stage page keeps a mesh peer alive for the whole run and
// bends every subsequent scenario's scores. The start page is
// `about:blank`; scenarios open their own targets at the stage URL
// through `cdp.mjs`, each closed when the scenario is done with it.
log.spawn(userWrap(nsOf('browser'), { HOME: browserProfileHome, DISPLAY: process.env.DISPLAY ?? ':0' }, chromiumBin).concat([
  '--headless=new',
  `--user-data-dir=${browserProfileDir}`,
  ...CHROMIUM_QUIET_FLAGS,
  CHROMIUM_HOST_RESOLVER_RULES,
  '--remote-debugging-port=9222',
  'about:blank',
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
