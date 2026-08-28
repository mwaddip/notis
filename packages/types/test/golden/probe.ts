/**
 * The probe struct — a local test struct that exercises every row of the
 * Primitives table at once, and every step of the boundary check.
 *
 * It is deliberately **not** a production struct. A synthetic one can carry a
 * field of every kind at once without committing to any real layout, so the
 * harness and the boundary check get exercised against something that is not
 * also a consensus preimage — a production struct would tie the harness's
 * coverage to whatever fields that struct happens to have.
 *
 * The production structs are the corpus's primary subject: `structs.ts`
 * registers their codecs the same way (`registerStruct`), and their vectors
 * live in the `.json` files beside `probe.json`. The probe stays as the
 * harness's own regression test.
 */

import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  type StructCodec,
  readArr,
  readBytesN,
  readHexN,
  readLp,
  readLpUtf8,
  readOpt,
  readVlqS,
  readVlqU,
  readVlqU64,
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeOpt,
  writeVlqS,
  writeVlqU,
  writeVlqU64OrThrow,
} from '../../src/codec.js';
import { MINT_REASON, hex, registerStruct, type ValueCodec } from './harness.js';

export interface Probe {
  version: number;
  id: string;
  refs: string[];
  author: Uint8Array;
  label: string;
  payload: Uint8Array;
  amount: bigint;
  offset: number;
  mintReason: 'postlock-unlock' | 'postlock-remainder' | 'genesis' | 'genesis-committee';
  extra: number | null;
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
 * | 9 | `mintReason` | `enum8`    |
 * | 10| `extra`   | `opt(vlqU)`   |
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
    MINT_REASON.write(w, p.mintReason);
    writeOpt(w, p.extra, (ww, v) => writeVlqU(ww, v));
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
      mintReason: MINT_REASON.read(r),
      extra: readOpt(r, (rr) => readVlqU(rr)),
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
      mintReason: j.mintReason as Probe['mintReason'],
      extra: (j.extra ?? null) as number | null,
    };
  },
  write: probeCodec.write,
  read: probeCodec.read,
};

registerStruct('probe', probeValueCodec);
