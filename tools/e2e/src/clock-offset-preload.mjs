// Shifts `Date.now()` by DAGSOCIAL_E2E_CLOCK_OFFSET_MS in the process that
// stamps block 1. The block creator stamps a header's `createdAt` from the
// node's clock (MINING_INTERFACE → Header timestamp rules → "Producer side"),
// and the difficulty schedule anchors on `t_a = createdAt(1)` (MINING_INTERFACE →
// Difficulty Schedule), so the offset shifts `t_a` by the same amount. A process
// on the same data directory with no shift stamps block 2 at real time, which
// drives Δ positive from block 3 onwards and clamps the schedule at the floor.
// The shifted first stamp is below the next real-time stamp, so the order rule
// holds, and a past stamp passes the future bound (MINING_INTERFACE → Header
// timestamp rules).

const raw = process.env.DAGSOCIAL_E2E_CLOCK_OFFSET_MS;
const offsetMs = Number(raw ?? '0');
if (Number.isFinite(offsetMs) && offsetMs !== 0) {
  const origNow = Date.now.bind(Date);
  Date.now = () => origNow() + offsetMs;
}
