import {
  encodeHeader,
  decodeHeader,
  encodeInterlinks,
  decodeInterlinks,
  encodeStruct,
  decodeStruct,
  writeVlqU,
  readVlqU,
  writeLp,
  readLp,
  writeArr,
  ByteWriter,
  ByteReader,
  ReaderError,
} from '@dagsocial/types';
import type { BlockHeader, StructCodec } from '@dagsocial/types';

// NIPOPOW_INTERFACE → Constants
export const MAX_NIPOPOW_PARAM = 128;
export const MAX_NIPOPOW_PREFIX = 16_384;

export interface PoPowHeader {
  header: BlockHeader;
  interlinks: string[];
}

export interface NipopowProof {
  m: number;
  k: number;
  prefix: PoPowHeader[];
  suffixHead: PoPowHeader;
  suffixTail: BlockHeader[];
}

// NIPOPOW_INTERFACE → PoPowHeader: lp(header) ‖ lp(interlinks)
const POPOW_HEADER: StructCodec<PoPowHeader> = {
  name: 'PoPowHeader',
  write(w: ByteWriter, p: PoPowHeader): void {
    writeLp(w, encodeHeader(p.header));
    writeLp(w, encodeInterlinks(p.interlinks));
  },
  read(r: ByteReader): PoPowHeader {
    const headerBytes = readLp(r);
    const header = decodeHeader(headerBytes);
    const interlinksBytes = readLp(r);
    const interlinks = decodeInterlinks(interlinksBytes);
    return { header, interlinks };
  },
};

function readBoundedVlqU(r: ByteReader, min: number, max: number, label: string): number {
  const v = readVlqU(r);
  if (v < min || v > max) {
    throw new ReaderError(`${label} out of range: ${v}`, 'out-of-domain');
  }
  return v;
}

// NIPOPOW_INTERFACE → NipopowProof:
// vlqU(m) ‖ vlqU(k) ‖ arr(PoPowHeader) ‖ PoPowHeader ‖ arr(lp(header))
const NIPOPOW_PROOF: StructCodec<NipopowProof> = {
  name: 'NipopowProof',
  write(w: ByteWriter, p: NipopowProof): void {
    writeVlqU(w, p.m);
    writeVlqU(w, p.k);
    writeArr(w, p.prefix, (ww, ph) => POPOW_HEADER.write(ww, ph));
    POPOW_HEADER.write(w, p.suffixHead);
    writeArr(w, p.suffixTail, (ww, h) => writeLp(ww, encodeHeader(h)));
  },
  read(r: ByteReader): NipopowProof {
    const m = readBoundedVlqU(r, 1, MAX_NIPOPOW_PARAM, 'm');
    const k = readBoundedVlqU(r, 1, MAX_NIPOPOW_PARAM, 'k');

    // NIPOPOW_INTERFACE → NipopowProof — prefix.length ≤ MAX_NIPOPOW_PREFIX, refused before the first element
    const prefixCount = readVlqU(r);
    if (prefixCount > MAX_NIPOPOW_PREFIX) {
      throw new ReaderError(
        `prefix count ${prefixCount} exceeds MAX_NIPOPOW_PREFIX (${MAX_NIPOPOW_PREFIX})`,
        'out-of-domain',
      );
    }
    const prefix: PoPowHeader[] = [];
    for (let i = 0; i < prefixCount; i++) {
      prefix.push(POPOW_HEADER.read(r));
    }

    const suffixHead = POPOW_HEADER.read(r);

    // NIPOPOW_INTERFACE → NipopowProof — suffixTail.length ≤ k − 1, refused before the first element
    const tailCount = readVlqU(r);
    if (tailCount > k - 1) {
      throw new ReaderError(
        `suffixTail count ${tailCount} exceeds k-1 (${k - 1})`,
        'out-of-domain',
      );
    }
    // interlinks count inside each PoPowHeader is bounded by MAX_INTERLINKS
    // via decodeInterlinks — that codec enforces it
    const suffixTail: BlockHeader[] = [];
    for (let i = 0; i < tailCount; i++) {
      const headerBytes = readLp(r);
      suffixTail.push(decodeHeader(headerBytes));
    }

    return { m, k, prefix, suffixHead, suffixTail };
  },
};

export function encodePoPowHeader(p: PoPowHeader): Uint8Array {
  return encodeStruct(POPOW_HEADER, p);
}

export function decodePoPowHeader(bytes: Uint8Array): PoPowHeader {
  return decodeStruct(POPOW_HEADER, bytes);
}

export function encodeNipopowProof(p: NipopowProof): Uint8Array {
  return encodeStruct(NIPOPOW_PROOF, p);
}

export function decodeNipopowProof(bytes: Uint8Array): NipopowProof {
  return decodeStruct(NIPOPOW_PROOF, bytes);
}
