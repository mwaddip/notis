// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { whatFor, amountFor, targetFor, feeFor } from '../src/extension/prompt-summary';
import type { SignSummary } from '../src/extension/protocol';

const appCss = readFileSync(resolve(process.cwd(), 'src/style/app.css'), 'utf8');

// The prompt page's three lines, pinned against WEB_INTERFACE → The extension →
// "The prompt reads as three lines: what, how much, to whom". The target's
// key or id renders whole, never shortened — a look-alike prefix cannot pass.
// The fee line rides a real `fee` box only (a send this client builds carries
// none — WEB_INTERFACE → The wallet).

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);
const POST_ID = 'cc'.repeat(32);

const thread: SignSummary = { kind: 'thread', spendRep: '5' };
const reply: SignSummary = { kind: 'reply', spendRep: '3' };
const like: SignSummary = { kind: 'like', targetHex: POST_ID, spendRep: '1' };
const withdraw: SignSummary = { kind: 'withdraw', postId: POST_ID };
const vouch: SignSummary = { kind: 'vouch', targetHex: KEY_A, spendRep: '1' };
const unvouch: SignSummary = { kind: 'unvouch' };
const invite: SignSummary = { kind: 'invite', inviteeHex: KEY_A, spendRep: '100' };
const claim: SignSummary = { kind: 'claim', name: 'Alice_01' };
const burn: SignSummary = { kind: 'burn', spendRep: '10' };
const other: SignSummary = { kind: 'other', spendRep: '0' };
const credits1: SignSummary = { kind: 'credits', sends: [{ ownerHex: KEY_A, value: '1250000000' }], feeValue: '0' };
const credits2: SignSummary = { kind: 'credits', sends: [
  { ownerHex: KEY_A, value: '1250000000' },
  { ownerHex: KEY_B, value: '775000000' },
], feeValue: '0' };
const creditsWithFee: SignSummary = { kind: 'credits', sends: [{ ownerHex: KEY_A, value: '1250000000' }], feeValue: '25000000' };

// ---------------------------------------------------------------------------
// whatFor — the first line, one Notis-prefixed word per kind.
// ---------------------------------------------------------------------------

describe('whatFor — every kind reads a Notis-prefixed word', () => {
  it('names the transaction for every SignSummary kind', () => {
    expect(whatFor(thread)).toBe('Notis post');
    expect(whatFor(reply)).toBe('Notis reply');
    expect(whatFor(like)).toBe('Notis like');
    expect(whatFor(withdraw)).toBe('Notis withdrawal');
    expect(whatFor(vouch)).toBe('Notis vouch');
    expect(whatFor(unvouch)).toBe('Notis unvouch');
    expect(whatFor(invite)).toBe('Notis invite');
    expect(whatFor(claim)).toBe('Notis name');
    expect(whatFor(burn)).toBe('Notis burn');
    expect(whatFor(other)).toBe('Notis rep transaction');
    expect(whatFor(credits1)).toBe('Notis transfer');
  });
});

// ---------------------------------------------------------------------------
// amountFor — $NOTIS for a transfer, `<N> rep` for a karma kind with a spend,
// null for a withdrawal, a claim, an unvouch.
// ---------------------------------------------------------------------------

describe('amountFor — rep or $NOTIS, or null', () => {
  it('reads `<spendRep> rep` for the karma kinds that carry one', () => {
    expect(amountFor(thread)).toBe('5 rep');
    expect(amountFor(reply)).toBe('3 rep');
    expect(amountFor(like)).toBe('1 rep');
    expect(amountFor(vouch)).toBe('1 rep');
    expect(amountFor(invite)).toBe('100 rep');
    expect(amountFor(burn)).toBe('10 rep');
    expect(amountFor(other)).toBe('0 rep');
  });

  it('is null for a withdrawal, a claim, an unvouch', () => {
    expect(amountFor(withdraw)).toBeNull();
    expect(amountFor(claim)).toBeNull();
    expect(amountFor(unvouch)).toBeNull();
  });

  it('sums the credits sends and formats as $NOTIS on the face, never base units', () => {
    expect(amountFor(credits1)).toBe('12.5 $NOTIS');
    // 12.5 + 7.75 = 20.25 $NOTIS
    expect(amountFor(credits2)).toBe('20.25 $NOTIS');
  });
});

// ---------------------------------------------------------------------------
// targetFor — the value whole, never shortened. One line per payment for a
// transfer. Null for an unvouch, a burn, a thread, a reply, an other kind.
// ---------------------------------------------------------------------------

describe('targetFor — the value whole, never shortened', () => {
  it('to: the whole key for a transfer, one entry per payment', () => {
    expect(targetFor(credits1)).toEqual([{ label: 'to:', value: KEY_A }]);
    expect(targetFor(credits2)).toEqual([
      { label: 'to:', value: KEY_A },
      { label: 'to:', value: KEY_B },
    ]);
  });

  it('to: the whole key for an invite', () => {
    expect(targetFor(invite)).toEqual([{ label: 'to:', value: KEY_A }]);
  });

  it('for: the whole key for a vouch', () => {
    expect(targetFor(vouch)).toEqual([{ label: 'for:', value: KEY_A }]);
  });

  it('post: the whole id for a like or a withdrawal', () => {
    expect(targetFor(like)).toEqual([{ label: 'post:', value: POST_ID }]);
    expect(targetFor(withdraw)).toEqual([{ label: 'post:', value: POST_ID }]);
  });

  it('an unlabelled name for a claim', () => {
    expect(targetFor(claim)).toEqual([{ label: '', value: 'Alice_01' }]);
  });

  it('null for the kinds that name nothing — unvouch, burn, thread, reply, other', () => {
    expect(targetFor(unvouch)).toBeNull();
    expect(targetFor(burn)).toBeNull();
    expect(targetFor(thread)).toBeNull();
    expect(targetFor(reply)).toBeNull();
    expect(targetFor(other)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// feeFor — a `fee` box only. A send this client builds carries none.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The cascade — WEB_INTERFACE → The extension → "The prompt window" says the
// first line is a `<div>`, not an `<h1>`, so the App's `header h1` rule (the
// only h1 rule in app.css) does not reach it and no `main` rule collides.
// ---------------------------------------------------------------------------

describe('the prompt page — the cascade', () => {
  it('main#prompt fills the popup; the what line is 17px 600 without carrying an h1 rule', () => {
    const style = document.createElement('style');
    style.textContent = appCss;
    document.head.appendChild(style);
    const main = document.createElement('main');
    main.id = 'prompt';
    const container = document.createElement('div');
    container.className = 'prompt';
    const lines = document.createElement('div');
    lines.className = 'lines';
    const what = document.createElement('div');
    what.className = 'line what';
    what.textContent = 'Notis transfer';
    lines.appendChild(what);
    container.appendChild(lines);
    main.appendChild(container);
    document.body.appendChild(main);
    const mainS = window.getComputedStyle(main);
    expect(mainS.display).toBe('flex');
    expect(mainS.flexDirection).toBe('column');
    const whatS = window.getComputedStyle(what);
    expect(whatS.fontWeight).toBe('600');
    expect(whatS.fontSize).toBe('17px');
    // The App's `header h1` rule wants 15px 600. `.line.what` is a div, so
    // that rule is out of the cascade — the size is 17px, not 15px.
    document.body.removeChild(main);
    document.head.removeChild(style);
  });
});

describe('feeFor — a real `fee` box only', () => {
  it('is null at a zero fee — a send this client builds carries none', () => {
    expect(feeFor(credits1)).toBeNull();
  });

  it('formats a non-zero fee as `fee <N> $NOTIS`', () => {
    expect(feeFor(creditsWithFee)).toBe('fee 0.25 $NOTIS');
  });

  it('is null for every non-credits kind', () => {
    expect(feeFor(thread)).toBeNull();
    expect(feeFor(reply)).toBeNull();
    expect(feeFor(like)).toBeNull();
    expect(feeFor(withdraw)).toBeNull();
    expect(feeFor(vouch)).toBeNull();
    expect(feeFor(unvouch)).toBeNull();
    expect(feeFor(invite)).toBeNull();
    expect(feeFor(claim)).toBeNull();
    expect(feeFor(burn)).toBeNull();
    expect(feeFor(other)).toBeNull();
  });
});
