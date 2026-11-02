// MESH_INTERFACE → Acceptance 8 — "a node on another chain has its
// proof read at the next check — one per distinct tip, and the
// client's own — and the heavier chain is the client's" and
// MINING_INTERFACE → "The peer-readiness gate" — `hostile-lagging`'s
// miner only produces templates when the node holds at least one
// Active peer. The cut that leaves it alone behind the honest chain
// stalls `miner-lagging` with no template.
//
// The remedy: pair `hostile-lagging` with `hostile-malformed` as each
// other's one Active peer. Both bootstrap from pub1 before the height
// wait so each starts synced to the honest chain, and each also names
// the other in `BOOTSTRAP_PEERS`. After the height wait, a per-host
// `lag_cut` drops every TCP packet on the Notis p2p port except the
// pair's own traffic — an accept rule for the partner's address and
// p2p port is written ahead of the drop in both the output and the
// input chain, on both hosts.
//
// A live run shows the pair-up in `stage/out/notis:<host>.log`:
//   `[net] peer:connect <partner peerId> (total=1)`
//   `[net] outbound handshake with <partner peerId>: ok=true ...`
// (or an inbound handshake on the other side), and NO
// `[net] peer:disconnect <partner peerId>` after the cut; the honest
// nodes' peerIds disappear from both logs. The dry-run only prints the
// nft argument lists this builder writes.

/**
 * The pair of hostile hosts that form the lighter fork — `[lagging,
 * partner]`. The partner is `hostile-malformed`: its mesh service's
 * `/blocks/current` answers a lie hash and its `/nipopow/proof/*`
 * answers non-hex, so its chain reaches no client even once it joins
 * the fork — a browser that reads it blacklists it for `malformed`
 * evidence. `hostile-lagging`'s mesh service forwards to its own node
 * unchanged, so a browser reading it sees the fork tip and places it
 * `behind`.
 */
export const HOSTILE_FORK_PAIR = ['hostile-lagging', 'hostile-malformed'];

/**
 * Pick the pair-partner for `name`, or `null` if `name` is not in the
 * pair.
 */
export function partnerOf(name) {
  const i = HOSTILE_FORK_PAIR.indexOf(name);
  if (i === -1) return null;
  return HOSTILE_FORK_PAIR[1 - i];
}

/**
 * Join `base` with `extras` as a comma-separated libp2p multiaddr list
 * (`BOOTSTRAP_PEERS`'s format — `packages/node/src/config.ts`'s
 * `parseBootstrapPeers` splits on `,`). Empty entries and duplicates
 * are dropped; the order the caller gave is kept.
 */
export function joinBootstrapPeers(base, extras) {
  const seen = new Set();
  const out = [];
  for (const addr of [base, ...extras]) {
    if (typeof addr !== 'string') continue;
    const trimmed = addr.trim();
    if (trimmed === '') continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join(',');
}

/**
 * The partner-reaching bootstrap addr for `name`: `/ip4/<partner
 * addr>/tcp/<partner p2p port>`. No `/p2p/<peer id>` tail — Notis
 * `BOOTSTRAP_PEERS` accepts a bare TCP multiaddr. Returns `null` if
 * `name` is not in the pair, or the partner carries no `node` entry.
 */
export function pairBootstrapAddr(topology, name) {
  const partner = partnerOf(name);
  if (partner === null) return null;
  const partnerHost = topology?.hosts?.[partner];
  if (partnerHost === null || typeof partnerHost !== 'object') return null;
  const addr = partnerHost.addr;
  const p2pPort = partnerHost.node?.p2pPort;
  if (typeof addr !== 'string' || typeof p2pPort !== 'number') return null;
  return `/ip4/${addr}/tcp/${p2pPort}`;
}

/**
 * The nft rules the per-host cut writes, in order:
 *   1. table ip <table>
 *   2. chain out { type filter hook output priority 0 ; }
 *   3. chain in  { type filter hook input  priority 0 ; }
 *   4. rule out ip daddr <partner addr> tcp dport <p2p port> accept
 *   5. rule in  ip saddr <partner addr> tcp sport <p2p port> accept
 *   6. rule out tcp dport <p2p port> drop
 *   7. rule in  tcp sport <p2p port> drop
 *
 * The accept rules on daddr/saddr sit ahead of the drops — nft reads
 * rules in order, first match wins, so the pair's p2p traffic takes
 * the accept and the honest nodes' hits the drop. The output `/
 * input` split names the hook each rule binds to; a chain hooked to
 * `output` filters packets this host emits, a chain hooked to `input`
 * filters packets this host receives.
 *
 * Returns an array of `{ description, argv }` entries where `argv` is
 * the full `sudo ip netns exec <ns> nft ...` command line.
 * `description` is the record name the stage's command log reads so a
 * teardown can single out any one rule.
 *
 * Pure: a plain function of topology + name + table — no filesystem
 * reads, no clock, no process state. A caller passes the result to
 * `log.shell(..., { privileged: true })` or lists it in a dry-run.
 */
export function buildHostCutArgs(topology, name, { table = 'lag_cut' } = {}) {
  if (typeof name !== 'string' || name === '') {
    throw new Error('buildHostCutArgs: name must be a non-empty string');
  }
  const host = topology?.hosts?.[name];
  if (host === null || typeof host !== 'object') {
    throw new Error(`buildHostCutArgs: topology has no host ${JSON.stringify(name)}`);
  }
  const partner = partnerOf(name);
  if (partner === null) {
    throw new Error(`buildHostCutArgs: ${JSON.stringify(name)} is not in HOSTILE_FORK_PAIR`);
  }
  const partnerHost = topology?.hosts?.[partner];
  if (partnerHost === null || typeof partnerHost !== 'object') {
    throw new Error(`buildHostCutArgs: topology has no partner ${JSON.stringify(partner)}`);
  }
  const port = host?.node?.p2pPort;
  if (typeof port !== 'number') {
    throw new Error(`buildHostCutArgs: ${name} has no node.p2pPort`);
  }
  const partnerAddr = partnerHost.addr;
  if (typeof partnerAddr !== 'string') {
    throw new Error(`buildHostCutArgs: partner ${partner} has no addr`);
  }
  const ns = `notismesh-${name}`;
  const portStr = String(port);
  const wrap = (...rest) => ['sudo', 'ip', 'netns', 'exec', ns, 'nft', ...rest];
  return [
    { description: `${name}-pair-add-table`,
      argv: wrap('add', 'table', 'ip', table) },
    { description: `${name}-pair-add-chain-out`,
      argv: wrap('add', 'chain', 'ip', table, 'out', '{', 'type', 'filter', 'hook', 'output', 'priority', '0', ';', '}') },
    { description: `${name}-pair-add-chain-in`,
      argv: wrap('add', 'chain', 'ip', table, 'in', '{', 'type', 'filter', 'hook', 'input', 'priority', '0', ';', '}') },
    { description: `${name}-pair-out-accept-${partner}`,
      argv: wrap('add', 'rule', 'ip', table, 'out', 'ip', 'daddr', partnerAddr, 'tcp', 'dport', portStr, 'accept') },
    { description: `${name}-pair-in-accept-${partner}`,
      argv: wrap('add', 'rule', 'ip', table, 'in', 'ip', 'saddr', partnerAddr, 'tcp', 'sport', portStr, 'accept') },
    { description: `${name}-pair-out-drop`,
      argv: wrap('add', 'rule', 'ip', table, 'out', 'tcp', 'dport', portStr, 'drop') },
    { description: `${name}-pair-in-drop`,
      argv: wrap('add', 'rule', 'ip', table, 'in', 'tcp', 'sport', portStr, 'drop') },
  ];
}

/**
 * `buildHostCutArgs` for every host in `HOSTILE_FORK_PAIR`, concatenated
 * in pair order. The stage applies this list after the height wait on
 * both hosts, so each one's cut lands as a whole ruleset: table,
 * chains, accepts, drops.
 */
export function buildPairCutArgs(topology, options) {
  const out = [];
  for (const name of HOSTILE_FORK_PAIR) {
    out.push(...buildHostCutArgs(topology, name, options));
  }
  return out;
}
