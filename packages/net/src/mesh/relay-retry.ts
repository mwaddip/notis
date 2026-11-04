// MESH_INTERFACE → NAT → "A relay that does not answer never stops a
// private node ... is tried again on the node list's retry cadence
// (`RETRY_BASE_MS` doubling to `RETRY_CAP_MS`)". `failures` counts
// failed attempts so far; the schedule is
// `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(failures−1))`. Pure. Zero or
// negative count reads 0.

import { RETRY_BASE_MS, RETRY_CAP_MS } from './constants.js';

export function retryIntervalMs(failures: number, base?: number, cap?: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const b = typeof base === 'number' && base > 0 ? base : RETRY_BASE_MS;
  const c = typeof cap === 'number' && cap > 0 ? cap : RETRY_CAP_MS;
  return Math.min(c, b * Math.pow(2, failures - 1));
}
