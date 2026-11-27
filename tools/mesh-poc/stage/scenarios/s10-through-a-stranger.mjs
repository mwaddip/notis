// MESH_INTERFACE → Acceptance → "Through a stranger" — "Two Notis nodes
// whose only FIPS path runs through a FIPS node that is no Notis node —
// the original FIPS daemon's release — reach each other over it: a browser
// that reaches the one alone reads the other over FIPS through it, its
// answers equal its direct HTTP answers byte for byte, and the stranger
// lists both nodes among its peers."
//
// Four sub-steps, in order:
//   1. The stranger lists pub1 and pub2 among its peers. `fipsctl show
//      peers` names each Notis node's own npub (read from the stage's
//      `stage/out/stranger/identity.json` and each Notis node's
//      `/mesh/identity`). `verdictS10StrangerPeers`.
//   2. The split — one add-table + add-chain(out, in) + two drops in
//      each of pub1's and pub2's namespaces, naming the other node's
//      addr alone. The stranger's addr is never named, so pub1↔stranger
//      and pub2↔stranger UDP links stand. Wait until neither Notis node
//      reads a non-FIPS standing `connection:open` to the other's peer
//      id in its own `notis.log`. `verdictS10Split`.
//   3. Through the stranger — s9's browser drop pattern reaches pub1
//      alone from the browser. The other first-contact node (pub2)
//      reads `transport: 'fips'` and `via: pub1` in the page's state.
//      `verdictS10Through`.
//   4. Probes byte for byte, forwarded count rose. Pause `miner-steady`
//      (as s9 does), read the stranger's `fipsctl show routing`
//      `forwarding.forwarded_packets` before probing, probe pub2's
//      `/blocks/current` and `/nipopow/proof/24/20` through the page,
//      read each path directly in pub2's namespace, read the forwarded
//      count again — the two equal and the count rose.
//      `verdictS10Probe`.
//
// `finally`: every table s10 added removed through `log.removeAll` and
// the daemon's control socket backstopped, `miner-steady` resumed in
// the same finally block s9 uses, and the stage's default `config.json`
// written back last.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import {
  verdictS10StrangerPeers, verdictS10Split, verdictS10Through, verdictS10Probe,
} from '../lib/verdicts.mjs';
import { writeStageDefault, writeConfigVariant } from '../lib/scenario-config.mjs';
import { withFipsAddresses } from '../lib/config-variants.mjs';
import { peerIdStringOf } from '../lib/config.mjs';
import {
  execIn, readDirect, readBodyDirect, findPid, signal, signalPid, leafPids, descendantPids,
} from '../lib/measure.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's10';
const SPLIT_TABLE = 's10_split';
const DROP_TABLE = 's10_drop';
const ACCESS_HOST = 'pub1';
const OTHER_HOST = 'pub2';
const STRANGER_HOST = 'stranger';

// MESH_INTERFACE → The client's node list — a check runs every
// `CHECK_INTERVAL_MS` (30 000 ms). The FIPS pass opens the link on
// the check where every other address of a candidate failed; the
// retry back-off takes a dropped node to `retry` on the next check.
const CHECK_INTERVAL_MS = 30_000;
// A FIPS link open, FIPS-stream handshake and node's first check reads
// the node's tip past its other addresses' deadlines; six check
// intervals bound the wait so a slow handshake does not hide a real
// failure.
const THROUGH_WAIT_MS = 6 * CHECK_INTERVAL_MS;
// The split waits for libp2p's own connection teardown on both sides,
// which runs on its keepalive cadence; the bound carries two check
// intervals plus a minute to cover a slow close.
const SPLIT_WAIT_MS = 2 * CHECK_INTERVAL_MS + 60_000;

const PROBE_PATHS = ['/blocks/current', '/nipopow/proof/24/20'];

export function describe() {
  return [
    'the stranger lists pub1 and pub2 among its peers',
    'the split: neither Notis node holds a non-fips libp2p connection to the other',
    'drop every mesh host but pub1: pub2 reads fips through pub1',
    'probe each node through the page: the mesh\'s bytes equal the node\'s own byte for byte, the stranger\'s forwarded count rose',
  ];
}

/**
 * MESH_INTERFACE → Acceptance → "Through a stranger" — the nft argvs
 * the split applies and removes inside pub1's and pub2's namespaces. In
 * each, one `add table` + `add chain` on output and on input + two
 * drops (`ip daddr <other> drop` and `ip saddr <other> drop`). The
 * stranger's addr is never named, so pub1↔stranger and pub2↔stranger
 * UDP packets stay — the only FIPS path between the two Notis nodes
 * now rides through the stranger.
 */
export function s10SplitArgs(topology, hostA, hostB) {
  if (typeof hostA !== 'string' || hostA === '') {
    throw new Error('s10SplitArgs: hostA must be a non-empty string');
  }
  if (typeof hostB !== 'string' || hostB === '') {
    throw new Error('s10SplitArgs: hostB must be a non-empty string');
  }
  const rowA = topology?.hosts?.[hostA];
  const rowB = topology?.hosts?.[hostB];
  if (!rowA || typeof rowA.addr !== 'string') {
    throw new Error(`s10SplitArgs: topology lacks ${hostA}'s addr`);
  }
  if (!rowB || typeof rowB.addr !== 'string') {
    throw new Error(`s10SplitArgs: topology lacks ${hostB}'s addr`);
  }
  if (rowA.mesh === undefined || rowB.mesh === undefined) {
    throw new Error(`s10SplitArgs: both hosts must carry a mesh entry; ${hostA} or ${hostB} does not`);
  }
  const addrA = rowA.addr;
  const addrB = rowB.addr;
  const half = (ns, otherAddr) => ({
    addTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', SPLIT_TABLE],
    addChainOut: [
      'sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', SPLIT_TABLE,
      'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}',
    ],
    addChainIn: [
      'sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', SPLIT_TABLE,
      'in', '{', 'type', 'filter', 'hook', 'input', 'priority', '0', ';', '}',
    ],
    dropOut: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', SPLIT_TABLE, 'out', 'ip', 'daddr', otherAddr, 'drop'],
    dropIn: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', SPLIT_TABLE, 'in', 'ip', 'saddr', otherAddr, 'drop'],
    deleteTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', SPLIT_TABLE],
  });
  return {
    hostA: half(`notismesh-${hostA}`, addrB),
    hostB: half(`notismesh-${hostB}`, addrA),
  };
}

/**
 * MESH_INTERFACE → Acceptance → "Through a stranger" — the nft argvs the
 * drop applies and removes inside `notismesh-browser`, the s9 shape with
 * the s10 table name. One `add table` + `add chain` on output + per-
 * mesh-host `add rule out ip daddr <addr> drop` for every mesh host but
 * `accessHost`.
 */
export function s10BrowserDropArgs(topology, accessHost) {
  if (typeof accessHost !== 'string' || accessHost === '') {
    throw new Error('s10BrowserDropArgs: accessHost must be a non-empty string');
  }
  const ns = 'notismesh-browser';
  const drops = [];
  for (const [host, hostConfig] of Object.entries(topology?.hosts ?? {})) {
    if (hostConfig?.mesh === undefined) continue;
    if (typeof hostConfig.addr !== 'string') continue;
    if (host === accessHost) continue;
    drops.push({
      name: host,
      argv: [
        'sudo', 'ip', 'netns', 'exec', ns,
        'nft', 'add', 'rule', 'ip', DROP_TABLE,
        'out', 'ip', 'daddr', hostConfig.addr, 'drop',
      ],
    });
  }
  const addTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', DROP_TABLE];
  const addChain = [
    'sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', DROP_TABLE,
    'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}',
  ];
  const deleteTable = ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', DROP_TABLE];
  return { addTable, addChain, drops, deleteTable };
}

export function applyFaults(log, topology) {
  // Dry-run records every fault the scenario would apply so a reader of
  // the whole output sees the set per scenario. Exec mode applies them
  // inside `run(ctx)` one at a time.
  //
  // MESH_INTERFACE → FIPS → "A node announces its FIPS address" — s10,
  // like s9, writes the config variant that appends each first-contact
  // node's FIPS address last. The record names the write so a reader
  // of the dry-run sees it beside the nft faults.
  const variantRecord = `[config:${NAME}:write-variant] writeConfigVariant withFipsAddresses(config.default.json, identities.json)`;
  log.records.push(variantRecord);
  if (log.dryRun) process.stdout.write(variantRecord + '\n');

  const split = s10SplitArgs(topology, ACCESS_HOST, OTHER_HOST);
  log.apply(`${ACCESS_HOST}-split-add-table`, split.hostA.addTable, split.hostA.deleteTable);
  log.apply(`${ACCESS_HOST}-split-add-chain-out`, split.hostA.addChainOut, null);
  log.apply(`${ACCESS_HOST}-split-add-chain-in`, split.hostA.addChainIn, null);
  log.apply(`${ACCESS_HOST}-split-drop-out`, split.hostA.dropOut, null);
  log.apply(`${ACCESS_HOST}-split-drop-in`, split.hostA.dropIn, null);
  log.apply(`${OTHER_HOST}-split-add-table`, split.hostB.addTable, split.hostB.deleteTable);
  log.apply(`${OTHER_HOST}-split-add-chain-out`, split.hostB.addChainOut, null);
  log.apply(`${OTHER_HOST}-split-add-chain-in`, split.hostB.addChainIn, null);
  log.apply(`${OTHER_HOST}-split-drop-out`, split.hostB.dropOut, null);
  log.apply(`${OTHER_HOST}-split-drop-in`, split.hostB.dropIn, null);

  const drop = s10BrowserDropArgs(topology, ACCESS_HOST);
  log.apply('browser-drop-add-table', drop.addTable, drop.deleteTable);
  log.apply('browser-drop-add-chain', drop.addChain, null);
  for (const { name, argv } of drop.drops) {
    log.apply(`browser-drop-${name}`, argv, null);
  }

  // The probe window pauses `miner-steady` so `/blocks/current` and
  // the proof route do not move between the probe and the direct read.
  // The dry-run names the recorded wrapper PID; exec mode walks `/proc`
  // down to the leaves at pause time.
  log.records.push(`[fault:${NAME}:miner-steady-pause] kill -STOP <miner-steady-innermost-pids>`);
  log.records.push(`[fault:remove:${NAME}:miner-steady-pause] kill -CONT <miner-steady-innermost-pids>`);
  if (log.dryRun) {
    process.stdout.write(`[fault:${NAME}:miner-steady-pause] kill -STOP <miner-steady-innermost-pids>\n`);
    process.stdout.write(`[fault:remove:${NAME}:miner-steady-pause] kill -CONT <miner-steady-innermost-pids>\n`);
  }
}

/**
 * Walk a `notis:<host>.log` file and return every standing non-FIPS
 * address for the named peer id — a `connection:open` line naming
 * that peer id whose matching `connection:close` with the same id has
 * not landed, and whose `addr=` field does not begin with `/fips/`.
 *
 * Returns `[]` when the log file does not exist. The log line shapes
 * are `[net] connection:open id=<id> peer=<pid> dir=<dir> addr=<multiaddr>`
 * and `[net] connection:close id=<id> ...`.
 */
function standingDirectAddrsToPeer(logPath, peerIdString) {
  if (!logPath || !existsSync(logPath)) return [];
  const text = readFileSync(logPath, 'utf8');
  const openById = new Map();
  const openRe = /\[net\] connection:open\s+(.+)/;
  const closeRe = /\[net\] connection:close\s+id=(\S+)/;
  for (const line of text.split('\n')) {
    const m = openRe.exec(line);
    if (m) {
      const fields = {};
      for (const kv of m[1].matchAll(/(\w+)=(\S+)/g)) fields[kv[1]] = kv[2];
      if (typeof fields.id === 'string') {
        openById.set(fields.id, { peer: fields.peer ?? null, addr: fields.addr ?? '' });
      }
      continue;
    }
    const c = closeRe.exec(line);
    if (c) openById.delete(c[1]);
  }
  const out = [];
  for (const { peer, addr } of openById.values()) {
    if (peer !== peerIdString) continue;
    if (typeof addr !== 'string' || addr.startsWith('/fips/')) continue;
    out.push(addr);
  }
  return out;
}

/**
 * Parse `fipsctl show peers` stdout into the array of npubs it holds.
 * The daemon's answer is a JSON object `{ "peers": [...] }` where each
 * peer entry is an object with an `npub` field — the only field this
 * scenario reads, so the parser is kept narrow. Verified against the
 * v0.5.3 release's own `fipsctl show peers` output with one peer
 * connected: the entry carries `"npub": "npub1..."` as its own top-
 * level field, beside `display_name`, `transport_type`, `transport_addr`
 * and the counter blocks.
 */
export function parseStrangerPeerNpubs(stdout) {
  const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (parsed === null || typeof parsed !== 'object') return [];
  const peers = Array.isArray(parsed.peers) ? parsed.peers : [];
  const npubs = [];
  for (const p of peers) {
    if (p === null || typeof p !== 'object') continue;
    const n = p.npub;
    if (typeof n === 'string' && n.startsWith('npub1')) npubs.push(n);
  }
  return npubs;
}

/**
 * MESH_INTERFACE → FIPS → "A node announces its FIPS address" — the
 * node's FIPS address rides among its libp2p multiaddrs as
 * `/fips/<npub>/p2p/<peer id>`, with no `/p2p-circuit` hop (`FIPS → "A
 * private node's relay addresses ride IP"` — a `/fips/.../p2p-circuit/...`
 * address is refused). Read the npub from the first such entry in a
 * parsed `/mesh/identity` answer (the node has one — its own). Returns
 * `null` when no entry matches, so the scenario's own caller names the
 * failure with context.
 *
 * NODE_INTERFACE → Mesh identity — the answer carries
 * `{ notisId, peerId, multiaddrs, localAddrs }` and no `fipsNpub`;
 * reading one would read `undefined`.
 */
export function extractNotisNpubFromMeshIdentity(identity) {
  if (identity === null || typeof identity !== 'object') return null;
  const addrs = Array.isArray(identity.multiaddrs) ? identity.multiaddrs : [];
  for (const a of addrs) {
    if (typeof a !== 'string') continue;
    if (!a.startsWith('/fips/')) continue;
    if (a.includes('/p2p-circuit')) continue;
    const parts = a.split('/');
    // ['', 'fips', '<npub>', 'p2p', '<peer id>']
    const npub = parts[2];
    if (typeof npub === 'string' && npub.startsWith('npub1')) return npub;
  }
  return null;
}

/**
 * Read `fipsctl show routing` and return `forwarding.forwarded_packets`
 * as a non-negative integer. Throws when the answer is not a JSON object
 * with that field — a changed shape must land as a loud failure, not a
 * zero that passes `rose`.
 */
function readStrangerForwarded(ctx, stranger) {
  const buf = execIn(`notismesh-${STRANGER_HOST}`, [
    stranger.fipsctlBin, '-s', stranger.sockPath, 'show', 'routing',
  ], { user: ctx.invokingUser, timeoutMs: 8_000 });
  const text = buf.toString('utf8');
  const parsed = JSON.parse(text);
  const n = parsed?.forwarding?.forwarded_packets;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new Error(`stranger: forwarding.forwarded_packets is not a non-negative number; answer begins ${text.slice(0, 120)}`);
  }
  return n;
}

export async function run(ctx) {
  const log = new FaultLog({ dryRun: ctx.dryRun, scenario: NAME });
  const started = Date.now();
  const rec = new StepRecorder();

  if (ctx.dryRun) {
    applyFaults(log, ctx.topology);
    for (const name of describe()) rec.skipped(name);
    log.removeAll();
    return { scenario: NAME, startedAt: started, endedAt: Date.now(), steps: rec.steps, faults: log.records };
  }

  // MESH_INTERFACE → Acceptance — every scenario writes `config.json`
  // fresh at its start so none inherits a previous one's variant. s10
  // and s9 both rest on the FIPS variant (`withFipsAddresses`) so the
  // browser can reach pub2 by FIPS through pub1.
  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  if (identities === null) {
    throw new Error('s10: identities.json missing; stage:up did not run');
  }
  const defaultConfigPath = join(ctx.outDir, 'browser', 'config.default.json');
  const baseConfig = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
  const fipsVariant = withFipsAddresses(baseConfig, identities);
  writeConfigVariant(ctx.outDir, fipsVariant);

  const accessId = identities[ACCESS_HOST]?.notisId;
  if (typeof accessId !== 'string') {
    throw new Error(`s10: identities.json has no ${ACCESS_HOST} row`);
  }
  const otherId = identities[OTHER_HOST]?.notisId;
  if (typeof otherId !== 'string') {
    throw new Error(`s10: identities.json has no ${OTHER_HOST} row`);
  }
  const otherRow = identities[OTHER_HOST];

  const strangerIdentityPath = join(ctx.outDir, STRANGER_HOST, 'identity.json');
  if (!existsSync(strangerIdentityPath)) {
    throw new Error(`s10: stranger identity.json missing at ${strangerIdentityPath}`);
  }
  const stranger = JSON.parse(readFileSync(strangerIdentityPath, 'utf8'));
  if (typeof stranger?.npub !== 'string' || typeof stranger?.sockPath !== 'string' || typeof stranger?.fipsctlBin !== 'string') {
    throw new Error(`s10: stranger identity.json malformed at ${strangerIdentityPath}`);
  }

  // Each Notis node's own npub, taken from the `/fips/<npub>/p2p/<peer
  // id>` entry in its `/mesh/identity` `multiaddrs` list; the stranger's
  // `fipsctl show peers` answer names each peer's npub, so the
  // scenario's step-1 check matches those strings against these.
  const notisNpubOf = (host) => {
    const row = identities[host];
    const addr = row?.addr;
    const httpPort = row?.httpPort;
    if (typeof addr !== 'string' || typeof httpPort !== 'number') {
      throw new Error(`s10: identities.json ${host} row has no addr or httpPort`);
    }
    const url = `http://${addr}:${httpPort}/mesh/identity`;
    const buf = readBodyDirect(`notismesh-${host}`, url, { user: ctx.invokingUser, timeoutMs: 8_000 });
    let parsed;
    try { parsed = JSON.parse(buf.toString('utf8')); } catch (err) {
      throw new Error(`s10: ${host} /mesh/identity did not parse as JSON: ${err?.message ?? err}`);
    }
    const npub = extractNotisNpubFromMeshIdentity(parsed);
    if (npub === null) {
      const addrs = Array.isArray(parsed?.multiaddrs) ? parsed.multiaddrs : [];
      throw new Error(`s10: ${host} /mesh/identity carries no /fips/<npub>/p2p/<peer id> multiaddr; got ${addrs.length} multiaddrs`);
    }
    return npub;
  };
  const pub1Npub = notisNpubOf(ACCESS_HOST);
  const pub2Npub = notisNpubOf(OTHER_HOST);

  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const splitArgs = s10SplitArgs(ctx.topology, ACCESS_HOST, OTHER_HOST);
  const dropArgs = s10BrowserDropArgs(ctx.topology, ACCESS_HOST);
  const minerEntry = findPid(ctx.pids?.pids, 'miner-steady');
  let pausedPids = [];
  const accessPeerIdString = peerIdStringOf(accessId);
  const otherPeerIdString = peerIdStringOf(otherId);
  const accessLogPath = join(ctx.outDir, ACCESS_HOST, 'notis.log');
  const otherLogPath = join(ctx.outDir, OTHER_HOST, 'notis.log');

  try {
    // --- Step 1: the stranger lists pub1 and pub2 among its peers ---
    await rec.step(describe()[0], async () => {
      const buf = execIn(`notismesh-${STRANGER_HOST}`, [
        stranger.fipsctlBin, '-s', stranger.sockPath, 'show', 'peers',
      ], { user: ctx.invokingUser, timeoutMs: 8_000 });
      const strangerPeers = parseStrangerPeerNpubs(buf);
      const m = { pub1Npub, pub2Npub, strangerPeers };
      return { verdict: verdictS10StrangerPeers(m), measurement: m };
    });

    // --- Step 2: the split — apply, wait for libp2p to drop its ---
    // --- direct connections between pub1 and pub2.                ---
    log.apply(`${ACCESS_HOST}-split-add-table`, splitArgs.hostA.addTable, splitArgs.hostA.deleteTable);
    log.apply(`${ACCESS_HOST}-split-add-chain-out`, splitArgs.hostA.addChainOut, null);
    log.apply(`${ACCESS_HOST}-split-add-chain-in`, splitArgs.hostA.addChainIn, null);
    log.apply(`${ACCESS_HOST}-split-drop-out`, splitArgs.hostA.dropOut, null);
    log.apply(`${ACCESS_HOST}-split-drop-in`, splitArgs.hostA.dropIn, null);
    log.apply(`${OTHER_HOST}-split-add-table`, splitArgs.hostB.addTable, splitArgs.hostB.deleteTable);
    log.apply(`${OTHER_HOST}-split-add-chain-out`, splitArgs.hostB.addChainOut, null);
    log.apply(`${OTHER_HOST}-split-add-chain-in`, splitArgs.hostB.addChainIn, null);
    log.apply(`${OTHER_HOST}-split-drop-out`, splitArgs.hostB.dropOut, null);
    log.apply(`${OTHER_HOST}-split-drop-in`, splitArgs.hostB.dropIn, null);

    await rec.step(describe()[1], async () => {
      const deadline = Date.now() + SPLIT_WAIT_MS;
      let pub1Pub2Direct = standingDirectAddrsToPeer(accessLogPath, otherPeerIdString);
      let pub2Pub1Direct = standingDirectAddrsToPeer(otherLogPath, accessPeerIdString);
      while ((pub1Pub2Direct.length > 0 || pub2Pub1Direct.length > 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        pub1Pub2Direct = standingDirectAddrsToPeer(accessLogPath, otherPeerIdString);
        pub2Pub1Direct = standingDirectAddrsToPeer(otherLogPath, accessPeerIdString);
      }
      const m = { pub1Pub2Direct, pub2Pub1Direct };
      return { verdict: verdictS10Split(m), measurement: m };
    });

    // --- Step 3: apply the browser drop, wait for pub2 to read fips ---
    log.apply('browser-drop-add-table', dropArgs.addTable, dropArgs.deleteTable);
    log.apply('browser-drop-add-chain', dropArgs.addChain, null);
    for (const { name, argv } of dropArgs.drops) {
      log.apply(`browser-drop-${name}`, argv, null);
    }
    await rec.step(describe()[2], async () => {
      const value = await cdpPoll(ctx, `${browserUrl}?clearMemory=1`,
        "document.getElementById('state')?.textContent ?? null",
        `if (v === null) return false;
         try {
           const s = JSON.parse(v);
           const nodes = Array.isArray(s.nodes) ? s.nodes : [];
           const e = nodes.find((n) => n.notisId === ${JSON.stringify(otherId)});
           if (!e) return false;
           if (e.status !== 'ok' && e.status !== 'trailing') return false;
           if (e.transport !== 'fips') return false;
           if (e.via !== ${JSON.stringify(accessId)}) return false;
           return true;
         } catch (_e) { return false; }`,
        THROUGH_WAIT_MS, 1000,
      );
      const s = JSON.parse(value);
      const nodes = Array.isArray(s.nodes) ? s.nodes : [];
      const e = nodes.find((n) => n.notisId === otherId) ?? null;
      const otherEntry = {
        notisId: otherId,
        status: e?.status ?? null,
        transport: e?.transport ?? null,
        via: e?.via ?? null,
      };
      const m = { accessId, otherEntry };
      return { verdict: verdictS10Through(m), measurement: m };
    });

    // --- Step 4: pause the miner, probe byte for byte, read the ---
    // --- stranger's forwarded count before and after.             ---
    if (minerEntry !== null) {
      pausedPids = leafPids(minerEntry.pid);
      for (const leaf of pausedPids) {
        signal(leaf, 'SIGSTOP');
      }
      log.records.push(`[fault:${NAME}:miner-steady-pause] kill -STOP ${pausedPids.join(' ')} (leaves of ${minerEntry.pid})`);
    }
    await rec.step(describe()[3], async () => {
      const forwardedBefore = readStrangerForwarded(ctx, stranger);
      const probes = [];
      const nodeNs = `notismesh-${OTHER_HOST}`;
      const otherHttpPort = otherRow.httpPort;
      if (typeof otherHttpPort !== 'number') {
        throw new Error(`s10 step 4: identities row for ${OTHER_HOST} has no httpPort`);
      }
      for (const probePath of PROBE_PATHS) {
        const directUrl = `http://127.0.0.1:${otherHttpPort}${probePath}`;
        const probeUrl = `${browserUrl}?probe=${encodeURIComponent(probePath)}&node=${otherId}`;
        const direct = readDirect(nodeNs, directUrl);
        const probeText = await cdpPoll(ctx, probeUrl,
          "document.getElementById('probe')?.textContent ?? null",
          `if (typeof v !== 'string' || v === '') return false;
           try {
             const p = JSON.parse(v);
             return p.nodeId === ${JSON.stringify(otherId)} && p.path === ${JSON.stringify(probePath)};
           } catch (_e) { return false; }`,
          60_000, 500,
        );
        const probe = JSON.parse(probeText);
        probes.push({
          nodeId: otherId,
          path: probePath,
          probe: { sha256: probe.sha256, bytes: probe.bytes },
          direct: { sha256: direct.sha256, bytes: direct.bytes },
        });
      }
      const forwardedAfter = readStrangerForwarded(ctx, stranger);
      const m = { probes, forwardedBefore, forwardedAfter };
      return { verdict: verdictS10Probe(m), measurement: m };
    });
  } finally {
    // Release the miner whether every step passed, raised or timed
    // out — a paused miner holds up every other scenario that reads
    // the chain. SIGSTOP on a leaf makes `sudo -u`'s job-control
    // relay suspend the wrapper too, so SIGCONT on the leaf alone
    // leaves the wrapper `T`. The resume sends SIGCONT to the whole
    // tree; `signalPid` falls back to `sudo kill -CONT` on EPERM for
    // the root-owned wrappers.
    if (pausedPids.length > 0 && minerEntry !== null) {
      const treePids = [minerEntry.pid, ...descendantPids(minerEntry.pid)];
      for (const pid of treePids) {
        const r = signalPid(pid, 'SIGCONT');
        if (!r.sent && r.reason !== 'ESRCH') {
          process.stderr.write(`[s10 teardown] SIGCONT ${pid}: ${r.reason}\n`);
        }
      }
      log.records.push(`[fault:remove:${NAME}:miner-steady-pause] kill -CONT ${treePids.join(' ')} (tree of ${minerEntry.pid})`);
    }
    log.removeAll();
    // Belt and braces: in case `log.removeAll` hit a transient failure
    // on either table, try the table deletes directly so a later
    // scenario does not read a leaked drop.
    tryDeleteTable(`notismesh-${ACCESS_HOST}`, SPLIT_TABLE);
    tryDeleteTable(`notismesh-${OTHER_HOST}`, SPLIT_TABLE);
    tryDeleteTable('notismesh-browser', DROP_TABLE);
    try { writeStageDefault(ctx.outDir); }
    catch (err) { process.stderr.write(`[s10 teardown] writeStageDefault: ${err?.message ?? err}\n`); }
  }
  return {
    scenario: NAME,
    startedAt: started,
    endedAt: Date.now(),
    steps: rec.steps,
    faults: log.records,
  };
}

function tryDeleteTable(ns, table) {
  try {
    execIn(ns, ['nft', 'delete', 'table', 'ip', table], { timeoutMs: 10_000 });
  } catch {
    // The removal is best-effort — `removeAll()` ran first, and a
    // missing table is the clean state the next scenario starts from.
  }
}

async function cdpPoll(ctx, url, expression, predicateBody, timeoutMs, pollMs) {
  const argv = [
    ctx.nodeBin, ctx.cdpScript, 'poll', url, expression, predicateBody,
    String(timeoutMs), String(pollMs),
  ];
  const buf = execIn('notismesh-browser', argv, {
    user: ctx.invokingUser,
    timeoutMs: timeoutMs + 10_000,
  });
  return JSON.parse(buf.toString('utf8'));
}
