// @vitest-environment happy-dom
// WEB_INTERFACE → The extension → "The debug file" — the pure function from a
// snapshot, the log's events and whether the identifying values go in to the
// file's text and its name. The cases pin unticked replacement (every
// identifying value gone from the text, keys planted in fields no rule names
// still caught, hex matched case-insensitively, the same value reading as
// the same placeholder across sections), ticked passthrough (the values
// stand), and the filename formed from a fixed clock.

import { describe, it, expect } from 'vitest';
import { buildDebugFile, debugFilename } from '../../src/extension/debug-file';
import type { DebugSnapshot } from '../../src/extension/debug-snapshot';
import type { DebugEvent } from '../../src/extension/debug-log';

const KEY = 'a'.repeat(64);
const KEY_UPPER = 'A'.repeat(64);
const NAME = 'alice';
const TX_PENDING = '1'.repeat(64);
const TX_WAITING = '2'.repeat(64);
const TX_PLANTED = '3'.repeat(64);
const POST_ID = '4'.repeat(64);
const BOX_ID = `${'5'.repeat(64)}-0`;
const HAND_ADDR =
  '/ip4/127.0.0.1/udp/9733/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';

function snapshotWithValues(): DebugSnapshot {
  return {
    build: {
      version: '0.7.0',
      commit: 'abcdef1',
      network: 'testnet',
      userAgent: 'Mozilla/5.0 (X11) Firefox/141',
    },
    settings: {
      serve: false,
      links: 'here',
      signPolicy: 'silent',
      handNode: { address: HAND_ADDR, off: false, key: null },
    },
    mesh: { error: `[node ${KEY_UPPER}] unreachable` },
    reader: {
      identityLoaded: true,
      unlocked: true,
      pubKeyHex: KEY,
      name: NAME,
      pending: [
        { kind: 'post', txId: TX_PENDING, postId: POST_ID, expiresAtHeight: 99, stage: 'pending' },
      ],
      waiting: [
        { kind: 'send', txId: TX_WAITING, postId: BOX_ID, seq: 1, ledger: 'credits', chain: 'c0ffee' },
      ],
      lastTipRun: null,
      lastFiguresRun: null,
      lastNamesRun: null,
    },
    postCache: { database: null, entries: 0, bytes: 0, own: 0, kept: 0, unavailable: false },
    log: { events: 0, bytes: 0, oldestT: null, dropped: 0, open: true, unavailable: false },
  };
}

function withPlantedKeyEvent(ev: DebugEvent[]): DebugEvent[] {
  return [
    ...ev,
    // An `error` event whose message carries the reader's key — a field no
    // rule names. The replacement catches it because every string in the
    // document is searched for each collected value.
    { t: 1, page: 'ab12cd34', kind: 'error', message: `unhandled at ${KEY}` },
    // A `request` event whose node entry's failure message carries the key.
    { t: 2, page: 'ab12cd34', kind: 'request', failure: `fail for key ${KEY}` },
    // A `write` event whose transaction id is held by no snapshot field —
    // the recorder collects it, and a wait outcome of its own would rename
    // nothing here.
    { t: 3, page: 'ab12cd34', kind: 'write', txId: TX_PLANTED, route: '/posts', node: 'n', tried: 1, status: 201 },
  ];
}

const FIXED_NOW = Date.UTC(2026, 10, 17, 23, 5, 40); // 2026-11-17 23:05:40 UTC

describe('the debug file', () => {
  it('unticked: every identifying value is gone, planted fields caught, same value reads as same placeholder', () => {
    const snapshot = snapshotWithValues();
    const events = withPlantedKeyEvent([
      { t: 0, page: 'ab12cd34', kind: 'wait', outcome: 'queued', txKind: 'send', ledger: 'credits', txId: TX_WAITING },
    ]);
    const built = buildDebugFile({
      snapshot, events, identifying: false, savedAt: FIXED_NOW, nowMs: FIXED_NOW,
    });

    // None of the collected values remain in the file's text.
    expect(built.text).not.toContain(KEY);
    expect(built.text).not.toContain(KEY.toLowerCase());
    // Hex matched case-insensitively — uppercase planted in a mesh error
    // message is caught too.
    expect(built.text).not.toContain(KEY_UPPER);
    expect(built.text).not.toContain(NAME);
    expect(built.text).not.toContain(TX_PENDING);
    expect(built.text).not.toContain(TX_WAITING);
    // The planted txId no snapshot field holds (it rode only an event) is
    // replaced too.
    expect(built.text).not.toContain(TX_PLANTED);
    expect(built.text).not.toContain(POST_ID);
    expect(built.text).not.toContain(BOX_ID);
    expect(built.text).not.toContain(HAND_ADDR);

    // One value, one placeholder: the reader's key appears as `key-1` in
    // the snapshot (reader.pubKeyHex) and in each event's planted field.
    // The match is case-insensitive, so `KEY_UPPER` becomes `key-1` too.
    const keyMatches = built.text.match(/key-1/g) ?? [];
    expect(keyMatches.length).toBeGreaterThanOrEqual(3);

    // The file still parses as JSON.
    const parsed = JSON.parse(built.text);
    expect(parsed.format).toBe('notis-debug/1');
    expect(parsed.identifying).toBe(false);
    expect(parsed.snapshot.reader.pubKeyHex).toBe('key-1');
    expect(parsed.snapshot.reader.name).toBe('name-1');
    expect(parsed.snapshot.settings.handNode.address).toBe('addr-1');
    // The planted `write` event rode only an event — the snapshot holds
    // nothing for `TX_PLANTED`. The collection reaches it from the event and
    // gives it `tx-3` (after `TX_PENDING` and `TX_WAITING` the snapshot
    // held).
    const plantedWrite = parsed.events.find((e: { kind: string; txId?: string }) => e.kind === 'write');
    expect(plantedWrite.txId).toBe('tx-3');
  });

  it('ticked: the text holds the key and the transaction id as they stand', () => {
    const snapshot = snapshotWithValues();
    const events: DebugEvent[] = [
      { t: 0, page: 'ab12cd34', kind: 'write', txId: TX_PENDING, route: '/posts', node: 'n', tried: 1, status: 201 },
    ];
    const built = buildDebugFile({
      snapshot, events, identifying: true, savedAt: FIXED_NOW, nowMs: FIXED_NOW,
    });
    expect(built.text).toContain(KEY);
    expect(built.text).toContain(TX_PENDING);
    const parsed = JSON.parse(built.text);
    expect(parsed.identifying).toBe(true);
    expect(parsed.snapshot.reader.pubKeyHex).toBe(KEY);
    expect(parsed.events[0].txId).toBe(TX_PENDING);
  });

  it('the file name from a fixed clock', () => {
    const name = debugFilename(FIXED_NOW);
    expect(name).toBe('notis-debug-20261117-230540.json');
    const built = buildDebugFile({
      snapshot: snapshotWithValues(),
      events: [],
      identifying: true,
      savedAt: FIXED_NOW,
      nowMs: FIXED_NOW,
    });
    expect(built.filename).toBe('notis-debug-20261117-230540.json');
  });
});

describe('the debug file — the hand-added node\'s key', () => {
  const HAND_KEY = '6'.repeat(64);

  it('unticked: the key a dial event and a node entry name stands nowhere and reads `hand-node` where it stood; ticked it stands', () => {
    const snapshot: DebugSnapshot = {
      ...snapshotWithValues(),
      settings: {
        serve: false,
        links: 'here',
        signPolicy: 'silent',
        handNode: { address: HAND_ADDR, off: false, key: HAND_KEY },
      },
      mesh: { error: `node entry ${HAND_KEY} unreachable` },
    };
    const events: DebugEvent[] = [
      { t: 0, page: 'ab12cd34', kind: 'dial', node: HAND_KEY, ok: false },
    ];
    const unticked = buildDebugFile({ snapshot, events, identifying: false, savedAt: FIXED_NOW, nowMs: FIXED_NOW });
    expect(unticked.text).not.toContain(HAND_KEY);
    const parsed = JSON.parse(unticked.text);
    expect(parsed.events[0].node).toBe('hand-node');
    expect(parsed.snapshot.mesh.error).toBe('node entry hand-node unreachable');
    expect(parsed.snapshot.settings.handNode.key).toBe('hand-node');

    const ticked = buildDebugFile({ snapshot, events, identifying: true, savedAt: FIXED_NOW, nowMs: FIXED_NOW });
    expect(ticked.text).toContain(HAND_KEY);
  });
});

describe("the debug file — a local node's key and addresses", () => {
  // WEB_INTERFACE → The extension → "The debug file" — a node found at the
  // access point: its key and each of its addresses are identifying values,
  // from the snapshot and from each read's report in the log.
  const LOCAL_KEY = '7'.repeat(64);
  const LOCAL_ADDR_A = '/ip4/198.51.100.2/udp/9733/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';
  const LOCAL_ADDR_B = '/ip4/198.51.100.2/udp/9734/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';

  function snapshotWithLocalNode(): DebugSnapshot {
    const base = snapshotWithValues();
    // Minimal shape: the file collection only reads `notisId`, `addrs` and
    // the `local` mark; the deep copy preserves what we hand in. The hand
    // node's address is cleared so the local entry's addresses hold the
    // first `addr-N` placeholders without a collision from `HAND_ADDR`.
    const node = {
      notisId: LOCAL_KEY,
      local: true,
      addrs: [LOCAL_ADDR_A, LOCAL_ADDR_B],
      api: null,
      status: 'ok',
      readMs: 12,
      firstContact: false, known: false, byHand: false, yours: false,
      failures: 0, retryAtMs: 0, behindBy: null,
      droppedAddrs: [], evidence: null, lastFailure: null, lastFailures: {},
      transport: 'webrtc-direct', path: 'direct', seenMs: null,
    };
    return {
      ...base,
      settings: {
        serve: false,
        links: 'here',
        signPolicy: 'silent',
        handNode: { address: '', off: false, key: null },
      },
      mesh: {
        state: {
          nodeId: null, transport: null, path: null, lastLeft: null, tip: null,
          agreement: null, checks: 0,
          traffic: { tipBytes: 0, proofBytes: 0, headerBytes: 0, gossipBytes: 0, proofReads: 0, forwarded: 0 },
          nodes: [node],
          seated: false, proofs: null, anchor: null, chain: null,
          notContinued: false, disagreement: null,
          localLookup: { reads: 0, last: null }, firstCheckEnded: false,
        },
        diagnostics: { connections: [], gossip: { meshPeers: 0, directPeers: 0 }, iceServers: [] },
      },
    } as unknown as DebugSnapshot;
  }

  it("unticked: a local entry's key and each of its addresses stand nowhere, each read as local-node / addr placeholders; ticked they stand", () => {
    const snapshot = snapshotWithLocalNode();
    const unticked = buildDebugFile({
      snapshot, events: [], identifying: false, savedAt: FIXED_NOW, nowMs: FIXED_NOW,
    });
    expect(unticked.text).not.toContain(LOCAL_KEY);
    expect(unticked.text).not.toContain(LOCAL_ADDR_A);
    expect(unticked.text).not.toContain(LOCAL_ADDR_B);
    const parsed = JSON.parse(unticked.text);
    expect(parsed.snapshot.mesh.state.nodes[0].notisId).toBe('local-node-1');
    expect(parsed.snapshot.mesh.state.nodes[0].addrs).toEqual(['addr-1', 'addr-2']);

    const ticked = buildDebugFile({
      snapshot, events: [], identifying: true, savedAt: FIXED_NOW, nowMs: FIXED_NOW,
    });
    expect(ticked.text).toContain(LOCAL_KEY);
    expect(ticked.text).toContain(LOCAL_ADDR_A);
    expect(ticked.text).toContain(LOCAL_ADDR_B);
  });

  it('an answered local-lookup event from an earlier page whose node the snapshot lacks is replaced too', () => {
    const EARLIER_KEY = '8'.repeat(64);
    const EARLIER_ADDR = '/ip4/198.51.100.3/udp/9733/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';
    // The current snapshot holds no local node (and no hand node to collide
    // with `addr-1`); only the log carries the earlier page's answered
    // event. The collection reaches the key and addresses through the
    // event.
    const snapshot: DebugSnapshot = {
      ...snapshotWithValues(),
      settings: {
        serve: false,
        links: 'here',
        signPolicy: 'silent',
        handNode: { address: '', off: false, key: null },
      },
    };
    const events: DebugEvent[] = [
      {
        t: 0, page: 'cd34ef56', kind: 'local-lookup', check: 2, ms: 33,
        outcome: { result: 'answered', notisId: EARLIER_KEY, localAddrs: [EARLIER_ADDR], added: true },
      } as unknown as DebugEvent,
    ];
    const unticked = buildDebugFile({
      snapshot, events, identifying: false, savedAt: FIXED_NOW, nowMs: FIXED_NOW,
    });
    expect(unticked.text).not.toContain(EARLIER_KEY);
    expect(unticked.text).not.toContain(EARLIER_ADDR);
    const parsed = JSON.parse(unticked.text);
    expect(parsed.events[0].outcome.notisId).toBe('local-node-1');
    expect(parsed.events[0].outcome.localAddrs).toEqual(['addr-1']);
  });
});
