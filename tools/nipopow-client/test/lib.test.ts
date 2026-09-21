import { describe, it, expect, vi } from 'vitest';

// The exported types are checked at compile time by this file's own import.
import type {
  TipResult, NodeTipResult, BoxesResult, BoxVerdict, BoxClass, BoxStatus,
  HttpFetch, VerifyProfile,
} from '../src/lib.js';

describe('library entry', () => {
  it('importing src/lib.ts writes nothing to stderr, calls no exit, and reads no argv', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const argvGet = vi.spyOn(process, 'argv', 'get');

    const lib = await import('../src/lib.js');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(argvGet).not.toHaveBeenCalled();

    // The runtime exports are exactly these three; the eight types above are checked
    // at compile time and carry no runtime name.
    expect(Object.keys(lib).sort()).toEqual(['proveBoxes', 'resolveTip', 'verifierProfile']);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    argvGet.mockRestore();
  });

  it('the exported types are usable from outside', () => {
    // A no-op that exists to reference every type in a value position, so tsc verifies
    // the export list against tip.ts, boxes.ts, config.ts, http.ts.
    const _t: TipResult | null = null;
    const _n: NodeTipResult | null = null;
    const _b: BoxesResult | null = null;
    const _v: BoxVerdict | null = null;
    const _c: BoxClass | null = null;
    const _s: BoxStatus | null = null;
    const _f: HttpFetch | null = null;
    const _p: VerifyProfile | null = null;
    void _t; void _n; void _b; void _v; void _c; void _s; void _f; void _p;
    expect(true).toBe(true);
  });
});
