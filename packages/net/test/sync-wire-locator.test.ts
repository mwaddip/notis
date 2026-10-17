import { describe, it, expect } from 'vitest';
import {
  ByteWriter,
  GENESIS_PREV_BLOCK_HASH,
  encodeStruct,
  writeHexNOrThrow,
  writeVlqU,
} from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';
import {
  decodeFrame,
  encodeFrame,
  decodeGetBlocks,
  decodeGetHeaders,
  decodeSyncInfo,
  syncInfoCodec,
  SyncMachine,
} from '@dagsocial/net';
import { holdsPageShape } from '../src/sync.js';
import {
  MSG_GET_BLOCKS,
  MSG_GET_HEADERS,
  MSG_SYNC_INFO,
} from '../src/types.js';
import type { SyncStore } from '../src/sync-machine.js';
import type { NetConfig } from '../src/types.js';
import type { SyncInfo } from '../src/sync-types.js';

// ---------------------------------------------------------------------------
// NET_INTERFACE → SyncInfo: `vlqU(tipHeight) ‖ hexN(tipHash, 32)`; a node with
// no blocks sends `0` and `GENESIS_PREV_BLOCK_HASH`.
// NET_INTERFACE → `GetHeaders` / `GetBlocks` responses:
// `GetHeaders (14): arr( hexN(hash, 32) )`, 1–`MAX_LOCATOR_HASHES`;
// `GetBlocks  (16): arr( hexN(id,   32) )`, 1–`MAX_CHAIN_RESPONSE_ITEMS`;
// each count refused before the first element, an empty list malformed.
// ---------------------------------------------------------------------------

const MAGIC = 0x54444147;

const H32_ZERO = '00'.repeat(32);
const H32_A = 'aa'.repeat(32);
const H32_B = 'bb'.repeat(32);
const H32_C = 'cc'.repeat(32);

function stubStore(overrides: Partial<SyncStore> = {}): SyncStore {
  return {
    getOrderingBlockId: () => null,
    heightByBlockId: () => null,
    chainHeight: () => 0,
    appendBlocks: () => {},
    ...overrides,
  };
}

const machineConfig: NetConfig = {
  magic: MAGIC,
  protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
  orderingBlockPowTargetFloorBits: 2304,
  bootstrapPeers: [],
  listenAddrs: '',
  maxPeers: 10,
  minPeers: 3,
  peerDbCap: 100,
  outboundRedialCooldownMs: 60_000,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3_600_000,
  penaltySafeIntervalMs: 120_000,
  syncRequestTimeoutMs: 10_000,
};

interface SentMessage {
  peerId: string;
  data: Uint8Array;
}

function makeMachine(store: Partial<SyncStore> = {}): {
  machine: SyncMachine;
  sent: SentMessage[];
} {
  const sent: SentMessage[] = [];
  const machine = new SyncMachine(
    machineConfig,
    stubStore(store),
    (peerId, data) => sent.push({ peerId, data }),
  );
  return { machine, sent };
}

/** The SyncInfo body of the one frame the machine sent, decoded by the current decoder. */
function syncInfoSent(sent: SentMessage[]): SyncInfo {
  const found = sent.find((m) => decodeFrame(MAGIC, m.data).code === MSG_SYNC_INFO);
  expect(found).toBeDefined();
  const body = decodeFrame(MAGIC, found!.data).body;
  const decoded = decodeSyncInfo(body);
  expect(decoded).not.toBeNull();
  return decoded!;
}

/** The raw body of the one SyncInfo frame the machine sent — raw bytes. */
function syncInfoBodyBytes(sent: SentMessage[]): Uint8Array {
  const found = sent.find((m) => decodeFrame(MAGIC, m.data).code === MSG_SYNC_INFO);
  expect(found).toBeDefined();
  return decodeFrame(MAGIC, found!.data).body;
}

/** Hand-written body: `vlqU(count) ‖ hexN(hash, 32)*count`. */
function hashListBody(hashes: string[]): Uint8Array {
  const w = new ByteWriter();
  writeVlqU(w, hashes.length);
  for (const h of hashes) writeHexNOrThrow(w, h, 32);
  return w.toBytes();
}

// ---------------------------------------------------------------------------
// SyncInfo — a claim carries its tip's id
// ---------------------------------------------------------------------------

describe('SyncInfo carries the tip hash as well as the height', () => {
  it('a claim at height h carries the id provider\'s hash', () => {
    const { machine, sent } = makeMachine({
      chainHeight: () => 42,
      getOrderingBlockId: (h) => (h === 42 ? H32_A : null),
    });

    machine.onPeerActive('peer1', 100);
    machine.flush();

    const decoded = syncInfoSent(sent);
    expect(decoded.tipHeight).toBe(42);
    expect(decoded!.tipHash).toBe(H32_A);
  });

  it('a claim at height 0 with the id provider unset carries GENESIS_PREV_BLOCK_HASH', () => {
    const { machine, sent } = makeMachine({
      chainHeight: () => 0,
      getOrderingBlockId: () => null,
    });

    machine.onPeerActive('peer1', 5);
    machine.flush();

    const decoded = syncInfoSent(sent);
    expect(decoded.tipHeight).toBe(0);
    expect(decoded!.tipHash).toBe(GENESIS_PREV_BLOCK_HASH);
  });

  it('the sent SyncInfo body is 33 bytes at height 0 — one vlqU plus the 32-byte hash', () => {
    const { machine, sent } = makeMachine({
      chainHeight: () => 0,
      getOrderingBlockId: () => null,
    });

    machine.onPeerActive('peer1', 5);
    machine.flush();

    const body = syncInfoBodyBytes(sent);
    const expected = new Uint8Array(33);
    expected[0] = 0x00;
    // the remaining 32 bytes are already zero — GENESIS_PREV_BLOCK_HASH
    expect(body).toEqual(expected);
  });

  it('a well-formed body (vlqU(h) ‖ 32 bytes) decodes to a tipHeight and a tipHash', () => {
    const w = new ByteWriter();
    writeVlqU(w, 7);
    writeHexNOrThrow(w, H32_B, 32);

    const decoded = decodeSyncInfo(w.toBytes());
    expect(decoded).not.toBeNull();
    expect(decoded!.tipHeight).toBe(7);
    expect(decoded!.tipHash).toBe(H32_B);
  });

  it('an upper-case hex hash is refused at encode', () => {
    // The write-side rule — `writeHexNOrThrow`'s `hexToBytesExact` reads only
    // `[0-9a-f]`. A caller handing uppercase hex to the encoder throws rather
    // than writing a second spelling of one id onto the wire.
    expect(() =>
      encodeStruct(syncInfoCodec, {
        tipHeight: 1,
        tipHash: 'A'.repeat(64),
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// GetHeaders by locator — `arr( hexN(hash, 32) )`, 1–MAX_LOCATOR_HASHES
// ---------------------------------------------------------------------------

describe('GetHeaders carries a locator', () => {
  it('a 1-entry locator decodes to a locator array', () => {
    const body = hashListBody([H32_A]);
    const decoded = decodeGetHeaders(body);
    expect(decoded).not.toBeNull();
    expect(decoded!.locator).toEqual([H32_A]);
  });

  it('a 3-entry locator decodes in order', () => {
    const body = hashListBody([H32_A, H32_B, H32_C]);
    const decoded = decodeGetHeaders(body);
    expect(decoded).not.toBeNull();
    expect(decoded!.locator).toEqual([H32_A, H32_B, H32_C]);
  });

  it('refuses an empty locator before the first element', () => {
    // A `vlqU(0)` body is "no entries"; an honest sender asks for nothing with
    // no bytes at all. The decoder refuses this on both the old shape and the
    // new one, so this case stands as a plain `it` from the start.
    const w = new ByteWriter();
    writeVlqU(w, 0);
    expect(decodeGetHeaders(w.toBytes())).toBeNull();
  });

  it('refuses a 29-entry locator (one past MAX_LOCATOR_HASHES = 28)', () => {
    // The two shapes decode this body alike — the old one as a trailing-bytes
    // mismatch (29 extra bytes after the two VLQ fields), the new one as the
    // 29 ids past the locator cap. Both answer null, so this stands as a plain
    // `it` from the start.
    const hashes: string[] = [];
    for (let i = 0; i < 29; i++) hashes.push(H32_ZERO);
    const body = hashListBody(hashes);
    expect(decodeGetHeaders(body)).toBeNull();
  });

  it('a 28-entry locator decodes', () => {
    const hashes: string[] = [];
    for (let i = 0; i < 28; i++) hashes.push(H32_ZERO);
    const body = hashListBody(hashes);
    const decoded = decodeGetHeaders(body);
    expect(decoded).not.toBeNull();
    expect(decoded!.locator).toHaveLength(28);
  });
});

// ---------------------------------------------------------------------------
// GetBlocks by id — `arr( hexN(id, 32) )`, 1–MAX_CHAIN_RESPONSE_ITEMS
// ---------------------------------------------------------------------------

describe('GetBlocks carries ids', () => {
  it('a 1-id body decodes to an ids array', () => {
    const body = hashListBody([H32_A]);
    const decoded = decodeGetBlocks(body);
    expect(decoded).not.toBeNull();
    expect(decoded!.ids).toEqual([H32_A]);
  });

  it('a 3-id body decodes in order', () => {
    const body = hashListBody([H32_A, H32_B, H32_C]);
    const decoded = decodeGetBlocks(body);
    expect(decoded).not.toBeNull();
    expect(decoded!.ids).toEqual([H32_A, H32_B, H32_C]);
  });

  it('refuses an empty id list before the first element', () => {
    const w = new ByteWriter();
    writeVlqU(w, 0);
    expect(decodeGetBlocks(w.toBytes())).toBeNull();
  });

  it('refuses a 401-id body (one past MAX_CHAIN_RESPONSE_ITEMS = 400)', () => {
    // Both shapes refuse — the old one as trailing bytes past the two VLQ
    // fields, the new one as the count past the response cap.
    const hashes: string[] = [];
    for (let i = 0; i < 401; i++) hashes.push(H32_ZERO);
    const body = hashListBody(hashes);
    expect(decodeGetBlocks(body)).toBeNull();
  });

  it('a 400-id body decodes', () => {
    const hashes: string[] = [];
    for (let i = 0; i < 400; i++) hashes.push(H32_ZERO);
    const body = hashListBody(hashes);
    const decoded = decodeGetBlocks(body);
    expect(decoded).not.toBeNull();
    expect(decoded!.ids).toHaveLength(400);
  });
});

// ---------------------------------------------------------------------------
// A frame carrying the request is identified by its code pair; the body is the
// same `arr( hexN )` for either query. The code is what tells them apart.
// ---------------------------------------------------------------------------

describe('request bodies share one layout, the frame code discriminates', () => {
  it('a GetHeaders body decodes under decodeGetBlocks', () => {
    const body = hashListBody([H32_A, H32_B]);
    const asHeaders = decodeGetHeaders(body);
    const asBlocks = decodeGetBlocks(body);
    expect(asHeaders).not.toBeNull();
    expect(asBlocks).not.toBeNull();
    expect(asHeaders!.locator)
      .toEqual(asBlocks!.ids);
  });

  it('a GetHeaders frame carries code 14 over a locator body', () => {
    const frame = encodeFrame(MAGIC, MSG_GET_HEADERS, hashListBody([H32_A]));
    const decoded = decodeFrame(MAGIC, frame);
    expect(decoded.code).toBe(MSG_GET_HEADERS);
    const req = decodeGetHeaders(decoded.body);
    expect(req).not.toBeNull();
    expect(req!.locator).toEqual([H32_A]);
  });

  it('a GetBlocks frame carries code 16 over an ids body', () => {
    const frame = encodeFrame(MAGIC, MSG_GET_BLOCKS, hashListBody([H32_A]));
    const decoded = decodeFrame(MAGIC, frame);
    expect(decoded.code).toBe(MSG_GET_BLOCKS);
    const req = decodeGetBlocks(decoded.body);
    expect(req).not.toBeNull();
    expect(req!.ids).toEqual([H32_A]);
  });
});

// ---------------------------------------------------------------------------
// `holdsPageShape` — NET_INTERFACE → `GetHeaders` / `GetBlocks` responses →
// "A `Headers` page has one shape, and a requester holds a page to it":
// heights consecutive and ascending; the first header's parent a locator
// hash or — at height 1 — `GENESIS_PREV_BLOCK_HASH`.
// ---------------------------------------------------------------------------

function fakeHeader(height: number, prev: string): BlockHeader {
  return {
    protocolVersion: 1,
    height,
    prevBlockHash: prev,
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: height,
    powTargetBits: 2304,
    createdAt: 1_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
}

describe('holdsPageShape — the page a requester holds to its locator', () => {
  it('empty page passes', () => {
    expect(holdsPageShape([], [H32_A])).toBe(true);
  });

  it('consecutive ascending heights with the first parent in the locator pass', () => {
    const page = [
      fakeHeader(5, H32_A),
      fakeHeader(6, '11'.repeat(32)),
      fakeHeader(7, '22'.repeat(32)),
    ];
    expect(holdsPageShape(page, [H32_A, H32_B])).toBe(true);
  });

  it('height 1 with GENESIS_PREV_BLOCK_HASH as its parent passes under any locator', () => {
    const page = [fakeHeader(1, GENESIS_PREV_BLOCK_HASH)];
    expect(holdsPageShape(page, [H32_A])).toBe(true);
  });

  it('a hole in the heights does not', () => {
    const page = [
      fakeHeader(5, H32_A),
      fakeHeader(7, '22'.repeat(32)),
    ];
    expect(holdsPageShape(page, [H32_A])).toBe(false);
  });

  it('a descent does not', () => {
    const page = [
      fakeHeader(5, H32_A),
      fakeHeader(4, '22'.repeat(32)),
    ];
    expect(holdsPageShape(page, [H32_A])).toBe(false);
  });

  it('a repeat does not', () => {
    const page = [
      fakeHeader(5, H32_A),
      fakeHeader(5, '22'.repeat(32)),
    ];
    expect(holdsPageShape(page, [H32_A])).toBe(false);
  });

  it('a first parent not in the locator does not', () => {
    const page = [fakeHeader(5, '22'.repeat(32))];
    expect(holdsPageShape(page, [H32_A, H32_B])).toBe(false);
  });

  it('a first header at height 1 whose parent is not GENESIS_PREV_BLOCK_HASH does not', () => {
    const page = [fakeHeader(1, H32_A)];
    expect(holdsPageShape(page, [H32_A])).toBe(false);
  });
});
