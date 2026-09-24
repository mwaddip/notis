// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { figuresLine, type FiguresLineInput } from '../src/model/figures-line';
import type { TipVerdict } from '../src/model/tip-verdict';
import type { FiguresResult, FigureBox, LedgerSums, RecordResult } from '@dagsocial/nipopow-client';
import type { IdentityRecord } from '@dagsocial/types';

// The pure line model that says beneath the wallet's balance and profile's rep
// what the verified-figures run could not prove (WEB_INTERFACE → The extension
// → "The verified figures", → The wallet window, → The profile window). The
// rows of the contract's list, each tested per ledger and titled by its rule;
// every FiguresResult built by hand — no tool call.

const emptySums: LedgerSums = { proven: 0n, young: 0n, unchecked: 0n, absent: 0n };

// A pure/complete IdentityRecord — the shape @dagsocial/types exports; the
// pure line only reads `record.status`, so the record's inner shape here is
// only what the type demands.
const RECORD: IdentityRecord = {
  lastActivityBlock: 0,
  lastDecayBlock: 0,
  invitedAtBlock: 0,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 0,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
};

function box(over: Partial<FigureBox> & Pick<FigureBox, 'boxClass' | 'status'>): FigureBox {
  return {
    boxId: 'a'.repeat(64),
    value: 0n,
    lockedUntilBlock: null,
    verdict: 'test',
    ...over,
  };
}

function result(over: Partial<FiguresResult> = {}): FiguresResult {
  return {
    boxes: [],
    record: { status: 'proven', record: RECORD } as RecordResult,
    karma: { ...emptySums, effective: 0n },
    credits: { ...emptySums },
    heightAfter: 100,
    failed: false,
    ...over,
  };
}

// A minimal input builder — the tests pass what row they test.
function input(over: Partial<FiguresLineInput>): FiguresLineInput {
  return {
    ledger: 'credits',
    verdict: null,
    result: null,
    shown: 0n,
    suffixHeight: 9005,
    boxCount: 1,
    height: 10000,
    ...over,
  };
}

const THIN: TipVerdict = { kind: 'thin', reason: 'no-proof', height: null };
const REFUSED: TipVerdict = { kind: 'refused', reason: 'invalid-proof', by: null, height: null };
const VERIFIED: TipVerdict = { kind: 'verified', nodes: 2, height: 9020 };

// ---------------------------------------------------------------------------
// Row 1 — verdict === undefined → null (a build with no verifier)
// ---------------------------------------------------------------------------
describe('figuresLine — row 1: no verifier build reads nothing', () => {
  it('credits: verdict undefined → null even with a full result standing', () => {
    expect(figuresLine(input({
      ledger: 'credits', verdict: undefined,
      result: result({ boxes: [box({ boxClass: 'credit', status: 'unproven', value: 5n })] }),
      shown: 10n,
    }))).toBeNull();
  });
  it('karma: verdict undefined → null', () => {
    expect(figuresLine(input({ ledger: 'karma', verdict: undefined }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 2 — the listing is empty → null (a proof of emptiness is a proof of nothing)
// ---------------------------------------------------------------------------
describe('figuresLine — row 2: an empty listing reads nothing', () => {
  it('credits: boxCount 0 → null even with a verified verdict and a result', () => {
    expect(figuresLine(input({
      ledger: 'credits', verdict: VERIFIED, boxCount: 0,
      result: result({ credits: { ...emptySums, absent: 1n } }),
    }))).toBeNull();
  });
  it('karma: boxCount 0 → null', () => {
    expect(figuresLine(input({ ledger: 'karma', verdict: VERIFIED, boxCount: 0 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 3 — no result stands and the verdict is thin / refused →
//   muted "not checked — the chain is not verified"
// Row 3' — otherwise (no verdict yet, or verified with no run back) → null
// ---------------------------------------------------------------------------
describe('figuresLine — row 3: the chain is not verified', () => {
  it('credits: thin, no result → muted "not checked — the chain is not verified"', () => {
    const line = figuresLine(input({ ledger: 'credits', verdict: THIN, result: null }));
    expect(line).toEqual({ text: 'not checked — the chain is not verified', weight: 'muted' });
  });
  it('credits: refused, no result → muted "not checked — the chain is not verified"', () => {
    const line = figuresLine(input({ ledger: 'credits', verdict: REFUSED, result: null }));
    expect(line).toEqual({ text: 'not checked — the chain is not verified', weight: 'muted' });
  });
  it('karma: thin, no result → the same muted line', () => {
    const line = figuresLine(input({ ledger: 'karma', verdict: THIN, result: null }));
    expect(line).toEqual({ text: 'not checked — the chain is not verified', weight: 'muted' });
  });
  it('karma: refused, no result → the same muted line', () => {
    const line = figuresLine(input({ ledger: 'karma', verdict: REFUSED, result: null }));
    expect(line).toEqual({ text: 'not checked — the chain is not verified', weight: 'muted' });
  });
});

describe("figuresLine — row 3': no verdict or a verified verdict without a run back reads nothing", () => {
  it('credits: verdict null (no run yet) → null', () => {
    expect(figuresLine(input({ ledger: 'credits', verdict: null, result: null }))).toBeNull();
  });
  it('credits: verdict verified, no result yet → null', () => {
    expect(figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: null }))).toBeNull();
  });
  it('karma: verdict null → null', () => {
    expect(figuresLine(input({ ledger: 'karma', verdict: null, result: null }))).toBeNull();
  });
  it('karma: verdict verified, no result yet → null', () => {
    expect(figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: null }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A listing the run did not prove — a result holding no box of the row's ledger
// under a listing that holds some → muted "not checked yet", never a figure of
// 0 proven, and before every row that reads the result
// ---------------------------------------------------------------------------
describe('figuresLine — a listing the run did not prove reads muted "not checked yet"', () => {
  it('credits: a result holding karma boxes alone under a listed balance → "not checked yet", never "0 $NOTIS proven"', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'proven', value: 100n })],
      karma: { ...emptySums, proven: 100n, effective: 100n },
    });
    expect(figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 1_250_000_000n })))
      .toEqual({ text: 'not checked yet', weight: 'muted' });
  });

  it('karma: a result holding no karma box under a listed rep → "not checked yet", never "0 rep proven"', () => {
    const r = result({
      boxes: [box({ boxClass: 'credit', status: 'proven', value: 500n })],
      credits: { ...emptySums, proven: 500n },
    });
    expect(figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 100n })))
      .toEqual({ text: 'not checked yet', weight: 'muted' });
  });

  it('it stands before the full rule: the record unproven in a result that proved no karma box reads "not checked yet"', () => {
    const r = result({
      boxes: [],
      record: { status: 'unproven', verdict: 'stateRoot mismatch' } as RecordResult,
      karma: { ...emptySums, effective: null },
    });
    expect(figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 100n })))
      .toEqual({ text: 'not checked yet', weight: 'muted' });
  });

  it('under a thin verdict with a result standing it still reads "not checked yet" — the unverified line is for no result', () => {
    const r = result({ boxes: [box({ boxClass: 'karma', status: 'proven', value: 100n })] });
    expect(figuresLine(input({ ledger: 'credits', verdict: THIN, result: r, shown: 1_250_000_000n })))
      .toEqual({ text: 'not checked yet', weight: 'muted' });
  });

  it('an empty listing stays silent — the empty-listing row comes first', () => {
    expect(figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: result({ boxes: [] }), boxCount: 0 }))).toBeNull();
    expect(figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: result({ boxes: [] }), boxCount: 0 }))).toBeNull();
  });

  it('a result holding the ledger\'s boxes reads by the rows after it, the other ledger\'s absence aside', () => {
    const r = result({
      boxes: [box({ boxClass: 'credit', status: 'proven', value: 1_250_000_000n })],
      credits: { ...emptySums, proven: 1_250_000_000n },
    });
    // Every credit box proven and the balance reproduced — silence for the balance …
    expect(figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 1_250_000_000n }))).toBeNull();
    // … while the rep row, whose listing the run was not handed, reads not checked yet.
    expect(figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 100n })))
      .toEqual({ text: 'not checked yet', weight: 'muted' });
  });
});

// ---------------------------------------------------------------------------
// Row 4 — clay: a box unproven or absent, or (karma) the record unproven
// ---------------------------------------------------------------------------
describe('figuresLine — row 4: the node lists / this node\'s proof did not verify (clay)', () => {
  it('credits: absent sum > 0 → clay "the node lists N $NOTIS the chain does not hold"', () => {
    // 12.5 $NOTIS absent = 1_250_000_000 base units
    const r = result({
      boxes: [box({ boxClass: 'credit', status: 'absent', value: 1_250_000_000n })],
      credits: { ...emptySums, absent: 1_250_000_000n },
    });
    const line = figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 1_250_000_000n }));
    expect(line).toEqual({ text: 'the node lists 12.5 $NOTIS the chain does not hold', weight: 'clay' });
  });

  it('credits: unproven box alone (no absent) → clay "this node\'s proof of the balance did not verify"', () => {
    const r = result({
      boxes: [box({ boxClass: 'credit', status: 'unproven', value: 100n })],
      credits: { ...emptySums },
    });
    const line = figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 0n }));
    expect(line).toEqual({ text: "this node's proof of the balance did not verify", weight: 'clay' });
  });

  it('karma: absent sum > 0 → clay "the node lists 5 rep the chain does not hold"', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'absent', value: 5n })],
      karma: { ...emptySums, absent: 5n, effective: null },
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 5n }));
    expect(line).toEqual({ text: 'the node lists 5 rep the chain does not hold', weight: 'clay' });
  });

  it('karma: unproven box → clay "this node\'s proof of your rep did not verify"', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'unproven', value: 3n })],
      karma: { ...emptySums, effective: null },
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 3n }));
    expect(line).toEqual({ text: "this node's proof of your rep did not verify", weight: 'clay' });
  });

  it('karma: record unproven (no boxes unproven or absent) → clay "this node\'s proof of your rep did not verify"', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'proven', value: 10n })],
      karma: { ...emptySums, proven: 10n, effective: null },
      record: { status: 'unproven', verdict: 'stateRoot mismatch' } as RecordResult,
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 10n }));
    expect(line).toEqual({ text: "this node's proof of your rep did not verify", weight: 'clay' });
  });

  it('karma: record unproven does NOT fire the credits line', () => {
    // The credits row must ignore the record's status.
    const r = result({
      boxes: [box({ boxClass: 'credit', status: 'proven', value: 100n })],
      credits: { ...emptySums, proven: 100n },
      record: { status: 'unproven', verdict: '' } as RecordResult,
    });
    // shown === proven, no other statuses — silence for credits (row 6).
    expect(figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 100n }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 4 — the valuation not made: beside a proven or absent record the tool
// answers `effective: null` only for a listing height that is not a block
// height; the rep row reads the full rule, never a figure of 0 proven
// (WEB_INTERFACE → The extension → "A run is total")
// ---------------------------------------------------------------------------
describe('figuresLine — row 4: a rep valuation the tool could not make (clay)', () => {
  const ABSENT_RECORD = { status: 'absent' } as RecordResult;

  it('karma: effective null beside a proven record, every box proven → clay "this node\'s proof of your rep did not verify", never "0 rep proven"', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'proven', value: 100n })],
      karma: { ...emptySums, proven: 100n, effective: null },
      failed: true,
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 100n }));
    expect(line).toEqual({ text: "this node's proof of your rep did not verify", weight: 'clay' });
  });

  it('karma: effective null beside an absent record, every box proven → the same clay line', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'proven', value: 100n })],
      record: ABSENT_RECORD,
      karma: { ...emptySums, proven: 100n, effective: null },
      failed: true,
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 100n }));
    expect(line).toEqual({ text: "this node's proof of your rep did not verify", weight: 'clay' });
  });

  it('karma: a no-proof box beside the valuation not made → row 4\'s clay line ahead of row 5', () => {
    const r = result({
      boxes: [
        box({ boxClass: 'karma', status: 'proven', value: 95n }),
        box({ boxClass: 'karma', status: 'no-proof', value: 5n }),
      ],
      karma: { ...emptySums, proven: 95n, effective: null },
      failed: true,
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 100n }));
    expect(line).toEqual({ text: "this node's proof of your rep did not verify", weight: 'clay' });
  });

  it('karma: an absent box beside the valuation not made → row 4 names what the chain does not hold', () => {
    const r = result({
      boxes: [
        box({ boxClass: 'karma', status: 'proven', value: 95n }),
        box({ boxClass: 'karma', status: 'absent', value: 5n }),
      ],
      karma: { ...emptySums, proven: 95n, absent: 5n, effective: null },
      failed: true,
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 100n }));
    expect(line).toEqual({ text: 'the node lists 5 rep the chain does not hold', weight: 'clay' });
  });

  it('credits: the rep valuation not made leaves the balance row as it reads — silence when every credit box proved', () => {
    const r = result({
      boxes: [
        box({ boxClass: 'karma', status: 'proven', value: 100n }),
        box({ boxClass: 'credit', status: 'proven', value: 1_250_000_000n }),
      ],
      karma: { ...emptySums, proven: 100n, effective: null },
      credits: { ...emptySums, proven: 1_250_000_000n },
      failed: true,
    });
    expect(figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 1_250_000_000n }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 5 — muted: a box no-proof, or (karma) the record no-proof
// ---------------------------------------------------------------------------
describe('figuresLine — row 5: the node served no proof', () => {
  it('credits: one no-proof box → muted "the node served no proof for N $NOTIS" (N = sum of no-proof boxes)', () => {
    const r = result({
      boxes: [box({ boxClass: 'credit', status: 'no-proof', value: 1_250_000_000n })],
      credits: { ...emptySums },
    });
    const line = figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 0n }));
    expect(line).toEqual({ text: 'the node served no proof for 12.5 $NOTIS', weight: 'muted' });
  });

  it('karma: one no-proof box → muted "the node served no proof for 5 rep"', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'no-proof', value: 5n })],
      // The proven record values the proven face — none — at 0.
      karma: { ...emptySums, effective: 0n },
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 0n }));
    expect(line).toEqual({ text: 'the node served no proof for 5 rep', weight: 'muted' });
  });

  it('karma: only the record is no-proof (no boxes no-proof) → muted "the node served no proof for your rep"', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'proven', value: 10n })],
      karma: { ...emptySums, proven: 10n, effective: null },
      record: { status: 'no-proof', verdict: 'HTTP 500' } as RecordResult,
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 10n }));
    expect(line).toEqual({ text: 'the node served no proof for your rep', weight: 'muted' });
  });

  it('karma: no-proof box wins over the record no-proof (the box has an amount)', () => {
    // Both a box and the record are no-proof — the box sum is what shows.
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'no-proof', value: 3n })],
      karma: { ...emptySums, effective: null },
      record: { status: 'no-proof', verdict: '' } as RecordResult,
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 0n }));
    expect(line).toEqual({ text: 'the node served no proof for 3 rep', weight: 'muted' });
  });
});

// ---------------------------------------------------------------------------
// Row 6 — silence is the green
// ---------------------------------------------------------------------------
describe('figuresLine — row 6: every box proven and the number reproduces → silence', () => {
  it('credits: one proven box, spendable equals shown → null', () => {
    const r = result({
      boxes: [box({ boxClass: 'credit', status: 'proven', value: 1_250_000_000n })],
      credits: { ...emptySums, proven: 1_250_000_000n },
    });
    expect(figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 1_250_000_000n }))).toBeNull();
  });
  it('karma: one proven box and effective reproduces shown → null', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'proven', value: 100n })],
      karma: { ...emptySums, proven: 100n, effective: 100n },
    });
    expect(figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 100n }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 7 — otherwise
// ---------------------------------------------------------------------------
describe('figuresLine — row 7: young / unchecked remainders and the rep-decayed case', () => {
  it('credits: proven + young → muted "P $NOTIS proven at block H · Y $NOTIS landed since"', () => {
    const r = result({
      boxes: [
        box({ boxClass: 'credit', status: 'proven', value: 8_750_000_000n }),
        box({ boxClass: 'credit', status: 'young',  value: 1_250_000_000n }),
      ],
      credits: { proven: 8_750_000_000n, young: 1_250_000_000n, unchecked: 0n, absent: 0n },
    });
    const line = figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 10_000_000_000n }));
    expect(line).toEqual({
      text: '87.5 $NOTIS proven at block 9005 · 12.5 $NOTIS landed since',
      weight: 'muted',
    });
  });

  it('credits: proven + unchecked → muted "P $NOTIS proven at block H · U $NOTIS not checked yet"', () => {
    const r = result({
      boxes: [
        box({ boxClass: 'credit', status: 'proven',    value: 8_750_000_000n }),
        box({ boxClass: 'credit', status: 'unchecked', value: 1_250_000_000n }),
      ],
      credits: { proven: 8_750_000_000n, young: 0n, unchecked: 1_250_000_000n, absent: 0n },
    });
    const line = figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 10_000_000_000n }));
    expect(line).toEqual({
      text: '87.5 $NOTIS proven at block 9005 · 12.5 $NOTIS not checked yet',
      weight: 'muted',
    });
  });

  it('credits: proven + young + unchecked → both clauses, in that order, joined by " · "', () => {
    const r = result({
      boxes: [
        box({ boxClass: 'credit', status: 'proven',    value: 8_000_000_000n }),
        box({ boxClass: 'credit', status: 'young',     value: 1_000_000_000n }),
        box({ boxClass: 'credit', status: 'unchecked', value:   500_000_000n }),
      ],
      credits: { proven: 8_000_000_000n, young: 1_000_000_000n, unchecked: 500_000_000n, absent: 0n },
    });
    const line = figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 9_500_000_000n }));
    expect(line).toEqual({
      text: '80 $NOTIS proven at block 9005 · 10 $NOTIS landed since · 5 $NOTIS not checked yet',
      weight: 'muted',
    });
  });

  it('karma: rep after decay moved (proven < shown, no young, no unchecked) → "P rep proven at block H" alone', () => {
    // A record whose clocks moved between the anchor and the live read — the
    // proven face is 100, decay valued it at 87, and the row still shows the
    // live effective 100 (an unchanged listing). The proven figure is
    // `karma.effective` = 87, below `shown` = 100, and no young/unchecked
    // stands.
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'proven', value: 100n })],
      karma: { proven: 100n, young: 0n, unchecked: 0n, absent: 0n, effective: 87n },
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 100n }));
    expect(line).toEqual({ text: '87 rep proven at block 9005', weight: 'muted' });
  });

  it('karma: proven + young → muted "P rep proven at block H · Y rep landed since"', () => {
    const r = result({
      boxes: [
        box({ boxClass: 'karma', status: 'proven', value: 87n }),
        box({ boxClass: 'karma', status: 'young',  value: 5n }),
      ],
      karma: { proven: 87n, young: 5n, unchecked: 0n, absent: 0n, effective: 87n },
    });
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 92n }));
    expect(line).toEqual({ text: '87 rep proven at block 9005 · 5 rep landed since', weight: 'muted' });
  });

  it('credits: a proven credit box locked past `height` is not spendable — leaves P out and fires row 7', () => {
    // The proven box carries a lock the live height has not passed, so it is
    // not in the balance's spendable sum. Row 7 fires, and P is 0 $NOTIS.
    const r = result({
      boxes: [box({ boxClass: 'credit', status: 'proven', value: 500_000_000n, lockedUntilBlock: 20_000 })],
      credits: { proven: 500_000_000n, young: 0n, unchecked: 0n, absent: 0n },
    });
    // The row's shown balance is 0 (the locked box is not spendable at live
    // height 10_000), and every box is proven, so row 6 would fire only when
    // P == shown; P = 0 here and shown = 0 → silence.
    expect(figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 0n, height: 10_000 }))).toBeNull();

    // With a shown of 1 $NOTIS (the row believes it can spend something) and
    // P = 0, row 7 fires: "0 $NOTIS proven at block H".
    const line = figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 100_000_000n, height: 10_000 }));
    expect(line).toEqual({ text: '0 $NOTIS proven at block 9005', weight: 'muted' });
  });

  it('credits: a proven credit box whose lock has passed contributes to P', () => {
    const r = result({
      boxes: [box({ boxClass: 'credit', status: 'proven', value: 500_000_000n, lockedUntilBlock: 5_000 })],
      credits: { proven: 500_000_000n, young: 0n, unchecked: 0n, absent: 0n },
    });
    // height 10_000 > lockedUntilBlock 5_000, so the box is spendable and P = shown.
    expect(figuresLine(input({ ledger: 'credits', verdict: VERIFIED, result: r, shown: 500_000_000n, height: 10_000 }))).toBeNull();
  });

  it('the proven-at-block clause names suffixHeight', () => {
    const r = result({
      boxes: [box({ boxClass: 'karma', status: 'proven', value: 5n }), box({ boxClass: 'karma', status: 'young', value: 3n })],
      karma: { proven: 5n, young: 3n, unchecked: 0n, absent: 0n, effective: 5n },
    });
    // A different suffixHeight — the clause reads it verbatim.
    const line = figuresLine(input({ ledger: 'karma', verdict: VERIFIED, result: r, shown: 8n, suffixHeight: 42 }));
    expect(line?.text).toContain('proven at block 42');
  });
});
