// @vitest-environment happy-dom
// WEB_INTERFACE → The settings window → "The debug row" — the row's reach
// line for a node reached over FIPS reads `fips · through <via's short form>`,
// naming the node whose connection the link rides. Every other transport
// reads `<transport> · <path>` as today (→ The extension → "The debug log").

import { describe, it, expect } from 'vitest';
import { debugRow, type DebugSeam } from '../../src/extension/debug-row';
import type {
  BuildFacts, SettingsFacts, SnapshotSeams,
} from '../../src/extension/debug-snapshot';
import type { PostCacheStats } from '../../src/extension/post-cache';
import type { DebugLogStats } from '../../src/extension/debug-log';
import type { NodeEntry } from '../../src/mesh/node-list';
import type { ClientState, ClientTraffic, MeshDiagnostics } from '../../src/mesh/mesh-client';
import { shortHex } from '../../src/dom';

const BUILD: BuildFacts = {
  version: '0.7.0', commit: 'abcdef1', network: 'testnet',
  userAgent: 'Mozilla/5.0 (X11) Firefox/141',
};

const SETTINGS: SettingsFacts = {
  serve: false,
  links: 'here',
  signPolicy: 'silent',
  handNode: { address: '', off: false, key: null },
};

const CACHE: PostCacheStats = {
  database: null, entries: 0, bytes: 0, own: 0, kept: 0, unavailable: false,
};

const LOG_STATS: DebugLogStats = {
  events: 0, bytes: 0, oldestT: null, dropped: 0, open: true, unavailable: false,
};

function emptyTraffic(): ClientTraffic {
  return { tipBytes: 0, proofBytes: 0, headerBytes: 0, gossipBytes: 0, proofReads: 0, forwarded: 0 };
}

function emptyState(overrides: Partial<ClientState> = {}): ClientState {
  return {
    nodeId: null, transport: null, path: null, lastLeft: null, tip: null,
    agreement: null, checks: 0, traffic: emptyTraffic(), nodes: [],
    seated: false, proofs: null, anchor: null, chain: null,
    notContinued: false, disagreement: null,
    localLookup: { reads: 0, last: null }, firstCheckEnded: false,
    ...overrides,
  };
}

function makeSeam(
  state: ClientState,
  diagnostics: MeshDiagnostics,
): DebugSeam {
  const seams: Omit<SnapshotSeams, 'reader'> = {
    build: () => ({ ...BUILD }),
    settings: () => ({ ...SETTINGS }),
    mesh: { state: () => state, diagnostics: () => diagnostics },
    postCache: { stats: () => Promise.resolve({ ...CACHE }) },
    debugLog: { stats: () => Promise.resolve({ ...LOG_STATS }) },
  };
  return {
    seams,
    log: { clear: () => Promise.resolve(), list: () => Promise.resolve([]) },
    download: () => {},
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe("nodesBlock — the reach line of a FIPS connection", () => {
  it("names the node it rides through: fips · through <via's short form>", async () => {
    const NODE_B = '68112eb3027cf9649a2ebc7f5caa48dbaf7fdb77ad3b1427176767ed2bf50d09';
    const VIA = 'aa'.repeat(32);

    const node: NodeEntry = {
      notisId: NODE_B,
      firstContact: false, known: false, byHand: false, yours: false,
      local: false,
      status: 'ok',
      failures: 0, retryAtMs: 0, readMs: 12, behindBy: null,
      addrs: [],
      droppedAddrs: [],
      evidence: null,
      lastFailure: null, lastFailures: {},
      transport: 'fips', path: null,
      via: VIA,
      api: null,
      seenMs: null,
    };

    const diag: MeshDiagnostics = {
      connections: [{
        connId: 'c1',
        peer: NODE_B,
        peerKind: 'notis',
        remoteAddr: '/fips/npub1lpxz9sucre2dap6u9pa87hyp7hxqkgr73f453809kjy5jjxc52es02zp2u',
        direction: 'inbound',
        transport: 'fips',
        path: null,
        limited: false,
        ageMs: 1234,
        handshake: { verdict: 'passed', reason: null },
      }],
      gossip: { meshPeers: 0, directPeers: 0 },
      iceServers: [],
    };

    const row = debugRow({
      seam: makeSeam(emptyState({ nodes: [node] }), diag),
      reader: () => ({
        identityLoaded: false, unlocked: false, pubKeyHex: null, name: null,
        pending: [], waiting: [], lastTipRun: null, lastFiguresRun: null, lastNamesRun: null,
      }),
      now: () => 0,
    });
    document.body.appendChild(row);
    const toggle = row.querySelector<HTMLButtonElement>('.field > button.word')!;
    toggle.click();
    await flush();

    const text = row.querySelector('.debug-body')!.textContent ?? '';
    expect(text).toContain(`fips · through ${shortHex(VIA, 16)}`);
    expect(text).not.toContain('fips · direct');
    expect(text).not.toContain('fips · none');
  });
});
