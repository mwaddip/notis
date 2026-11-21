// MESH_INTERFACE → Acceptance 9 — "A browser whose host routes to one
// node alone — the access point's shape — reaches another node by key
// through it over FIPS: its check reads both, the other reads `fips`
// through the one, and its answers equal its direct HTTP answers byte
// for byte; a node reached that way and then cut reads `retry`, never
// `blacklisted`; a browser with direct paths to every node opens no
// FIPS link."
//
// Four sub-steps, in order:
//   1. No faults — the stage default. Every node the browser's config
//      lists is reached at its other addresses; no `fips-link` event
//      opens and no entry's transport reads `fips`. `verdictS9NoLink`.
//   2. The drop table — one add-table + add-chain + per-host drop in
//      `notismesh-browser` naming every mesh host but the access
//      host (pub1), lan1's and lan1-peer's 10.103.0.x addresses
//      included (`s9ThroughOneNodeArgs`). Wait for the other
//      first-contact node to read `transport: 'fips'`, `via: pub1`.
//      `verdictS9Through`.
//   3. Pause `miner-steady` (SIGSTOP on its leaf PIDs, SIGCONT in
//      `finally`), then probe each node's `/blocks/current` and
//      `/nipopow/proof/24/20` through the page and read each
//      directly inside its own namespace. `verdictS9Probe` holds
//      the mesh's bytes equal to the node's own.
//   4. Cut pub2 by firewalling its p2p ports in its own namespace
//      (the `s9_cut` nft table in `notismesh-pub2`): pub1's link to
//      pub2 drops under the running connection's packet loss, and
//      pub2's entry moves to `retry`, never `blacklisted`. Restore
//      pub2 in the step's own `finally`; the outer `finally` runs
//      `log.removeAll()` as a backstop.
//
// The stage default's first-contact set is pub1 + pub2 (`stage/up.mjs`
// writes it); pub2 is the other node the scenario asserts the FIPS
// reach for. `verdictS9Through` takes a list of other ids.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaultLog } from '../lib/fault-log.mjs';
import {
  verdictS9NoLink, verdictS9Through, verdictS9Probe, verdictS9Cut,
} from '../lib/verdicts.mjs';
import { writeStageDefault } from '../lib/scenario-config.mjs';
import {
  execIn, readDirect, findPid, signal, signalPid, leafPids, descendantPids,
} from '../lib/measure.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';

export const NAME = 's9';
const DROP_TABLE = 's9_drop';
const CUT_TABLE = 's9_cut';
const ACCESS_HOST = 'pub1';
const CUT_HOST = 'pub2';
// MESH_INTERFACE → The client's node list — a check runs every
// `CHECK_INTERVAL_MS` (30 000 ms). The FIPS pass opens the link on
// the check where every other address of a candidate failed; the
// retry back-off takes a dropped node to `retry` on the next check.
const CHECK_INTERVAL_MS = 30_000;
// A link open + FIPS-stream handshake + node's first check reads
// the node's tip past its other addresses' deadlines; the deadline
// is bounded at six check intervals so a slow handshake does not
// hide a real failure.
const THROUGH_WAIT_MS = 6 * CHECK_INTERVAL_MS;
// The cut step waits for pub2 to move to `retry` — two check
// intervals is the retry cadence a dropped link takes to land there
// (MESH_INTERFACE → The client's node list).
const CUT_WAIT_MS = 2 * CHECK_INTERVAL_MS + 10_000;
const PROBE_PATHS = ['/blocks/current', '/nipopow/proof/24/20'];

export function describe() {
  return [
    'direct paths to every node: the client reads each one without opening a FIPS link',
    'drop every mesh host but pub1: pub2 reads fips through pub1',
    'probe each node through the page: the mesh\'s bytes equal the node\'s own byte for byte',
    'pub2 cut: pub2 reads retry, never blacklisted',
  ];
}

/**
 * MESH_INTERFACE → Acceptance 9 — the nft argvs the drop table
 * applies and removes inside `notismesh-browser`. One `add table` +
 * `add chain` on output + per-mesh-host `add rule out ip daddr <addr>
 * drop` for every host whose topology config holds `mesh`, where
 * the host's name is not `accessHost`. lan1 and lan1-peer share
 * natC's inside bridge with the browser (10.103.0.x), so their own
 * addresses are in the table; a drop on 11.100.x addresses alone
 * would leave them reachable. The deletion of the table cascades
 * through its rules.
 */
export function s9ThroughOneNodeArgs(topology, accessHost) {
  if (typeof accessHost !== 'string' || accessHost === '') {
    throw new Error('s9ThroughOneNodeArgs: accessHost must be a non-empty string');
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

/**
 * MESH_INTERFACE → Acceptance 9 — the nft argvs the cut applies and
 * removes inside `notismesh-pub2`. Dropping the inbound webrtc UDP
 * and the mesh/notis TCP ports breaks pub1's live connection to
 * pub2 (nftables' default input hook has no `ct state established
 * accept`, so an existing flow's packets drop too). The table's
 * deletion cascades.
 */
export function s9CutArgs(topology, host) {
  if (typeof host !== 'string' || host === '') {
    throw new Error('s9CutArgs: host must be a non-empty string');
  }
  const row = topology?.hosts?.[host];
  if (!row || !row.mesh) {
    throw new Error(`s9CutArgs: topology has no mesh host ${host}`);
  }
  const ns = `notismesh-${host}`;
  const webrtcPort = String(row.mesh.webrtcPort);
  const tcpPort = String(row.mesh.tcpPort);
  const notisPort = String(row.node.p2pPort);
  return {
    addTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'table', 'ip', CUT_TABLE],
    addChain: [
      'sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'chain', 'ip', CUT_TABLE,
      'in', '{', 'type', 'filter', 'hook', 'input', 'priority', '0', ';', '}',
    ],
    dropWebrtc: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', CUT_TABLE, 'in', 'udp', 'dport', webrtcPort, 'drop'],
    dropMeshTcp: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', CUT_TABLE, 'in', 'tcp', 'dport', tcpPort, 'drop'],
    dropNotisTcp: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'add', 'rule', 'ip', CUT_TABLE, 'in', 'tcp', 'dport', notisPort, 'drop'],
    deleteTable: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', CUT_TABLE],
  };
}

export function applyFaults(log, topology) {
  // Dry-run: record every fault the scenario would apply so a reader
  // of the whole output sees the set per scenario. Exec mode applies
  // them inside `run(ctx)` one at a time.
  const a = s9ThroughOneNodeArgs(topology, ACCESS_HOST);
  log.apply('browser-drop-add-table', a.addTable, a.deleteTable);
  log.apply('browser-drop-add-chain', a.addChain, null);
  for (const { name, argv } of a.drops) {
    log.apply(`browser-drop-${name}`, argv, null);
  }
  const c = s9CutArgs(topology, CUT_HOST);
  log.apply(`${CUT_HOST}-cut-add-table`, c.addTable, c.deleteTable);
  log.apply(`${CUT_HOST}-cut-add-chain`, c.addChain, null);
  log.apply(`${CUT_HOST}-cut-drop-webrtc`, c.dropWebrtc, null);
  log.apply(`${CUT_HOST}-cut-drop-mesh-tcp`, c.dropMeshTcp, null);
  log.apply(`${CUT_HOST}-cut-drop-notis-tcp`, c.dropNotisTcp, null);
  // MESH_INTERFACE → Acceptance 9 — the probe window pauses
  // `miner-steady` so `/blocks/current` and the proof route do not
  // move between the probe and the direct read. The dry-run names
  // the recorded wrapper PID; exec mode walks `/proc` down to the
  // leaves at pause time.
  log.records.push(`[fault:${NAME}:miner-steady-pause] kill -STOP <miner-steady-innermost-pids>`);
  log.records.push(`[fault:remove:${NAME}:miner-steady-pause] kill -CONT <miner-steady-innermost-pids>`);
  if (log.dryRun) {
    process.stdout.write(`[fault:${NAME}:miner-steady-pause] kill -STOP <miner-steady-innermost-pids>\n`);
    process.stdout.write(`[fault:remove:${NAME}:miner-steady-pause] kill -CONT <miner-steady-innermost-pids>\n`);
  }
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

  // MESH_INTERFACE → Acceptance — every scenario writes config.json
  // fresh at its start so none inherits a previous scenario's variant.
  // s9 reads the stage default — pub1 and pub2 as first contact.
  writeStageDefault(ctx.outDir);

  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  if (identities === null) {
    throw new Error('s9: identities.json missing; stage:up did not run');
  }
  const accessId = identities[ACCESS_HOST]?.notisId;
  if (typeof accessId !== 'string') {
    throw new Error(`s9: identities.json has no ${ACCESS_HOST} row`);
  }
  const cutId = identities[CUT_HOST]?.notisId;
  if (typeof cutId !== 'string') {
    throw new Error(`s9: identities.json has no ${CUT_HOST} row`);
  }

  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const configPath = join(ctx.outDir, 'browser', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const firstContactIds = new Set();
  for (const a of config.firstContact ?? []) {
    if (typeof a?.notisId === 'string') firstContactIds.add(a.notisId);
  }
  // The "other" set is every first-contact id that is not the access
  // host; the scenario asserts the FIPS reach for each (one per
  // present stage topology — pub2).
  const otherIds = Array.from(firstContactIds).filter((id) => id !== accessId);
  if (otherIds.length === 0) {
    throw new Error('s9: config.json first-contact has no honest node besides the access host');
  }

  // --- Step 1: no faults ---
  // The state element's `nodes` carries every entry's `transport` and
  // `via`; a FIPS link emits a `fips-link` event the page records
  // beside the state (`<pre id="fips-links">`). Step 1 reads both
  // once the chain has seated.
  await rec.step(describe()[0], async () => {
    const value = await cdpPoll(ctx, `${browserUrl}?clearMemory=1`,
      `(function () {
         const stateEl = document.getElementById('state');
         const linksEl = document.getElementById('fips-links');
         if (stateEl === null) return null;
         return JSON.stringify({
           state: stateEl.textContent,
           links: linksEl === null ? '[]' : linksEl.textContent,
         });
       })()`,
      `if (v === null) return false;
       try {
         const o = JSON.parse(v);
         const s = JSON.parse(o.state);
         if (typeof s.nodeId !== 'string') return false;
         if (typeof s.checks !== 'number' || s.checks < 1) return false;
         return true;
       } catch (_e) { return false; }`,
      60_000, 500,
    );
    const outer = JSON.parse(value);
    const s = JSON.parse(outer.state);
    let links;
    try { links = JSON.parse(outer.links); } catch { links = []; }
    const entries = (Array.isArray(s.nodes) ? s.nodes : [])
      .map((n) => ({ notisId: n.notisId, transport: n.transport ?? null }));
    const m = {
      fipsLinkCount: Array.isArray(links) ? links.length : 0,
      entries,
    };
    return { verdict: verdictS9NoLink(m), measurement: m };
  });

  // --- Step 2: apply the drop table, wait for the FIPS pass ---
  const dropArgs = s9ThroughOneNodeArgs(ctx.topology, ACCESS_HOST);
  const cutArgs = s9CutArgs(ctx.topology, CUT_HOST);
  const minerEntry = findPid(ctx.pids?.pids, 'miner-steady');
  let pausedPids = [];
  try {
    await rec.step(describe()[1], async () => {
      log.apply('browser-drop-add-table', dropArgs.addTable, dropArgs.deleteTable);
      log.apply('browser-drop-add-chain', dropArgs.addChain, null);
      for (const { name, argv } of dropArgs.drops) {
        log.apply(`browser-drop-${name}`, argv, null);
      }
      // A fresh page reloads under the drop table so the client's
      // startup check runs under it from the first dial — a client
      // that had direct connections open from step 1 keeps them
      // (nftables cuts new flows and the running flows' packets
      // alike, but conntrack's own timing allows a read or two to
      // land before the kernel drops them). `?clearMemory=1` drops
      // the chain memory so the baseline is a fresh check.
      const value = await cdpPoll(ctx, `${browserUrl}?clearMemory=1`,
        "document.getElementById('state')?.textContent ?? null",
        `if (v === null) return false;
         try {
           const s = JSON.parse(v);
           const nodes = Array.isArray(s.nodes) ? s.nodes : [];
           const others = ${JSON.stringify(otherIds)};
           for (const id of others) {
             const e = nodes.find((n) => n.notisId === id);
             if (!e) return false;
             if (e.status !== 'ok' && e.status !== 'trailing') return false;
             if (e.transport !== 'fips') return false;
             if (e.via !== ${JSON.stringify(accessId)}) return false;
           }
           return true;
         } catch (_e) { return false; }`,
        THROUGH_WAIT_MS, 1000,
      );
      const s = JSON.parse(value);
      const nodes = Array.isArray(s.nodes) ? s.nodes : [];
      const otherEntries = otherIds.map((id) => {
        const e = nodes.find((n) => n.notisId === id) ?? null;
        return {
          notisId: id,
          status: e?.status ?? null,
          transport: e?.transport ?? null,
          via: e?.via ?? null,
        };
      });
      const m = { accessId, otherEntries };
      return { verdict: verdictS9Through(m), measurement: m };
    });

    // --- Step 3: probes byte for byte ---
    // The miner is paused across both probes so each node's
    // `/blocks/current` and proof reads name one tip.
    if (minerEntry !== null) {
      pausedPids = leafPids(minerEntry.pid);
      for (const leaf of pausedPids) {
        signal(leaf, 'SIGSTOP');
      }
      log.records.push(`[fault:${NAME}:miner-steady-pause] kill -STOP ${pausedPids.join(' ')} (leaves of ${minerEntry.pid})`);
    }
    await rec.step(describe()[2], async () => {
      const probes = [];
      // Each probe pair is one read through the page (`?probe=<path>
      // &node=<id>`) and one direct read in the node's own namespace.
      // The scenario runs through pub1 and pub2 in order so a reader
      // of `stage/out/scenarios/s9.json`'s measurement sees each
      // node's two paths grouped together.
      const nodesToProbe = [
        { host: ACCESS_HOST, notisId: accessId },
        ...otherIds.map((id) => ({
          host: hostOfId(identities, id),
          notisId: id,
        })),
      ];
      for (const { host, notisId } of nodesToProbe) {
        if (host === null) {
          throw new Error(`s9 step 3: no identities row for ${notisId}`);
        }
        const row = identities[host];
        if (!row || typeof row.httpPort !== 'number') {
          throw new Error(`s9 step 3: identities row for ${host} has no httpPort`);
        }
        const nodeNs = `notismesh-${host}`;
        for (const probePath of PROBE_PATHS) {
          const directUrl = `http://127.0.0.1:${row.httpPort}${probePath}`;
          const probeUrl = `${browserUrl}?probe=${encodeURIComponent(probePath)}&node=${notisId}`;
          const direct = readDirect(nodeNs, directUrl);
          const probeText = await cdpPoll(ctx, probeUrl,
            "document.getElementById('probe')?.textContent ?? null",
            `if (typeof v !== 'string' || v === '') return false;
             try {
               const p = JSON.parse(v);
               return p.nodeId === ${JSON.stringify(notisId)} && p.path === ${JSON.stringify(probePath)};
             } catch (_e) { return false; }`,
            60_000, 500,
          );
          const probe = JSON.parse(probeText);
          probes.push({
            nodeId: notisId,
            path: probePath,
            probe: { sha256: probe.sha256, bytes: probe.bytes },
            direct: { sha256: direct.sha256, bytes: direct.bytes },
          });
        }
      }
      const m = { probes };
      return { verdict: verdictS9Probe(m), measurement: m };
    });

    // --- Step 4: cut pub2 ---
    let blacklistedAtAnyPoll = false;
    let cutStatus = null;
    await rec.step(describe()[3], async () => {
      log.apply(`${CUT_HOST}-cut-add-table`, cutArgs.addTable, cutArgs.deleteTable);
      log.apply(`${CUT_HOST}-cut-add-chain`, cutArgs.addChain, null);
      log.apply(`${CUT_HOST}-cut-drop-webrtc`, cutArgs.dropWebrtc, null);
      log.apply(`${CUT_HOST}-cut-drop-mesh-tcp`, cutArgs.dropMeshTcp, null);
      log.apply(`${CUT_HOST}-cut-drop-notis-tcp`, cutArgs.dropNotisTcp, null);
      // The predicate watches every poll's reading of cutId; a
      // `blacklisted` reading at any poll is kept so the verdict
      // reads FAIL on it.
      const value = await cdpPoll(ctx, browserUrl,
        `(function () {
           const el = document.getElementById('state');
           if (el === null) return null;
           const s = (function () { try { return JSON.parse(el.textContent); } catch (_e) { return null; } })();
           if (s === null) return null;
           const nodes = Array.isArray(s.nodes) ? s.nodes : [];
           const e = nodes.find((n) => n.notisId === ${JSON.stringify(cutId)});
           if (!e) return JSON.stringify({ seen: false });
           if (e.status === 'blacklisted') {
             window.__s9SawBlacklist = true;
           }
           return JSON.stringify({
             seen: true,
             status: e.status,
             sawBlacklist: window.__s9SawBlacklist === true,
           });
         })()`,
        `if (v === null) return false;
         try {
           const o = JSON.parse(v);
           if (!o.seen) return false;
           if (o.sawBlacklist === true) return true;
           return o.status === 'retry';
         } catch (_e) { return false; }`,
        CUT_WAIT_MS, 1000,
      );
      const o = JSON.parse(value);
      cutStatus = typeof o.status === 'string' ? o.status : null;
      blacklistedAtAnyPoll = o.sawBlacklist === true;
      const m = {
        nodeId: cutId,
        status: cutStatus,
        blacklistedAtAnyPoll,
      };
      return { verdict: verdictS9Cut(m), measurement: m };
    });
  } finally {
    // Release the miner whether every step passed, raised or timed
    // out — a paused miner holds up every other scenario that reads
    // the chain. SIGSTOP on a leaf makes `sudo -u`'s job-control
    // relay suspend the wrapper too (sudo's tcsetpgrp wait path), so
    // SIGCONT on the leaf alone leaves the wrapper `T`. The resume
    // sends SIGCONT to the whole tree; `signalPid` falls back to
    // `sudo kill -CONT` on EPERM for the root-owned wrappers.
    if (pausedPids.length > 0 && minerEntry !== null) {
      const treePids = [minerEntry.pid, ...descendantPids(minerEntry.pid)];
      for (const pid of treePids) {
        const r = signalPid(pid, 'SIGCONT');
        if (!r.sent && r.reason !== 'ESRCH') {
          process.stderr.write(`[s9 teardown] SIGCONT ${pid}: ${r.reason}\n`);
        }
      }
      log.records.push(`[fault:remove:${NAME}:miner-steady-pause] kill -CONT ${treePids.join(' ')} (tree of ${minerEntry.pid})`);
    }
    log.removeAll();
    // Belt and braces: in case `log.removeAll` hit a transient
    // failure on either table, try the table deletes directly so a
    // later scenario does not read a leaked drop.
    tryDeleteTable('notismesh-browser', DROP_TABLE);
    tryDeleteTable(`notismesh-${CUT_HOST}`, CUT_TABLE);
    try { writeStageDefault(ctx.outDir); }
    catch (err) { process.stderr.write(`[s9 teardown] writeStageDefault: ${err?.message ?? err}\n`); }
  }
  return {
    scenario: NAME,
    startedAt: started,
    endedAt: Date.now(),
    steps: rec.steps,
    faults: log.records,
  };
}

function hostOfId(identities, notisId) {
  if (!identities || typeof identities !== 'object') return null;
  for (const [host, row] of Object.entries(identities)) {
    if (row?.notisId === notisId) return host;
  }
  return null;
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
