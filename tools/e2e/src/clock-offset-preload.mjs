// MINING_INTERFACE → Difficulty Schedule — the block creator stamps a new
// header's `createdAt` with `Math.max(nowMs(), prev.createdAt + 1)`, and `nowMs()`
// in `packages/node/src/services/difficulty.ts` reads `Date.now()`. The schedule
// (ASERT, anchored at block 1) reads header stamps against `t_a = createdAt(1)`,
// so shifting `Date.now()` on the process that stamps block 1 shifts `t_a` by
// the same offset; a subsequent process on the same data directory with no
// shift stamps block 2 at real time, driving Δ positive at admission from
// block 3 onwards and clamping the schedule at the floor.
//
// MINING_INTERFACE → Header timestamp rules — order is strict increase (satisfied,
// since the shifted first stamp is below the next real-time stamp) and the future
// bound caps the future (not touched: a past-stamp block passes it).

const raw = process.env.DAGSOCIAL_E2E_CLOCK_OFFSET_MS;
const offsetMs = Number(raw ?? '0');
if (Number.isFinite(offsetMs) && offsetMs !== 0) {
  const origNow = Date.now.bind(Date);
  Date.now = () => origNow() + offsetMs;
}
