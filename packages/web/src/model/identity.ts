// The identity spine's hue, derived from the author's public key. Carried whole
// from thread-panes §3.2: the arc is 175–345° in OKLCH — what is left once the
// hues that already mean something are excluded (clay ~40° warning, gold ~75°
// credits, green ~135° karma, red banned) — quantised to twelve evenly spaced
// stops rather than sampled anywhere on the arc, because uniform sampling of a
// continuous range clumps. A near-miss sends the reader back to compare; an
// exact repeat reads as "same author", which is why quantising is better than a
// wider space. Do not widen the arc and do not sample continuously.

export const ID_ARC_START = 175;
export const ID_ARC_SPAN = 170;
export const ID_STOPS = 12;

/** FNV-1a over the key hex → one of ID_STOPS evenly spaced stops. */
export function identityStop(keyHex: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < keyHex.length; i++) {
    h ^= keyHex.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % ID_STOPS;
}

export function identityHue(keyHex: string): number {
  return ID_ARC_START + identityStop(keyHex) * (ID_ARC_SPAN / ID_STOPS);
}
