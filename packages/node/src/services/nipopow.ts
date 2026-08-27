import type { BlockHeader } from '@dagsocial/types';
import type { PoPowHeader, PopowHeaderReader } from '@dagsocial/nipopow';
import { guardStoreRead } from './corrupt-state.js';

// NODE_INTERFACE → Nipopow reader
export interface PopowReaderDeps {
  getPopowHeaderByHash(hash: string): PoPowHeader | null;
  getPopowHeaderAtHeight(height: number): PoPowHeader | null;
  getLastHeaders(n: number): BlockHeader[];
  getHeadersAfter(height: number, n: number): BlockHeader[];
  getCurrentHeight(): number;
}

export function createPopowHeaderReader(deps: PopowReaderDeps): PopowHeaderReader {
  return {
    chainHeight: deps.getCurrentHeight,
    popowHeaderByHash: guardStoreRead(deps.getPopowHeaderByHash),
    popowHeaderAtHeight: guardStoreRead(deps.getPopowHeaderAtHeight),
    lastHeaders: guardStoreRead(deps.getLastHeaders),
    headersAfter: guardStoreRead(deps.getHeadersAfter),
  };
}
