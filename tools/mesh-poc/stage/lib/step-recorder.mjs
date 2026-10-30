// MESH_INTERFACE → Acceptance — "A step that times out or throws is
// recorded `FAIL` with its last measured value and the error, the
// scenario's faults are removed, and the run goes on to the next step
// or scenario". The scenario wraps each step in `recorder.step(name,
// fn)`; `fn` returns `{ verdict, measurement }`; a throw lands as a
// `FAIL` with `{ error: <message> }` and the next `recorder.step`
// still runs.

export class StepRecorder {
  constructor() {
    this.steps = [];
  }

  /**
   * Run `fn` under the scenario's try/catch. `fn` returns an object with
   * `verdict` ('PASS' | 'FAIL' | 'skipped') and `measurement`. A thrown
   * error is recorded `FAIL` with the error on the measurement; the
   * `steps` array grows either way.
   */
  async step(name, fn) {
    const t0 = Date.now();
    try {
      const r = await fn();
      const verdict = r?.verdict ?? 'FAIL';
      const measurement = r?.measurement ?? null;
      this.steps.push({ name, verdict, measurement, timeMs: Date.now() - t0 });
      return { verdict, measurement };
    } catch (err) {
      const message = String(err?.message ?? err);
      this.steps.push({
        name,
        verdict: 'FAIL',
        measurement: { error: message },
        timeMs: Date.now() - t0,
      });
      return { verdict: 'FAIL', measurement: { error: message } };
    }
  }

  /**
   * Record a step as `skipped` without running anything — scenarios use
   * this for a step whose prerequisite failed (eg s1's probes when
   * no identity row was found).
   */
  skipped(name, measurement = null) {
    this.steps.push({ name, verdict: 'skipped', measurement, timeMs: 0 });
  }
}
