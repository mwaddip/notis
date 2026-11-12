// MESH_INTERFACE → Block gossip → "A router scores its peers by
// gossipsub's defaults" — a `cdp.mjs poll` or `eval` that is signalled
// before its `finally` runs leaks the open target in Chromium, and the
// leaked page keeps a browser peer in the mesh for the rest of the
// run. The termination registry's rule: every page-opening call
// registers its target close here, and a SIGTERM or SIGINT runs each
// registered close before the process exits. The handler fires at
// most once, so a repeated signal does not double-close.

import { describe, expect, it } from 'vitest';
import { createTerminationRegistry, parseTimeoutArg } from '../stage/cdp.mjs';

describe('cdp.mjs — createTerminationRegistry', () => {
  it('runs every registered cleanup when the handler fires, then exits', async () => {
    const codes: number[] = [];
    const r = createTerminationRegistry({ exit: (c) => codes.push(c), bind: false });
    const called: string[] = [];
    r.register(() => { called.push('a'); });
    r.register(() => { called.push('b'); });
    await r.run('SIGTERM');
    expect(called.sort()).toEqual(['a', 'b']);
    expect(codes).toEqual([143]);
    expect(r.hasFired()).toBe(true);
  });

  it('fires once; a second signal is a no-op', async () => {
    const codes: number[] = [];
    const r = createTerminationRegistry({ exit: (c) => codes.push(c), bind: false });
    let runs = 0;
    r.register(() => { runs += 1; });
    await r.run('SIGTERM');
    await r.run('SIGINT');
    expect(runs).toBe(1);
    expect(codes).toEqual([143]);
  });

  it('awaits an async cleanup before exit', async () => {
    const codes: number[] = [];
    const r = createTerminationRegistry({ exit: (c) => codes.push(c), bind: false });
    let finished = false;
    r.register(async () => {
      await new Promise((res) => setTimeout(res, 10));
      finished = true;
    });
    await r.run('SIGTERM');
    expect(finished, 'cleanup finished before exit').toBe(true);
    expect(codes).toEqual([143]);
  });

  it("a cleanup's throw does not block the exit or the next cleanup", async () => {
    const codes: number[] = [];
    const r = createTerminationRegistry({ exit: (c) => codes.push(c), bind: false });
    const called: string[] = [];
    r.register(() => { called.push('a'); throw new Error('x'); });
    r.register(() => { called.push('b'); });
    await r.run('SIGTERM');
    expect(called.sort()).toEqual(['a', 'b']);
    expect(codes).toEqual([143]);
  });

  it('an unregistered cleanup does not run on signal', async () => {
    const codes: number[] = [];
    const r = createTerminationRegistry({ exit: (c) => codes.push(c), bind: false });
    let runs = 0;
    const unregister = r.register(() => { runs += 1; });
    unregister();
    await r.run('SIGTERM');
    expect(runs).toBe(0);
    expect(codes).toEqual([143]);
  });

  it('SIGINT exits 130, SIGTERM exits 143', async () => {
    const codes: number[] = [];
    const r1 = createTerminationRegistry({ exit: (c) => codes.push(c), bind: false });
    const r2 = createTerminationRegistry({ exit: (c) => codes.push(c), bind: false });
    await r1.run('SIGINT');
    await r2.run('SIGTERM');
    expect(codes).toEqual([130, 143]);
  });

  it('bind:false installs no listener on process', () => {
    const beforeTerm = process.listenerCount('SIGTERM');
    const beforeInt = process.listenerCount('SIGINT');
    const r = createTerminationRegistry({ bind: false });
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    r.unbind();
  });
});

describe('cdp.mjs — parseTimeoutArg', () => {
  it('answers the fallback for an absent argument and the default when none is given', () => {
    expect(parseTimeoutArg(undefined, 1234)).toBe(1234);
    expect(parseTimeoutArg(undefined)).toBe(30_000);
  });

  it('answers a positive integer as a number', () => {
    expect(parseTimeoutArg('320000')).toBe(320_000);
  });

  it.each(['0', '-5', '1.5', 'abc', '', '12s'])('refuses %j', (text) => {
    expect(() => parseTimeoutArg(text)).toThrow(/positive integer/);
  });
});
