// The binding-check harness (WEB_INTERFACE → The client's builds substitute
// nothing). run.mjs builds this entry through the SAME plugin the app build
// uses, then evaluates the bundle in headless Chromium and calls
// __contentHashHex over live node posts — the proof that the bundle's hashing
// is the node's; under Node the real crypto is present, so no committed unit
// test can prove it.
import { computeContentHash } from '@dagsocial/types';

function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function contentHashHex(content: string): string {
  return toHex(computeContentHash(content));
}

(globalThis as Record<string, unknown>)['__contentHashHex'] = contentHashHex;
