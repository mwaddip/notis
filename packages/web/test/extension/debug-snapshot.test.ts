// @vitest-environment happy-dom
// WEB_INTERFACE → The extension → "The snapshot" — the composer that reads
// each seam at one moment and answers the frozen pair the debug row renders
// and the file carries. The cases pin: every part present over fake seams;
// a `traffic` counter moved after the snapshot does not move in the taken
// copy; and a reader seam that throws leaves every other part whole while
// its own part carries `{ error }`.

import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  takeSnapshot,
  type BuildFacts,
  type ReaderFacts,
  type SettingsFacts,
  type SnapshotSeams,
} from '../../src/extension/debug-snapshot';
import {
  createDebugLog,
  type DebugLog,
  type DebugTimerHandle,
  type DebugTimers,
} from '../../src/extension/debug-log';
import type { MeshDiagnostics, ClientState, ClientTraffic } from '../../src/mesh/mesh-client';

function fakeTimers(): DebugTimers {
  const map = new Map<DebugTimerHandle, () => void>();
  let seq = 0;
  return {
    setInterval(fn, _ms): DebugTimerHandle {
      const h = ++seq;
      map.set(h, fn);
      return h;
    },
    clearInterval(handle): void { map.delete(handle); },
  };
}

function makeLog(): DebugLog {
  return createDebugLog({
    indexedDB: new IDBFactory(),
    now: () => 1_000,
    pageId: 'ab12cd34',
    boundBytes: 2_000_000,
    batchSize: 10,
    batchInterval: 1_000,
    timers: fakeTimers(),
  });
}

function emptyTraffic(): ClientTraffic {
  return { tipBytes: 0, proofBytes: 0, headerBytes: 0, gossipBytes: 0, proofReads: 0, forwarded: 0 };
}

function emptyState(overrides: Partial<ClientState> = {}): ClientState {
  return {
    nodeId: null,
    transport: null,
    path: null,
    lastLeft: null,
    tip: null,
    agreement: null,
    checks: 0,
    traffic: emptyTraffic(),
    nodes: [],
    seated: false,
    proofs: null,
    anchor: null,
    chain: null,
    notContinued: false,
    disagreement: null,
    ...overrides,
  };
}

function emptyDiagnostics(): MeshDiagnostics {
  return { connections: [], gossip: { meshPeers: 0, directPeers: 0 }, iceServers: [] };
}

const BUILD: BuildFacts = {
  version: '0.7.0',
  commit: 'abcdef1',
  network: 'testnet',
  userAgent: 'Mozilla/5.0 (X11) Firefox/141',
};

const SETTINGS: SettingsFacts = {
  serve: false,
  links: 'here',
  signPolicy: 'silent',
  handNode: { address: '', off: false },
};

const READER: ReaderFacts = {
  identityLoaded: true,
  unlocked: true,
  pubKeyHex: 'f'.repeat(64),
  name: 'alice',
  pending: [],
  waiting: [],
  lastTipRun: null,
  lastFiguresRun: null,
  lastNamesRun: null,
};

function seams(overrides: Partial<SnapshotSeams> = {}): SnapshotSeams {
  const log = makeLog();
  return {
    build: () => BUILD,
    settings: () => SETTINGS,
    mesh: {
      state: () => emptyState(),
      diagnostics: () => emptyDiagnostics(),
    },
    reader: () => READER,
    debugLog: log,
    ...overrides,
  };
}

describe('the debug snapshot', () => {
  it.fails('every part present over fake seams', async () => {
    const snap = await takeSnapshot(seams());
    expect(snap.build).toEqual(BUILD);
    expect(snap.settings).toEqual(SETTINGS);
    expect(snap.mesh).toEqual({ state: emptyState(), diagnostics: emptyDiagnostics() });
    expect(snap.reader).toEqual(READER);
    expect(snap.postCache).toEqual({});
    expect(snap.log).toMatchObject({
      events: expect.any(Number),
      bytes: expect.any(Number),
      oldestT: null,
      dropped: 0,
      open: expect.any(Boolean),
      unavailable: false,
    });
  });

  it.fails('a traffic counter moved after the snapshot does not move in it', async () => {
    const liveState = emptyState();
    const live = seams({
      mesh: {
        state: () => liveState,
        diagnostics: () => emptyDiagnostics(),
      },
    });
    const snap = await takeSnapshot(live);
    // the client keeps mutating the traffic object; the snapshot must not
    // follow (WEB_INTERFACE → The extension → "The snapshot" — "A snapshot is
    // a deep copy").
    liveState.traffic.tipBytes = 999;
    liveState.traffic.proofReads = 7;
    expect(snap.mesh).not.toHaveProperty('error');
    const meshPart = snap.mesh as { state: ClientState };
    expect(meshPart.state.traffic.tipBytes).toBe(0);
    expect(meshPart.state.traffic.proofReads).toBe(0);
  });

  it.fails('a reader seam that throws leaves every other part whole and reports the error', async () => {
    const snap = await takeSnapshot(seams({
      reader: (): ReaderFacts => { throw new Error('reader is broken'); },
    }));
    expect(snap.reader).toEqual({ error: 'reader is broken' });
    expect(snap.build).toEqual(BUILD);
    expect(snap.settings).toEqual(SETTINGS);
    expect(snap.mesh).toEqual({ state: emptyState(), diagnostics: emptyDiagnostics() });
    expect(snap.postCache).toEqual({});
    expect(snap.log).not.toHaveProperty('error');
  });
});
