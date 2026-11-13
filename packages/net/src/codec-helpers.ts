// Shared read helpers for stream and handshake codecs — the two paths each
// package reads bounded strings and capability lists through. Browser-safe
// by construction: `@dagsocial/types` and the two guard constants are the
// only imports. The sync and handshake codecs import these here rather than
// across one another, because each of those modules has its own set of
// Node-bound neighbors it keeps apart from `./browser`.
import { decodeStruct, readVlqU, ReaderError } from '@dagsocial/types';
import type { ByteReader, StructCodec } from '@dagsocial/types';
import {
  isBoundedInt,
  MAX_CAPABILITY_CODE,
  MAX_CAPABILITY_ENTRIES,
} from './msg-guards.js';

/**
 * TYPES_INTERFACE → The boundary check → "Callers convert `ReaderError` into
 * a verdict" — discharged in the shape net's boundary uses: decoders return
 * `null` instead of throwing, and the caller decides what a `null` means for
 * the peer that sent it.
 */
export function tryDecodeStruct<T>(codec: StructCodec<T>, bytes: Uint8Array): T | null {
  try {
    return decodeStruct(codec, bytes);
  } catch {
    return null;
  }
}

export function readBoundedLpUtf8(r: ByteReader, maxBytes: number, name: string): string {
  const len = readVlqU(r);
  if (len > maxBytes) {
    throw new ReaderError(`${name}: ${len} bytes exceeds ${maxBytes}`, 'out-of-domain');
  }
  const bytes = r.readBytes(len);
  let str: string;
  try {
    str = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReaderError(`${name}: invalid UTF-8`, 'out-of-domain');
  }
  return str;
}

export function readBoundedCapabilities(r: ByteReader, name: string): number[] {
  const count = readVlqU(r);
  if (count > MAX_CAPABILITY_ENTRIES) {
    throw new ReaderError(`${name}: ${count} capabilities exceeds ${MAX_CAPABILITY_ENTRIES}`, 'array-too-large');
  }
  const caps: number[] = [];
  for (let i = 0; i < count; i++) {
    const c = readVlqU(r);
    if (!isBoundedInt(c, MAX_CAPABILITY_CODE)) {
      throw new ReaderError(`${name}: capability ${c} out of domain`, 'out-of-domain');
    }
    caps.push(c);
  }
  return caps;
}
