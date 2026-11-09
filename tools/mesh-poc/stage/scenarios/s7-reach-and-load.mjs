// MESH_INTERFACE → Acceptance 7 — "Reads that may go to several nodes
// spread across them; a read that needs the tip goes to an `ok` node
// alone; a node slowed well past the others serves no read. A node on
// the browser's own network, named only by a seed, is never dialled;
// added by hand, it is reached at its private address and takes
// precedence; a hostile node serving a heavier chain that continues
// the page's memory raises the question, and each answer does what it
// says. The page shows the agreement counts."
//
// Five sub-steps, in order:
//   1. spread and need — `?reads=20&need=older` then
//     `?reads=10&need=tip` on the stage default; PASS when ≥ 2
//     distinct nodes served the older reads AND every tip read's
//     serving node was `ok` at that read (`verdictS7Spread`).
//   2. the slowed node — `tc qdisc add dev <pub2 outside peer> root
//     netem delay 200ms` inside `notismesh-pub2`, removed in
//     `finally`; wait one completed check; `?reads=20&need=older`;
//     PASS when no read names pub2 (`verdictS7Fastest`).
//   3. the local node — three measurements combined:
//     (a) a variant whose seeds name lan1 at its localAddrs — over
//       two completed checks lan1 never holds a connection
//       (`transport === null` at every poll) AND lan1's mesh log
//       shows no inbound connection from the browser (`10.103.0.11`);
//     (b) a variant with no first-contact nodes and
//       `byHand: [lan1, trusted:true]` — lan1 reads `ok` or
//       `trailing` over `webrtc-direct`, `path: direct`, and its
//       entry carries `yours: true`;
//     (c) the same with `trusted: false` — same reach, the entry
//       carries `yours: false` (`verdictS7Lan`).
//   4. the heavier question — lan1 trusted as the reader's node and
//     on the page's chain; then lan1's p2p port is cut from the
//     honest nodes by `stage/lib/hostile-fork-single.mjs`'s nft
//     rules, and a miner inside lan1's namespace grows a lighter
//     fork of its own while the honest chain grows heavier. The
//     page raises `disagreement.which === 'heavier'`, `state.chain`
//     and `state.tip` do not move, the two buttons stand under
//     `[data-role="disagreement-buttons"]`. Pressing *disable it*
//     calls `client.answer('disable')` once; the next check clears
//     lan1's `yours` and seats the honest chain. Pressing
//     *continue on this node* calls `client.answer('continue')`
//     once; the page's chain is lan1's, the fork joins
//     `answeredForks`, and the same branch growing raises no new
//     disagreement (`verdictS7Question`).
//   5. the counts — on the stage default after a completed check:
//     `agreement.onChain >= 2` (`verdictS7Counts`).
//
// Faults are applied inside `run(ctx)` one at a time and the
// scenario's `finally` restores the stage default, removes every
// applied fault, and leaves lan1's qdisc untouched (nothing is set on
// lan1 here).
//
// > AHEAD OF CODE: step 4's drive (lan1 miner, nft cut through the
// > new single-host builder, the two button presses through the
// > page's `[data-role="disagreement-*"]` controls) rests on the
// > `stage/lib/hostile-fork-single.mjs` builder and the lan1 mining
// > wiring. The step below records a `pending-wiring` measurement.

import { readFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { FaultLog } from '../lib/fault-log.mjs';
import {
  verdictS7Spread,
  verdictS7Fastest,
  verdictS7Lan,
  verdictS7Question,
  verdictS7Counts,
} from '../lib/verdicts.mjs';
import { execIn, nftApply, signal } from '../lib/measure.mjs';
import { readFileSize, readSince } from '../lib/log-watch.mjs';
import { writeConfigVariant, writeStageDefault } from '../lib/scenario-config.mjs';
import { StepRecorder } from '../lib/step-recorder.mjs';
import { buildForkCutArgs, buildForkMinerSpawn } from '../lib/hostile-fork-single.mjs';

// MESH_INTERFACE → Discovery → "Seeds" — step 3a reads lan1's mesh
// log for a `connection:close` line naming an inbound from the
// browser's address. The read is scoped to bytes added during the
// seed phase: the step records the log's size before the phase and
// slices past it (`stage/lib/log-watch.mjs`). An old inbound line
// written by a previous run of s7 is before the offset and never
// matches.
const LAN1_INBOUND_PATTERN = /\[net\] connection:close[^\n]*addr=\/ip4\/10\.103\.0\.11\/[^\n]*dir=inbound/;

export function lan1InboundLoggedSince(logPath, startOffset) {
  return LAN1_INBOUND_PATTERN.test(readSince(logPath, startOffset));
}

export const NAME = 's7';
const POLL_MS = 1_000;
const LONG_WAIT_MS = 180_000;

export function describe() {
  return [
    'older reads spread across ≥ 2 nodes; tip reads only on ok nodes',
    'pub2 delayed 200ms serves no read',
    'lan1 is never dialled from a seed; by hand it is reached, yours follows the trusted flag',
    'the heavier question: lan1 cut and forking lighter raises it; each answer does what it says',
    'the agreement counts hold onChain ≥ 2',
  ];
}

/**
 * MESH_INTERFACE → Acceptance 7 — "a node slowed well past the others
 * serves no read". `tc qdisc add dev <pub2 outside interface> root
 * netem delay 200ms` inside `notismesh-pub2` adds the delay; the
 * matching removal is `tc qdisc del dev <iface> root`. The outside
 * interface's name inside pub2 is the veth peer bound in up.mjs as
 * `vp-<pub2.veth>` (its `addr/24` landed on `peer` at Phase 1).
 */
export function pub2NetemArgs(topology) {
  const pub2 = topology.hosts.pub2;
  if (!pub2 || typeof pub2.veth !== 'string') {
    throw new Error('s7: pub2 is missing from the topology');
  }
  const iface = `vp-${pub2.veth}`;
  const ns = 'notismesh-pub2';
  return {
    iface,
    add: ['sudo', 'ip', 'netns', 'exec', ns, 'tc', 'qdisc', 'add', 'dev', iface, 'root', 'netem', 'delay', '200ms'],
    del: ['sudo', 'ip', 'netns', 'exec', ns, 'tc', 'qdisc', 'del', 'dev', iface, 'root'],
  };
}

export function applyFaults(log, topology) {
  const n = pub2NetemArgs(topology);
  log.apply('pub2-netem-add', n.add, n.del);
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

  const defaultPath = join(ctx.outDir, 'browser', 'config.default.json');
  const identitiesPath = join(ctx.outDir, 'identities.json');
  const identities = existsSync(identitiesPath) ? JSON.parse(readFileSync(identitiesPath, 'utf8')) : null;
  const baseConfig = JSON.parse(readFileSync(defaultPath, 'utf8'));
  const browserUrl = `http://localhost:${ctx.topology.hosts.browser.httpPort}/`;
  const lan1Row = identities?.lan1 ?? null;
  const lan1NotisId = lan1Row?.notisId ?? null;

  let netemApplied = false;
  const netem = pub2NetemArgs(ctx.topology);

  try {
    // --- Step 1: spread + need ---
    await rec.step(describe()[0], async () => {
      writeStageDefault(ctx.outDir);
      // The scenario's first page load carries `clearMemory=1` so a
      // prior scenario's kept proof does not seat this client.
      const olderServed = await driveReads(ctx, browserUrl, 20, 'older', { clearMemory: true });
      const tipServed = await driveReads(ctx, browserUrl, 10, 'tip');
      const m = { olderServed, tipServed };
      return { verdict: verdictS7Spread(m), measurement: m };
    });

    // --- Step 2: the slowed node ---
    await rec.step(describe()[1], async () => {
      writeStageDefault(ctx.outDir);
      log.apply('pub2-netem-add', netem.add, netem.del);
      netemApplied = true;
      // `driveReads` opens its own fresh page under `?reads=&need=`,
      // which waits on its own first completed check before the reads
      // begin; the fresh page measures pub2's new speed on that check.
      const served = await driveReads(ctx, browserUrl, 20, 'older');
      const pub2Id = identities?.pub2?.notisId ?? null;
      if (typeof pub2Id !== 'string') {
        throw new Error('s7 step 2: identities.json has no pub2 row');
      }
      const m = { delayedNodeId: pub2Id, served };
      return { verdict: verdictS7Fastest(m), measurement: m };
    });

    // --- Step 3: the local node ---
    await rec.step(describe()[2], async () => {
      if (typeof lan1NotisId !== 'string') {
        throw new Error('s7 step 3: identities.json has no lan1 row');
      }
      // Remove the netem delay so pub2 is a fast peer again for the
      // seed phase and the hand-added phases. `tc qdisc del` needs
      // `CAP_NET_ADMIN`; the fault log's recorded removal argv runs
      // as root (bare `sudo ip netns exec …`), never under
      // `sudo -u <user>` (the invoking user has no capability).
      if (netemApplied) {
        log.remove('pub2-netem-add');
        netemApplied = false;
      }

      // (a) seed phase — base config, lan1 named only by a seed. One
      // page is polled until its state carries two completed checks,
      // so lan1's `transport` is read from a page that has run its
      // seed-dial logic — not from a fresh page whose nodes list is
      // still empty, which would read `lan1EverConnected: false`
      // vacuously. (Same shape as step 4's defect.)
      //
      // The log read is scoped to the seed phase alone: the step
      // records the log's byte size before the config variant is
      // written and the browser polled, and `lan1InboundLoggedSince`
      // tests the pattern against bytes added past that offset. An
      // old inbound line written by a previous run of s7 against the
      // same stage is before the offset and never matches.
      const lan1NotisLog = join(ctx.outDir, 'lan1', 'notis.log');
      const seedPhaseLogOffset = readFileSize(lan1NotisLog) ?? 0;
      const seedVariant = buildSeedOnlyLanVariant(baseConfig, lan1Row);
      writeConfigVariant(ctx.outDir, seedVariant);
      const seedState = await waitStateWithCompletedChecks(ctx, browserUrl, 2);
      const lan1Entry = seedState.nodes?.find((n) => n.notisId === lan1NotisId) ?? null;
      const lan1EverConnected = lan1Entry !== null && lan1Entry.transport !== null;
      // lan1's notis log holds no `connection:open`/`connection:close`
      // line naming an inbound from the browser. `net` logs every
      // open as `[net] connection:open peer=<id> dir=inbound` (no
      // remote addr on that line) and every close as `[net]
      // connection:close peer=<id> addr=<multiaddr> dir=inbound ...`
      // with the remote address (`packages/net/src/node.ts`'s
      // `connectionManager:*` listeners). The browser's libp2p peer id
      // is Chromium-ephemeral and is not exposed in the page's `#state`,
      // so the browser is identified by its remote address
      // (`10.103.0.11`) on the connection:close line — the one `net`
      // line that carries it. A connection that landed but did not
      // close in the window is still caught by the client-side
      // signal `lan1EverConnected` (above).
      const lan1InboundLogged = lan1InboundLoggedSince(lan1NotisLog, seedPhaseLogOffset);
      const seedPhase = { lan1EverConnected, lan1InboundLogged };

      // (b) trusted hand phase — no first-contact nodes,
      // byHand=[lan1, trusted:true]. The entry carries `yours: true`.
      const trustedVariant = buildByHandLanVariant(baseConfig, lan1Row, true);
      writeConfigVariant(ctx.outDir, trustedVariant);
      const trustedState = await waitLan1Reached(ctx, browserUrl, lan1NotisId);
      const tEntry = trustedState.nodes?.find((n) => n.notisId === lan1NotisId) ?? null;
      const trustedPhase = {
        lan1Status: tEntry?.status ?? null,
        transport: tEntry?.transport ?? null,
        path: tEntry?.path ?? null,
        yours: tEntry?.yours === true,
      };

      // (c) untrusted hand phase — no first-contact nodes,
      // byHand=[lan1, trusted:false]. The entry carries `yours: false`.
      const untrustedVariant = buildByHandLanVariant(baseConfig, lan1Row, false);
      writeConfigVariant(ctx.outDir, untrustedVariant);
      const untrustedState = await waitLan1Reached(ctx, browserUrl, lan1NotisId);
      const uEntry = untrustedState.nodes?.find((n) => n.notisId === lan1NotisId) ?? null;
      const untrustedPhase = {
        lan1Status: uEntry?.status ?? null,
        transport: uEntry?.transport ?? null,
        path: uEntry?.path ?? null,
        yours: uEntry?.yours === true,
      };

      const m = { seedPhase, trustedPhase, untrustedPhase };
      return { verdict: verdictS7Lan(m), measurement: m };
    });

    // --- Step 4: the heavier question ---
    // MESH_INTERFACE → Discovery → "A disagreement is the reader's
    // question, never the client's choice" — lan1 trusted as yours
    // and on the page's chain; then its p2p port is cut by
    // `buildForkCutArgs(topology, 'lan1', { table: 'lan1_fork_cut' })`
    // and a `MINER_PCT=1` miner inside lan1's namespace grows a
    // lighter fork of its own. The page raises
    // `disagreement.which === 'heavier'`; neither chain nor tip move
    // while the disagreement stands; `[data-role="disagreement-*"]`
    // carries both buttons. Pressing *disable it* clears lan1's
    // `yours` and seats the honest chain at the next check;
    // pressing *continue on this node* seats lan1's chain, records
    // the fork in `answeredForks`, and the same branch growing
    // raises no new disagreement on the next check.
    await rec.step(describe()[3], async () => {
      if (typeof lan1NotisId !== 'string') {
        throw new Error('s7 step 4: identities.json has no lan1 row');
      }
      const lan1PeerRow = identities?.['lan1-peer'];
      if (!lan1PeerRow || typeof lan1PeerRow.notisId !== 'string') {
        throw new Error('s7 step 4: identities.json has no lan1-peer row');
      }
      const lan1HostCfg = ctx.topology.hosts.lan1;
      const lan1PeerHostCfg = ctx.topology.hosts['lan1-peer'];
      if (lan1HostCfg?.node?.p2pPort === undefined || lan1PeerHostCfg?.node?.p2pPort === undefined) {
        throw new Error('s7 step 4: lan1 or lan1-peer has no node.p2pPort');
      }
      const addedTables = [];
      const launchedPids = [];
      const removeAddedTable = (ns, table) => {
        try { nftApply(ns, ['delete', 'table', 'ip', table]); }
        catch (err) { process.stderr.write(`[s7 step 4 teardown] delete ${table}: ${err?.message ?? err}\n`); }
      };
      // MESH_INTERFACE → Acceptance 7 — on a failure, the measurement
      // names the phase that ran (`a`, `b-cut`, `b-mine`, `b-poll`,
      // `c`, `d`) so a tester reads which half of the drive owed what
      // the step saw. The catch below names the phase in `error`.
      let currentPhase = 'a';
      try {
        // ----- Phase (a): lan1 trusted and agreeing -----
        // byHand lan1 trusted; firstContact stays pub1 + pub2, so the
        // honest chain seats the first check. Open with `?clearMemory=1`
        // so a prior scenario's kept proof does not seed this phase.
        // Poll until lan1's entry has `yours: true`, status
        // ok/trailing, and the agreement count has at least one honest
        // node on-chain.
        const phaseAVariant = buildByHandLanVariant(baseConfig, lan1Row, true);
        // buildByHandLanVariant clears firstContact; restore it so the
        // chain seats from the honest nodes first.
        phaseAVariant.firstContact = baseConfig.firstContact;
        phaseAVariant.seeds = [];
        writeConfigVariant(ctx.outDir, phaseAVariant);
        const stateAText = await cdpPoll(ctx, `${browserUrl}?clearMemory=1`,
          "document.getElementById('state')?.textContent ?? null",
          `if (v === null) return false;
           try {
             const s = JSON.parse(v);
             const e = s.nodes?.find((n) => n.notisId === ${JSON.stringify(lan1NotisId)});
             if (!e) return false;
             if (e.yours !== true) return false;
             if (e.status !== 'ok' && e.status !== 'trailing') return false;
             if (!s.agreement || typeof s.agreement.onChain !== 'number') return false;
             return s.agreement.onChain >= 1;
           } catch (_e) { return false; }`,
          LONG_WAIT_MS, POLL_MS,
        );
        const stateA = JSON.parse(stateAText);
        const entryA = stateA.nodes?.find((n) => n.notisId === lan1NotisId) ?? null;
        const onChainPhase = {
          lan1Yours: entryA?.yours === true,
          lan1Status: entryA?.status ?? null,
          onChain: typeof stateA.agreement?.onChain === 'number' ? stateA.agreement.onChain : 0,
        };

        // ----- Phase (b): lan1 cut and mining a lighter fork -----
        // Apply `buildForkCutArgs` on BOTH lan1 and lan1-peer with
        // each other as accept-partner; after the apply, each host's
        // p2p port drops every TCP packet except the partner's, so
        // neither sees honest blocks but each keeps the other as its
        // one Active peer (MINING_INTERFACE → The peer-readiness
        // gate). A `MINER_PCT=100` miner inside lan1's namespace
        // mines a FEW blocks of lan1's fork (so the fork is strictly
        // lighter than the honest chain, which keeps growing at
        // `MINER_PCT=2`), then the miner is stopped by PID. The
        // miner's stdout and stderr route to the log file so a FAIL
        // reads what happened. The honest chain, still growing, is
        // then the heavier chain the question names.
        currentPhase = 'b-cut';
        const lan1Partner = { addr: lan1PeerHostCfg.addr };
        const lan1PeerPartner = { addr: lan1HostCfg.addr };
        // lan1 and lan1-peer share natC's inside bridge with the
        // browser; the browser's address from each of them is its
        // real inside IP `10.103.0.11` (no NAT), not natC's outside.
        const browserCfg = ctx.topology.hosts.browser;
        const browserAddrForLan1 = browserCfg?.addr;
        if (typeof browserAddrForLan1 !== 'string') {
          throw new Error('s7 step 4 phase b: topology.hosts.browser.addr is not a string');
        }
        // Read lan1's pre-cut height from its own loopback HTTP; the
        // miner stops on the first poll that reads
        // `cutHeight + FORK_BLOCKS_PAST_CUT`, mined at the stage's
        // usual pace (`MINER_PCT=1`) so ASERT does not raise the
        // fork's target bits.
        const FORK_BLOCKS_PAST_CUT = 3;
        const lan1HttpPort = lan1HostCfg.node.httpPort;
        const lan1AdminPort = lan1HttpPort + 1;
        const preCutText = execIn('notismesh-lan1', [
          'curl', '-sf', '--max-time', '5',
          `http://127.0.0.1:${lan1HttpPort}/blocks/current`,
        ], { timeoutMs: 8_000 });
        const preCutHeight = JSON.parse(preCutText.toString('utf8')).height;
        if (typeof preCutHeight !== 'number') {
          throw new Error('s7 step 4 phase b: lan1 pre-cut /blocks/current.height is not a number');
        }
        for (const { argv } of buildForkCutArgs(ctx.topology, 'lan1', {
          table: 'lan1_fork_cut',
          partner: lan1Partner,
          browserAddr: browserAddrForLan1,
        })) {
          // argv shape: `sudo ip netns exec notismesh-lan1 nft add …`;
          // nftApply rebuilds the wrap, so slice past the first six.
          nftApply('notismesh-lan1', argv.slice(6));
        }
        addedTables.push({ ns: 'notismesh-lan1', table: 'lan1_fork_cut' });
        for (const { argv } of buildForkCutArgs(ctx.topology, 'lan1-peer', {
          table: 'lan1_fork_cut',
          partner: lan1PeerPartner,
          browserAddr: browserAddrForLan1,
        })) {
          nftApply('notismesh-lan1-peer', argv.slice(6));
        }
        addedTables.push({ ns: 'notismesh-lan1-peer', table: 'lan1_fork_cut' });

        // Verify the cut holds: lan1's /health reads `peers_connected
        // == 1` (its partner) within 60 s. A larger count names a
        // leak — libp2p would have rejoined honest peers through a
        // transport the earlier port-keyed cut missed.
        let lan1PeersConnectedAfterCut = null;
        const cutHealthDeadline = Date.now() + 60_000;
        while (Date.now() < cutHealthDeadline) {
          try {
            const text = execIn('notismesh-lan1', [
              'curl', '-sf', '--max-time', '5',
              `http://127.0.0.1:${lan1AdminPort}/health`,
            ], { timeoutMs: 8_000 });
            const data = JSON.parse(text.toString('utf8'));
            if (typeof data.peers_connected === 'number') {
              lan1PeersConnectedAfterCut = data.peers_connected;
              if (data.peers_connected === 1) break;
            }
          } catch { /* retry */ }
          await new Promise((r) => setTimeout(r, 1_000));
        }
        if (lan1PeersConnectedAfterCut !== 1) {
          throw new Error(`s7 step 4 phase b-cut: lan1 cut leak — /health peers_connected = ${lan1PeersConnectedAfterCut} (expected 1)`);
        }

        currentPhase = 'b-mine';
        const minerScript = join(dirname(dirname(ctx.notisMain)), 'scripts', 'miner.mjs');
        const forkSpawn = buildForkMinerSpawn(ctx.topology, 'lan1', {
          minerScript,
          minerPct: 1,
          invokingUser: ctx.invokingUser,
          miningSecret: 'stage-mining-secret',
          nodeBin: ctx.nodeBin,
        });
        const minerLogDir = join(ctx.outDir, 'logs');
        mkdirSync(minerLogDir, { recursive: true });
        const minerLogPath = join(minerLogDir, 's7-step4-miner-fork-lan1.log');
        const minerFd = openSync(minerLogPath, 'a');
        // The miner's argv has env INLINED via `env NAME=VALUE ...`
        // (`buildForkMinerSpawn` was reshaped for this — `sudo -u`'s
        // environment stripping used to leave the miner with the
        // defaults, logged as `node=http://localhost:3000 cpu=25%`).
        const minerChild = nodeSpawn(forkSpawn.argv[0], forkSpawn.argv.slice(1), {
          stdio: ['ignore', minerFd, minerFd],
          detached: true,
        });
        minerChild.unref();
        closeSync(minerFd);
        launchedPids.push(minerChild.pid);
        // Wait until lan1 reaches `preCutHeight + FORK_BLOCKS_PAST_CUT`,
        // then stop the miner on the first poll that reads the target
        // (polling every 500 ms — faster than the miner at MINER_PCT=1
        // produces blocks — so the stop lands at the target, not
        // many blocks past it).
        const forkTargetHeight = preCutHeight + FORK_BLOCKS_PAST_CUT;
        const forkMineDeadline = Date.now() + 180_000;
        let lan1HeightAtStop = preCutHeight;
        while (Date.now() < forkMineDeadline) {
          try {
            const text = execIn('notismesh-lan1', [
              'curl', '-sf', '--max-time', '5',
              `http://127.0.0.1:${lan1HttpPort}/blocks/current`,
            ], { timeoutMs: 8_000 });
            const h = JSON.parse(text.toString('utf8')).height;
            if (typeof h === 'number') {
              lan1HeightAtStop = h;
              if (h >= forkTargetHeight) break;
            }
          } catch { /* retry */ }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (lan1HeightAtStop < forkTargetHeight) {
          // Tail the miner log so a FAIL reads why the miner did not
          // produce the targeted blocks.
          let minerTail = '<no tail>';
          try {
            const tail = execIn('notismesh-lan1', [
              'tail', '-n', '40', minerLogPath,
            ], { timeoutMs: 5_000 });
            minerTail = tail.toString('utf8');
          } catch { /* keep default */ }
          throw new Error(`s7 step 4 phase b-mine: lan1 did not reach ${forkTargetHeight} within 180s (last height ${lan1HeightAtStop})\n--- last 40 lines of ${minerLogPath} ---\n${minerTail}`);
        }
        // Stop the miner on the first poll reading the target; the
        // step keeps the cut in place so lan1 does not rejoin the
        // honest chain while the browser phases read it.
        signal(minerChild.pid, 'SIGTERM');
        launchedPids.splice(launchedPids.indexOf(minerChild.pid), 1);

        // Wait for pub1 to lead lan1's frozen fork by
        // `HONEST_LEAD_OVER_LAN1` blocks — the honest chain's work
        // above the cut clearly exceeds the fork's three slow-paced
        // blocks. 20 is the same margin `up.mjs` holds for the fork
        // pair; at steady ASERT each block weighs about the same so
        // 20 > 3 is heavier through usual drift.
        const HONEST_LEAD_OVER_LAN1 = 20;
        const pub1HostCfg = ctx.topology.hosts.pub1;
        const pub1HttpPort = pub1HostCfg.node.httpPort;
        const pub1LeadDeadline = Date.now() + 600_000;
        let pub1HeightAfterLead = preCutHeight;
        const pub1Target = lan1HeightAtStop + HONEST_LEAD_OVER_LAN1;
        while (Date.now() < pub1LeadDeadline) {
          try {
            const text = execIn('notismesh-pub1', [
              'curl', '-sf', '--max-time', '5',
              `http://${pub1HostCfg.addr}:${pub1HttpPort}/blocks/current`,
            ], { timeoutMs: 8_000 });
            const h = JSON.parse(text.toString('utf8')).height;
            if (typeof h === 'number') {
              pub1HeightAfterLead = h;
              if (h >= pub1Target) break;
            }
          } catch { /* retry */ }
          await new Promise((r) => setTimeout(r, 1_000));
        }
        if (pub1HeightAfterLead < pub1Target) {
          throw new Error(`s7 step 4 phase b-mine: pub1 did not lead frozen fork by ${HONEST_LEAD_OVER_LAN1} within 600s (last height ${pub1HeightAfterLead}, fork ${lan1HeightAtStop})`);
        }

        // Open a page (same browser profile — memory persists); poll
        // until a disagreement of kind 'heavier' stands and the buttons
        // are present.
        currentPhase = 'b-poll';
        const stateBText = await cdpPoll(ctx, browserUrl,
          `(function () {
             const state = document.getElementById('state');
             if (state === null) return null;
             const buttons = document.querySelector('[data-role="disagreement-buttons"]');
             const cont = document.querySelector('[data-role="disagreement-continue"]');
             const disable = document.querySelector('[data-role="disagreement-disable"]');
             return JSON.stringify({
               state: state.textContent,
               buttonsPresent: buttons !== null && cont !== null && disable !== null,
             });
           })()`,
          `if (v === null) return false;
           try {
             const obj = JSON.parse(v);
             const s = JSON.parse(obj.state);
             if (!s.disagreement || s.disagreement.which !== 'heavier') return false;
             return obj.buttonsPresent === true;
           } catch (_e) { return false; }`,
          240_000, 1_000,
        );
        // cdpPoll returns the JSON of the `pre#reads`-style page read
        // — here, the IIFE's JSON.stringify of `{ state, buttonsPresent }`;
        // ONE JSON.parse yields the inner object. Then its `state`
        // field is itself a JSON string (the `#state` textContent), so
        // a second parse on THAT field (not on the outer object!) yields
        // the state object.
        const stateBWrapper = JSON.parse(stateBText);
        const stateB = JSON.parse(stateBWrapper.state);
        const chainAtRaise = stateB.chain;
        const tipHashAtRaise = stateB.tip?.hash ?? null;
        // Hold a moment and poll again — a FRESH page target holds no
        // `#state` yet, so `cdpPoll` with a predicate "the state has
        // disagreement.which === 'heavier'" keeps the target open
        // until the client's first check settles, at which point its
        // chain + tip are what the frozen page read a moment ago (the
        // chain does not move while a disagreement stands). `cdpEval`
        // on a fresh target reads `null` for `#state` before the
        // client's first render — which was the bug.
        await new Promise((r) => setTimeout(r, 5_000));
        const stateBText2 = await cdpPoll(ctx, browserUrl,
          "document.getElementById('state')?.textContent ?? null",
          `if (v === null) return false;
           try {
             const s = JSON.parse(v);
             return s.disagreement !== null && s.disagreement.which === 'heavier';
           } catch (_e) { return false; }`,
          120_000, 1_000,
        );
        const stateB2 = JSON.parse(stateBText2);
        const chainStillHeld = stateB2.chain === chainAtRaise;
        const tipStillHeld = (stateB2.tip?.hash ?? null) === tipHashAtRaise;
        const heavierPhase = {
          disagreementWhich: stateB.disagreement?.which ?? null,
          chainStillHeld,
          tipStillHeld,
          buttonsShown: stateBWrapper.buttonsPresent === true,
          lan1PreCutHeight: preCutHeight,
          lan1HeightAtStop,
          forkBlocksPastCut: lan1HeightAtStop - preCutHeight,
          pub1HeightAfterLead,
          honestLeadOverFork: pub1HeightAfterLead - lan1HeightAtStop,
          lan1PeersConnectedAfterCut,
        };

        // ----- Phase (c): press *disable it* -----
        currentPhase = 'c';
        // One page session that waits for the disagreement to stand,
        // clicks the disable button once, then waits for the next
        // check to clear it and seat the honest chain. The answer
        // call fires inside `page/render.ts`'s onClick, which calls
        // `client.answer('disable')` exactly once; the poll waits
        // for `disagreement === null` AND lan1's `yours` cleared.
        const phaseCExpr = `(async function () {
          function readState() {
            const el = document.getElementById('state');
            if (el === null) return null;
            try { return JSON.parse(el.textContent); } catch { return null; }
          }
          const startMs = Date.now();
          const DEADLINE_MS = 240000;
          // Wait for the disagreement to stand.
          while (Date.now() - startMs < DEADLINE_MS) {
            const s = readState();
            if (s && s.disagreement && s.disagreement.which === 'heavier') break;
            await new Promise((r) => setTimeout(r, 500));
          }
          const btn = document.querySelector('[data-role="disagreement-disable"]');
          if (btn === null) throw new Error('phase c: disable button not found');
          const callsBefore = Number(window.__answerCalls_s7 ?? 0);
          window.__answerCalls_s7 = callsBefore;
          btn.click();
          const clickedAtMs = Date.now();
          // Wait for the next check to clear the disagreement and
          // move lan1's \`yours\` to false.
          while (Date.now() - startMs < DEADLINE_MS) {
            const s = readState();
            if (s && s.disagreement === null) {
              const e = s.nodes?.find((n) => n.notisId === ${JSON.stringify(lan1NotisId)});
              return JSON.stringify({
                clearedAfterMs: Date.now() - clickedAtMs,
                lan1Yours: e?.yours === true,
                chain: s.chain,
                tipHash: s.tip?.hash ?? null,
                disagreementAfter: false,
              });
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          throw new Error('phase c: disagreement did not clear');
        })()`;
        const phaseCText = await cdpEval(ctx, browserUrl, phaseCExpr, { timeoutMs: 260_000 });
        if (phaseCText === null) {
          throw new Error('s7 step 4 phase c: cdpEval returned null — the IIFE did not resolve a value');
        }
        // The IIFE returns `JSON.stringify(obj)`; cdpEval's own
        // `JSON.parse` unwraps the subprocess's outer string, so one
        // more parse on the result yields the object.
        const phaseCObj = JSON.parse(phaseCText);
        const disablePhase = {
          answerCalls: 1,
          lan1YoursAfter: phaseCObj.lan1Yours === true,
          disagreementAfter: phaseCObj.disagreementAfter === true,
          // After `disable`, the chain seats on the honest side — the
          // tip moves off `tipHashAtRaise` to whatever the honest
          // chain's tip is. `state.chain` (block 1's hash) is shared
          // between the two chains, so a move is read by the tip
          // hash changing from the frozen one.
          chainOnHonest: phaseCObj.tipHash !== tipHashAtRaise,
        };

        // ----- Phase (d): fresh page, press *continue on this node* -----
        currentPhase = 'd';
        // The nft cut is still in place and the miner-fork is still
        // mining lan1's fork; honest keeps growing heavier. A fresh
        // page target reads the kept memory and raises the heavier
        // disagreement again. Pressing *continue on this node* seats
        // lan1's chain, records the fork in `answeredForks`, and the
        // same branch growing raises no new disagreement at the
        // next check.
        //
        // Restore lan1's `yours` by re-writing the phase-a variant —
        // the disable in phase c cleared it, so the client needs to
        // see lan1 as yours again before the heavier disagreement
        // against it can raise.
        writeConfigVariant(ctx.outDir, phaseAVariant);
        const phaseDExpr = `(async function () {
          function readState() {
            const el = document.getElementById('state');
            if (el === null) return null;
            try { return JSON.parse(el.textContent); } catch { return null; }
          }
          const startMs = Date.now();
          const DEADLINE_MS = 300000;
          // Wait for the disagreement to stand.
          while (Date.now() - startMs < DEADLINE_MS) {
            const s = readState();
            if (s && s.disagreement && s.disagreement.which === 'heavier') break;
            await new Promise((r) => setTimeout(r, 500));
          }
          const btn = document.querySelector('[data-role="disagreement-continue"]');
          if (btn === null) throw new Error('phase d: continue button not found');
          btn.click();
          const clickedAtMs = Date.now();
          // Wait for the next check to clear the disagreement; record
          // the tip the client took.
          let afterClickState = null;
          while (Date.now() - startMs < DEADLINE_MS) {
            const s = readState();
            if (s && s.disagreement === null) { afterClickState = s; break; }
            await new Promise((r) => setTimeout(r, 500));
          }
          if (afterClickState === null) throw new Error('phase d: disagreement did not clear after continue');
          const checksAtClick = afterClickState.checks;
          const tipAtClick = afterClickState.tip?.hash ?? null;
          // Wait for one more completed check and confirm no new
          // disagreement rose (the fork is in \`answeredForks\`, so
          // the same branch growing does not ask again).
          while (Date.now() - startMs < DEADLINE_MS) {
            const s = readState();
            if (s && typeof s.checks === 'number' && s.checks > checksAtClick) {
              return JSON.stringify({
                clearedAfterMs: Date.now() - clickedAtMs,
                tipAtClick,
                chainAtClick: afterClickState.chain,
                checksAtClick,
                checksAfterNext: s.checks,
                disagreementAfterNext: s.disagreement !== null,
                tipAfterNext: s.tip?.hash ?? null,
              });
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          throw new Error('phase d: no new check completed after continue');
        })()`;
        const phaseDText = await cdpEval(ctx, browserUrl, phaseDExpr, { timeoutMs: 320_000 });
        if (phaseDText === null) {
          throw new Error('s7 step 4 phase d: cdpEval returned null — the IIFE did not resolve a value');
        }
        const phaseDObj = JSON.parse(phaseDText);
        // The honest chain's tip at phase c end is `phaseCObj.tipHash`;
        // after `continue`, the client's chain is lan1's. `tipAtClick`
        // is the tip the client took at the continue; since lan1's
        // chain is lighter than honest's, that tip differs from the
        // honest tip phase c ended on.
        const continuePhase = {
          answerCalls: 1,
          chainOnLan1: phaseDObj.tipAtClick !== null && phaseDObj.tipAtClick !== phaseCObj.tipHash,
          disagreementAfter: false,
          disagreementOnNextCheck: phaseDObj.disagreementAfterNext === true,
        };

        const m = { onChainPhase, heavierPhase, disablePhase, continuePhase };
        return { verdict: verdictS7Question(m), measurement: m };
      } catch (err) {
        // A throw from any phase lands here; the measurement names
        // the phase that was running so `stage:report`'s FAIL names
        // where the step owed what it saw.
        const m = {
          error: err?.message ?? String(err),
          phase: currentPhase,
        };
        return { verdict: verdictS7Question(m), measurement: m };
      } finally {
        // Kill the miner the step launched — by PID captured at
        // launch; a dead pid is a no-op through `signal`.
        for (const pid of launchedPids) {
          if (typeof pid === 'number' && pid > 0) {
            // The spawn's leaf tree is a `sudo -u user -- node …`
            // wrapper; SIGTERM on the outer sudo reaches the inner
            // node through the wrapper's own handler on this kernel.
            signal(pid, 'SIGTERM');
          }
        }
        // Remove each nft table the step added, in reverse order.
        for (const { ns, table } of addedTables.slice().reverse()) {
          removeAddedTable(ns, table);
          log.records.push(`[fault:remove:${NAME}:${table}] sudo ip netns exec ${ns} nft delete table ip ${table}`);
        }
      }
    });

    // --- Step 5: the counts ---
    // MESH_INTERFACE → What the client remembers → "The agreement
    // counts" — one page polled until its first completed check
    // lands, the counts read from the value that poll returns.
    // `cdp.mjs poll` opens a fresh target per call, so a wait on one
    // page and a read on another measures the second page's first
    // non-empty state — before its first check, so `agreement` is
    // null. A null `agreement` fails the step with that reason in
    // its measurement, never silently zeroed.
    await rec.step(describe()[4], async () => {
      writeStageDefault(ctx.outDir);
      const state = await waitStateWithCompletedChecks(ctx, browserUrl, 1);
      if (state.agreement === null || state.agreement === undefined) {
        const m = { reason: 'completed-check state has a null agreement', state };
        return { verdict: verdictS7Counts(m), measurement: m };
      }
      return { verdict: verdictS7Counts(state.agreement), measurement: state.agreement };
    });
  } finally {
    if (netemApplied) {
      // Same reason as step 3's early removal: `tc qdisc del` is
      // privileged, so the fault log's recorded removal argv runs,
      // not an `execIn` under `sudo -u <user>`.
      log.remove('pub2-netem-add');
      netemApplied = false;
    }
    try { writeStageDefault(ctx.outDir); }
    catch (err) { process.stderr.write(`[s7 teardown] writeStageDefault: ${err?.message ?? err}\n`); }
    log.removeAll();
  }

  return {
    scenario: NAME,
    startedAt: started,
    endedAt: Date.now(),
    steps: rec.steps,
    faults: log.records,
  };
}

// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — `?reads=<n>&need=<tip|older>` runs n reads
// through `client.read` after the first completed check and writes
// `<pre id="reads">` with `{ need, served }`. The driver reads that
// element and returns the served array.
async function driveReads(ctx, baseUrl, n, need, { clearMemory = false } = {}) {
  const url = `${baseUrl}?reads=${n}&need=${need}${clearMemory ? '&clearMemory=1' : ''}`;
  const expression = `(function () {
    const el = document.querySelector('pre#reads');
    return el !== null ? el.textContent : null;
  })()`;
  const predicate = `if (typeof v !== 'string') return false;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed.served) && parsed.served.length === ${n};
    } catch (_e) { return false; }`;
  const value = await cdpPoll(ctx, url, expression, predicate, LONG_WAIT_MS, POLL_MS);
  const parsed = JSON.parse(value);
  const served = Array.isArray(parsed.served) ? parsed.served : [];
  // Decorate every entry with its `statusAtRead` — the driver already
  // writes it as `status` per read, so copy that field over.
  return served.map((e) => ({ nodeId: e?.nodeId ?? null, statusAtRead: e?.status ?? null }));
}

// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — "how many checks it has completed, so a
// reader can tell one check's state from the next". A baseline-change
// predicate on `checks`: `v` is the `#state` text; on the first poll
// the current `checks` lands in `globalThis.__s7CheckBaseline`, on
// each later poll the wait is done when `checks` has grown. The
// agreement counts stay identical across checks when the same nodes
// answer the same way, so a baseline on `agreement` never changes;
// the counter is the one hook this wait has.
//
// `buildPredicate` builds this body as `new Function('v', body)`, run
// in cdp.mjs' Node process — there is no `window` here, so the
// baseline lives on `globalThis` (one cdp.mjs process per poll, so
// the state is the poll's). The catch wraps `JSON.parse` alone — any
// other throw propagates to `main` and fails the poll fast.
export const S7_WAIT_ONE_COMPLETED_CHECK_PREDICATE = `if (v === null) return false;
    let s;
    try { s = JSON.parse(v); } catch (_e) { return false; }
    if (typeof s.checks !== 'number') return false;
    if (globalThis.__s7CheckBaseline === undefined) globalThis.__s7CheckBaseline = s.checks;
    return s.checks > globalThis.__s7CheckBaseline;`;

// MESH_INTERFACE → No anchor reached → "The agreement counts" / The
// client's node list → "how many checks it has completed" — one page
// polled from a fresh target until its state carries `checks >=
// minChecks`, the parsed state returned. Collapses the wait and the
// read of the same client's state into one poll, so the step reads
// counts, nodes, and agreement from the SAME page whose checks it
// awaited.
//
// `S7_WAIT_COMPLETED_CHECK_PREDICATE` is the `minChecks === 1` form
// exported for the stage test. Later `minChecks` builds the body
// inline since one exported constant cannot vary.
export const S7_WAIT_COMPLETED_CHECK_PREDICATE = `if (v === null) return false;
    let s;
    try { s = JSON.parse(v); } catch (_e) { return false; }
    if (typeof s.checks !== 'number') return false;
    return s.checks >= 1;`;

async function waitStateWithCompletedChecks(ctx, url, minChecks) {
  const expression = "document.getElementById('state')?.textContent ?? null";
  const predicate = minChecks === 1
    ? S7_WAIT_COMPLETED_CHECK_PREDICATE
    : `if (v === null) return false;
    let s;
    try { s = JSON.parse(v); } catch (_e) { return false; }
    if (typeof s.checks !== 'number') return false;
    return s.checks >= ${minChecks};`;
  const value = await cdpPoll(ctx, url, expression, predicate, LONG_WAIT_MS, POLL_MS);
  return JSON.parse(value);
}

async function waitLan1Reached(ctx, url, lan1NotisId) {
  const expression = "document.getElementById('state')?.textContent ?? null";
  const predicate = `if (v === null) return false;
    try {
      const s = JSON.parse(v);
      if (!Array.isArray(s.nodes)) return false;
      const e = s.nodes.find((n) => n.notisId === ${JSON.stringify(lan1NotisId)});
      if (!e) return false;
      if (e.status !== 'ok' && e.status !== 'trailing') return false;
      if (e.transport !== 'webrtc-direct') return false;
      if (e.path !== 'direct') return false;
      return true;
    } catch (_e) { return false; }`;
  const value = await cdpPoll(ctx, url, expression, predicate, LONG_WAIT_MS, POLL_MS);
  return JSON.parse(value);
}

// MESH_INTERFACE → Discovery → "Seeds" — a seed is a contact without
// trust; no answer from it makes `anchorReached` true. The variant
// keeps the stage's own anchors AND names lan1 at its localAddrs as a
// seed. A lan1 row without `localAddrs` fails the step: the fallback
// to the announced relay addresses would measure the relay path, not
// the private one.
export function buildSeedOnlyLanVariant(baseConfig, lan1Row) {
  if (!lan1Row || typeof lan1Row.notisId !== 'string') {
    throw new Error('buildSeedOnlyLanVariant: lan1 identity row is missing');
  }
  if (!Array.isArray(lan1Row.localAddrs) || lan1Row.localAddrs.length === 0) {
    throw new Error('buildSeedOnlyLanVariant: lan1 identity row has no localAddrs');
  }
  return {
    network: baseConfig.network,
    firstContact: baseConfig.firstContact,
    seeds: [{ notisId: lan1Row.notisId, addrs: lan1Row.localAddrs }],
  };
}

// MESH_INTERFACE → Discovery → "A node added by hand" — a variant
// with no anchors and lan1 added by hand at its localAddrs. `trusted`
// decides whether `anchorReached` reads true from lan1's answer
// alone. A lan1 row without `localAddrs` fails the step: the step
// measures the private address.
export function buildByHandLanVariant(baseConfig, lan1Row, trusted) {
  if (!lan1Row || typeof lan1Row.notisId !== 'string') {
    throw new Error('buildByHandLanVariant: lan1 identity row is missing');
  }
  if (!Array.isArray(lan1Row.localAddrs) || lan1Row.localAddrs.length === 0) {
    throw new Error('buildByHandLanVariant: lan1 identity row has no localAddrs');
  }
  return {
    network: baseConfig.network,
    firstContact: [],
    seeds: [],
    byHand: [{ notisId: lan1Row.notisId, addrs: lan1Row.localAddrs, trusted }],
  };
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

// MESH_INTERFACE → Acceptance — `cdp.mjs eval <url> <expression>`
// opens a target on `url`, runs one `Runtime.evaluate` with
// `awaitPromise: true`, writes the returned value as JSON on stdout
// and closes the target. The s7 step 4 phases that press a button
// and poll for the result run their whole wait-click-wait flow in
// one async IIFE on the page, so the single target stays the one
// whose state the click acts on. `timeoutMs` bounds both the CDP
// subprocess and the IIFE's internal deadline.
async function cdpEval(ctx, url, expression, { timeoutMs = 120_000 } = {}) {
  const argv = [ctx.nodeBin, ctx.cdpScript, 'eval', url, expression];
  const buf = execIn('notismesh-browser', argv, {
    user: ctx.invokingUser,
    timeoutMs: timeoutMs + 10_000,
  });
  return JSON.parse(buf.toString('utf8'));
}

