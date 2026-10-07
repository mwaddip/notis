import { describe, it, expect, vi } from 'vitest';

// The exported types are checked at compile time by this file's own import.
import type {
  TipResult, NodeTipResult,
  ListedBox, Listing, ListingResult,
  Anchor, FigureStatus, FigureBox, RecordResult, LedgerSums, FiguresResult, HoldingsRead,
  RangeResult, HoldingKind,
  NameClaim, NameStatus, NameResult,
  PostCheck, PostUnboundReason,
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
      'DEFAULT_K',
      'DEFAULT_M',
      'checkPosts',
      'fetchListing',
      'proveFigures',
      'proveName',
      'proveRange',
      'resolveTip',
      'verifierProfile',
    ]);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    argvGet.mockRestore();
  });

  // CONSTANTS → Client defaults
  it('exports DEFAULT_M === 24 and DEFAULT_K === 20', async () => {
    const lib = await import('../src/lib.js');
    expect(lib.DEFAULT_M).toBe(24);
    expect(lib.DEFAULT_K).toBe(20);
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
    const _hr: HoldingsRead | null = null;
    const _rrs: RangeResult | null = null;
    const _hk: HoldingKind | null = null;
    const _nc: NameClaim | null = null;
    const _ns: NameStatus | null = null;
    const _nr: NameResult | null = null;
    const _pc: PostCheck | null = null;
    const _pur: PostUnboundReason | null = null;
    const _f: HttpFetch | null = null;
    const _p: VerifyProfile | null = null;
    void _t; void _n; void _lb; void _l; void _lr; void _a;
    void _fs; void _fb; void _rr; void _ls; void _fr;
    void _hr; void _rrs; void _hk;
    void _nc; void _ns; void _nr;
    void _pc; void _pur;
    void _f; void _p;
    expect(true).toBe(true);
  });
});
