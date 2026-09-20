// Compare two `manifest.json` texts by their parsed content, since Mozilla's
// signing re-serialises `manifest.json` and the closing newline goes.
// WEB_INTERFACE → "The Firefox build ships signed as well".
//
// Pure ESM, no I/O and no `process`. Errors name their function.

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const ta = typeof a;
  if (ta !== typeof b) return false;
  if (ta !== 'object') return false;
  const aIsArr = Array.isArray(a);
  if (aIsArr !== Array.isArray(b)) return false;
  if (aIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function parseTopObject(text) {
  if (typeof text !== 'string') {
    throw new Error(`sameManifestContent: text is not a string`);
  }
  let val;
  try {
    val = JSON.parse(text);
  } catch {
    throw new Error(`sameManifestContent: text is not JSON`);
  }
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    throw new Error(`sameManifestContent: text is not a JSON object`);
  }
  return val;
}

/** Return `true` when two `manifest.json` texts parse to deeply-equal
 *  objects — object key order irrelevant, arrays compared in order — and
 *  `false` on any content difference (a changed value, an added or removed
 *  key, a reordered array). Whitespace differences and a trailing newline
 *  are not content and return `true`. Throws, naming
 *  `sameManifestContent`, when either text is not a string, is not JSON, or
 *  parses to something other than a JSON object (`null`, an array, or a
 *  primitive). */
export function sameManifestContent(aText, bText) {
  const a = parseTopObject(aText);
  const b = parseTopObject(bText);
  return deepEqual(a, b);
}
