// MESH_INTERFACE → The client's node list / Acceptance 4 — three more
// guards: `withPeerId` rewrites the LAST `/p2p/<id>` component (the
// target), never the first one (which may be a relay); s4 step 1
// accepts both "connected through another node" and "stays on the cut
// node over WSS"; every scenario writes `config.json` before opening a
// page so none inherits a previous scenario's variant.

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { withPeerId } from '../src/client/mesh-client.js';
import { verdictS4Pub1UdpDrop } from '../stage/lib/verdicts.mjs';
import { writeStageDefault, writeConfigVariant } from '../stage/lib/scenario-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const SRC_UP = join(PACKAGE_ROOT, 'stage', 'up.mjs');
const SCENARIO_DIR = join(PACKAGE_ROOT, 'stage', 'scenarios');

// Peer ids libp2p accepts (base58 48-byte); the strings here are the
// shape, not real keys — `multiaddr` parses them as peer id tails.
const PRIV_PEER = '12D3KooWEfriZyCaBZELDo2RHVQmfQYgyc3yjdRJWjGWFUC61sWR';
const RELAY_PEER = '12D3KooWEN7XDtjFLXiSgDS9FWnhewMP2HGgPvrxvEbhFKYEKk75';
const PUB_PEER = '12D3KooWFBopVk5LjSUPnHXB71RuWvEjmaDrQbWCyXH3iBtXzqaE';

// A notisId whose peer id string matches PRIV_PEER — the real
// `toLibp2pPeerIdString` reads blake2b over the key's protobuf
// encoding, so the test uses the real conversion by handing one of
// the stage's real priv1 fixtures.
const PRIV_NOTIS = '481c7ccaf5f11f17dbafc6e04177eb290c54a5e09aa9625159af002b2c9985a2';

describe('finding 9 — withPeerId rewrites the LAST /p2p/ component, never a relay\'s', () => {
  // libp2p's dial reads the LAST `/p2p/<id>` on a multiaddr as the
  // destination (the circuit's target); the FIRST one on a relayed
  // address is the relay. The current implementation replaces the
  // FIRST match (`addr.replace(/\/p2p\/[^/]+/, ...)` with no `g`
  // flag), which rewrites the relay's id and breaks every circuit
  // dial.

  it('a /p2p-circuit address keeps the relay id and names the target in the last /p2p/', () => {
    const addr = `/ip4/11.100.0.12/udp/4001/webrtc-direct/certhash/HASH2/p2p/${RELAY_PEER}/p2p-circuit/p2p/${PRIV_PEER}`;
    const rewritten = withPeerId(addr, PRIV_NOTIS).toString();
    // The relay's id must still be there, in the position before `/p2p-circuit`.
    expect(rewritten, 'relay id preserved before /p2p-circuit').toContain(`/p2p/${RELAY_PEER}/p2p-circuit`);
    // The target id (== PRIV_PEER derived from PRIV_NOTIS) is the last `/p2p/<id>`.
    expect(rewritten, 'target id in last /p2p/').toMatch(new RegExp(`/p2p/${PRIV_PEER}$`));
  });

  it('a plain address with another peer id has the target id rewritten in place', () => {
    const addr = `/ip4/11.100.0.11/tcp/4002/p2p/${PUB_PEER}`;
    const rewritten = withPeerId(addr, PRIV_NOTIS).toString();
    expect(rewritten).toMatch(new RegExp(`/p2p/${PRIV_PEER}$`));
    // No stale pub peer survives.
    expect(rewritten, 'pub peer gone').not.toContain(PUB_PEER);
  });

  it('a bare address with no /p2p/ gets one appended', () => {
    const addr = '/ip4/11.100.0.11/tcp/4002';
    const rewritten = withPeerId(addr, PRIV_NOTIS).toString();
    expect(rewritten).toMatch(new RegExp(`^/ip4/11\\.100\\.0\\.11/tcp/4002/p2p/${PRIV_PEER}$`));
  });

  it('a /p2p-circuit WITHOUT a trailing /p2p/ gets the target appended', () => {
    const addr = `/ip4/11.100.0.12/udp/4001/webrtc-direct/certhash/HASH2/p2p/${RELAY_PEER}/p2p-circuit`;
    const rewritten = withPeerId(addr, PRIV_NOTIS).toString();
    expect(rewritten, 'relay id still there').toContain(`/p2p/${RELAY_PEER}/p2p-circuit`);
    expect(rewritten, 'target appended after /p2p-circuit').toMatch(new RegExp(`/p2p-circuit/p2p/${PRIV_PEER}$`));
  });
});

describe('finding 10 — s4 step 1 verdict PASSes when the client stays connected by either path', () => {
  // MESH_INTERFACE → Acceptance 4: "UDP to one public node: the client
  // stays connected, through another node or over that node's secure
  // WebSocket — whichever ranks first". Verdict PASSes when the client
  // is connected AND the connection is not UDP to the blocked node.

  it('PASS when the client moved to another public (nodeId !== blockedNodeId)', () => {
    expect(verdictS4Pub1UdpDrop({
      connected: true,
      nodeId: 'bb'.repeat(32),
      blockedNodeId: 'aa'.repeat(32),
      transport: 'webrtc-direct',
    })).toBe('PASS');
  });

  it('PASS when the client stayed on the blocked node over WSS', () => {
    expect(verdictS4Pub1UdpDrop({
      connected: true,
      nodeId: 'aa'.repeat(32),
      blockedNodeId: 'aa'.repeat(32),
      transport: 'wss',
    })).toBe('PASS');
  });

  it('FAIL when the client stayed on the blocked node over webrtc-direct (UDP to it)', () => {
    expect(verdictS4Pub1UdpDrop({
      connected: true,
      nodeId: 'aa'.repeat(32),
      blockedNodeId: 'aa'.repeat(32),
      transport: 'webrtc-direct',
    })).toBe('FAIL');
  });

  it('FAIL when the client stayed on the blocked node over webrtc (also UDP)', () => {
    expect(verdictS4Pub1UdpDrop({
      connected: true,
      nodeId: 'aa'.repeat(32),
      blockedNodeId: 'aa'.repeat(32),
      transport: 'webrtc',
    })).toBe('FAIL');
  });

  it('FAIL when not connected', () => {
    expect(verdictS4Pub1UdpDrop({
      connected: false,
      nodeId: null,
      blockedNodeId: 'aa'.repeat(32),
      transport: null,
    })).toBe('FAIL');
  });
});

describe('finding 11 — every scenario writes config.json before opening the page', () => {
  // The sixth scenario leaked its hostile seeds into the seventh's
  // page state. `up.mjs` writes a canonical default to
  // `config.default.json` alongside `config.json`; each scenario's
  // setup writes config.json fresh (default or variant) before any
  // `cdpPoll`. No rename / backup / restore pattern.

  it('writeStageDefault copies config.default.json to config.json byte-for-byte', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mesh-scenario-config-'));
    try {
      const defaultPath = join(tmp, 'browser', 'config.default.json');
      const activePath = join(tmp, 'browser', 'config.json');
      const body = JSON.stringify({ network: 'devnet', anchors: [{ notisId: 'aa'.repeat(32), addrs: [] }], stunServers: [], seeds: [] }, null, 2);
      require('node:fs').mkdirSync(join(tmp, 'browser'), { recursive: true });
      writeFileSync(defaultPath, body);
      // Pollute the active file first — scenario inheritance would
      // otherwise look like a pass.
      writeFileSync(activePath, 'LEFTOVER FROM A PREVIOUS SCENARIO');
      writeStageDefault(tmp);
      const after = readFileSync(activePath, 'utf8');
      expect(after, 'config.json equals config.default.json').toBe(body);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writeStageDefault throws when config.default.json is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mesh-scenario-config-'));
    try {
      expect(() => writeStageDefault(tmp)).toThrow(/config\.default\.json/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writeConfigVariant writes the variant JSON to config.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mesh-scenario-config-'));
    try {
      require('node:fs').mkdirSync(join(tmp, 'browser'), { recursive: true });
      const variant = { network: 'devnet', anchors: [{ notisId: 'cc'.repeat(32), addrs: ['x'] }], stunServers: [], seeds: [] };
      writeConfigVariant(tmp, variant);
      const after = JSON.parse(readFileSync(join(tmp, 'browser', 'config.json'), 'utf8'));
      expect(after).toEqual(variant);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('up.mjs writes config.default.json alongside config.json', () => {
    const src = readFileSync(SRC_UP, 'utf8');
    expect(src, 'up.mjs writes config.default.json').toContain('config.default.json');
  });

  for (const scenario of ['s1-no-name', 's3-node-goes-away', 's4-transport-cut', 's5-impersonation']) {
    it(`${scenario} writes the stage default before its first cdpPoll`, () => {
      const src = readFileSync(join(SCENARIO_DIR, `${scenario}.mjs`), 'utf8');
      const writeIdx = src.indexOf('writeStageDefault(');
      expect(writeIdx, `${scenario} calls writeStageDefault`).toBeGreaterThan(0);
      const firstPoll = src.indexOf('cdpPoll(');
      expect(firstPoll, `${scenario} has a cdpPoll call`).toBeGreaterThan(0);
      expect(writeIdx, `${scenario}: writeStageDefault runs before cdpPoll`).toBeLessThan(firstPoll);
    });
  }

  for (const scenario of ['s2-nat', 's6-hostile']) {
    it(`${scenario} writes a variant through writeConfigVariant before its first cdp call`, () => {
      const src = readFileSync(join(SCENARIO_DIR, `${scenario}.mjs`), 'utf8');
      const writeIdx = src.indexOf('writeConfigVariant(');
      expect(writeIdx, `${scenario} calls writeConfigVariant`).toBeGreaterThan(0);
      // The first cdp call: `cdpPoll(`, `cdpPollIce(` or `cdpEval(`.
      // The config variant has to land before any of them opens the
      // page.
      const indices = ['cdpPoll(', 'cdpPollIce(', 'cdpEval('].map((n) => src.indexOf(n)).filter((i) => i >= 0);
      expect(indices.length, `${scenario} has a cdp call`).toBeGreaterThan(0);
      const firstCdp = Math.min(...indices);
      expect(writeIdx, `${scenario}: writeConfigVariant runs before the first cdp call`).toBeLessThan(firstCdp);
    });
  }

  it('no scenario uses the renameSync / backup pattern on config.json', () => {
    for (const scenario of ['s1-no-name', 's2-nat', 's3-node-goes-away', 's4-transport-cut', 's5-impersonation', 's6-hostile']) {
      const src = readFileSync(join(SCENARIO_DIR, `${scenario}.mjs`), 'utf8');
      // A rename-based swap of config.json leaks a previous scenario's
      // variant when teardown fails partway; the write-fresh approach
      // has no backup to restore. `renameSync` is still allowed on
      // other paths (none actually use it), so grep for the specific
      // config-backup / variant-restore pattern.
      expect(src, `${scenario} does not renameSync config.json`).not.toMatch(/renameSync/);
      expect(src, `${scenario} does not keep a configBackupPath`).not.toMatch(/configBackupPath|configBackup\b/);
    }
  });
});
