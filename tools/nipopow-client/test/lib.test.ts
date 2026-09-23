import { describe, it, expect, vi } from 'vitest';

// The exported types are checked at compile time by this file's own import.
import type {
  TipResult, NodeTipResult,
  ListedBox, Listing, ListingResult,
  Anchor, FigureStatus, FigureBox, RecordResult, LedgerSums, FiguresResult,
  NameClaim, NameStatus, NameResult,
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

    // Runtime exports — the value names, sorted. The types above are checked
    // at compile time and carry no runtime name.
    expect(Object.keys(lib).sort()).toEqual([
      'fetchListing',
      'proveBoxes',
      'proveFigures',
      'proveName',
      'resolveTip',
      'verifierProfile',
    ]);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    argvGet.mockRestore();
  });

  it('the exported types are usable from outside', () => {
    // A no-op that exists to reference every type in a value position, so tsc
    // verifies the export list against tip.ts, boxes.ts, names.ts, config.ts,
    // http.ts.
    const _t: TipResult | null = null;
    const _n: NodeTipResult | null = null;
    const _lb: ListedBox | null = null;
    const _l: Listing | null = null;
    const _lr: ListingResult | null = null;
    const _a: Anchor | null = null;
    const _fs: FigureStatus | null = null;
    const _fb: FigureBox | null = null;
    const _rr: RecordResult | null = null;
    const _ls: LedgerSums | null = null;
    const _fr: FiguresResult | null = null;
    const _nc: NameClaim | null = null;
    const _ns: NameStatus | null = null;
    const _nr: NameResult | null = null;
    const _f: HttpFetch | null = null;
    const _p: VerifyProfile | null = null;
    void _t; void _n; void _lb; void _l; void _lr; void _a;
    void _fs; void _fb; void _rr; void _ls; void _fr;
    void _nc; void _ns; void _nr;
    void _f; void _p;
    expect(true).toBe(true);
  });
});
