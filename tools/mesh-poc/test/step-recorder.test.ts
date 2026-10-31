// MESH_INTERFACE → Acceptance — "A step that times out or throws is
// recorded `FAIL` with its last measured value and the error, the
// scenario's faults are removed, and the run goes on to the next step".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepRecorder } from '../stage/lib/step-recorder.mjs';

describe('StepRecorder', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a scenario whose second step throws records it FAIL and still records the third', async () => {
    const r = new StepRecorder();
    await r.step('one', () => ({ verdict: 'PASS', measurement: { a: 1 } }));
    await r.step('two', () => { throw new Error('boom'); });
    await r.step('three', () => ({ verdict: 'PASS', measurement: { c: 3 } }));
    expect(r.steps.length, 'three steps recorded').toBe(3);
    expect(r.steps[0]!.verdict).toBe('PASS');
    expect(r.steps[1]!.verdict).toBe('FAIL');
    expect((r.steps[1]!.measurement as { error: string }).error).toContain('boom');
    expect(r.steps[2]!.verdict).toBe('PASS');
  });

  it('a step that returns PASS/FAIL/skipped reads as given', async () => {
    const r = new StepRecorder();
    await r.step('p', () => ({ verdict: 'PASS', measurement: null }));
    await r.step('f', () => ({ verdict: 'FAIL', measurement: { reason: 'no' } }));
    await r.step('s', () => ({ verdict: 'skipped', measurement: null }));
    expect(r.steps.map((s) => s.verdict)).toEqual(['PASS', 'FAIL', 'skipped']);
  });

  it('skipped(name) records a skip without running anything', () => {
    const r = new StepRecorder();
    r.skipped('one');
    r.skipped('two', { why: 'no prereq' });
    expect(r.steps.length).toBe(2);
    expect(r.steps[0]!.verdict).toBe('skipped');
    expect(r.steps[0]!.measurement).toBe(null);
    expect(r.steps[1]!.measurement).toEqual({ why: 'no prereq' });
  });

  it('step records `timeMs` for both pass and fail', async () => {
    // StepRecorder reads `Date.now()` at start and end of a step; a
    // real-timer `setTimeout(…, N)` fires from the event loop's cached
    // clock and can land a millisecond short of N by `Date.now()`, so
    // a `>= N` assertion is flaky under load. Vitest's fake timers
    // mock Date and setTimeout together — advancing by exactly N
    // settles the pending timer and reads back an exact N ms.
    vi.useFakeTimers();
    const r = new StepRecorder();
    const slow = r.step('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { verdict: 'PASS', measurement: null };
    });
    await vi.advanceTimersByTimeAsync(10);
    await slow;
    const throws = r.step('throws', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('nope');
    });
    await vi.advanceTimersByTimeAsync(5);
    await throws;
    expect(r.steps[0]!.timeMs).toBe(10);
    expect(r.steps[1]!.timeMs).toBe(5);
  });
});
