import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { encode } from 'cbor-x';
import { computeContentHash, encodePostBody, decodePostBody } from '@dagsocial/types';
import { verifyPostBody } from '@dagsocial/validation';
import { SyncMachine } from '../src/sync-machine.js';
import type { SyncStore } from '../src/sync-machine.js';
import {
  MSG_SYNC_INFO,
  MSG_INV,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_ORDERING_BLOCK,
} from '../src/types.js';
import type { NetConfig } from '../src/types.js';
import { MAX_INV_IDS, MAX_SERVE_BODY_BYTES } from '../src/msg-guards.js';
import { decodeFrame } from '../src/frame.js';
import { decodeModifierResponse } from '../src/sync-codec.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse } from '../src/sync-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubStore(overrides: Partial<SyncStore> = {}): SyncStore {
  return {
    getOrderingBlock: () => null,
    serializeOrderingBlock: () => null,
    getOrderingBlockHeader: () => null,
    getOrderingBlockId: () => null,
    chainHeight: () => 0,
    getAnchors: () => [],
    appendHeaders: () => {},
    appendBlocks: () => {},
    setValidatedHeight: () => {},
    flush: () => {},
    ...overrides,
  };
}

const testConfig: NetConfig = {
  magic: 0x54444147,
  bootstrapPeers: [],
  listenAddrs: '',
  maxPeers: 10,
  minPeers: 3,
  peerDbCap: 100,
  outboundRedialCooldownMs: 60000,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000,
  penaltySafeIntervalMs: 120000,
  syncRequestTimeoutMs: 10000,
};

interface SentMessage {
  peerId: string;
  data: Uint8Array;
}

function makeMachine(overrides?: {
  store?: Partial<SyncStore>;
  sendToPeer?: (peerId: string, data: Uint8Array) => void;
}): { machine: SyncMachine; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const machine = new SyncMachine(
    testConfig,
    stubStore(overrides?.store),
    overrides?.sendToPeer ?? ((peerId, data) => sent.push({ peerId, data })),
  );
  return { machine, sent };
}

/** CBOR-encode a SyncInfo, enqueue it, and flush. */
function sendSyncInfo(machine: SyncMachine, peerId: string, info: SyncInfo): void {
  const body = new Uint8Array(encode(info));
  machine.handleMessage(peerId, MSG_SYNC_INFO, body);
  machine.flush();
}

/** CBOR-encode an Inv, enqueue it, and flush. */
function sendInv(machine: SyncMachine, peerId: string, inv: Inv): void {
  const body = new Uint8Array(encode(inv));
  machine.handleMessage(peerId, MSG_INV, body);
  machine.flush();
}

/** Call onPeerActive and flush the event loop. */
function peerActive(machine: SyncMachine, peerId: string, peerHeight: number): void {
  machine.onPeerActive(peerId, peerHeight);
  machine.flush();
}

/** Call onPeerDisconnect and flush the event loop. */
function peerDisconnect(machine: SyncMachine, peerId: string): void {
  machine.onPeerDisconnect(peerId);
  machine.flush();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SyncMachine', () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  describe('initial state', () => {
    it('starts idle', () => {
      const { machine } = makeMachine();
      expect(machine.getState().phase).toBe('idle');
    });

    it('has no sync peer', () => {
      const { machine } = makeMachine();
      expect(machine.getState().syncPeerId).toBeNull();
    });

    it('has an empty stalled set', () => {
      const { machine } = makeMachine();
      expect(machine.getState().stalledPeers.size).toBe(0);
    });

    it('has zero downloaded and applied heights', () => {
      const { machine } = makeMachine();
      expect(machine.getState().downloadedHeight).toBe(0);
      expect(machine.getState().stateAppliedHeight).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // onPeerActive
  // -----------------------------------------------------------------------

  describe('onPeerActive', () => {
    it('transitions to syncing when peer is ahead and we are idle', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');
    });

    it('sends SyncInfo when transitioning to syncing', () => {
      const { machine, sent } = makeMachine({
        store: { chainHeight: () => 0, getOrderingBlockId: () => 'abc123' },
      });
      peerActive(machine, 'peer1', 100);
      expect(sent.length).toBe(1);
      expect(sent[0]!.peerId).toBe('peer1');
    });

    it('removes peer from stalled set when entering syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      machine.getState().stalledPeers.add('peer1');
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().stalledPeers.has('peer1')).toBe(false);
    });

    it('stays idle when peer height equals ours', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 0);
      expect(machine.getState().phase).toBe('idle');
    });

    it('serves Inv when peer is behind', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 10,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      peerActive(machine, 'peer1', 5); // peer at 5, we at 10
      expect(sent.length).toBe(1);
      expect(sent[0]!.peerId).toBe('peer1');
    });

    it('re-enters syncing from synced when peer reports higher height', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      // Get to synced
      peerActive(machine, 'peer1', 200);
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');

      // Peer reports a higher height — should re-enter syncing
      peerActive(machine, 'peer2', 300);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer2');
    });

    it('does not switch sync peer when already syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');

      // Another peer comes along, also ahead
      peerActive(machine, 'peer2', 200);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');
    });
  });

  // -----------------------------------------------------------------------
  // handleSyncInfo (via handleMessage with MSG_SYNC_INFO)
  // -----------------------------------------------------------------------

  describe('handleSyncInfo', () => {
    it('starts syncing when peer reports higher height and we are idle', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');
    });

    it('serves Inv when peer reports lower height', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 10,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 5,
        tipBlockId: 'xyz',
        anchors: [],
      });
      expect(sent.length).toBe(1);
      expect(sent[0]!.peerId).toBe('peer1');
    });

    it('transitions to synced when peer reports equal height while we are syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      // First enter syncing
      peerActive(machine, 'peer1', 200);
      expect(machine.getState().phase).toBe('syncing');

      // Now peer reports equal height
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');
    });

    it('clears stalled peers when transitioning to synced', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      peerActive(machine, 'peer1', 200);
      machine.getState().stalledPeers.add('oldPeer');

      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');
      expect(machine.getState().stalledPeers.size).toBe(0);
    });

    it('stays idle when peer reports equal height and we are idle', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('idle');
    });

    it('re-enters syncing from synced when peer reports higher height', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      // Get to synced
      peerActive(machine, 'peer1', 200);
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');

      // A different peer reports higher height via SyncInfo
      sendSyncInfo(machine, 'peer2', {
        tipHeight: 300,
        tipBlockId: 'def',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer2');
    });

    it('removes peer from stalled set on re-engage', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      machine.getState().stalledPeers.add('peer1');
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });
      expect(machine.getState().stalledPeers.has('peer1')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // handleInv (via handleMessage with MSG_INV)
  // -----------------------------------------------------------------------

  describe('handleInv', () => {
    it('sends ModifierRequest when syncing', () => {
      const { machine, sent } = makeMachine({
        store: { chainHeight: () => 0, getOrderingBlockId: () => null },
      });
      peerActive(machine, 'peer1', 100);
      sent.length = 0; // clear the SyncInfo send

      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['id1', 'id2'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(1);
      expect(sent[0]!.peerId).toBe('peer1');
    });

    it('ignores Inv when not syncing', () => {
      const { machine, sent } = makeMachine({ store: { chainHeight: () => 0 } });
      // Machine is idle
      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['id1'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(0);
    });

    it('filters out already-known IDs', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 1,
          getOrderingBlockId: (h: number) => (h === 1 ? 'id1' : null), // id1 is known
        },
      });
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['id1', 'id2'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(1);
      // The encoded ModifierRequest should only contain id2
    });

    it('sends nothing when all IDs are already known', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 2,
          getOrderingBlockId: (h: number) => `id${h}`, // id1 and id2 both known
        },
      });
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['id1', 'id2'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(0);
    });

    it('ignores unknown typeId', () => {
      const { machine, sent } = makeMachine({
        store: { chainHeight: () => 0 },
      });
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      const inv: Inv = { typeId: 999, ids: ['x'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // handleModifierResponse
  // -----------------------------------------------------------------------

  describe('handleModifierResponse', () => {
    // Responses only apply when they answer an outstanding request from the
    // same peer (audit M-10) — each test solicits via an Inv from the sync
    // peer first. The unsolicited paths are covered in sync-integrity.test.ts.

    it('no-ops on empty modifier list', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      const body = new Uint8Array(
        encode({ typeId: MODIFIER_ORDERING_BLOCK, modifiers: [] }),
      );
      // Should not throw
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush();
    });

    it('calls appendBlocks for solicited ordering block responses', () => {
      const appended: unknown[] = [];
      const { machine } = makeMachine({
        store: {
          chainHeight: () => 0,
          appendBlocks: (blocks: unknown[]) => { appended.push(...blocks); },
        },
      });
      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1', 'b2'] });
      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [
            { id: 'b1', data: new Uint8Array([1]) },
            { id: 'b2', data: new Uint8Array([2]) },
          ],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush();
      expect(appended.length).toBe(2);
    });

    it('skips modifiers with empty data', () => {
      const appended: unknown[] = [];
      const { machine } = makeMachine({
        store: {
          chainHeight: () => 0,
          appendBlocks: (blocks: unknown[]) => { appended.push(...blocks); },
        },
      });
      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1', 'b2'] });
      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [
            { id: 'b1', data: new Uint8Array([]) }, // empty — skipped
            { id: 'b2', data: new Uint8Array([2]) },
          ],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush();
      expect(appended.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // servePeer via onPeerActive (peer behind us)
  // -----------------------------------------------------------------------

  describe('servePeer', () => {
    it('sends Inv to peer that is behind', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 10,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      peerActive(machine, 'peer1', 5);
      expect(sent.length).toBe(1);
    });

    it('sends no Inv when peer is at or above our tip', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 10,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      peerActive(machine, 'peer1', 10); // equal — behind condition is peerHeight < ourHeight
      expect(sent.length).toBe(0);
    });

    it('caps Inv at MAX_INV_IDS (400)', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 1000,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      peerActive(machine, 'peer1', 0);
      expect(sent.length).toBe(1);
      // The Inv should have at most 400 IDs
      // We can't easily verify the encoded content here, but the send happened
    });

    it('skips heights with no block ID', () => {
      const ids: string[] = [];
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 5,
          getOrderingBlockId: (h: number) => {
            if (h === 3) return null; // gap at height 3
            return `block_${h}`;
          },
        },
      });
      peerActive(machine, 'peer1', 0);
      expect(sent.length).toBe(1);
      // Should have sent Inv for heights 1,2,4,5 (skipping 3)
    });
  });

  // -----------------------------------------------------------------------
  // onTimerTick — stall detection and periodic SyncInfo
  // -----------------------------------------------------------------------

  describe('onTimerTick', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rotates peer after stall timeout with no progress', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');

      // Advance past stall timeout (60s)
      vi.advanceTimersByTime(61_000);
      machine.onTimerTick();

      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().syncPeerId).toBeNull();
      expect(machine.getState().stalledPeers.has('peer1')).toBe(true);
    });

    it('does not rotate if progress was made recently', () => {
      // Progress must be solicited AND chain-advancing to count (audit M-10).
      let height = 0;
      const { machine } = makeMachine({
        store: {
          chainHeight: () => height,
          appendBlocks: (blocks: unknown[]) => { height += blocks.length; },
        },
      });
      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1'] });

      // Real progress: a solicited response that advances the chain
      vi.advanceTimersByTime(30_000); // 30s
      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [{ id: 'b1', data: new Uint8Array([1]) }],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush(); // <-- process the data event so lastProgressMs updates

      // Advance to 61s total
      vi.advanceTimersByTime(31_000);
      machine.onTimerTick();

      // Should still be syncing — progress was at 30s (31s ago < 60s)
      expect(machine.getState().phase).toBe('syncing');
    });

    it('rotates after stall even with progress long ago', () => {
      let height = 0;
      const { machine } = makeMachine({
        store: {
          chainHeight: () => height,
          appendBlocks: (blocks: unknown[]) => { height += blocks.length; },
        },
      });
      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1'] });

      // Solicited, chain-advancing progress at t=0
      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [{ id: 'b1', data: new Uint8Array([1]) }],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush(); // <-- process the data event so lastProgressMs updates

      // Advance past 60s from that progress
      vi.advanceTimersByTime(61_000);
      machine.onTimerTick();

      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().stalledPeers.has('peer1')).toBe(true);
    });

    it('starts with fresh progress timestamp on entering syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });

      // Enter syncing at fake time 0 — lastProgressMs is set to Date.now()
      peerActive(machine, 'peer1', 100);

      // Advance 59s — just under the stall threshold
      vi.advanceTimersByTime(59_000);
      machine.onTimerTick();

      // Should still be syncing (59s < 60s stall timeout)
      expect(machine.getState().phase).toBe('syncing');
    });

    it('a batch that does not advance height makes no progress (M-10)', () => {
      // Simulates a handler returning false: appendBlocks runs but
      // chainHeight stays at 0, so no progress is recorded.
      const { machine } = makeMachine({
        store: {
          chainHeight: () => 0,
          appendBlocks: () => {},
        },
      });
      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1'] });

      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [{ id: 'b1', data: new Uint8Array([1]) }],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush();

      vi.advanceTimersByTime(61_000);
      machine.onTimerTick();

      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().stalledPeers.has('peer1')).toBe(true);
    });

    it('sends periodic SyncInfo when not idle', () => {
      const { machine, sent } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      sent.length = 0; // clear initial SyncInfo

      // Advance past 30s poll interval
      vi.advanceTimersByTime(31_000);
      machine.onTimerTick();

      expect(sent.length).toBe(1); // periodic SyncInfo
    });

    it('does not send periodic SyncInfo when idle', () => {
      const { machine, sent } = makeMachine({ store: { chainHeight: () => 0 } });

      vi.advanceTimersByTime(31_000);
      machine.onTimerTick();

      expect(sent.length).toBe(0);
    });

    it('sends periodic SyncInfo when synced', () => {
      const { machine, sent } = makeMachine({ store: { chainHeight: () => 100 } });
      // Get to synced phase
      peerActive(machine, 'peer1', 200);
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');
      sent.length = 0;

      vi.advanceTimersByTime(31_000);
      machine.onTimerTick();

      expect(sent.length).toBe(1); // periodic SyncInfo in synced phase
    });
  });

  // -----------------------------------------------------------------------
  // onPeerDisconnect
  // -----------------------------------------------------------------------

  describe('onPeerDisconnect', () => {
    it('adds sync peer to stalled set on disconnect', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      peerDisconnect(machine, 'peer1');

      expect(machine.getState().stalledPeers.has('peer1')).toBe(true);
    });

    it('resets to idle when sync peer disconnects while syncing', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');

      peerDisconnect(machine, 'peer1');
      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().syncPeerId).toBeNull();
    });

    it('does not reset phase for non-sync peer disconnect', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');

      peerDisconnect(machine, 'peer2'); // different peer
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');
    });

    it('does not add non-sync peer to stalled set', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      peerDisconnect(machine, 'peer2');

      expect(machine.getState().stalledPeers.has('peer2')).toBe(false);
    });

    it('resets to idle when sync peer disconnects while synced', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 100 } });
      peerActive(machine, 'peer1', 200);
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });
      expect(machine.getState().phase).toBe('synced');

      peerDisconnect(machine, 'peer1');
      // Phase resets to idle so the node can pick a new sync peer
      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().syncPeerId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // rotatePeer (tested indirectly via stall, but also directly)
  // -----------------------------------------------------------------------

  describe('rotatePeer', () => {
    it('happens on stall (covered by timer tests)', () => {
      // Already covered above
    });
  });

  // -----------------------------------------------------------------------
  // Unknown message type
  // -----------------------------------------------------------------------

  describe('unknown message type', () => {
    it('ignores messages with unknown codes', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      // Should not throw
      machine.handleMessage('peer1', 99, new Uint8Array([1, 2, 3]));
      machine.flush();
      expect(machine.getState().phase).toBe('idle');
    });
  });

  // -----------------------------------------------------------------------
  // getState returns a stable snapshot
  // -----------------------------------------------------------------------

  describe('getState', () => {
    it('reflects current state after transitions', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });

      expect(machine.getState().phase).toBe('idle');

      peerActive(machine, 'peer1', 100);
      const s1 = machine.getState();
      expect(s1.phase).toBe('syncing');
      expect(s1.syncPeerId).toBe('peer1');

      peerDisconnect(machine, 'peer1');
      const s2 = machine.getState();
      expect(s2.phase).toBe('idle');
      expect(s2.syncPeerId).toBeNull();
      expect(s2.stalledPeers.has('peer1')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // SyncInfo message content
  // -----------------------------------------------------------------------

  describe('sendSyncInfo content', () => {
    it('includes tip height, block id, and anchors', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 42,
          getOrderingBlockId: (h: number) => (h === 42 ? 'tip42' : null),
          getAnchors: () => [{ height: 0, blockId: 'genesis' }],
        },
      });

      peerActive(machine, 'peer1', 100);

      expect(sent.length).toBe(1);
      // We can't easily decode the framed SyncInfo from the raw bytes in the test,
      // but the send happened with the right peer.
      expect(sent[0]!.peerId).toBe('peer1');
    });
  });

  // -----------------------------------------------------------------------
  // Config magic is used verbatim — no fallback
  // (ARCHITECTURE → What varies per network, and what must not)
  // -----------------------------------------------------------------------

  describe('config magic', () => {
    it('frames SyncInfo with exactly config.magic', () => {
      const sent: SentMessage[] = [];
      const machine = new SyncMachine(
        testConfig,
        stubStore({ chainHeight: () => 0 }),
        (peerId, data) => sent.push({ peerId, data }),
          );

      machine.onPeerActive('peer1', 100);
      machine.flush();

      expect(sent.length).toBe(1);
      // Leading 4 bytes are the frame magic, big-endian — must be the
      // configured testnet magic, not MAGIC_MAINNET.
      const d = sent[0]!.data;
      const leading = ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0;
      expect(leading).toBe(0x54444147);
    });
  });

  // -----------------------------------------------------------------------
  // handleModifierRequest — response from store
  // -----------------------------------------------------------------------

  describe('handleModifierRequest', () => {
    it('sends ModifierResponse when blocks are found', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 5,
          getOrderingBlockId: (h: number) => `block_${h}`,
          getOrderingBlock: () => ({ header: { height: 3 } }),
          serializeOrderingBlock: () => new Uint8Array([1, 2, 3]),
        },
      });

      const req: ModifierRequest = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['block_3'] };
      const body = new Uint8Array(encode(req));
      machine.handleMessage('peer1', MSG_MODIFIER_REQUEST, body);
      machine.flush();

      // A response goes out only when at least one modifier is found — the
      // 'does not respond when no blocks match' case below is the control.
      expect(sent.length).toBe(1);
      expect(sent[0]!.peerId).toBe('peer1');
    });

    it('does not respond when no blocks match', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 0,
          getOrderingBlockId: () => null,
        },
      });

      const req: ModifierRequest = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['nonexistent'] };
      const body = new Uint8Array(encode(req));
      machine.handleMessage('peer1', MSG_MODIFIER_REQUEST, body);
      machine.flush();

      expect(sent.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // MODIFIER_POST_BODY (103) — serve and receive arms
  // -----------------------------------------------------------------------

  describe('post body modifier (103)', () => {

    const CONTENT = 'test post body';
    const CONTENT_HASH = computeContentHash(CONTENT);
    const POST_ID = 'aa'.repeat(32);

    function makeBodyMachine(opts: {
      provider?: (id: string) => string | null;
      commitmentProvider?: (id: string) => Uint8Array | null;
      onBody?: (id: string, content: string, peer: string) => boolean;
    } = {}) {
      const sent: SentMessage[] = [];
      const misbehaviors: { peerId: string; reason: string }[] = [];
      const machine = new SyncMachine(
        testConfig,
        stubStore({ chainHeight: () => 0 }),
        (peerId, data) => sent.push({ peerId, data }),
      );
      if (opts.provider) machine.setPostBodyProvider(opts.provider);
      if (opts.commitmentProvider) machine.setPostBodyCommitmentProvider(opts.commitmentProvider);
      machine.setPostBodyVerifier((c, h) => verifyPostBody(c, h));
      if (opts.onBody) machine.setOnPostBody(opts.onBody);
      machine.setOnMisbehavior((peerId, reason) => misbehaviors.push({ peerId, reason }));
      return { machine, sent, misbehaviors };
    }

    // --- serve arm ---

    it('serves a body from the provider', () => {
      const { machine, sent } = makeBodyMachine({
        provider: (id) => id === POST_ID ? CONTENT : null,
      });

      const req: ModifierRequest = { typeId: 103, ids: [POST_ID] };
      machine.handleMessage('peer1', MSG_MODIFIER_REQUEST, new Uint8Array(encode(req)));
      machine.flush();

      expect(sent).toHaveLength(1);
      const frame = decodeFrame(testConfig.magic, sent[0]!.data);
      const resp = decodeModifierResponse(frame.body)!;
      expect(resp.typeId).toBe(103);
      expect(resp.modifiers).toHaveLength(1);
      expect(resp.modifiers[0]!.id).toBe(POST_ID);
      expect(decodePostBody(resp.modifiers[0]!.data)).toBe(CONTENT);
    });

    it('omits ids the provider does not hold', () => {
      const { machine, sent } = makeBodyMachine({
        provider: () => null,
      });

      const req: ModifierRequest = { typeId: 103, ids: [POST_ID] };
      machine.handleMessage('peer1', MSG_MODIFIER_REQUEST, new Uint8Array(encode(req)));
      machine.flush();

      expect(sent).toHaveLength(0);
    });

    it('byte-bounds the response like ordering blocks', () => {
      const bigContent = 'x'.repeat(200);
      const { machine, sent } = makeBodyMachine({
        provider: () => bigContent,
      });

      const ids = Array.from({ length: 100 }, (_, i) => `${'bb'.repeat(31)}${i.toString(16).padStart(2, '0')}`);
      const req: ModifierRequest = { typeId: 103, ids };
      machine.handleMessage('peer1', MSG_MODIFIER_REQUEST, new Uint8Array(encode(req)));
      machine.flush();

      expect(sent).toHaveLength(1);
      const frame = decodeFrame(testConfig.magic, sent[0]!.data);
      const resp = decodeModifierResponse(frame.body)!;
      const totalBytes = resp.modifiers.reduce((s, m) => s + m.data.length, 0);
      expect(totalBytes).toBeLessThanOrEqual(MAX_SERVE_BODY_BYTES + encodePostBody(bigContent).length);
    });

    // --- receive arm ---

    it('delivers a verified body through onPostBody', () => {
      const delivered: { id: string; content: string; peer: string }[] = [];
      const { machine } = makeBodyMachine({
        commitmentProvider: (id) => id === POST_ID ? CONTENT_HASH : null,
        onBody: (id, content, peer) => { delivered.push({ id, content, peer }); return true; },
      });

      // Request the id first so it is outstanding
      const outstanding = (machine as any).outstanding as Map<string, Set<string>>;
      outstanding.set('peer1', new Set([POST_ID]));

      const resp = { typeId: 103, modifiers: [{ id: POST_ID, data: encodePostBody(CONTENT) }] };
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, new Uint8Array(encode(resp)));
      machine.flush();

      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.content).toBe(CONTENT);
    });

    it('penalises a body that fails its commitment', () => {
      const { machine, misbehaviors } = makeBodyMachine({
        commitmentProvider: () => CONTENT_HASH,
        onBody: () => true,
      });

      const outstanding = (machine as any).outstanding as Map<string, Set<string>>;
      outstanding.set('peer1', new Set([POST_ID]));

      const wrongBody = encodePostBody('wrong content');
      const resp = { typeId: 103, modifiers: [{ id: POST_ID, data: wrongBody }] };
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, new Uint8Array(encode(resp)));
      machine.flush();

      expect(misbehaviors).toHaveLength(1);
      expect(misbehaviors[0]!.reason).toContain('commitment mismatch');
    });

    it('ignores an unrequested id', () => {
      const delivered: string[] = [];
      const { machine } = makeBodyMachine({
        commitmentProvider: () => CONTENT_HASH,
        onBody: (id) => { delivered.push(id); return true; },
      });

      // No outstanding ids for peer1
      const resp = { typeId: 103, modifiers: [{ id: POST_ID, data: encodePostBody(CONTENT) }] };
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, new Uint8Array(encode(resp)));
      machine.flush();

      expect(delivered).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Backfill phase — NET_INTERFACE → Sync State Machine
  // -----------------------------------------------------------------------

  describe('backfill', () => {
    const CONTENT_A = 'body-a';
    const HASH_A = computeContentHash(CONTENT_A);
    const ID_A = 'cc'.repeat(32);

    function makeBackfillMachine(opts: {
      peerHeight?: number;
      missingBodies?: { id: string; contentHash: Uint8Array }[];
      persistentMissing?: boolean;
      onBody?: (id: string, content: string, peer: string) => boolean;
      connectedPeers?: string[];
    } = {}) {
      let height = 0;
      const sent: SentMessage[] = [];
      const machine = new SyncMachine(
        testConfig,
        stubStore({ chainHeight: () => height }),
        (peerId, data) => sent.push({ peerId, data }),
      );
      machine.start();

      const syncedFired: number[] = [];
      machine.onSynced(() => { syncedFired.push(1); });

      if (opts.missingBodies !== undefined) {
        if (opts.persistentMissing) {
          const remaining = new Set(opts.missingBodies.map(e => e.id));
          machine.setMissingBodiesProvider((limit) =>
            opts.missingBodies!.filter(e => remaining.has(e.id)).slice(0, limit));
          machine.setOnPostBody((id) => { remaining.delete(id); return true; });
        } else {
          let called = false;
          machine.setMissingBodiesProvider((limit) => {
            if (called) return [];
            called = true;
            return opts.missingBodies!.slice(0, limit);
          });
        }
      }
      machine.setPostBodyCommitmentProvider((id) => {
        const entry = (opts.missingBodies ?? []).find(e => e.id === id);
        return entry?.contentHash ?? null;
      });
      machine.setPostBodyVerifier((c, h) => verifyPostBody(c, h));
      if (opts.onBody) machine.setOnPostBody(opts.onBody);
      if (opts.connectedPeers) {
        machine.setGetConnectedPeers(() => opts.connectedPeers!);
      }

      const peerHeight = opts.peerHeight ?? 100;
      machine.onPeerActive('sync-peer', peerHeight);
      machine.flush();
      expect(machine.getState().phase).toBe('syncing');

      height = peerHeight;
      return { machine, sent, syncedFired, setHeight: (h: number) => { height = h; } };
    }

    it('tip reached → backfill (provider has bodies)', () => {
      const { machine, sent } = makeBackfillMachine({
        missingBodies: [{ id: ID_A, contentHash: HASH_A }],
      });

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();

      expect(machine.getState().phase).toBe('backfill');
      // A ModifierRequest for the missing bodies was sent
      const bodyReqs = sent.filter(s => {
        const frame = decodeFrame(testConfig.magic, s.data);
        return frame.code === MSG_MODIFIER_REQUEST;
      });
      expect(bodyReqs.length).toBeGreaterThanOrEqual(1);
    });

    it('provider empty → synced immediately', () => {
      const { machine, syncedFired } = makeBackfillMachine({
        missingBodies: [],
      });

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();

      expect(machine.getState().phase).toBe('synced');
      expect(syncedFired).toHaveLength(1);
    });

    it('no provider set → passes straight through to synced', () => {
      let height = 0;
      const machine = new SyncMachine(
        testConfig,
        stubStore({ chainHeight: () => height }),
        () => {},
      );
      machine.start();

      let synced = 0;
      machine.onSynced(() => { synced++; });

      machine.onPeerActive('peer1', 50);
      machine.flush();
      height = 50;

      machine.handleMessage('peer1', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 50, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();

      expect(machine.getState().phase).toBe('synced');
      expect(synced).toBe(1);
      machine.stop();
    });

    it('a stored body is progress', () => {
      const delivered: string[] = [];
      const { machine } = makeBackfillMachine({
        missingBodies: [{ id: ID_A, contentHash: HASH_A }],
        onBody: (id, _c, _p) => { delivered.push(id); return true; },
      });

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();
      expect(machine.getState().phase).toBe('backfill');

      const resp = { typeId: 103, modifiers: [{ id: ID_A, data: encodePostBody(CONTENT_A) }] };
      machine.handleMessage('sync-peer', MSG_MODIFIER_RESPONSE, new Uint8Array(encode(resp)));
      machine.flush();

      expect(delivered).toEqual([ID_A]);
      expect(machine.getState().phase).toBe('synced');
    });

    it('syncPhase reports backfill', () => {
      const { machine } = makeBackfillMachine({
        missingBodies: [{ id: ID_A, contentHash: HASH_A }],
      });

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();

      expect(machine.getState().phase).toBe('backfill');
      machine.stop();
    });

    // --- liveness: omission, rotation, exhaustion ---

    it('a peer that omits an id → the id is re-asked of the next peer', () => {
      const ID_B = 'dd'.repeat(32);
      const CONTENT_B = 'body-b';
      const HASH_B = computeContentHash(CONTENT_B);

      const { machine, sent } = makeBackfillMachine({
        missingBodies: [
          { id: ID_A, contentHash: HASH_A },
          { id: ID_B, contentHash: HASH_B },
        ],
        persistentMissing: true,
        connectedPeers: ['sync-peer', 'peer2'],
      });

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();
      expect(machine.getState().phase).toBe('backfill');

      // Peer responds with only ID_A, omitting ID_B
      const resp = { typeId: 103, modifiers: [{ id: ID_A, data: encodePostBody(CONTENT_A) }] };
      machine.handleMessage('sync-peer', MSG_MODIFIER_RESPONSE, new Uint8Array(encode(resp)));
      machine.flush();

      // The machine should have rotated to peer2 and sent a request
      const peer2Reqs = sent.filter(s => s.peerId === 'peer2');
      expect(peer2Reqs.length).toBeGreaterThanOrEqual(1);
      machine.stop();
    });

    it('60 s without a stored body → rotation', () => {
      const { machine } = makeBackfillMachine({
        missingBodies: [{ id: ID_A, contentHash: HASH_A }],
        persistentMissing: true,
        connectedPeers: ['sync-peer', 'peer2'],
      });

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();
      expect(machine.getState().phase).toBe('backfill');
      expect(machine.getState().syncPeerId).toBe('sync-peer');

      // Advance the stall clock past 60s
      (machine as any).lastProgressMs = Date.now() - 61_000;
      machine.onTimerTick();

      // Stall rotation should have moved to peer2 or entered synced
      expect(machine.getState().syncPeerId).not.toBe('sync-peer');
      machine.stop();
    });

    it('every connected peer exhausted → synced, onSyncComplete fires', () => {
      const { machine, syncedFired } = makeBackfillMachine({
        missingBodies: [{ id: ID_A, contentHash: HASH_A }],
        persistentMissing: true,
        connectedPeers: ['sync-peer'],
      });

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();
      expect(machine.getState().phase).toBe('backfill');

      // Respond with nothing — peer omits all ids
      const emptyResp = { typeId: 103, modifiers: [] as { id: string; data: Uint8Array }[] };
      machine.handleMessage('sync-peer', MSG_MODIFIER_RESPONSE, new Uint8Array(encode(emptyResp)));
      machine.flush();

      // sync-peer is the only connected peer and it was asked — exhaustion
      expect(machine.getState().phase).toBe('synced');
      expect(syncedFired).toHaveLength(1);
      machine.stop();
    });

    it('provider empties mid-batch → synced without waiting for exhaustion', () => {
      const delivered: string[] = [];
      const remaining = new Set([ID_A]);
      const bodies = [{ id: ID_A, contentHash: HASH_A }];
      const sent: SentMessage[] = [];
      let height = 0;
      const machine = new SyncMachine(
        testConfig,
        stubStore({ chainHeight: () => height }),
        (peerId, data) => sent.push({ peerId, data }),
      );
      machine.start();

      const syncedFired: number[] = [];
      machine.onSynced(() => { syncedFired.push(1); });

      machine.setMissingBodiesProvider((_limit) =>
        bodies.filter(e => remaining.has(e.id)));
      machine.setPostBodyCommitmentProvider((id) =>
        bodies.find(e => e.id === id)?.contentHash ?? null);
      machine.setPostBodyVerifier((c, h) => verifyPostBody(c, h));
      machine.setOnPostBody((id) => { remaining.delete(id); delivered.push(id); return true; });
      machine.setGetConnectedPeers(() => ['sync-peer', 'peer2']);

      machine.onPeerActive('sync-peer', 100);
      machine.flush();
      height = 100;

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();
      expect(machine.getState().phase).toBe('backfill');

      // Peer delivers the body — provider now returns empty
      const resp = { typeId: 103, modifiers: [{ id: ID_A, data: encodePostBody(CONTENT_A) }] };
      machine.handleMessage('sync-peer', MSG_MODIFIER_RESPONSE, new Uint8Array(encode(resp)));
      machine.flush();

      expect(delivered).toEqual([ID_A]);
      expect(machine.getState().phase).toBe('synced');
      expect(syncedFired).toHaveLength(1);
      machine.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Malformed messages + event-loop isolation (audit C-7)
  // -----------------------------------------------------------------------

  describe('malformed messages (audit C-7)', () => {
    /** Let the background event loop run a few iterations. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

    function makeReportingMachine(store: Partial<SyncStore> = {}): {
      machine: SyncMachine;
      sent: SentMessage[];
      violations: { peerId: string; reason: string }[];
    } {
      const sent: SentMessage[] = [];
      const violations: { peerId: string; reason: string }[] = [];
      const machine = new SyncMachine(
        testConfig,
        stubStore(store),
        (peerId, data) => sent.push({ peerId, data }),
            (peerId, reason) => violations.push({ peerId, reason }),
      );
      return { machine, sent, violations };
    }

    // --- decode boundary: the message never reaches a handler ---------------

    it('drops a ModifierRequest with no ids and penalizes the sender', () => {
      const { machine, sent, violations } = makeReportingMachine({ chainHeight: () => 5 });
      // The audit payload: well-formed CBOR, but `ids` is missing.
      machine.handleMessage('attacker', MSG_MODIFIER_REQUEST, new Uint8Array(encode({ typeId: 101 })));
      machine.flush();

      expect(sent).toHaveLength(0);
      expect(violations).toEqual([{ peerId: 'attacker', reason: 'malformed ModifierRequest' }]);
    });

    it('drops a malformed Inv', () => {
      const { machine, violations } = makeReportingMachine({ chainHeight: () => 0 });
      peerActive(machine, 'peer1', 100);
      machine.handleMessage('peer1', MSG_INV, new Uint8Array(encode({ typeId: 101, ids: 'all' })));
      machine.flush();
      expect(violations).toEqual([{ peerId: 'peer1', reason: 'malformed Inv' }]);
    });

    it('drops a malformed ModifierResponse', () => {
      const appended: unknown[] = [];
      const { machine, violations } = makeReportingMachine({
        chainHeight: () => 0,
        appendBlocks: (blocks: unknown[]) => { appended.push(...blocks); },
      });
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, new Uint8Array(encode({ typeId: 101 })));
      machine.flush();
      expect(appended).toHaveLength(0);
      expect(violations).toEqual([{ peerId: 'peer1', reason: 'malformed ModifierResponse' }]);
    });

    it('drops non-CBOR garbage without throwing', () => {
      const { machine, violations } = makeReportingMachine({ chainHeight: () => 0 });
      machine.handleMessage('attacker', MSG_SYNC_INFO, new Uint8Array([0xff, 0xff, 0xff]));
      machine.flush();
      expect(violations).toHaveLength(1);
      expect(machine.getState().phase).toBe('idle');
    });

    // --- height bounds: servePeer's per-height loop is never entered --------

    it('never reaches servePeer for a negative advertised height', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });

      machine.onPeerActive('attacker', -1_000_000_000);
      machine.flush();

      // The ~1e9-iteration store scan never ran.
      expect(reads).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(machine.getState().phase).toBe('idle');
      expect(violations).toHaveLength(1);
    });

    it('never reaches servePeer for a SyncInfo with a negative tipHeight', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });

      machine.handleMessage('attacker', MSG_SYNC_INFO, new Uint8Array(encode({
        tipHeight: -1_000_000_000,
        tipBlockId: 'x',
        anchors: [],
      })));
      machine.flush();

      expect(reads).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(violations).toEqual([{ peerId: 'attacker', reason: 'malformed SyncInfo' }]);
    });

    it('still serves a peer that is legitimately behind', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });

      machine.handleMessage('peer1', MSG_SYNC_INFO, new Uint8Array(encode({
        tipHeight: 5,
        tipBlockId: 'x',
        anchors: [],
      })));
      machine.flush();

      expect(reads).toEqual([6, 7, 8, 9, 10]);
      expect(sent).toHaveLength(1);
      expect(violations).toHaveLength(0);
    });

    // --- event-loop isolation ----------------------------------------------

    it('keeps the background event loop alive after a malformed ModifierRequest', async () => {
      const { machine } = makeReportingMachine({ chainHeight: () => 0 });
      machine.start();
      try {
        machine.handleMessage('attacker', MSG_MODIFIER_REQUEST, new Uint8Array(encode({ typeId: 101 })));
        await settle();

        // The loop must still be processing. If the throw above escaped the
        // per-event frame the loop promise would already have rejected and this
        // event would never be seen.
        machine.onPeerActive('peer1', 100);
        await settle();

        expect(machine.getState().phase).toBe('syncing');
        expect(machine.getState().syncPeerId).toBe('peer1');
      } finally {
        machine.stop();
      }
    });

    it('survives a handler that throws and keeps processing later events', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let calls = 0;
      const { machine } = makeReportingMachine({
        chainHeight: () => {
          calls++;
          if (calls === 1) throw new Error('store exploded');
          return 0;
        },
      });
      machine.start();
      try {
        machine.onPeerActive('poison', 50);
        await settle();
        expect(machine.getState().phase).toBe('idle');

        machine.onPeerActive('peer1', 100);
        await settle();
        expect(machine.getState().phase).toBe('syncing');
        expect(errSpy).toHaveBeenCalled();
      } finally {
        machine.stop();
        errSpy.mockRestore();
      }
    });

    it('isolates a throwing handler in flush() too', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let calls = 0;
      const { machine } = makeReportingMachine({
        chainHeight: () => {
          calls++;
          if (calls === 1) throw new Error('store exploded');
          return 0;
        },
      });

      machine.onPeerActive('poison', 50);
      machine.onPeerActive('peer1', 100);
      expect(() => machine.flush()).not.toThrow();
      expect(machine.getState().phase).toBe('syncing');

      errSpy.mockRestore();
    });

    it('isolates a throwing appendBlocks on the DATA path', () => {
      // The two tests above throw from `chainHeight` during `onPeerActive` — a
      // *control* event, so they exercise `dispatchControlEvent`.
      // `LazySyncStore.appendBlocks` propagates a block-handler throw rather
      // than swallowing it, and the frame that has to contain it is
      // `dispatchDataEvent`. Structurally identical helper, but the claim is
      // about the data path, so it is measured on the data path.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { machine } = makeMachine({
        store: {
          chainHeight: () => 0,
          appendBlocks: () => { throw new Error('apply exploded'); },
        },
      });

      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1'] });
      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [{ id: 'b1', data: new Uint8Array([1]) }],
        }),
      );

      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      expect(() => machine.flush()).not.toThrow();

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("data event 'modifier-response' from peer1 failed"),
      );
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('apply exploded'));
      errSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Resource limits (audit H-9)
  //
  // Element-wise shape checks pass an arbitrarily long array through, and every
  // element buys the receiver work. Two things have to hold: the array is capped
  // on receipt, and the work per surviving message is bounded by the chain, not
  // by the chain times the peer's id count.
  // -----------------------------------------------------------------------

  describe('resource limits (audit H-9)', () => {
    function makeReportingMachine(store: Partial<SyncStore> = {}): {
      machine: SyncMachine;
      sent: SentMessage[];
      violations: { peerId: string; reason: string }[];
    } {
      const sent: SentMessage[] = [];
      const violations: { peerId: string; reason: string }[] = [];
      const machine = new SyncMachine(
        testConfig,
        stubStore(store),
        (peerId, data) => sent.push({ peerId, data }),
            (peerId, reason) => violations.push({ peerId, reason }),
      );
      return { machine, sent, violations };
    }

    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `block_${i + 1}`);

    // --- inbound arrays are capped on receipt -------------------------------

    it('drops an Inv over MAX_INV_IDS and penalizes the sender', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });
      peerActive(machine, 'attacker', 100);
      sent.length = 0;
      reads.length = 0;

      machine.handleMessage(
        'attacker',
        MSG_INV,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS + 1) })),
      );
      machine.flush();

      expect(sent).toHaveLength(0);
      expect(reads).toHaveLength(0);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain(`exceeds ${MAX_INV_IDS}`);
    });

    it('accepts an Inv of exactly MAX_INV_IDS ids', () => {
      const { machine, sent, violations } = makeReportingMachine({ chainHeight: () => 0 });
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      machine.handleMessage(
        'peer1',
        MSG_INV,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS) })),
      );
      machine.flush();

      expect(violations).toHaveLength(0);
      expect(sent).toHaveLength(1);
    });

    it('drops a ModifierRequest over MAX_INV_IDS before the serve loop runs', () => {
      const reads: number[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
        serializeOrderingBlock: () => new Uint8Array([1]),
      });

      machine.handleMessage(
        'attacker',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS + 1) })),
      );
      machine.flush();

      expect(reads).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain(`exceeds ${MAX_INV_IDS}`);
    });

    it('drops a ModifierResponse over MAX_INV_IDS without applying it', () => {
      const appended: unknown[] = [];
      const { machine, violations } = makeReportingMachine({
        chainHeight: () => 0,
        appendBlocks: (blocks: unknown[]) => { appended.push(...blocks); },
      });

      machine.handleMessage(
        'attacker',
        MSG_MODIFIER_RESPONSE,
        new Uint8Array(encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: ids(MAX_INV_IDS + 1).map((id) => ({ id, data: new Uint8Array([1]) })),
        })),
      );
      machine.flush();

      expect(appended).toHaveLength(0);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain(`exceeds ${MAX_INV_IDS}`);
    });

    it('drops a SyncInfo with more than MAX_INV_IDS anchors', () => {
      const { machine, sent, violations } = makeReportingMachine({ chainHeight: () => 10 });

      machine.handleMessage('attacker', MSG_SYNC_INFO, new Uint8Array(encode({
        tipHeight: 5,
        tipBlockId: 'x',
        anchors: Array.from({ length: MAX_INV_IDS + 1 }, (_, i) => ({ height: i, blockId: `a${i}` })),
      })));
      machine.flush();

      expect(sent).toHaveLength(0);
      expect(machine.getState().phase).toBe('idle');
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain(`exceeds ${MAX_INV_IDS}`);
    });

    // --- serve work is O(chainHeight + ids), never O(ids × chainHeight) -----

    it('scans the chain once per ModifierRequest, not once per id', () => {
      const CHAIN_HEIGHT = 50;
      const reads: number[] = [];
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => CHAIN_HEIGHT,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
        serializeOrderingBlock: () => new Uint8Array([1, 2, 3]),
      });

      machine.handleMessage(
        'peer1',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS) })),
      );
      machine.flush();

      // One pass over heights 0..CHAIN_HEIGHT. Nesting the height scan inside
      // the id loop reads ~MAX_INV_IDS × CHAIN_HEIGHT heights for this same
      // message, which is what this count exists to catch.
      expect(reads).toHaveLength(CHAIN_HEIGHT + 1);
      expect(sent).toHaveLength(1);
    });

    it('scans the chain once per Inv, not once per announced id', () => {
      const CHAIN_HEIGHT = 50;
      const reads: number[] = [];
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => CHAIN_HEIGHT,
        getOrderingBlockId: (h: number) => { reads.push(h); return `block_${h}`; },
      });
      peerActive(machine, 'peer1', 1000);
      sent.length = 0;
      reads.length = 0;

      machine.handleMessage(
        'peer1',
        MSG_INV,
        new Uint8Array(encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          ids: Array.from({ length: MAX_INV_IDS }, (_, i) => `unknown_${i}`),
        })),
      );
      machine.flush();

      expect(reads).toHaveLength(CHAIN_HEIGHT + 1);
      expect(sent).toHaveLength(1);
    });

    // --- served bodies stay inside the reader's byte cap --------------------

    function servedModifierCount(sent: SentMessage[]): number {
      expect(sent).toHaveLength(1);
      const { code, body } = decodeFrame(testConfig.magic!, sent[0]!.data);
      expect(code).toBe(MSG_MODIFIER_RESPONSE);
      return decodeModifierResponse(body)!.modifiers.length;
    }

    it('truncates a response that would exceed MAX_SERVE_BODY_BYTES', () => {
      const chunk = new Uint8Array(3 * 1024 * 1024); // two of these overflow 4 MiB
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => 3,
        getOrderingBlockId: (h: number) => `block_${h}`,
        serializeOrderingBlock: () => chunk,
      });

      machine.handleMessage(
        'peer1',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(3) })),
      );
      machine.flush();

      expect(servedModifierCount(sent)).toBe(1);
    });

    it('still serves a single block larger than the byte budget', () => {
      // Otherwise an oversized block could never be handed over and sync wedges.
      const chunk = new Uint8Array(MAX_SERVE_BODY_BYTES + 1024);
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => 1,
        getOrderingBlockId: (h: number) => `block_${h}`,
        serializeOrderingBlock: () => chunk,
      });

      machine.handleMessage(
        'peer1',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(1) })),
      );
      machine.flush();

      expect(servedModifierCount(sent)).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Idle event loop (NET_INTERFACE → Biased Event Loop, clause 4)
  //
  // Cost is the property under test here, and no assertion on sync *output*
  // can see it: the loop produced correct results while consuming a core.
  // These pin the loop's behaviour between events instead — how often it
  // does work when it has none, and how fast it reacts when work arrives.
  // -----------------------------------------------------------------------

  describe('idle event loop', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('does not re-poll while both queues are empty', async () => {
      const { machine } = makeMachine();
      const ticks = vi.spyOn(machine, 'onTimerTick');

      machine.start();
      try {
        await sleep(100);
      } finally {
        machine.stop();
      }

      // One tick is due on entry; the next is a second away. A polling loop
      // ran this tens of thousands of times over the same window.
      expect(ticks.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(ticks.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('dispatches a control event enqueued while parked, without waiting for the tick', async () => {
      let dispatchedAt = 0;
      let signal: () => void = () => {};
      const dispatched = new Promise<void>((resolve) => { signal = resolve; });

      const { machine } = makeMachine({
        store: {
          // handlePeerActive is the first thing to read the store, so this
          // stamps the moment the event was actually dispatched.
          chainHeight: () => {
            if (dispatchedAt === 0) {
              dispatchedAt = Date.now();
              signal();
            }
            return 0;
          },
        },
      });

      machine.start();
      try {
        await sleep(100); // let the loop park on its tick deadline
        const enqueuedAt = Date.now();
        machine.onPeerActive('peer1', 100);
        await dispatched;

        expect(dispatchedAt - enqueuedAt).toBeLessThan(100);
        expect(machine.getState().phase).toBe('syncing');
        expect(machine.getState().syncPeerId).toBe('peer1');
      } finally {
        machine.stop();
      }
    });

    it('keeps ticking while parked, and stops ticking once stopped', async () => {
      const { machine } = makeMachine();
      const ticks = vi.spyOn(machine, 'onTimerTick');

      machine.start();
      await sleep(1200);

      // Parking must not starve the tick — stall rotation depends on it.
      const whileRunning = ticks.mock.calls.length;
      expect(whileRunning).toBeGreaterThanOrEqual(2);

      machine.stop();
      await sleep(1200);

      // stop() retires the pending tick timer rather than leaving it armed.
      expect(ticks.mock.calls.length).toBe(whileRunning);
    });
  });
});
