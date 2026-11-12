// NET_INTERFACE → ModifierRequest, NET_INTERFACE → ModifierResponse —
// the struct codecs for the two modifier messages. Browser-safe: imports
// `@dagsocial/types`, `./msg-guards.js` and `./sync-types.js` alone. The
// frame wrappers that glue the codecs to `./frame.js`
// (`encodeModifierRequest`, `decodeModifierRequest` and the response
// pair) live in `./sync-codec.js`, which re-exports the codecs so
// `@dagsocial/net`'s barrel keeps exporting them.

import {
  ReaderError,
  readHexN,
  readU8,
  readVlqU,
  writeArr,
  writeHexNOrThrow,
  writeLp,
  writeU8OrThrow,
} from '@dagsocial/types';
import type { StructCodec } from '@dagsocial/types';
import { MAX_ORDERING_BLOCK_BYTES } from '@dagsocial/types';
import { MAX_INV_IDS } from './msg-guards.js';
import type { ModifierResponse } from './sync-types.js';

// ---------------------------------------------------------------------------
// ModifierRequest (4) — NET_INTERFACE → ModifierRequest
//
// u8(typeId) ‖ arr( hexN(id, 32) )
//
// typeId is u8 — the byte is the domain; unknown values decode and are dropped
// by the handler (node.ts filters ModifierRequest by typeId before dispatch).
// 1–MAX_INV_IDS ids; empty is malformed (nonEmpty — no honest sender requests
// nothing).
// ---------------------------------------------------------------------------

export const modifierRequestCodec: StructCodec<{ typeId: number; ids: string[] }> = {
  name: 'modifierRequest',
  write(w, msg) {
    writeU8OrThrow(w, msg.typeId);
    writeArr(w, msg.ids, (iw, id) => writeHexNOrThrow(iw, id, 32));
  },
  read(r) {
    const typeId = readU8(r);
    const count = readVlqU(r);
    if (count < 1) {
      throw new ReaderError('modifierRequest: empty id list', 'out-of-domain');
    }
    if (count > MAX_INV_IDS) {
      throw new ReaderError(
        `modifierRequest: ${count} ids exceeds ${MAX_INV_IDS}`,
        'array-too-large',
      );
    }
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(readHexN(r, 32));
    return { typeId, ids };
  },
};

// ---------------------------------------------------------------------------
// ModifierResponse (5) — NET_INTERFACE → ModifierResponse
//
// u8(typeId) ‖ arr( hexN(id, 32) ‖ lp(data) )
//
// 1–MAX_INV_IDS modifiers; empty is malformed — a peer with none of the
// requested modifiers answers zero bytes, never an empty list.
// ---------------------------------------------------------------------------

export const modifierResponseCodec: StructCodec<ModifierResponse> = {
  name: 'modifierResponse',
  write(w, msg) {
    writeU8OrThrow(w, msg.typeId);
    writeArr(w, msg.modifiers, (mw, m) => {
      writeHexNOrThrow(mw, m.id, 32);
      writeLp(mw, m.data);
    });
  },
  read(r) {
    const typeId = readU8(r);
    const count = readVlqU(r);
    if (count < 1) {
      throw new ReaderError('modifierResponse: empty modifier list', 'out-of-domain');
    }
    if (count > MAX_INV_IDS) {
      throw new ReaderError(
        `modifierResponse: ${count} modifiers exceeds ${MAX_INV_IDS}`,
        'array-too-large',
      );
    }
    const modifiers: { id: string; data: Uint8Array }[] = [];
    for (let i = 0; i < count; i++) {
      const id = readHexN(r, 32);
      // NET_INTERFACE → Validation (and untrusted-input safety) →
      // "A peer's bytes are weighed before they are decoded"
      const dataLen = readVlqU(r);
      if (dataLen > MAX_ORDERING_BLOCK_BYTES) {
        throw new ReaderError(
          `modifierResponse: data ${dataLen} bytes exceeds MAX_ORDERING_BLOCK_BYTES (${MAX_ORDERING_BLOCK_BYTES})`,
          'out-of-domain',
        );
      }
      modifiers.push({ id, data: new Uint8Array(r.readBytes(dataLen)) });
    }
    return { typeId, modifiers };
  },
};

