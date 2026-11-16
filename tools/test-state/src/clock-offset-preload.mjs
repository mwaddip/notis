// Shifts `Date.now()` by DAGSOCIAL_CLOCK_OFFSET_MS in every node-side process
// of a run (TEST_STATE_INTERFACE → The clock offset). The loader computes the
// offset once as the state's tip `createdAt` plus 1 000 ms minus real time at
// load, and gives it to the node, the faucet, the miner and every node a
// caller spawns for the run, loaded with `--import`. Every read through the
// process's clock — libp2p's included — sees the same offset, so an interval
// inside one process is unmoved. The shifted clock is behind real time, so a
// stamp any process makes is in the past for every reader — the browser on
// real time, and a reader on the same offset.

const raw = process.env.DAGSOCIAL_CLOCK_OFFSET_MS;
const offsetMs = Number(raw ?? '0');
if (Number.isFinite(offsetMs) && offsetMs !== 0) {
  const origNow = Date.now.bind(Date);
  Date.now = () => origNow() + offsetMs;
}
