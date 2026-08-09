/**
 * The probe struct — a local test struct that exercises every row of the
 * Primitives table at once, and every step of the boundary check.
 *
 * It is deliberately **not** a production struct. Phase 1b ships the codec
 * layer ahead of the structs that will use it (Phases 2–5), so the harness
 * needs something to be a struct *for* — and a synthetic one is better than an
 * early half-migrated `Post`, because it can carry a field of every kind
 * without committing to any layout that is still main's to specify.
 *
 * Phases 2–5 replace this as the primary subject: they register their real
 * struct codecs the same way (`registerStruct`) and add `<struct>.json` beside
 * `probe.json`. The probe stays as the harness's own regression test.
 */

import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  type StructCodec,
  readArr,
  readBool,
  readBytesN,
  readHexN,
  readLp,
  readLpUtf8,
  readOpt,
  readVlqS,
  readVlqU,
  readVlqU64,
  writeArr,
  writeBool,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeOpt,
  writeVlqS,
  writeVlqU,
  writeVlqU64OrThrow,
} from '../../src/codec.js';
import { TRIGGER, hex, registerStruct, type ValueCodec } from './harness.js';

export interface Probe {
  version: number;
  id: string;
  refs: string[];
  author: Uint8Array;
  label: string;
  payload: Uint8Array;
  amount: bigint;
  offset: number;
  trigger: 'author' | 'storage_prune';
  extra: number | null;
  flag: boolean;
}

/**
 * The probe's normative layout. Field order **is** the specification — the
 * write and read halves below walk it in the same order, and a reviewer should
 * be able to read them side by side against this table:
 *
 * | # | Field     | Encoding      |
 * |---|-----------|---------------|
 * | 1 | `version` | `vlqU`        |
 * | 2 | `id`      | `b32` (hex)   |
 * | 3 | `refs`    | `arr(b32)`    |
 * | 4 | `author`  | `b32` (bytes) |
 * | 5 | `label`   | `lpUtf8`      |
 * | 6 | `payload` | `lp`          |
 * | 7 | `amount`  | `vlqU` (u64)  |
 * | 8 | `offset`  | `vlqS`        |
 * | 9 | `trigger` | `enum8`       |
 * | 10| `extra`   | `opt(vlqU)`   |
 * | 11| `flag`    | `u8` (bool)   |
 */
export const probeCodec: StructCodec<Probe> = {
  name: 'Probe',

  write(w: ByteWriter, p: Probe): void {
    writeVlqU(w, p.version);
    writeHexNOrThrow(w, p.id, 32);
    writeArr(w, p.refs, (ww, ref) => writeHexNOrThrow(ww, ref, 32));
    writeBytesNOrThrow(w, p.author, 32);
    writeLpUtf8(w, p.label);
    writeLp(w, p.payload);
    writeVlqU64OrThrow(w, p.amount);
    writeVlqS(w, p.offset);
    TRIGGER.write(w, p.trigger);
    writeOpt(w, p.extra, (ww, v) => writeVlqU(ww, v));
    writeBool(w, p.flag);
  },

  read(r: ByteReader): Probe {
    return {
      version: readVlqU(r),
      id: readHexN(r, 32),
      refs: readArr(r, (rr) => readHexN(rr, 32)),
      author: readBytesN(r, 32),
      label: readLpUtf8(r),
      payload: readLp(r),
      amount: readVlqU64(r),
      offset: readVlqS(r),
      trigger: TRIGGER.read(r),
      extra: readOpt(r, (rr) => readVlqU(rr)),
      flag: readBool(r),
    };
  },
};

/** JSON form → `Probe`. Byte fields arrive as hex, `amount` as a decimal string. */
const probeValueCodec: ValueCodec<Probe> = {
  parse(json: unknown): Probe {
    const j = json as Record<string, unknown>;
    return {
      version: j.version as number,
      id: j.id as string,
      refs: j.refs as string[],
      author: hex(j.author as string),
      label: j.label as string,
      payload: hex(j.payload as string),
      amount: BigInt(j.amount as string),
      offset: j.offset as number,
      trigger: j.trigger as Probe['trigger'],
      extra: (j.extra ?? null) as number | null,
      flag: j.flag as boolean,
    };
  },
  write: probeCodec.write,
  read: probeCodec.read,
};

registerStruct('probe', probeValueCodec);
