// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  walletBody, renderCreditsRow, resetCreditsSendForm, sendUnlockRow,
  type WalletHandlers, type WalletCtx, type SendRecipient,
} from '../src/view/wallet';
import { prefs } from '../src/prefs';
import { shortHex } from '../src/dom';
import type { CreditsResult, StatusResult } from '../src/api/dto';
import type { FiguresView } from '../src/model/state';
import type { TipVerdict } from '../src/model/tip-verdict';
import type { FiguresResult, FigureBox, LedgerSums, RecordResult, Anchor } from '@dagsocial/nipopow-client';
import type { BlockHeader, IdentityRecord, UserId } from '@dagsocial/types';

const appCss = readFileSync(resolve(process.cwd(), 'src/style/app.css'), 'utf8');

// The @wallet window rendered from a fake handlers/ctx (WEB_INTERFACE → The
// wallet window): the balance line, the send form's validation, the confirm
// and flight states, and the extension arm (confirmInRow: false).

const KEY = 'ab'.repeat(32);
const unlocked = { pubKeyHex: KEY, locked: false };

function handlers(over: Partial<WalletHandlers> = {}): WalletHandlers {
  return {
    // Every press begins — no check runs: the web build always, the extension
    // between presses.
    beginSendPress: () => true,
    pressSend: () => {},
    resolveRecipient: async () => ({ refusal: 'no one holds that name.' }),
    send: () => {},
    askFaucetCredits: () => {},
    unlockIdentity: async () => {},
    ...over,
  };
}

function creditsField(body: HTMLElement): HTMLElement | null {
  return body.querySelector<HTMLElement>('.credits-field');
}

function button(root: HTMLElement, text: string): HTMLButtonElement | null {
  for (const b of root.querySelectorAll('button')) if (b.textContent === text) return b as HTMLButtonElement;
  return null;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const REC = 'cd'.repeat(32);
const REC_NAME = 'bob';

function statusAt(blockHeight: number): StatusResult {
  return {
    networkType: 'testnet', blockHeight, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function creditsResult(over: Partial<CreditsResult> = {}): CreditsResult {
  return { userId: KEY, total: '0', boxes: [], boxCount: 0, next: null, ...over };
}

function ctx(over: Partial<WalletCtx> = {}): WalletCtx {
  return {
    identity: null, status: null, credits: null, creditGrant: null,
    sendFlight: null, pendingSend: null, sendCheck: null, sendAnswer: null,
    // The web arm's default — the confirm row stands. The extension arm's
    // tests override this to false and cover the flow the prompt confirms
    // (WEB_INTERFACE → The wallet window → "in the web build, the confirm row").
    confirmInRow: true,
    // The web arm's default — no verifier, so `figuresLine` reads row 1 and
    // renders nothing beneath the figure. The extension arm's tests override
    // both (WEB_INTERFACE → The extension → "The verified figures").
    verdict: undefined, figures: null,
    ...over,
  };
}

function creditsCtx(over: Partial<WalletCtx> = {}): WalletCtx {
  return ctx({ identity: unlocked, status: statusAt(1000), credits: creditsResult(), ...over });
}

function extCtx(over: Partial<WalletCtx> = {}): WalletCtx {
  return creditsCtx({
    credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    confirmInRow: false,
    ...over,
  });
}

const render = (h: WalletHandlers, c: WalletCtx): HTMLElement => walletBody(h, c);

beforeEach(() => {
  localStorage.clear();
  prefs.faucet = '';
});

describe('wallet window — the two states', () => {
  it('with no identity, one lead line pointing at the profile window and no credits-field', () => {
    const body = render(handlers(), ctx());
    expect(body.textContent).toContain('no identity in this browser. the profile window creates or imports one.');
    expect(creditsField(body)).toBeNull();
    expect(body.querySelector('.credits-line')).toBeNull();
  });

  it('with an identity, .credits-field wraps the balance and send rows carrying their classes; slot classes present', () => {
    const body = render(handlers(), creditsCtx());
    const field = creditsField(body)!;
    expect(field).not.toBeNull();
    // The two rows carry .balance-row and .send-row — the identity toggleSendRow
    // selects by, so the geometry of credits-field does not decide the row's
    // identity (WEB_INTERFACE → The wallet window → "The `balance` row",
    // → "The `send` row").
    const balance = field.querySelector<HTMLElement>(':scope > .balance-row');
    const send = field.querySelector<HTMLElement>(':scope > .send-row');
    expect(balance).not.toBeNull();
    expect(send).not.toBeNull();
    expect(balance!.querySelector('label')?.textContent).toBe('balance');
    expect(send!.querySelector('label')?.textContent).toBe('send');
    // The slot classes stand inside the balance and send rows.
    expect(field.querySelector('.credits-line')).not.toBeNull();
    expect(field.querySelector('.credits-form')).not.toBeNull();
    expect(field.querySelector('.credits-flight')).not.toBeNull();
  });

  it('.send-row is hidden while no box is spendable and shown once one is', () => {
    const empty = render(handlers(), creditsCtx());
    expect(creditsField(empty)!.querySelector<HTMLElement>(':scope > .send-row')?.hidden).toBe(true);
    const spendable = render(handlers(), creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    }));
    expect(creditsField(spendable)!.querySelector<HTMLElement>(':scope > .send-row')?.hidden).toBe(false);
  });

  // The `send` row stands while a send's own line stands — its flight, the
  // pending line, *sent* — so a send of the whole balance still reads its
  // ending (WEB_INTERFACE → The wallet window → "The `send` row").
  it('a landed flight with no spendable box keeps the send row visible with *sent*', () => {
    const c = creditsCtx({ credits: creditsResult(), sendFlight: { stage: 'landed' } });
    const f = creditsField(render(handlers(), c))!;
    expect(f.querySelector<HTMLElement>(':scope > .send-row')?.hidden).toBe(false);
    expect(f.querySelector('.credits-flight')?.textContent).toBe('sent');
    expect(f.querySelector('form.credits-form')).toBeNull();
  });

  it('a rejected flight with no spendable box keeps the send row visible', () => {
    const c = creditsCtx({
      credits: creditsResult(),
      sendFlight: { stage: 'rejected', reason: 'send not sent.' },
    });
    const f = creditsField(render(handlers(), c))!;
    expect(f.querySelector<HTMLElement>(':scope > .send-row')?.hidden).toBe(false);
    expect(f.querySelector('.credits-flight')?.textContent).toContain('send not sent.');
  });

  it('a rebuild with a pending send and no spendable box shows the send row', () => {
    const c = creditsCtx({
      credits: creditsResult(),
      pendingSend: { toHex: REC, toName: 'bob', amount: 1_250_000_000n },
    });
    const f = creditsField(render(handlers(), c))!;
    expect(f.querySelector<HTMLElement>(':scope > .send-row')?.hidden).toBe(false);
    expect(f.querySelector('.credits-flight')?.textContent).toBe('12.5 $NOTIS to @bob · submitted');
    expect(f.querySelector('form.credits-form')).toBeNull();
  });
});


// ---------------------------------------------------------------------------

describe('wallet window — the balance and send rows', () => {
  it('credits null shows —', () => {
    const f = creditsField(render(handlers(), ctx({ identity: unlocked })))!;
    expect(f.querySelector('.credits-line')?.textContent).toBe('—');
    expect(f.querySelector('form.credits-form')).toBeNull();
    expect(f.querySelector('.credits-flight')?.textContent).toBe('');
  });

  it('a spendable sum shows the balance in gold + $NOTIS, no locked hint', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '1250000000' }], boxCount: 1 }),
    });
    const f = creditsField(render(handlers(), c))!;
    const bal = f.querySelector('.mono.gold') as HTMLElement;
    expect(bal.textContent).toBe('12.5');
    expect(f.querySelector('.credits-line')?.textContent).toContain('12.5');
    expect(f.querySelector('.credits-line')?.textContent).toContain('$NOTIS');
    expect(f.querySelector('.credits-line .hint')).toBeNull();
    expect(f.querySelector('form.credits-form')).not.toBeNull();
  });

  it('a locked box past height stays out of the balance and the hint reads its value (READ-1 defect 1)', () => {
    // One unlocked at 100_000_000 (1 $NOTIS), one locked to block 2000, height 1000.
    const c = creditsCtx({
      credits: creditsResult({
        boxes: [
          { boxId: 'a'.repeat(32), value: '100000000' },
          { boxId: 'b'.repeat(32), value: '900000000', lockedUntilBlock: 2000 },
        ],
        boxCount: 2,
      }),
    });
    const f = creditsField(render(handlers(), c))!;
    expect((f.querySelector('.mono.gold') as HTMLElement).textContent).toBe('1');
    const hint = f.querySelector('.credits-line .hint');
    expect(hint?.textContent).toContain('9 $NOTIS more unlock by block ');
    expect(hint?.textContent).toContain('2000');
    // The total is NOT summed with the locked value — the hint stands beside it.
    expect((f.querySelector('.mono.gold') as HTMLElement).textContent).not.toBe('10');
  });

  it('a lockedUntilBlock === height is spendable, one past drops (READ-1 defect 1, the boundary)', () => {
    const c = creditsCtx({
      status: statusAt(1000),
      credits: creditsResult({
        boxes: [
          { boxId: 'a'.repeat(32), value: '100000000', lockedUntilBlock: 1000 }, // === height, kept
          { boxId: 'b'.repeat(32), value: '200000000', lockedUntilBlock: 1001 }, // one past, dropped
        ],
        boxCount: 2,
      }),
    });
    const f = creditsField(render(handlers(), c))!;
    expect((f.querySelector('.mono.gold') as HTMLElement).textContent).toBe('1');
    expect(f.querySelector('.credits-line .hint')?.textContent).toContain('2 $NOTIS more');
  });

  it('only locked boxes → the zero branch with the locked hint beneath (READ-1 defect 1)', () => {
    prefs.faucet = ''; // no faucet → the zero branch reads "no $NOTIS yet."
    const c = creditsCtx({
      credits: creditsResult({
        boxes: [{ boxId: 'a'.repeat(32), value: '900000000', lockedUntilBlock: 2000 }],
        boxCount: 1,
      }),
    });
    const f = creditsField(render(handlers(), c))!;
    const line = f.querySelector('.credits-line')!;
    expect(line.textContent).toContain('no $NOTIS yet.');
    expect(line.querySelector('.hint')?.textContent).toContain('9 $NOTIS more unlock by block');
    expect(f.querySelector('form.credits-form')).toBeNull();
  });

  it('faucet configured, no spendable → *ask the faucet for $NOTIS*', () => {
    prefs.faucet = '/faucet';
    const f = creditsField(render(handlers(), creditsCtx()))!;
    expect(button(f, 'ask the faucet for $NOTIS')).not.toBeNull();
  });

  it('faucet configured, grant pending → working…', () => {
    prefs.faucet = '/faucet';
    const f = creditsField(render(handlers(), creditsCtx({ creditGrant: { state: 'pending' } })))!;
    expect(f.querySelector('.credits-line')?.textContent).toContain('working…');
    expect(button(f, 'ask the faucet for $NOTIS')).toBeNull();
  });

  it('faucet configured, grant expired → the height and *ask again*', () => {
    prefs.faucet = '/faucet';
    const f = creditsField(render(handlers(), creditsCtx({ creditGrant: { state: 'expired', atHeight: 5999 } })))!;
    expect(f.querySelector('.credits-line')?.textContent).toContain("no block took the faucet's transfer");
    expect(f.querySelector('.credits-line')?.textContent).toContain('5999');
    expect(button(f, 'ask again')).not.toBeNull();
  });

  it('no faucet configured, no credits → *no $NOTIS yet.*', () => {
    prefs.faucet = '';
    const f = creditsField(render(handlers(), creditsCtx()))!;
    expect(f.querySelector('.credits-line')?.textContent).toContain('no $NOTIS yet.');
    expect(button(f, 'ask the faucet for $NOTIS')).toBeNull();
  });

  it('the send form validates: empty amount, non-numeric, zero, ninth decimal, own key', async () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = creditsField(render(handlers(), c))!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    const refusal = form.querySelector<HTMLElement>('.pf-refusal')!;

    const submit = async (t: string, a: string): Promise<void> => {
      to.value = t; amount.value = a;
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      await flush();
    };

    // Empty amount.
    await submit(REC, '');
    expect(refusal.hidden).toBe(false);
    expect(refusal.textContent).toContain('an amount is digits');
    // A non-numeric amount.
    await submit(REC, 'x');
    expect(refusal.textContent).toContain('an amount is digits');
    // Zero.
    await submit(REC, '0');
    expect(refusal.textContent).toContain('an amount is digits');
    // Ninth decimal.
    await submit(REC, '0.123456789');
    expect(refusal.textContent).toContain('an amount is digits');
    // Own key → *that is your own key.*
    await submit(KEY, '1');
    expect(refusal.textContent).toContain('your own key');
    // Not a key or a name.
    await submit('!!', '1');
    expect(refusal.textContent).toContain('not a key or a name');
  });

  it('the confirm row: two texts with the 16-glyph prefix (READ-1 nit)', async () => {
    // resolveRecipient answers a resolved handle for the "@bob" input; the confirm
    // shows the handle and the 16-glyph key prefix.
    const h = handlers({ resolveRecipient: async () => ({ key: REC, name: REC_NAME }) });
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = creditsField(render(h, c))!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;

    to.value = '@bob'; amount.value = '12.5';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    let confirm = f.querySelector('.pf-confirm') as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(confirm.textContent).toContain('send 12.5 $NOTIS to @bob · ');
    expect(confirm.querySelector('.mono')?.textContent).toBe(shortHex(REC, 16));

    // A bare key input → the second text: no handle, the prefix in mono.
    // Re-query the form — restoreForm builds a fresh element on keep.
    button(f, 'keep')!.click();
    const OTHER = 'ff'.repeat(32);
    const form2 = f.querySelector('form.credits-form') as HTMLFormElement;
    const to2 = form2.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount2 = form2.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to2.value = OTHER; amount2.value = '1';
    form2.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    confirm = f.querySelector('.pf-confirm') as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(confirm.textContent).toContain('send 1 $NOTIS to ');
    expect(confirm.textContent).not.toContain('@');
    expect(confirm.querySelector('.mono')?.textContent).toBe(shortHex(OTHER, 16));
  });

  it('keep restores the form with its values', async () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = creditsField(render(handlers(), c))!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to.value = REC; amount.value = '3.14';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // The confirm row is up.
    expect(f.querySelector('.pf-confirm')).not.toBeNull();
    button(f, 'keep')!.click();
    // The form is back with its values.
    const back = f.querySelector('form.credits-form') as HTMLFormElement;
    const inputs = back.querySelectorAll<HTMLInputElement>('input');
    expect(inputs[0]!.value).toBe(REC);
    expect(inputs[1]!.value).toBe('3.14');
  });

  it('a locked press on send mounts the unlock row and calls no handler', async () => {
    const sent: Array<[string, string | null, bigint]> = [];
    const h = handlers({ send: (k, n, a) => sent.push([k, n, a]) });
    const c = creditsCtx({
      identity: { pubKeyHex: KEY, locked: true },
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = creditsField(render(h, c))!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to.value = REC; amount.value = '1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // Confirm shown → press send → the wrap becomes the unlock form.
    const confirm = f.querySelector('.pf-confirm') as HTMLElement;
    const sendBtn = [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement;
    sendBtn.click();
    // The unlock form is now in the confirm's wrap; the send handler was not called.
    expect(f.querySelector('form.pf')?.querySelector<HTMLInputElement>('input[type="password"]')).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('after an in-row unlock, a second send goes straight through with no unlock form mounted', async () => {
    // An in-row unlock fires no onChange, so the App does not re-render the
    // profile; sendConfirm holds its own effective ctx so the rebuilt form and
    // the next press see the unlocked identity (WEB_INTERFACE → The wallet).
    const sent: Array<[string, string | null, bigint]> = [];
    const unlockedWith: string[] = [];
    const h = handlers({
      send: (k, n, a) => sent.push([k, n, a]),
      unlockIdentity: async (p) => { unlockedWith.push(p); },
    });
    const c = creditsCtx({
      identity: { pubKeyHex: KEY, locked: true },
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = creditsField(render(h, c))!;

    // First press: submit → confirm → send → unlock form mounts, no send yet.
    const form1 = f.querySelector('form.credits-form') as HTMLFormElement;
    const inputs1 = form1.querySelectorAll<HTMLInputElement>('input');
    inputs1[0]!.value = REC; inputs1[1]!.value = '1';
    form1.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const confirm1 = f.querySelector('.pf-confirm') as HTMLElement;
    ([...confirm1.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement).click();
    // The confirm wrap now holds the unlock form (a password input identifies it).
    const unlock = f.querySelector('.pf-confirm form') as HTMLFormElement;
    expect(unlock.querySelector('input[type="password"]')).not.toBeNull();
    expect(sent).toHaveLength(0);

    // The unlock's submit resolves: send fires, the unlock form is gone, and
    // the slot holds a fresh sendForm built with an unlocked effective ctx.
    (unlock.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    unlock.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(unlockedWith).toEqual(['pw']);
    expect(sent).toHaveLength(1);
    expect(f.querySelector('input[type="password"]')).toBeNull();
    expect(f.querySelector('form.credits-form')).not.toBeNull();

    // Second press: fill the rebuilt form, submit, press send. The rebuilt
    // form's ctx is unlocked, so send fires straight — no unlock form mounts.
    const form2 = f.querySelector('form.credits-form') as HTMLFormElement;
    const inputs2 = form2.querySelectorAll<HTMLInputElement>('input');
    inputs2[0]!.value = REC; inputs2[1]!.value = '2';
    form2.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const confirm2 = f.querySelector('.pf-confirm') as HTMLElement;
    ([...confirm2.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement).click();
    expect(f.querySelector('input[type="password"]')).toBeNull();
    expect(sent).toHaveLength(2);
    expect(unlockedWith).toHaveLength(1); // no second unlock asked
  });

  it('the pending line reads *<amount> $NOTIS to @bob · submitted* (READ-1 defect 2)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      pendingSend: { toHex: REC, toName: 'bob', amount: 1_250_000_000n },
    });
    const f = creditsField(render(handlers(), c))!;
    expect(f.querySelector('.credits-flight')?.textContent).toBe('12.5 $NOTIS to @bob · submitted');
  });

  it('the pending line falls back to the 16-glyph prefix when toName is null (READ-1 defect 2)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      pendingSend: { toHex: REC, toName: null, amount: 1_250_000_000n },
    });
    const f = creditsField(render(handlers(), c))!;
    expect(f.querySelector('.credits-flight')?.textContent).toBe(`12.5 $NOTIS to ${shortHex(REC, 16)} · submitted`);
  });

  it('a landed flight reads *sent* (READ-1 defect 4)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'landed' },
    });
    const f = creditsField(render(handlers(), c))!;
    expect(f.querySelector('.credits-flight')?.textContent).toBe('sent');
  });

  it('a rejected flight reads the reason; a notSent flight reads *not sent.*; an expired one reads the height', () => {
    const rejected = creditsField(render(handlers(), creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'rejected', reason: 'send rejected: not enough $NOTIS.' },
    })))!;
    expect(rejected.querySelector('.credits-flight')?.textContent).toContain('not enough $NOTIS.');

    const notSent = creditsField(render(handlers(), creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'rejected', reason: 'send not sent.' },
    })))!;
    expect(notSent.querySelector('.credits-flight')?.textContent).toContain('send not sent.');

    const expired = creditsField(render(handlers(), creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'expired', expiresAtHeight: 9000 },
    })))!;
    expect(expired.querySelector('.credits-flight')?.textContent).toContain('9,000');
  });

  it('renderCreditsRow leaves the form the reader is filling in place (READ-1 defect 3)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const body = render(handlers(), c);
    const f = creditsField(body)!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to.value = REC; amount.value = '3.14';

    // A pending send lands on this row via renderCreditsRow — the form must stay
    // with its values (WEB_INTERFACE → The wallet).
    const c2 = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'rejected', reason: 'send not sent.' },
    });
    renderCreditsRow(f, handlers(), c2);
    // Same form element, same values.
    expect(f.querySelector('form.credits-form')).toBe(form);
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    expect(inputs[0]!.value).toBe(REC);
    expect(inputs[1]!.value).toBe('3.14');
    // The flight slot shows the ending.
    expect(f.querySelector('.credits-flight')?.textContent).toContain('send not sent.');
  });

  it('resetCreditsSendForm clears the form after an accepted submission (READ-1 defect 3)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = creditsField(render(handlers(), c))!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = REC; inputs[1]!.value = '3.14';
    resetCreditsSendForm(f);
    expect(inputs[0]!.value).toBe('');
    expect(inputs[1]!.value).toBe('');
  });

  it('renderCreditsRow builds a form when the spendable side turns from zero to non-zero', () => {
    // Empty at first — no form.
    const empty = creditsCtx();
    const body = render(handlers(), empty);
    const f = creditsField(body)!;
    expect(f.querySelector('form.credits-form')).toBeNull();
    // A grant lands: credits now hold a box; the update owes a fresh form.
    const withCredits = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    renderCreditsRow(f, handlers(), withCredits);
    expect(f.querySelector('form.credits-form')).not.toBeNull();
  });

  // The layout — the recipient on its own line, the amount and the boxed `send`
  // on one line inside .amount-row. The box is the primary action's, the same
  // classes the composer's `post` and the feed's `new post` wear (WEB_INTERFACE
  // → The wallet window → "The `send` row"; HOUSE_STYLE → Interaction → "A
  // box marks a commit pair and a surface's primary action").
  describe('the send form — the recipient above, the amount and the boxed send on one line', () => {
    const spendableCtx = (): WalletCtx => creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });

    it('the amount input and the send button share .amount-row; the recipient sits above it', () => {
      const f = creditsField(render(handlers(), spendableCtx()))!;
      const form = f.querySelector('form.credits-form') as HTMLFormElement;
      const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
      const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
      const send = [...form.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement;
      const row = form.querySelector('.amount-row') as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.contains(amount)).toBe(true);
      expect(row.contains(send)).toBe(true);
      // The recipient sits above the row — it is not itself a child of it.
      expect(row.contains(to)).toBe(false);
    });

    it('the send button carries btn btn-primary and type=submit — the primary action\'s box', () => {
      const f = creditsField(render(handlers(), spendableCtx()))!;
      const form = f.querySelector('form.credits-form') as HTMLFormElement;
      const send = [...form.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement;
      expect(send.type).toBe('submit');
      expect(send.classList.contains('btn')).toBe(true);
      expect(send.classList.contains('btn-primary')).toBe(true);
    });

    it('under the app stylesheet the row computes display: flex', () => {
      const style = document.createElement('style');
      style.textContent = appCss;
      document.head.appendChild(style);
      const body = render(handlers(), spendableCtx());
      document.body.appendChild(body);
      const f = creditsField(body)!;
      const row = f.querySelector('form.credits-form .amount-row') as HTMLElement;
      const s = window.getComputedStyle(row);
      expect(s.display).toBe('flex');
      document.body.removeChild(body);
      document.head.removeChild(style);
    });
  });
});

// ---------------------------------------------------------------------------
// The extension arm — WEB_INTERFACE → The wallet window →
// "in the extension there is no confirm row". `confirmInRow: false` — the
// confirm row does not build; the form hands the App the press once its amount
// and recipient are read, and the row draws the answer the App holds: the key
// beneath the recipient field in mono, whole, or the refusal in its line, and
// after the form the unlock row a locked identity owes. The press itself —
// the check, the unlock, the flow — is pinned through the App in
// app-send-check.test.ts.
// ---------------------------------------------------------------------------

function extForm(f: HTMLElement): { form: HTMLFormElement; to: HTMLInputElement; amount: HTMLInputElement } {
  const form = f.querySelector('form.credits-form') as HTMLFormElement;
  return {
    form,
    to: form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!,
    amount: form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!,
  };
}

describe('wallet — the send flow, extension arm (confirmInRow: false)', () => {
  it('a handle: the form hands the App the press — the name less its `@`, the amount in base units — and builds no confirm row', async () => {
    const pressed: Array<[SendRecipient, bigint]> = [];
    const resolved: string[] = [];
    const sent: unknown[] = [];
    const h = handlers({
      pressSend: (to, a) => pressed.push([to, a]),
      resolveRecipient: async (t) => { resolved.push(t); return { key: REC, name: REC_NAME }; },
      send: (...args) => sent.push(args),
    });
    const f = creditsField(render(h, extCtx()))!;
    const { form, to, amount } = extForm(f);
    to.value = '@bob'; amount.value = '12.5';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(f.querySelector('.pf-confirm')).toBeNull();
    expect(pressed).toEqual([[{ name: 'bob' }, 1_250_000_000n]]);
    // The App resolves and sends; the form does neither and draws no key itself.
    expect(resolved).toEqual([]);
    expect(sent).toEqual([]);
    expect(form.querySelector<HTMLElement>('.resolved-key')!.hidden).toBe(true);
  });

  it('a bare key: handed to the App as a key, lowercased', async () => {
    const pressed: Array<[SendRecipient, bigint]> = [];
    const h = handlers({ pressSend: (to, a) => pressed.push([to, a]) });
    const f = creditsField(render(h, extCtx()))!;
    const { form, to, amount } = extForm(f);
    to.value = 'FF'.repeat(32); amount.value = '3.14';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(f.querySelector('.pf-confirm')).toBeNull();
    expect(pressed).toEqual([[{ key: 'ff'.repeat(32) }, 314_000_000n]]);
  });

  it('a refusal of the form\'s own — the amount, a recipient neither key nor name — hands the App nothing', async () => {
    const pressed: unknown[] = [];
    const h = handlers({ pressSend: (...args) => pressed.push(args) });
    const f = creditsField(render(h, extCtx()))!;
    const { form, to, amount } = extForm(f);
    const refusal = form.querySelector<HTMLElement>('.pf-refusal')!;
    to.value = '@bob'; amount.value = '0';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(refusal.textContent).toBe('an amount is digits with up to eight decimals.');
    to.value = '@not a name'; amount.value = '1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(refusal.textContent).toBe('that is not a key or a name.');
    expect(pressed).toEqual([]);
  });

  it('every press opens with beginSendPress, in either build', async () => {
    for (const confirmInRow of [false, true]) {
      let begun = 0;
      const h = handlers({ beginSendPress: () => { begun += 1; return true; } });
      const { form, to, amount } = extForm(creditsField(render(h, extCtx({ confirmInRow })))!);
      to.value = '@bob'; amount.value = '';
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      await flush();
      expect(begun).toBe(1);
    }
  });

  it('the key the App holds stands beneath the recipient field — whole, in mono — the refusal line hidden', () => {
    const f = creditsField(render(handlers(), extCtx({ sendAnswer: { key: REC, unlock: null } })))!;
    const { form } = extForm(f);
    const key = form.querySelector<HTMLElement>('.resolved-key')!;
    expect(key.hidden).toBe(false);
    expect(key.textContent).toBe(REC);
    expect(key.classList.contains('mono')).toBe(true);
    expect(form.querySelector<HTMLElement>('.pf-refusal')!.hidden).toBe(true);
  });

  it('the refusal the App holds reads in the form\'s line, taking away the key a press before left beneath the field', () => {
    const f = creditsField(render(handlers(), extCtx({ sendAnswer: { key: REC, unlock: null } })))!;
    const { form } = extForm(f);
    renderCreditsRow(f, handlers(), extCtx({ sendAnswer: { refusal: 'no one holds that name.' } }));
    const refusal = form.querySelector<HTMLElement>('.pf-refusal')!;
    const key = form.querySelector<HTMLElement>('.resolved-key')!;
    expect(refusal.hidden).toBe(false);
    expect(refusal.textContent).toBe('no one holds that name.');
    expect(key.hidden).toBe(true);
    expect(key.textContent).toBe('');
  });

  it('with no answer held a render leaves the form\'s own lines as its press left them', async () => {
    const h = handlers();
    const f = creditsField(render(h, extCtx()))!;
    const { form, to, amount } = extForm(f);
    to.value = '@bob'; amount.value = 'x';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    renderCreditsRow(f, h, extCtx());
    const refusal = form.querySelector<HTMLElement>('.pf-refusal')!;
    expect(refusal.hidden).toBe(false);
    expect(refusal.textContent).toBe('an amount is digits with up to eight decimals.');
  });

  it('the unlock row the App holds stands after the form: a render in place leaves the same element, a rebuilt body moves it under its fresh form', () => {
    const row = sendUnlockRow(KEY, async () => {}, () => {});
    const c = extCtx({ sendAnswer: { key: REC, unlock: row } });
    const f = creditsField(render(handlers(), c))!;
    const { form } = extForm(f);
    expect(form.nextElementSibling).toBe(row);
    renderCreditsRow(f, handlers(), c);
    expect(form.nextElementSibling).toBe(row);
    expect(f.querySelectorAll('.card-unlock')).toHaveLength(1);
    const rebuilt = extForm(creditsField(render(handlers(), c))!).form;
    expect(rebuilt.nextElementSibling).toBe(row);
    expect(form.nextElementSibling).toBeNull();
  });

  it('sendUnlockRow: a `.card-unlock` row holding the unlock form for the key — the passphrase to onUnlock, `cancel` to onCancel', async () => {
    const unlocked: string[] = [];
    let cancelled = 0;
    const row = sendUnlockRow(KEY, async (p) => { unlocked.push(p); }, () => { cancelled += 1; });
    expect(row.className).toBe('card-unlock');
    const unlock = row.querySelector<HTMLFormElement>('form.pf')!;
    expect(unlock.querySelector<HTMLInputElement>('input[autocomplete="username"]')!.value).toBe(KEY);
    unlock.querySelector<HTMLInputElement>('input[type="password"]')!.value = 'pw';
    unlock.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(unlocked).toEqual(['pw']);
    button(row, 'cancel')!.click();
    expect(cancelled).toBe(1);
  });

  it('resetCreditsSendForm clears the resolved-key hint alongside the inputs', () => {
    // Fill the form and reveal the resolved-key line, then reset.
    const f = creditsField(render(handlers(), extCtx()))!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const key = form.querySelector<HTMLElement>('.resolved-key')!;
    key.textContent = REC;
    key.hidden = false;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = REC; inputs[1]!.value = '1';
    resetCreditsSendForm(f);
    expect(inputs[0]!.value).toBe('');
    expect(inputs[1]!.value).toBe('');
    expect(key.textContent).toBe('');
    expect(key.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// While a handle's check runs — WEB_INTERFACE → The wallet window → "The `send`
// row": in the extension the flight's place reads *checking @bob…* from the
// press to its answer, and a press during it does nothing. The App holds the
// check; the row reads it from `sendCheck` and a press from `beginSendPress`.
// ---------------------------------------------------------------------------

describe('wallet — the send row while a handle is checked', () => {
  it('the flight\'s place reads *checking @bob…* — the handle as the App holds it — in one stage line', () => {
    const f = creditsField(render(handlers(), extCtx({ sendCheck: '@BoB' })))!;
    const flight = f.querySelector<HTMLElement>('.credits-flight')!;
    expect(flight.children).toHaveLength(1);
    const line = flight.firstElementChild as HTMLElement;
    expect(line.tagName).toBe('DIV');
    expect(line.className).toBe('stage');
    expect(line.textContent).toBe('checking @BoB…');
  });

  it('the line stands alone in the flight\'s place, over the pending line and over an ending', () => {
    const pending = creditsField(render(handlers(), extCtx({
      sendCheck: '@bob',
      pendingSend: { toHex: REC, toName: 'alice', amount: 1_250_000_000n },
    })))!;
    expect(pending.querySelector('.credits-flight')?.textContent).toBe('checking @bob…');
    const ended = creditsField(render(handlers(), extCtx({
      sendCheck: '@bob',
      sendFlight: { stage: 'rejected', reason: 'send not sent.' },
    })))!;
    expect(ended.querySelector('.credits-flight')?.textContent).toBe('checking @bob…');
  });

  it('the send row stands while the check runs with no box spendable, its line alone', () => {
    const f = creditsField(render(handlers(), creditsCtx({ confirmInRow: false, sendCheck: '@bob' })))!;
    expect(f.querySelector<HTMLElement>(':scope > .send-row')?.hidden).toBe(false);
    expect(f.querySelector('.credits-flight')?.textContent).toBe('checking @bob…');
    expect(f.querySelector('form.credits-form')).toBeNull();
  });

  it('an in-place render follows the check — the line comes and goes — and leaves the form and its values standing', () => {
    const h = handlers();
    const f = creditsField(render(h, extCtx()))!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = '@bob'; inputs[1]!.value = '12.5';
    renderCreditsRow(f, h, extCtx({ sendCheck: '@bob' }));
    expect(f.querySelector('.credits-flight')?.textContent).toBe('checking @bob…');
    expect(f.querySelector('form.credits-form')).toBe(form);
    renderCreditsRow(f, h, extCtx());
    expect(f.querySelector('.credits-flight')?.textContent).toBe('');
    expect(f.querySelector('form.credits-form')).toBe(form);
    expect([inputs[0]!.value, inputs[1]!.value]).toEqual(['@bob', '12.5']);
  });

  it('a press while a check runs does nothing — a handle, a bad amount, a key — and the key beneath the field stands', async () => {
    let checking = false;
    const pressed: Array<[SendRecipient, bigint]> = [];
    const h = handlers({
      beginSendPress: () => !checking,
      pressSend: (to, a) => pressed.push([to, a]),
    });
    const f = creditsField(render(h, extCtx({ sendAnswer: { key: REC, unlock: null } })))!;
    const { form, to, amount } = extForm(f);
    const refusal = form.querySelector<HTMLElement>('.pf-refusal')!;
    const key = form.querySelector<HTMLElement>('.resolved-key')!;
    expect(key.textContent).toBe(REC);
    checking = true;
    for (const [t, a] of [['@carol', '2'], ['@carol', 'x'], ['ff'.repeat(32), '3']] as const) {
      to.value = t; amount.value = a;
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      await flush();
      expect(pressed).toEqual([]);
      expect(refusal.hidden).toBe(true);
      expect(key.hidden).toBe(false);
      expect(key.textContent).toBe(REC);
      expect([to.value, amount.value]).toEqual([t, a]);
    }
    // The check over, the next press is a press.
    checking = false;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(pressed).toEqual([[{ key: 'ff'.repeat(32) }, 300_000_000n]]);
  });

  it('a press while a check runs leaves a refusal line standing as it reads', async () => {
    let checking = false;
    const h = handlers({ beginSendPress: () => !checking });
    const f = creditsField(render(h, extCtx()))!;
    const { form, to, amount } = extForm(f);
    const refusal = form.querySelector<HTMLElement>('.pf-refusal')!;
    to.value = '@bob'; amount.value = '';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(refusal.hidden).toBe(false);
    expect(refusal.textContent).toBe('an amount is digits with up to eight decimals.');
    checking = true;
    amount.value = '1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(refusal.hidden).toBe(false);
    expect(refusal.textContent).toBe('an amount is digits with up to eight decimals.');
  });
});

// ---------------------------------------------------------------------------
// The verified-figures line beneath the balance (WEB_INTERFACE → The
// extension → "The verified figures", → The wallet window → "The `balance`
// row"). The pure model's rows are pinned in test/figures-line.test.ts; these
// tests pin the row's plumbing: the hint element renders under the figure,
// and under the full rule (row 4) the gold figure gains `.clay` alongside the
// hint. HOUSE_STYLE → Gold and clay are not interchangeable — gold gives way
// to clay only while the node's own proof of the balance fails.
// ---------------------------------------------------------------------------

const EMPTY_SUMS: LedgerSums = { proven: 0n, young: 0n, unchecked: 0n, absent: 0n };
const RECORD: IdentityRecord = {
  lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0,
  lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0,
  memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
};
function stubHeader(over: Partial<BlockHeader> = {}): BlockHeader {
  return {
    protocolVersion: 1, height: 9020, prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(32),
    validatorId: new Uint8Array(32) as UserId, powNonce: 0, powTargetBits: 0,
    createdAt: 0, interlinkRoot: '00'.repeat(32),
    ...over,
  };
}
function anchor(suffixHeight = 9005, tipHeight = 9020): Anchor {
  return {
    tip: stubHeader({ height: tipHeight }),
    suffixHead: { header: stubHeader({ height: suffixHeight }), interlinks: [] },
  };
}
function figBox(over: Partial<FigureBox> & Pick<FigureBox, 'boxClass' | 'status'>): FigureBox {
  return { boxId: 'a'.repeat(64), value: 0n, lockedUntilBlock: null, verdict: 'test', ...over };
}
function figuresView(result: Partial<FiguresResult> = {}, suffixHeight = 9005): FiguresView {
  return {
    result: {
      boxes: [],
      record: { status: 'proven', record: RECORD } as RecordResult,
      karma: { ...EMPTY_SUMS, effective: 0n },
      credits: { ...EMPTY_SUMS },
      heightAfter: 9020,
      failed: false,
      ...result,
    },
    anchor: anchor(suffixHeight),
  };
}
const VERIFIED: TipVerdict = { kind: 'verified', nodes: 2, height: 9020 };
const THIN: TipVerdict = { kind: 'thin', reason: 'no-proof', height: null };

describe('wallet — the verified-figures line beneath the balance', () => {
  const SPENDABLE_BOX = { boxId: 'a'.repeat(64), value: '1250000000' }; // 12.5 $NOTIS
  const spendableCtx = (over: Partial<WalletCtx> = {}): WalletCtx => creditsCtx({
    credits: creditsResult({ boxes: [SPENDABLE_BOX], boxCount: 1 }),
    ...over,
  });

  it('the default web ctx (no verifier) renders no verified-figures hint', () => {
    // Rows 1 — verdict === undefined — is silence. The gold figure carries no
    // .clay, and no .hint sits beneath the credits-line.
    const f = creditsField(render(handlers(), spendableCtx()))!;
    const gold = f.querySelector<HTMLElement>('.mono.gold')!;
    expect(gold.classList.contains('clay')).toBe(false);
    expect(f.querySelector('.credits-line .hint')).toBeNull();
  });

  it('a verified verdict + a proven+young result renders a muted hint, no .clay on the figure (row 7)', () => {
    // 12.5 shown, 8.75 proven + 3.75 young.
    const fv = figuresView({
      boxes: [
        figBox({ boxClass: 'credit', status: 'proven', value: 875_000_000n }),
        figBox({ boxClass: 'credit', status: 'young',  value: 375_000_000n }),
      ],
      credits: { proven: 875_000_000n, young: 375_000_000n, unchecked: 0n, absent: 0n },
    });
    const c = spendableCtx({ verdict: VERIFIED, figures: fv });
    const f = creditsField(render(handlers(), c))!;
    const hint = f.querySelector<HTMLElement>('.credits-line .hint');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe('8.75 $NOTIS proven at block 9005 · 3.75 $NOTIS landed since');
    expect(hint!.classList.contains('clay')).toBe(false);
    const gold = f.querySelector<HTMLElement>('.mono.gold')!;
    expect(gold.classList.contains('clay')).toBe(false);
    // The figure itself is unchanged.
    expect(gold.textContent).toBe('12.5');
  });

  it('an unproven credit box → the full rule: clay hint AND clay class on the gold figure (row 4)', () => {
    const fv = figuresView({
      boxes: [figBox({ boxClass: 'credit', status: 'unproven', value: 1_250_000_000n })],
      credits: { ...EMPTY_SUMS },
    });
    const c = spendableCtx({ verdict: VERIFIED, figures: fv });
    const f = creditsField(render(handlers(), c))!;
    const hint = f.querySelector<HTMLElement>('.credits-line .hint');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe("this node's proof of the balance did not verify");
    expect(hint!.classList.contains('clay')).toBe(true);
    const gold = f.querySelector<HTMLElement>('.mono.gold')!;
    expect(gold.classList.contains('clay')).toBe(true);
    // The figure itself never changes.
    expect(gold.textContent).toBe('12.5');
  });

  it('an absent credit sum → clay "the node lists N $NOTIS the chain does not hold"', () => {
    const fv = figuresView({
      boxes: [figBox({ boxClass: 'credit', status: 'absent', value: 1_250_000_000n })],
      credits: { ...EMPTY_SUMS, absent: 1_250_000_000n },
    });
    const c = spendableCtx({ verdict: VERIFIED, figures: fv });
    const f = creditsField(render(handlers(), c))!;
    const hint = f.querySelector<HTMLElement>('.credits-line .hint');
    expect(hint?.textContent).toBe('the node lists 12.5 $NOTIS the chain does not hold');
    expect(hint?.classList.contains('clay')).toBe(true);
    expect(f.querySelector<HTMLElement>('.mono.gold')!.classList.contains('clay')).toBe(true);
  });

  it('a thin verdict with no figures back → the unverified line (row 3), muted, no clay on the figure', () => {
    const c = spendableCtx({ verdict: THIN, figures: null });
    const f = creditsField(render(handlers(), c))!;
    const hint = f.querySelector<HTMLElement>('.credits-line .hint');
    expect(hint?.textContent).toBe('not checked — the chain is not verified');
    expect(hint?.classList.contains('clay')).toBe(false);
    expect(f.querySelector<HTMLElement>('.mono.gold')!.classList.contains('clay')).toBe(false);
  });

  it('every proven and the number reproduces → no hint (row 6 silence)', () => {
    const fv = figuresView({
      boxes: [figBox({ boxClass: 'credit', status: 'proven', value: 1_250_000_000n })],
      credits: { ...EMPTY_SUMS, proven: 1_250_000_000n },
    });
    const c = spendableCtx({ verdict: VERIFIED, figures: fv });
    const f = creditsField(render(handlers(), c))!;
    expect(f.querySelector('.credits-line .hint')).toBeNull();
    expect(f.querySelector<HTMLElement>('.mono.gold')!.classList.contains('clay')).toBe(false);
  });

  it('a wallet whose boxes are all locked still renders the verified-figures line — a fake locked box reads clay', () => {
    // No spendable box (all locked past height); c.boxCount > 0. The row falls
    // through the no-spendable branch (no gold figure) and appendFiguresLine
    // runs with shown = 0n. An unproven credit box reads the clay hint just as
    // it does in the spendable branch — the row now says what the run could
    // not prove (WEB_INTERFACE → The extension → "The verified figures" —
    // "a wallet whose boxes are all locked shows the faucet step … and no
    // line, so a fake locked box passes unremarked" — the finding this test
    // pins the fix for).
    const c = creditsCtx({
      status: statusAt(1000),
      credits: creditsResult({
        boxes: [{ boxId: 'b'.repeat(64), value: '900000000', lockedUntilBlock: 20_000 }],
        boxCount: 1,
      }),
      verdict: VERIFIED,
      figures: figuresView({
        boxes: [figBox({
          boxClass: 'credit',
          status: 'unproven',
          value: 900_000_000n,
          lockedUntilBlock: 20_000,
        })],
        credits: { ...EMPTY_SUMS },
      }),
    });
    const f = creditsField(render(handlers(), c))!;
    // No gold figure — the row is in the no-spendable branch.
    expect(f.querySelector('.mono.gold')).toBeNull();
    // The locked hint stands, and the verified-figures clay hint stands
    // beside it.
    const hints = f.querySelectorAll<HTMLElement>('.credits-line .hint');
    expect(hints.length).toBe(2);
    expect(hints[0]!.textContent).toContain('$NOTIS more unlock by block');
    expect(hints[1]!.textContent).toBe("this node's proof of the balance did not verify");
    expect(hints[1]!.classList.contains('clay')).toBe(true);
  });

  it('the locked hint stands beside the verified-figures hint when both fire', () => {
    // A spendable box + a locked box + a verified figure with a young remainder:
    // both the locked hint and the verified hint sit inside .credits-line.
    const c = creditsCtx({
      credits: creditsResult({
        boxes: [
          { boxId: 'a'.repeat(64), value: '1250000000' },
          { boxId: 'b'.repeat(64), value: '500000000', lockedUntilBlock: 20_000 },
        ],
        boxCount: 2,
      }),
      verdict: VERIFIED,
      figures: figuresView({
        boxes: [
          figBox({ boxClass: 'credit', status: 'proven', value: 875_000_000n }),
          figBox({ boxClass: 'credit', status: 'young',  value: 375_000_000n }),
        ],
        credits: { proven: 875_000_000n, young: 375_000_000n, unchecked: 0n, absent: 0n },
      }),
    });
    const f = creditsField(render(handlers(), c))!;
    const hints = f.querySelectorAll<HTMLElement>('.credits-line .hint');
    expect(hints.length).toBe(2);
    // The locked hint is first (it renders before the verified line) —
    // WEB_INTERFACE → The wallet window → "The `balance` row".
    expect(hints[0]!.textContent).toContain('$NOTIS more unlock by block');
    expect(hints[1]!.textContent).toContain('proven at block 9005');
  });
});

describe('app.css — the verified-figures clay rules', () => {
  // Read the stylesheet the same way test/style.test.ts does — lexical pins,
  // no computed style (happy-dom has no CSSOM). One rule per line.
  it('.winbody .hint.clay reads clay from --clay', () => {
    expect(appCss).toMatch(/\.winbody \.hint\.clay\s*\{[^}]*color: var\(--clay\)/);
  });
  it('.mono.clay reads clay from --clay', () => {
    expect(appCss).toMatch(/\.mono\.clay\s*\{[^}]*color: var\(--clay\)/);
  });
  it('.mono.clay is declared AFTER .gold so .mono.gold.clay renders clay (hypothesis 2)', () => {
    const goldIdx = appCss.indexOf('.gold { color: var(--gold);');
    const clayIdx = appCss.indexOf('.mono.clay { color: var(--clay);');
    expect(goldIdx).toBeGreaterThan(-1);
    expect(clayIdx).toBeGreaterThan(-1);
    expect(clayIdx).toBeGreaterThan(goldIdx);
  });
});