// The binding-check harness (WEB_INTERFACE → The browser reaches @dagsocial/types
// through a build-time shim). run.mjs builds this entry through the SAME crypto
// alias and Buffer inject the app uses, then evaluates the bundle in headless
// Chromium and calls __contentHashHex over live node posts. Reaching
// computeContentHash here means the built bundle's shim actually runs — under
// Node the substitution never happens, so no committed unit test can prove it.
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
