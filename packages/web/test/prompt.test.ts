// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { headingFor, linesFor } from '../src/extension/prompt-summary';
import type { SignSummary } from '../src/extension/protocol';

// The prompt page's heading and lines, pinned against WEB_INTERFACE →
// "A credits amount on the prompt is $NOTIS, never base units": the heading
// names the total sent, each line its payment and recipient, and a fee line
// only when the transaction carries a `fee` box. The formatter is one — every
// $NOTIS surface reads formatCredits (→ The wallet).

const RECIPIENT_A = 'aa'.repeat(32);
const RECIPIENT_B = 'bb'.repeat(32);

describe('headingFor — credits', () => {
  it("names the total across all sends, formatted", () => {
    // 12.5 + 7.75 = 20.25 $NOTIS
    const s: SignSummary = {
      kind: 'credits',
      sends: [
        { ownerHex: RECIPIENT_A, value: '1250000000' },
        { ownerHex: RECIPIENT_B, value: '775000000' },
      ],
      feeValue: '0',
    };
    expect(headingFor(s).textContent).toBe('send 20.25 $NOTIS?');
  });
});

describe('linesFor — credits', () => {
  it('formats each send as `<amount> $NOTIS to <prefix>`', () => {
    const s: SignSummary = {
      kind: 'credits',
      sends: [{ ownerHex: RECIPIENT_A, value: '1250000000' }],
      feeValue: '0',
    };
    const lines = linesFor(s, undefined);
    expect(lines).toEqual([`12.5 $NOTIS to ${RECIPIENT_A.slice(0, 8)}…${RECIPIENT_A.slice(-4)}`]);
  });

  it('emits no fee line at a zero fee — a send this client builds carries none', () => {
    const s: SignSummary = {
      kind: 'credits',
      sends: [{ ownerHex: RECIPIENT_A, value: '1250000000' }],
      feeValue: '0',
    };
    expect(linesFor(s, undefined).some((line) => line.startsWith('fee '))).toBe(false);
  });

  it('emits a formatted fee line at a non-zero fee', () => {
    const s: SignSummary = {
      kind: 'credits',
      sends: [{ ownerHex: RECIPIENT_A, value: '1250000000' }],
      feeValue: '25000000',
    };
    const lines = linesFor(s, undefined);
    expect(lines).toContain('fee 0.25 $NOTIS');
  });
});
