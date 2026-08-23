/**
 * The whole-bit expansion `2^(256 − n) − 1` rendered by byte fill, sharing no
 * arithmetic with `orderingPowTarget`'s fixed-point path.
 * VALIDATION_INTERFACE → orderingPowTarget.
 */
export function wholeBitTarget(n: number): Uint8Array | null {
  if (!Number.isSafeInteger(n) || n < 0 || n > 256) return null;
  const target = new Uint8Array(32);
  const zeroBytes = n >> 3;
  const remainderBits = n & 7;
  if (remainderBits !== 0) target[zeroBytes] = 0xff >> remainderBits;
  for (let i = zeroBytes + (remainderBits !== 0 ? 1 : 0); i < 32; i++) target[i] = 0xff;
  return target;
}
