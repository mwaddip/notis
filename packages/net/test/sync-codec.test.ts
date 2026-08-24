import { describe, it, expect } from 'vitest';
import {
  encodeSyncInfo, decodeSyncInfo,
  encodeInv, decodeInv,
  encodeModifierRequest, decodeModifierRequest,
  encodeModifierResponse, decodeModifierResponse,
  syncInfoCodec, invCodec, modifierRequestCodec, modifierResponseCodec,
} from '@dagsocial/net';
import { MAGIC_TESTNET, decodeFrame, MAX_ADVERTISED_HEIGHT, MAX_INV_IDS } from '@dagsocial/net';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE } from '@dagsocial/net';
import { encodeStruct } from '@dagsocial/types';

const H32 = '0'.repeat(64);
const H32_A = 'a'.repeat(64);
const H32_B = 'b'.repeat(64);

describe('sync codec', () => {
  it('round-trips SyncInfo', () => {
    const info = {
      tipHeight: 42,
      tipBlockId: H32,
      anchors: [{ height: 42, blockId: H32_A }],
    };
    const frame = encodeSyncInfo(MAGIC_TESTNET, info);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_SYNC_INFO);
    expect(decodeSyncInfo(b)).toEqual(info);
  });

  it('round-trips SyncInfo with zero anchors (genesis)', () => {
    const info = { tipHeight: 0, tipBlockId: H32, anchors: [] };
    const frame = encodeSyncInfo(MAGIC_TESTNET, info);
    const decoded = decodeSyncInfo(decodeFrame(MAGIC_TESTNET, frame).body);
    expect(decoded).toEqual(info);
  });

  it('round-trips Inv', () => {
    const inv = { typeId: 101, ids: [H32, H32_A, H32_B] };
    const frame = encodeInv(MAGIC_TESTNET, inv);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_INV);
    expect(decodeInv(b)).toEqual(inv);
  });

  it('round-trips ModifierRequest at MAX_INV_IDS', () => {
    const req = { typeId: 101, ids: Array.from({length: MAX_INV_IDS}, () => H32) };
    const frame = encodeModifierRequest(MAGIC_TESTNET, req);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_MODIFIER_REQUEST);
    const decoded = decodeModifierRequest(b);
    expect(decoded!.ids).toHaveLength(MAX_INV_IDS);
  });

  it('round-trips ModifierResponse with binary data', () => {
    const resp = {
      typeId: 101,
      modifiers: [
        { id: H32, data: new Uint8Array([1, 2, 3]) },
        { id: H32_A, data: new Uint8Array([4, 5, 6]) },
      ],
    };
    const frame = encodeModifierResponse(MAGIC_TESTNET, resp);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_MODIFIER_RESPONSE);
    const decoded = decodeModifierResponse(b);
    expect(decoded!.typeId).toBe(101);
    expect(decoded!.modifiers).toHaveLength(2);
    expect(decoded!.modifiers[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('sync codec decode boundary', () => {
  const decoders = {
    decodeSyncInfo,
    decodeInv,
    decodeModifierRequest,
    decodeModifierResponse,
  };

  for (const [name, decodeFn] of Object.entries(decoders)) {
    it(`${name} returns null on truncated bytes`, () => {
      expect(decodeFn(new Uint8Array([]))).toBeNull();
      expect(decodeFn(new Uint8Array([0x01]))).toBeNull();
    });

    it(`${name} returns null on trailing bytes`, () => {
      const valid = validBodyFor(name);
      const withTrailing = new Uint8Array(valid.length + 1);
      withTrailing.set(valid);
      withTrailing[valid.length] = 0x00;
      expect(decodeFn(withTrailing)).toBeNull();
    });

    it(`${name} returns null on non-minimal VLQ (re-encode compare)`, () => {
      const valid = validBodyFor(name);
      // SyncInfo starts with vlqU; Inv/ModReq/ModResp start with u8 + vlqU(count).
      // Expand the first VLQ field to a non-minimal 2-byte encoding (LEB128: add 0x80 continuation).
      const firstVlqOffset = name === 'decodeSyncInfo' ? 0 : 1; // skip u8(typeId)
      const nonMinimal = new Uint8Array(valid.length + 1);
      nonMinimal.set(valid.subarray(0, firstVlqOffset), 0);
      nonMinimal[firstVlqOffset] = valid[firstVlqOffset]! | 0x80;
      nonMinimal[firstVlqOffset + 1] = 0x00;
      nonMinimal.set(valid.subarray(firstVlqOffset + 1), firstVlqOffset + 2);
      expect(decodeFn(nonMinimal)).toBeNull();
    });
  }

  describe('SyncInfo', () => {
    it('accepts a well-formed body', () => {
      const info = { tipHeight: 10, tipBlockId: H32, anchors: [{ height: 5, blockId: H32_A }] };
      expect(decodeSyncInfo(encodeStruct(syncInfoCodec, info))).toEqual(info);
    });

    it('rejects tipHeight above MAX_ADVERTISED_HEIGHT', () => {
      expect(decodeSyncInfo(encodeStruct(syncInfoCodec, {
        tipHeight: MAX_ADVERTISED_HEIGHT + 1,
        tipBlockId: H32,
        anchors: [],
      }))).toBeNull();
    });

    it('rejects an anchor height above MAX_ADVERTISED_HEIGHT', () => {
      expect(decodeSyncInfo(encodeStruct(syncInfoCodec, {
        tipHeight: 10,
        tipBlockId: H32,
        anchors: [{ height: MAX_ADVERTISED_HEIGHT + 1, blockId: H32 }],
      }))).toBeNull();
    });

    it('rejects more than MAX_SYNC_ANCHORS anchors', () => {
      const body = encodeStruct(syncInfoCodec, {
        tipHeight: 10,
        tipBlockId: H32,
        anchors: Array.from({length: 5}, (_, i) => ({ height: i, blockId: H32 })),
      });
      expect(decodeSyncInfo(body)).toBeNull();
    });

    it('accepts exactly 4 anchors (MAX_SYNC_ANCHORS)', () => {
      const info = {
        tipHeight: 10,
        tipBlockId: H32,
        anchors: Array.from({length: 4}, (_, i) => ({ height: i, blockId: H32 })),
      };
      expect(decodeSyncInfo(encodeStruct(syncInfoCodec, info))).toEqual(info);
    });

    it('accepts zero anchors (genesis)', () => {
      const info = { tipHeight: 0, tipBlockId: H32, anchors: [] };
      expect(decodeSyncInfo(encodeStruct(syncInfoCodec, info))).toEqual(info);
    });

    it('rejects wrong-width blockId (31 bytes)', () => {
      const body = encodeStruct(syncInfoCodec, { tipHeight: 10, tipBlockId: H32, anchors: [] });
      const truncated = body.subarray(0, body.length - 1);
      expect(decodeSyncInfo(truncated)).toBeNull();
    });
  });

  describe('Inv / ModifierRequest', () => {
    it('rejects empty id list (nonEmpty)', () => {
      expect(decodeInv(encodeStruct(invCodec, { typeId: 101, ids: [] }))).toBeNull();
      expect(decodeModifierRequest(encodeStruct(modifierRequestCodec, { typeId: 101, ids: [] }))).toBeNull();
    });

    it('rejects over-cap id list', () => {
      const ids = Array.from({length: MAX_INV_IDS + 1}, () => H32);
      expect(decodeInv(encodeStruct(invCodec, { typeId: 101, ids }))).toBeNull();
    });

    it('accepts typeId 0 and 255 (u8 domain)', () => {
      expect(decodeInv(encodeStruct(invCodec, { typeId: 0, ids: [H32] }))).toEqual({ typeId: 0, ids: [H32] });
      expect(decodeInv(encodeStruct(invCodec, { typeId: 255, ids: [H32] }))).toEqual({ typeId: 255, ids: [H32] });
    });

    it('accepts an unknown but bounded typeId', () => {
      const decoded = decodeInv(encodeStruct(invCodec, { typeId: 200, ids: [H32] }));
      expect(decoded).toEqual({ typeId: 200, ids: [H32] });
    });
  });

  describe('ModifierResponse', () => {
    it('rejects empty modifier list (nonEmpty)', () => {
      const body = encodeStruct(modifierResponseCodec, { typeId: 101, modifiers: [] });
      expect(decodeModifierResponse(body)).toBeNull();
    });

    it('rejects over-cap modifier list', () => {
      const modifiers = Array.from({length: MAX_INV_IDS + 1}, () => ({
        id: H32, data: new Uint8Array([1]),
      }));
      expect(decodeModifierResponse(
        encodeStruct(modifierResponseCodec, { typeId: 101, modifiers }),
      )).toBeNull();
    });
  });
});

function validBodyFor(decoderName: string): Uint8Array {
  switch (decoderName) {
    case 'decodeSyncInfo':
      return encodeStruct(syncInfoCodec, { tipHeight: 10, tipBlockId: H32, anchors: [] });
    case 'decodeInv':
      return encodeStruct(invCodec, { typeId: 101, ids: [H32] });
    case 'decodeModifierRequest':
      return encodeStruct(modifierRequestCodec, { typeId: 101, ids: [H32] });
    case 'decodeModifierResponse':
      return encodeStruct(modifierResponseCodec, {
        typeId: 101, modifiers: [{ id: H32, data: new Uint8Array([1]) }],
      });
    default: throw new Error(`unknown decoder: ${decoderName}`);
  }
}
