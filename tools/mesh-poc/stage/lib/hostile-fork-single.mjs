// MESH_INTERFACE → Acceptance 6 — "A page with an honest kept chain
// whose reachable nodes all serve the hostile chain keeps its own and
// says no node continues it." The pair (`hostile-fork-pair.mjs`) mines
// from its own genesis and devnet pins no `genesisId`, so its proof is
// `incomparable` with an honest kept proof and the client drops the
// kept one before reaching the memory judgement (MESH_INTERFACE → What
// the client remembers → "When every verified proof shares no block
// with the kept one"). s6 step 1 needs a hostile host whose fork
// **shares the honest chain**: it syncs from the honest nodes, is cut
// from them at a chosen height, and mines a lighter fork of its own
// past the cut. A page that verified the honest tip's proof reads the
// fork host's chain `off` the kept one, and the client says `No node
// reached continues the chain you verified.`
//
// The mechanics reuse the pair's cut building blocks — the per-host
// nft table, the output/input chain hooks, the daddr/saddr accept
// rules that pass the pair's own traffic (here: none) and the drop
// rules on the p2p port. Two differences:
//   1. the cut is applied AFTER the host has synced from the honest
//      chain, not before its Notis node spawns (the sync is the whole
//      point);
//   2. the host carries no partner — the accept rules are empty and
//      only the drops apply, so every TCP packet on the p2p port is
//      dropped at cut time.
//
// The host is a role=`hostile` entry in topology.json whose node.role
// is `server`; a miner process (`packages/node/scripts/miner.mjs`) is
// started inside its namespace at cut time, pointed at the host's own
// HTTP port. The miner reads the node's `/mining/template` and
// `/mining/submit` paths over HTTP, so no NODE_ROLE change is needed.
//
// Pure: `buildForkCutArgs` is a plain function of the topology and
// the host name; it holds no file-system read, no clock, no process
// state. The stage applies the returned argv lists in order.

/**
 * The nft rules the single-host cut writes, in order (`table` names
 * the table a teardown deletes). When `partner` is given
 * (`{ addr, p2pPort }`), accept rules for the partner's TCP p2p
 * traffic land BEFORE the drops on both chains — nft reads rules in
 * order, first match wins, so the partner's packets take the accept
 * and every other host's p2p hits the drop. This is the pattern
 * `stage/lib/hostile-fork-pair.mjs` uses for the genesis-pair; the
 * difference here is the pair synced the honest chain from pub1
 * before the cut, and the rules are applied dynamically rather than
 * pre-spawn.
 *
 * Without a partner, every TCP packet on the Notis p2p port drops in
 * either direction — the single-host form, left for a caller who
 * does not need the peer-readiness gate (`MINING_INTERFACE`).
 *
 * Returns an array of `{ description, argv }` entries where `argv` is
 * the full `sudo ip netns exec <ns> nft ...` command line a caller
 * hands to `nftApply` or lists in a dry-run. `description` is the
 * record name the stage's command log reads so a teardown can single
 * out any one rule.
 */
export function buildForkCutArgs(topology, name, { table = 'fork_cut', partner = null } = {}) {
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
  const ns = `notismesh-${name}`;
  const portStr = String(port);
  const wrap = (...rest) => ['sudo', 'ip', 'netns', 'exec', ns, 'nft', ...rest];
  const rules = [
    { description: `${name}-fork-add-table`,
      argv: wrap('add', 'table', 'ip', table) },
    { description: `${name}-fork-add-chain-out`,
      argv: wrap('add', 'chain', 'ip', table, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}') },
    { description: `${name}-fork-add-chain-in`,
      argv: wrap('add', 'chain', 'ip', table, 'in', '{', 'type', 'filter', 'hook', 'input', 'priority', '0', ';', '}') },
  ];
  if (partner !== null) {
    if (typeof partner.addr !== 'string' || partner.addr === '') {
      throw new Error(`buildForkCutArgs: partner.addr must be a non-empty string`);
    }
    if (typeof partner.p2pPort !== 'number') {
      throw new Error(`buildForkCutArgs: partner.p2pPort must be a number`);
    }
    const partnerPortStr = String(partner.p2pPort);
    rules.push(
      { description: `${name}-fork-out-accept-partner`,
        argv: wrap('add', 'rule', 'ip', table, 'out', 'ip', 'daddr', partner.addr, 'tcp', 'dport', partnerPortStr, 'accept') },
      { description: `${name}-fork-in-accept-partner`,
        argv: wrap('add', 'rule', 'ip', table, 'in', 'ip', 'saddr', partner.addr, 'tcp', 'sport', partnerPortStr, 'accept') },
    );
  }
  rules.push(
    { description: `${name}-fork-out-drop`,
      argv: wrap('add', 'rule', 'ip', table, 'out', 'tcp', 'dport', portStr, 'drop') },
    { description: `${name}-fork-in-drop`,
      argv: wrap('add', 'rule', 'ip', table, 'in', 'tcp', 'sport', portStr, 'drop') },
  );
  return rules;
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
 * The miner-process spawn plan for the fork host, as a caller passes
 * to `log.spawn`: the `argv` runs `packages/node/scripts/miner.mjs`
 * inside the host's namespace as the invoking user; `env` sets the
 * `NODE_URL` to the host's own HTTP port on loopback, `MINER_PCT` to
 * the given pace and (when a secret is handed) `MINING_SECRET`. The
 * miner reads the node's HTTP mining endpoints, so no `NODE_ROLE`
 * change is needed on the host — a `role: 'server'` Notis node answers
 * the mining routes.
 *
 * Returns `{ description, argv, env }`. The caller hands these three
 * to its own spawn wrapper, which writes the pid to `pids.json`.
 *
 * Pure: no file-system, no process, no clock.
 */
export function buildForkMinerSpawn(topology, name, {
  minerScript,
  minerPct = 1,
  invokingUser,
  miningSecret,
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
  const envEntries = {
    NODE_URL: `http://127.0.0.1:${String(httpPort)}`,
    MINER_PCT: String(minerPct),
  };
  if (typeof miningSecret === 'string' && miningSecret !== '') {
    envEntries.MINING_SECRET = miningSecret;
  }
  const outer = typeof invokingUser === 'string' && invokingUser !== ''
    ? ['sudo', 'ip', 'netns', 'exec', ns, 'sudo', '-u', invokingUser, '--', 'node', minerScript]
    : ['sudo', 'ip', 'netns', 'exec', ns, 'node', minerScript];
  return {
    description: `miner-${name}`,
    argv: outer,
    env: envEntries,
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
