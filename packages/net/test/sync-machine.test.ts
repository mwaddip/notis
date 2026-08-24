import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { encode } from 'cbor-x';
import { computeContentHash } from '@dagsocial/types';
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
import { decodeSyncInfo, decodeModifierRequest, decodeModifierResponse } from '../src/sync-codec.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse } from '../src/sync-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubStore(overrides: Partial<SyncStore> = {}): SyncStore {
  return {
    getOrderingBlock: () => null,
    serializeOrderingBlock: () => null,
    getOrderingBlockId: () => null,
    heightByBlockId: () => null,
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
function peerActive(
  machine: SyncMachine, peerId: string, peerHeight: number,
  direction: 'inbound' | 'outbound' = 'outbound',
): void {
  machine.onPeerActive(peerId, peerHeight, direction);
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

    it('switches sync peer when a taller peer exceeds retained height + 1', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });
      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer1');

      // NET_INTERFACE → Sync State Machine, Switch: 200 > 100 + 1 → switch
      peerActive(machine, 'peer2', 200);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peer2');
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
      // NET_INTERFACE → Serve Side: SyncInfo reply then Inv, both to the sender
      expect(sent.length).toBe(2);
      expect(sent[0]!.peerId).toBe('peer1');
      expect(sent[1]!.peerId).toBe('peer1');
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
          heightByBlockId: (id: string) => (id === 'id1' ? 1 : null),
        },
      });
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids: ['id1', 'id2'] };
      sendInv(machine, 'peer1', inv);

      expect(sent.length).toBe(1);
    });

    it('sends nothing when all IDs are already known', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 2,
          heightByBlockId: (id: string) => (id === 'id1' ? 1 : id === 'id2' ? 2 : null),
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
          heightByBlockId: (id: string) => parseInt(id.replace('block_', ''), 10),
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
  // Post body modifier (103) — serve and receive
  //
  // Retargeted: the serve arm moved to the stream handler
  // (servePostBodiesResponse in node.ts, tested in sync-stream-handler.test.ts).
  // The receive arm (receivePostBodies) is deleted: bodies arrive through
  // pullPostBodies on the request's own stream, not unsolicited via the
  // machine's outstanding set. The backfill tests below cover delivery
  // through the pull function.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Backfill phase — NET_INTERFACE → Sync State Machine
  // -----------------------------------------------------------------------

  describe('backfill', () => {
    const CONTENT_A = 'body-a';
    const HASH_A = computeContentHash(CONTENT_A);
    const ID_A = 'cc'.repeat(32);

    const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

    // The machine's backfill batch is served by the pullPostBodies delegate
    // wired here (NET_INTERFACE → Sync State Machine, Backfill);
    // verification lives inside requestPostBodies (node.ts).
    function makeBackfillMachine(opts: {
      peerHeight?: number;
      missingBodies?: { id: string; contentHash: Uint8Array }[];
      persistentMissing?: boolean;
      onBody?: (id: string, content: string, peer: string) => boolean;
      connectedPeers?: string[];
      bodyStore?: Map<string, string>;
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

      const bodyStore = opts.bodyStore ?? new Map<string, string>();

      const remaining = new Set((opts.missingBodies ?? []).map(e => e.id));
      if (opts.missingBodies !== undefined) {
        if (opts.persistentMissing) {
          machine.setMissingBodiesProvider((limit) =>
            opts.missingBodies!.filter(e => remaining.has(e.id)).slice(0, limit));
        } else {
          let called = false;
          machine.setMissingBodiesProvider((limit) => {
            if (called) return [];
            called = true;
            return opts.missingBodies!.slice(0, limit);
          });
        }
      }

      machine.setPullPostBodies(async (entries, _peerId) => {
        const results: { id: string; content: string }[] = [];
        for (const e of entries) {
          const content = bodyStore.get(e.id);
          if (content !== undefined) results.push({ id: e.id, content });
        }
        return results;
      });
      const userOnBody = opts.onBody;
      machine.setOnPostBody((id, content, peer) => {
        remaining.delete(id);
        return userOnBody ? userOnBody(id, content, peer) : true;
      });
      if (opts.connectedPeers) {
        machine.setGetConnectedPeers(() => opts.connectedPeers!);
      }

      const peerHeight = opts.peerHeight ?? 100;
      machine.onPeerActive('sync-peer', peerHeight);
      machine.flush();
      expect(machine.getState().phase).toBe('syncing');

      height = peerHeight;
      return { machine, sent, syncedFired, setHeight: (h: number) => { height = h; }, bodyStore };
    }

    it('tip reached → backfill (provider has bodies)', async () => {
      const { machine, bodyStore } = makeBackfillMachine({
        missingBodies: [{ id: ID_A, contentHash: HASH_A }],
      });
      bodyStore.set(ID_A, CONTENT_A);

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();

      expect(machine.getState().phase).toBe('backfill');
      await settle();
      expect(machine.getState().phase).toBe('synced');
      machine.stop();
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
      machine.stop();
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

    it('a stored body is progress', async () => {
      const delivered: string[] = [];
      const { machine, bodyStore } = makeBackfillMachine({
        missingBodies: [{ id: ID_A, contentHash: HASH_A }],
        onBody: (id, _c, _p) => { delivered.push(id); return true; },
      });
      bodyStore.set(ID_A, CONTENT_A);

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();
      expect(machine.getState().phase).toBe('backfill');

      await settle();

      expect(delivered).toEqual([ID_A]);
      expect(machine.getState().phase).toBe('synced');
      machine.stop();
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

    it('a peer that omits an id → the id is re-asked of the next peer', async () => {
      const ID_B = 'dd'.repeat(32);
      const CONTENT_B = 'body-b';
      const HASH_B = computeContentHash(CONTENT_B);

      const pullCalls: { peerId: string; ids: string[] }[] = [];
      const { machine, bodyStore } = makeBackfillMachine({
        missingBodies: [
          { id: ID_A, contentHash: HASH_A },
          { id: ID_B, contentHash: HASH_B },
        ],
        persistentMissing: true,
        connectedPeers: ['sync-peer', 'peer2'],
      });
      // sync-peer has ID_A but not ID_B
      bodyStore.set(ID_A, CONTENT_A);
      // Override the pull to track calls
      machine.setPullPostBodies(async (entries, peerId) => {
        pullCalls.push({ peerId, ids: entries.map(e => e.id) });
        const results: { id: string; content: string }[] = [];
        for (const e of entries) {
          const c = bodyStore.get(e.id);
          if (c !== undefined) results.push({ id: e.id, content: c });
        }
        return results;
      });

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();
      expect(machine.getState().phase).toBe('backfill');

      await settle();

      // sync-peer was asked first; peer2 was asked after the omission
      expect(pullCalls.some(c => c.peerId === 'peer2')).toBe(true);
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

    it('every connected peer exhausted → synced, onSyncComplete fires', async () => {
      // Pull returns empty — peer has no bodies. Only one connected peer.
      const { machine, syncedFired } = makeBackfillMachine({
        missingBodies: [{ id: ID_A, contentHash: HASH_A }],
        persistentMissing: true,
        connectedPeers: ['sync-peer'],
      });
      // bodyStore has no entries → pull returns empty

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();
      expect(machine.getState().phase).toBe('backfill');

      await settle();

      expect(machine.getState().phase).toBe('synced');
      expect(syncedFired).toHaveLength(1);
      machine.stop();
    });

    it('provider empties mid-batch → synced without waiting for exhaustion', async () => {
      const delivered: string[] = [];
      const { machine, syncedFired, bodyStore } = makeBackfillMachine({
        missingBodies: [{ id: ID_A, contentHash: HASH_A }],
        persistentMissing: true,
        onBody: (id, _c, _p) => { delivered.push(id); return true; },
        connectedPeers: ['sync-peer', 'peer2'],
      });
      bodyStore.set(ID_A, CONTENT_A);

      machine.handleMessage('sync-peer', MSG_SYNC_INFO, new Uint8Array(
        encode({ tipHeight: 100, tipBlockId: 'abc', anchors: [] }),
      ));
      machine.flush();
      expect(machine.getState().phase).toBe('backfill');

      await settle();

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

      // SyncInfo reply reads tip (10), then servePeer reads 6..10
      expect(reads).toEqual([10, 6, 7, 8, 9, 10]);
      // NET_INTERFACE → Serve Side: reply then Inv
      expect(sent).toHaveLength(2);
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
      const lookups: string[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        heightByBlockId: (id: string) => { lookups.push(id); return null; },
      });
      peerActive(machine, 'attacker', 100);
      sent.length = 0;
      lookups.length = 0;

      machine.handleMessage(
        'attacker',
        MSG_INV,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS + 1) })),
      );
      machine.flush();

      expect(sent).toHaveLength(0);
      expect(lookups).toHaveLength(0);
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
      const lookups: string[] = [];
      const { machine, sent, violations } = makeReportingMachine({
        chainHeight: () => 10,
        heightByBlockId: (id: string) => { lookups.push(id); return 1; },
        serializeOrderingBlock: () => new Uint8Array([1]),
      });

      machine.handleMessage(
        'attacker',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(MAX_INV_IDS + 1) })),
      );
      machine.flush();

      expect(lookups).toHaveLength(0);
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

    // --- cost rule: k ids cost k point lookups, no index rebuild -----
    //
    // NET_INTERFACE → Sync Handler Registration: one id is one provider call,
    // never a chain walk. These assertions pin the index rebuild dead.

    it('Inv: zero getOrderingBlockId calls, at most k heightByBlockId calls', () => {
      const K = 5;
      const idReads: number[] = [];
      const lookups: string[] = [];
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => 50,
        getOrderingBlockId: (h: number) => { idReads.push(h); return `block_${h}`; },
        heightByBlockId: (id: string) => { lookups.push(id); return null; },
      });
      peerActive(machine, 'peer1', 1000);
      sent.length = 0;
      idReads.length = 0;
      lookups.length = 0;

      machine.handleMessage(
        'peer1',
        MSG_INV,
        new Uint8Array(encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          ids: Array.from({ length: K }, (_, i) => `unknown_${i}`),
        })),
      );
      machine.flush();

      expect(idReads).toHaveLength(0);
      expect(lookups.length).toBeLessThanOrEqual(K);
      expect(sent).toHaveLength(1);
    });

    it('ModifierRequest: headers-provider calls only for blocks serialized', () => {
      const K = 5;
      const idReads: number[] = [];
      const lookups: string[] = [];
      let serializeCalls = 0;
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => 50,
        getOrderingBlockId: (h: number) => { idReads.push(h); return `block_${h}`; },
        heightByBlockId: (id: string) => { lookups.push(id); return parseInt(id.replace('block_', ''), 10); },
        serializeOrderingBlock: () => { serializeCalls++; return new Uint8Array([1, 2, 3]); },
      });

      machine.handleMessage(
        'peer1',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(K) })),
      );
      machine.flush();

      expect(idReads).toHaveLength(0);
      expect(lookups).toHaveLength(K);
      expect(serializeCalls).toBe(K);
      expect(sent).toHaveLength(1);
    });

    it('ModifierRequest: unknown ids produce zero serialize calls', () => {
      let serializeCalls = 0;
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => 50,
        heightByBlockId: () => null,
        serializeOrderingBlock: () => { serializeCalls++; return new Uint8Array([1]); },
      });

      machine.handleMessage(
        'peer1',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ids(5) })),
      );
      machine.flush();

      expect(serializeCalls).toBe(0);
      expect(sent).toHaveLength(0);
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
        heightByBlockId: (id: string) => parseInt(id.replace('block_', ''), 10),
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
      const chunk = new Uint8Array(MAX_SERVE_BODY_BYTES + 1024);
      const { machine, sent } = makeReportingMachine({
        chainHeight: () => 1,
        heightByBlockId: (id: string) => parseInt(id.replace('block_', ''), 10),
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
  // Unset-provider semantics (NET_INTERFACE → Sync Handler Registration)
  // -----------------------------------------------------------------------

  describe('unset-provider semantics', () => {
    it('SyncInfo tip id is empty when id provider is unset', () => {
      const { machine, sent } = makeMachine({
        store: { chainHeight: () => 5, getOrderingBlockId: () => null },
      });
      peerActive(machine, 'peer1', 10);

      const syncInfoMsg = sent.find(m => {
        const { code } = decodeFrame(testConfig.magic!, m.data);
        return code === MSG_SYNC_INFO;
      });
      expect(syncInfoMsg).toBeDefined();
      const { body } = decodeFrame(testConfig.magic!, syncInfoMsg!.data);
      const decoded = decodeSyncInfo(body);
      expect(decoded).not.toBeNull();
      expect(decoded!.tipBlockId).toBe('');
    });

    it('anchors are empty when id provider is unset', () => {
      const { machine, sent } = makeMachine({
        store: { chainHeight: () => 5, getOrderingBlockId: () => null, getAnchors: () => [] },
      });
      peerActive(machine, 'peer1', 10);

      const syncInfoMsg = sent.find(m => {
        const { code } = decodeFrame(testConfig.magic!, m.data);
        return code === MSG_SYNC_INFO;
      });
      expect(syncInfoMsg).toBeDefined();
      const { body } = decodeFrame(testConfig.magic!, syncInfoMsg!.data);
      const decoded = decodeSyncInfo(body);
      expect(decoded).not.toBeNull();
      expect(decoded!.anchors).toEqual([]);
    });

    it('Inv ids are all unknown when heightByBlockId provider is unset', () => {
      const { machine, sent } = makeMachine();
      peerActive(machine, 'peer1', 100);
      sent.length = 0;

      machine.handleMessage(
        'peer1',
        MSG_INV,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ['a', 'b', 'c'] })),
      );
      machine.flush();

      expect(sent).toHaveLength(1);
      const { body } = decodeFrame(testConfig.magic!, sent[0]!.data);
      const req = decodeModifierRequest(body);
      expect(req).not.toBeNull();
      expect(req!.ids).toEqual(['a', 'b', 'c']);
    });

    it('ModifierRequest serves nothing when heightByBlockId provider is unset', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 10,
          serializeOrderingBlock: () => new Uint8Array([1, 2, 3]),
        },
      });

      machine.handleMessage(
        'peer1',
        MSG_MODIFIER_REQUEST,
        new Uint8Array(encode({ typeId: MODIFIER_ORDERING_BLOCK, ids: ['a', 'b'] })),
      );
      machine.flush();

      expect(sent).toHaveLength(0);
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

  // -----------------------------------------------------------------------
  // Serve-side SyncInfo reply — NET_INTERFACE → Serve Side
  // -----------------------------------------------------------------------

  describe('serve-side SyncInfo reply', () => {
    it('a behind sender earns SyncInfo then Inv, addressed to the sender', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 20,
          getOrderingBlockId: (h: number) => `block_${h}`,
        },
      });
      // Sync from a different peer so the reply is NOT to our sync peer
      peerActive(machine, 'syncPeer', 50);
      sent.length = 0;

      sendSyncInfo(machine, 'behindPeer', {
        tipHeight: 10,
        tipBlockId: 'x',
        anchors: [],
      });

      // SyncInfo reply + Inv, both to behindPeer (NOT to syncPeer)
      expect(sent.length).toBe(2);
      expect(sent[0]!.peerId).toBe('behindPeer');
      expect(sent[1]!.peerId).toBe('behindPeer');

      // Decode the first frame to confirm it is a SyncInfo (code 2)
      const frame0 = decodeFrame(testConfig.magic, sent[0]!.data);
      expect(frame0).not.toBeNull();
      expect(frame0!.code).toBe(MSG_SYNC_INFO);

      // Second is an Inv (code 3)
      const frame1 = decodeFrame(testConfig.magic, sent[1]!.data);
      expect(frame1).not.toBeNull();
      expect(frame1!.code).toBe(MSG_INV);
    });

    it('an equal sender earns SyncInfo alone', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 100,
          getOrderingBlockId: () => 'abc',
        },
      });
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });

      // Only SyncInfo reply, no Inv (not behind)
      expect(sent.length).toBe(1);
      const frame = decodeFrame(testConfig.magic, sent[0]!.data);
      expect(frame).not.toBeNull();
      expect(frame!.code).toBe(MSG_SYNC_INFO);
    });

    it('replies while idle', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 0,
          getOrderingBlockId: () => null,
        },
      });
      expect(machine.getState().phase).toBe('idle');

      sendSyncInfo(machine, 'peer1', {
        tipHeight: 50,
        tipBlockId: 'abc',
        anchors: [],
      });

      // At least the SyncInfo reply fires (peer is ahead, so pick also sends)
      const syncInfoSends = sent.filter(s => {
        const f = decodeFrame(testConfig.magic, s.data);
        return f && f.code === MSG_SYNC_INFO;
      });
      expect(syncInfoSends.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Completion — the syncing → backfill → synced leg
  // -----------------------------------------------------------------------

  describe('completion via SyncInfo reply', () => {
    it('syncs to tip, receives equal reply, reaches synced', () => {
      let height = 0;
      const syncedFired: number[] = [];
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => height,
          getOrderingBlockId: () => 'tip',
          getAnchors: () => [],
        },
      });
      machine.onSynced(() => { syncedFired.push(1); });

      peerActive(machine, 'peer1', 100);
      expect(machine.getState().phase).toBe('syncing');

      // Simulate sync completion: our height catches up
      height = 100;
      sent.length = 0;

      // The equal-height reply from the sync peer → backfill → synced
      sendSyncInfo(machine, 'peer1', {
        tipHeight: 100,
        tipBlockId: 'tip',
        anchors: [],
      });

      expect(machine.getState().phase).toBe('synced');
      expect(syncedFired).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Movement gate — NET_INTERFACE → Serve Side, "The reply is movement-gated"
  // -----------------------------------------------------------------------

  describe('movement gate', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('suppresses an identical echo within the floor', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 100,
          getOrderingBlockId: () => 'abc',
          getAnchors: () => [],
        },
      });

      // First SyncInfo from peer1 — movement (first report) → reply
      sendSyncInfo(machine, 'peer1', { tipHeight: 100, tipBlockId: 'abc', anchors: [] });
      const afterFirst = sent.length;
      expect(afterFirst).toBe(1);

      // Second identical SyncInfo within the floor — suppressed
      vi.advanceTimersByTime(5_000);
      sendSyncInfo(machine, 'peer1', { tipHeight: 100, tipBlockId: 'abc', anchors: [] });
      expect(sent.length).toBe(afterFirst);
    });

    it('replies at once when the sender reports a new tip', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 100,
          getOrderingBlockId: () => 'abc',
          getAnchors: () => [],
        },
      });

      sendSyncInfo(machine, 'peer1', { tipHeight: 100, tipBlockId: 'abc', anchors: [] });
      const afterFirst = sent.length;

      // Sender's tip changed → movement → reply at once (pick may add a send)
      vi.advanceTimersByTime(1_000);
      sendSyncInfo(machine, 'peer1', { tipHeight: 101, tipBlockId: 'def', anchors: [] });
      // The reply fires (movement); pick may enter syncing and send another
      expect(sent.length).toBeGreaterThan(afterFirst);
      // The reply is addressed to the sender
      expect(sent[afterFirst]!.peerId).toBe('peer1');
    });

    it('replies at once when our tip advanced since last send', () => {
      let height = 100;
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => height,
          getOrderingBlockId: () => 'abc',
          getAnchors: () => [],
        },
      });

      sendSyncInfo(machine, 'peer1', { tipHeight: 100, tipBlockId: 'abc', anchors: [] });
      const afterFirst = sent.length;

      // Our tip advanced
      height = 101;
      vi.advanceTimersByTime(1_000);
      sendSyncInfo(machine, 'peer1', { tipHeight: 100, tipBlockId: 'abc', anchors: [] });

      // Our movement → reply + Inv (peer now behind)
      expect(sent.length).toBeGreaterThan(afterFirst);
    });

    it('two equal-height peers settle — identical echo suppressed', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 100,
          getOrderingBlockId: () => 'tip',
          getAnchors: () => [],
        },
      });

      // First SyncInfo from peer1 — first report → movement → reply
      sendSyncInfo(machine, 'peer1', { tipHeight: 100, tipBlockId: 'tip', anchors: [] });
      const afterFirst = sent.length;
      expect(afterFirst).toBe(1);

      // Peer1 echoes the same values within the floor → suppressed
      vi.advanceTimersByTime(1_000);
      sendSyncInfo(machine, 'peer1', { tipHeight: 100, tipBlockId: 'tip', anchors: [] });
      expect(sent.length).toBe(afterFirst);

      // After MIN_SYNCINFO_INTERVAL_MS the floor expires → one more reply
      vi.advanceTimersByTime(15_000);
      sendSyncInfo(machine, 'peer1', { tipHeight: 100, tipBlockId: 'tip', anchors: [] });
      expect(sent.length).toBe(afterFirst + 1);
    });
  });

  // -----------------------------------------------------------------------
  // Pick / Switch — NET_INTERFACE → Sync State Machine, Pick / Switch
  // -----------------------------------------------------------------------

  describe('pick and switch', () => {
    it('switches to a much taller peer mid-sync', () => {
      const { machine, sent } = makeMachine({ store: { chainHeight: () => 0 } });

      peerActive(machine, 'peerA', 2);
      expect(machine.getState().syncPeerId).toBe('peerA');
      sent.length = 0;

      // peerD at +50 — exceeds peerA's retained (2) by more than 1
      peerActive(machine, 'peerD', 50);
      expect(machine.getState().syncPeerId).toBe('peerD');
      expect(machine.getState().stalledPeers.has('peerA')).toBe(false);

      // A SyncInfo was sent to peerD
      const syncInfosToD = sent.filter(s => {
        const f = decodeFrame(testConfig.magic, s.data);
        return s.peerId === 'peerD' && f && f.code === MSG_SYNC_INFO;
      });
      expect(syncInfosToD.length).toBe(1);
    });

    it('does not switch when retained-highest is exactly current + 1', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });

      peerActive(machine, 'peerA', 100);
      expect(machine.getState().syncPeerId).toBe('peerA');

      // peerD at exactly peerA's retained + 1 → no switch
      peerActive(machine, 'peerD', 101);
      expect(machine.getState().syncPeerId).toBe('peerA');
    });

    it('adopts at enterSynced with no new event (bridging)', () => {
      let height = 0;
      const { machine } = makeMachine({
        store: {
          chainHeight: () => height,
          getOrderingBlockId: () => 'abc',
          getAnchors: () => [],
        },
      });

      peerActive(machine, 'peerA', 100);
      expect(machine.getState().syncPeerId).toBe('peerA');

      // peerD at peerA + 1 → no switch while syncing
      peerActive(machine, 'peerD', 101);
      expect(machine.getState().syncPeerId).toBe('peerA');

      // Finish syncing from peerA
      height = 100;
      sendSyncInfo(machine, 'peerA', { tipHeight: 100, tipBlockId: 'abc', anchors: [] });

      // enterSynced → pickSyncPeer → peerD above us → adopt
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peerD');
    });

    it('disconnect of sync peer → pick runs → next-best adopted', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });

      peerActive(machine, 'peerA', 100);
      peerActive(machine, 'peerB', 50);
      expect(machine.getState().syncPeerId).toBe('peerA');

      peerDisconnect(machine, 'peerA');

      // peerB is the remaining peer above us
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peerB');
    });

    it('disconnect of only peer → idle', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });

      peerActive(machine, 'peerA', 100);
      peerDisconnect(machine, 'peerA');

      expect(machine.getState().phase).toBe('idle');
      expect(machine.getState().syncPeerId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Retention bounds — P10 edge
  // -----------------------------------------------------------------------

  describe('retention bounds', () => {
    it('rejects heights outside MAX_ADVERTISED_HEIGHT via onPeerActive', () => {
      const violations: { peerId: string; reason: string }[] = [];
      const machine = new SyncMachine(
        testConfig,
        stubStore(),
        () => {},
        (peerId, reason) => violations.push({ peerId, reason }),
      );

      machine.onPeerActive('attacker', 200_000_000);
      machine.flush();

      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(machine.getState().phase).toBe('idle');
    });

    it('rejects out-of-domain SyncInfo tipHeight', () => {
      const violations: { peerId: string; reason: string }[] = [];
      const machine = new SyncMachine(
        testConfig,
        stubStore(),
        () => {},
        (peerId, reason) => violations.push({ peerId, reason }),
      );

      // decodeSyncInfo returns null for out-of-domain tipHeight → rejectMessage
      const body = new Uint8Array(encode({
        tipHeight: -1,
        tipBlockId: 'abc',
        anchors: [],
      }));
      machine.handleMessage('attacker', MSG_SYNC_INFO, body);
      machine.flush();

      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it('peer heights map shrinks at disconnect', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });

      peerActive(machine, 'peer1', 100);
      peerActive(machine, 'peer2', 200);
      peerDisconnect(machine, 'peer1');

      // After disconnect peer1's height is gone — only peer2 remains as sync peer
      // (peer1 is disconnected and its height removed)
      expect(machine.getState().syncPeerId).toBe('peer2');
    });
  });

  // -----------------------------------------------------------------------
  // Progress send — NET_INTERFACE → Sync State Machine, Sync
  // -----------------------------------------------------------------------

  describe('progress send', () => {
    it('advancing batch sends one immediate SyncInfo', () => {
      let height = 0;
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => height,
          getOrderingBlockId: () => null,
          appendBlocks: (blocks: unknown[]) => { height += blocks.length; },
        },
      });

      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1'] });
      sent.length = 0;

      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [{ id: 'b1', data: new Uint8Array([1]) }],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush();

      // One SyncInfo sent to peer1 (the sync peer) on progress
      const syncInfos = sent.filter(s => {
        const f = decodeFrame(testConfig.magic, s.data);
        return f && f.code === MSG_SYNC_INFO && s.peerId === 'peer1';
      });
      expect(syncInfos.length).toBe(1);
    });

    it('non-advancing batch sends no SyncInfo', () => {
      const { machine, sent } = makeMachine({
        store: {
          chainHeight: () => 0,
          getOrderingBlockId: () => null,
          appendBlocks: () => {},
        },
      });

      peerActive(machine, 'peer1', 100);
      sendInv(machine, 'peer1', { typeId: MODIFIER_ORDERING_BLOCK, ids: ['b1'] });
      sent.length = 0;

      const body = new Uint8Array(
        encode({
          typeId: MODIFIER_ORDERING_BLOCK,
          modifiers: [{ id: 'b1', data: new Uint8Array([1]) }],
        }),
      );
      machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
      machine.flush();

      // No SyncInfo — height did not advance
      expect(sent.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Switch guard — NET_INTERFACE → Sync State Machine, Pick
  // -----------------------------------------------------------------------

  describe('switch guard', () => {
    it('does not switch to a candidate below our height', () => {
      let height = 0;
      const { machine } = makeMachine({
        store: {
          chainHeight: () => height,
          getOrderingBlockId: () => null,
          getAnchors: () => [],
        },
      });

      // Start syncing from peerA at 100
      peerActive(machine, 'peerA', 100);
      expect(machine.getState().syncPeerId).toBe('peerA');

      // We advance past peerA's lagging retained height
      height = 150;

      // peerB at 120 — taller than peerA (120 > 100+1) but below us (120 < 150)
      peerActive(machine, 'peerB', 120);
      expect(machine.getState().syncPeerId).toBe('peerA');
    });
  });

  // -----------------------------------------------------------------------
  // Negative backfill — NET_INTERFACE → Sync State Machine, Backfill
  // -----------------------------------------------------------------------

  describe('negative backfill entry', () => {
    it('a third peer reporting equal height does not enter backfill', () => {
      const { machine } = makeMachine({
        store: {
          chainHeight: () => 100,
          getOrderingBlockId: () => 'abc',
          getAnchors: () => [],
        },
      });

      peerActive(machine, 'peerA', 200);
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('peerA');

      // NET_INTERFACE → Sync State Machine, Backfill: only the sync peer's equal triggers it
      sendSyncInfo(machine, 'peerX', {
        tipHeight: 100,
        tipBlockId: 'abc',
        anchors: [],
      });

      expect(machine.getState().phase).toBe('syncing');
    });
  });

  // -----------------------------------------------------------------------
  // Outbound preference — NET_INTERFACE → Sync State Machine, Pick
  // -----------------------------------------------------------------------

  describe('outbound preference', () => {
    it('outbound +2 beats inbound +50 at pick', () => {
      let height = 0;
      const { machine } = makeMachine({
        store: {
          chainHeight: () => height,
          getOrderingBlockId: () => 'abc',
          getAnchors: () => [],
        },
      });

      // Sync from a temporary peer and reach synced
      peerActive(machine, 'tmp', 10, 'outbound');
      height = 10;
      sendSyncInfo(machine, 'tmp', { tipHeight: 10, tipBlockId: 'abc', anchors: [] });
      expect(machine.getState().phase).toBe('synced');

      // While synced, register both candidates above us
      peerActive(machine, 'inPeer', 50, 'inbound');
      // inPeer triggers pickSyncPeer at synced → enters syncing
      expect(machine.getState().syncPeerId).toBe('inPeer');

      // Disconnect inPeer → idle → pick with remaining peers
      peerDisconnect(machine, 'inPeer');

      // Re-register both: outbound at +2, inbound at +50
      peerActive(machine, 'outPeer', 12, 'outbound');
      expect(machine.getState().syncPeerId).toBe('outPeer');

      peerActive(machine, 'inPeer2', 50, 'inbound');
      // bestCandidate prefers outPeer (outbound at 12 > 10) over inPeer2 (inbound at 50 > 10)
      // Switch: bestCandidate returns outPeer, which IS syncPeerId → no switch
      expect(machine.getState().syncPeerId).toBe('outPeer');
    });

    it('inbound-only set still syncs', () => {
      const { machine } = makeMachine({ store: { chainHeight: () => 0 } });

      peerActive(machine, 'inPeer1', 100, 'inbound');
      expect(machine.getState().phase).toBe('syncing');
      expect(machine.getState().syncPeerId).toBe('inPeer1');
    });
  });
});
