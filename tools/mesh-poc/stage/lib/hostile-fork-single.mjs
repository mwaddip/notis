// MESH_INTERFACE → Acceptance 6 — "A page with an honest kept chain
// whose reachable nodes all serve the hostile chain keeps its own and
// says no node continues it." The pair (`hostile-fork-pair.mjs`) mines
// from its own genesis and devnet pins no `genesisId`, so its proof is
// `incomparable` with an honest kept proof: the client drops the kept
// one and reaches the memory judgement with no chain. s6's first step
// reads the `notContinued` rule, which needs a hostile fork whose
// chain **shares the honest chain**. The remedy pairs the fork with a
// partner that keeps it peered after the cut
// (MINING_INTERFACE → The peer-readiness gate), and both hosts drop
// every packet to and from every other host — libp2p peers over TCP,
// WebRTC-direct (UDP), through relays and over the secure WebSocket;
// a cut on the Notis p2p port alone (an earlier attempt) leaked
// through every other transport, so the fork pair rejoined the honest
// chain through its mesh listener. The new cut is policy-drop on both
// chains, with accepts only for loopback, the partner's address, and
// the browser's address (so the page still reaches the fork pair at
// its mesh port).

/**
 * The nft rules the single-host cut writes. `table` names the table
 * a teardown deletes; `partner: { addr }` is the one host the host
 * stays peered with across the cut (any protocol); `browserAddr` is
 * the browser's reachable address from this host (natC's outside
 * address for a public fork host, the browser's inside address for
 * a private fork host).
 *
 *   1. `add table ip <table>`
 *   2. `add chain ip <table> out { type filter hook output priority 0 ; policy drop ; }`
 *   3. `add chain ip <table> in  { type filter hook input  priority 0 ; policy drop ; }`
 *   4. `add rule  ip <table> out oif lo accept`           (loopback — the node's own HTTP)
 *   5. `add rule  ip <table> in  iif lo accept`
 *   6. `add rule  ip <table> out ip daddr <partner.addr> accept`   (partner)
 *   7. `add rule  ip <table> in  ip saddr <partner.addr> accept`
 *   8. `add rule  ip <table> out ip daddr <browserAddr> accept`    (browser)
 *   9. `add rule  ip <table> in  ip saddr <browserAddr> accept`
 *
 * The chain's default `policy drop` closes every other packet, so
 * libp2p's WebRTC-direct, relay and secure-WebSocket traffic between
 * the host and the honest nodes drops at the kernel — no block flows
 * between the honest chain and the fork pair after the cut.
 *
 * Returns an array of `{ description, argv }` entries where `argv` is
 * the full `sudo ip netns exec <ns> nft ...` command line a caller
 * hands to `nftApply` or lists in a dry-run. `description` is the
 * record name the stage's command log reads so a teardown can single
 * out any one rule.
 *
 * Pure: a plain function of topology + name + options; no file-system
 * read, no clock, no process state.
 */
export function buildForkCutArgs(topology, name, { table = 'fork_cut', partner = null, browserAddr = null } = {}) {
  if (typeof name !== 'string' || name === '') {
    throw new Error('buildForkCutArgs: name must be a non-empty string');
  }
  const host = topology?.hosts?.[name];
  if (host === null || typeof host !== 'object' || host === undefined) {
    throw new Error(`buildForkCutArgs: topology has no host ${JSON.stringify(name)}`);
  }
  const port = host?.node?.p2pPort;
  if (typeof port !== 'number') {
    throw new Error(`buildForkCutArgs: ${name} has no node.p2pPort`);
  }
  if (partner === null || typeof partner !== 'object') {
    throw new Error('buildForkCutArgs: partner is required — the one host the fork stays peered with across the cut');
  }
  if (typeof partner.addr !== 'string' || partner.addr === '') {
    throw new Error('buildForkCutArgs: partner.addr must be a non-empty string');
  }
  if (typeof browserAddr !== 'string' || browserAddr === '') {
    throw new Error('buildForkCutArgs: browserAddr must be a non-empty string — the browser\'s address as seen from this host (natC outside for a public fork, 10.103.0.11 for a private fork)');
  }
  const ns = `notismesh-${name}`;
  const wrap = (...rest) => ['sudo', 'ip', 'netns', 'exec', ns, 'nft', ...rest];
  return [
    { description: `${name}-fork-add-table`,
      argv: wrap('add', 'table', 'ip', table) },
    { description: `${name}-fork-add-chain-out`,
      argv: wrap('add', 'chain', 'ip', table, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', 'policy', 'drop', ';', '}') },
    { description: `${name}-fork-add-chain-in`,
      argv: wrap('add', 'chain', 'ip', table, 'in', '{', 'type', 'filter', 'hook', 'input', 'priority', '0', ';', 'policy', 'drop', ';', '}') },
    { description: `${name}-fork-out-accept-lo`,
      argv: wrap('add', 'rule', 'ip', table, 'out', 'oif', 'lo', 'accept') },
    { description: `${name}-fork-in-accept-lo`,
      argv: wrap('add', 'rule', 'ip', table, 'in', 'iif', 'lo', 'accept') },
    { description: `${name}-fork-out-accept-partner`,
      argv: wrap('add', 'rule', 'ip', table, 'out', 'ip', 'daddr', partner.addr, 'accept') },
    { description: `${name}-fork-in-accept-partner`,
      argv: wrap('add', 'rule', 'ip', table, 'in', 'ip', 'saddr', partner.addr, 'accept') },
    { description: `${name}-fork-out-accept-browser`,
      argv: wrap('add', 'rule', 'ip', table, 'out', 'ip', 'daddr', browserAddr, 'accept') },
    { description: `${name}-fork-in-accept-browser`,
      argv: wrap('add', 'rule', 'ip', table, 'in', 'ip', 'saddr', browserAddr, 'accept') },
  ];
}

/**
 * The matching teardown argv for `buildForkCutArgs` — a single
 * `delete table` is enough; nft's own cascade drops the chains and
 * rules. Pure.
 */
export function buildForkCutTeardownArgs(name, { table = 'fork_cut' } = {}) {
  if (typeof name !== 'string' || name === '') {
    throw new Error('buildForkCutTeardownArgs: name must be a non-empty string');
  }
  const ns = `notismesh-${name}`;
  return [
    { description: `${name}-fork-delete-table`,
      argv: ['sudo', 'ip', 'netns', 'exec', ns, 'nft', 'delete', 'table', 'ip', table] },
  ];
}

/**
 * The miner-process spawn plan for the fork host, with env INLINED on
 * the command line via `env VAR=VAL ...` — `sudo -u <user>` strips
 * environment variables for security, so the inner process would see
 * the defaults (an earlier attempt passed env through `process.env`,
 * and the miner logged `node=http://localhost:3000 cpu=25%` — the
 * defaults). The `env` command the inner shell runs sets the env on
 * the final `node <minerScript>` call directly.
 *
 * `nodeBin` is the absolute path to Node — `sudo -u`'s `secure_path`
 * reduces `$PATH` to a narrow default where `node` may resolve to an
 * older binary or none; the stage spawns every long-lived process
 * with `process.execPath` to hold that invariant
 * (`NODE_ABS` in up.mjs).
 *
 * Returns `{ description, argv }`. The caller hands argv to its own
 * spawn wrapper (`log.spawn`'s pidfile and teardown tree match every
 * other spawn's shape).
 *
 * Pure: no file-system, no process, no clock.
 */
export function buildForkMinerSpawn(topology, name, {
  minerScript,
  minerPct = 1,
  invokingUser,
  miningSecret,
  nodeBin = 'node',
} = {}) {
  if (typeof name !== 'string' || name === '') {
    throw new Error('buildForkMinerSpawn: name must be a non-empty string');
  }
  if (typeof minerScript !== 'string' || minerScript === '') {
    throw new Error('buildForkMinerSpawn: minerScript must be a non-empty string');
  }
  const host = topology?.hosts?.[name];
  if (host === null || typeof host !== 'object' || host === undefined) {
    throw new Error(`buildForkMinerSpawn: topology has no host ${JSON.stringify(name)}`);
  }
  const httpPort = host?.node?.httpPort;
  if (typeof httpPort !== 'number') {
    throw new Error(`buildForkMinerSpawn: ${name} has no node.httpPort`);
  }
  const ns = `notismesh-${name}`;
  const envPairs = [`NODE_URL=http://127.0.0.1:${String(httpPort)}`, `MINER_PCT=${String(minerPct)}`];
  if (typeof miningSecret === 'string' && miningSecret !== '') {
    envPairs.push(`MINING_SECRET=${miningSecret}`);
  }
  const envMap = Object.fromEntries(envPairs.map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i), p.slice(i + 1)];
  }));
  // The env lands on the command line as `env NAME=VALUE ...` so the
  // inner `node minerScript` reads them regardless of `sudo -u`'s
  // environment stripping — same shape as `up.mjs`'s `userWrap`.
  const argv = typeof invokingUser === 'string' && invokingUser !== ''
    ? ['sudo', 'ip', 'netns', 'exec', ns, 'sudo', '-u', invokingUser, '--', 'env', ...envPairs, nodeBin, minerScript]
    : ['sudo', 'ip', 'netns', 'exec', ns, 'env', ...envPairs, nodeBin, minerScript];
  return {
    description: `miner-${name}`,
    argv,
    env: envMap,
  };
}

/**
 * The Notis `BOOTSTRAP_PEERS` value for a fork host: `pub1Addr`
 * alone, the honest nodes' entry. The host syncs the honest chain
 * before `buildForkCutArgs` cuts it. A fork host is neither in
 * `HOSTILE_FORK_PAIR` nor otherwise distinguished — its bootstrap is
 * the honest chain's. Pure.
 */
export function forkHostBootstrapPeers(pub1Addr) {
  if (typeof pub1Addr !== 'string' || pub1Addr === '') {
    throw new Error('forkHostBootstrapPeers: pub1Addr must be a non-empty string');
  }
  return pub1Addr;
}
