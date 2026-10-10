import { el, shortHex, endForm } from '../dom';
import { prefs } from '../prefs';
import { unlockForm } from './passphrase';
import { stageLine, type Flight } from './card';
import { isValidUsernameBytes } from '@dagsocial/types';
import { formatCredits, parseCredits } from '../model/credits';
import { spendableCreditBoxes, lockedCreditSummary } from '../wallet/reads';
import { figuresLine } from '../model/figures-line';
import type { FiguresView, WindowBody } from '../model/state';
import type { TipVerdict } from '../model/tip-verdict';
import type { CreditsResult, StatusResult } from '../api/dto';

// The @wallet window — WEB_INTERFACE → The wallet window. Everything $NOTIS
// lives here and on no profile: one .credits-field wrapping the `balance` and
// `send` rows. The slot classes — .credits-line, .credits-form, .credits-flight,
// .resolved-key, .amount-row, .pf-confirm, .card-unlock — the harness's
// selectors reach the row through them.
//
// The body is one node from the window's open to its close (WEB_INTERFACE →
// The workspace → "A window's body stands while the window is open"). Its
// `update` draws the balance line and the flight's place from the state it
// reads, and leaves the send form, what is typed in it and the confirm row
// alone; the form is added once a box is spendable and ends, with the confirm
// row, once none is (→ "A draw updates a standing body in place"). The form
// and the confirm row read the state through `read` when pressed (→ "A
// window's controls act on the state as it stands at the press").
//
// The window declares the narrow shapes it reads and calls; the App's Handlers and
// RenderCtx satisfy them structurally, so there is one contract, not two.

/** The recipient the send form resolved at the press: a key with an optional
 *  handle (WEB_INTERFACE → The wallet window → "The `send` row"). A handle read
 *  that came back empty is a refusal, so this is the success shape. */
export type ResolvedRecipient = { key: string; name: string | null };

/** Who a press sends to, as the form read it: a 64-hex key, or a well-formed
 *  handle with one leading `@` stripped, resolved at the press
 *  (WEB_INTERFACE → The wallet window → "The `send` row"). */
export type SendRecipient = { key: string } | { name: string };

/** The answer the App gives a press in the extension, held until the next press
 *  begins: a refusal, or the key the send goes to — with the unlock row the App
 *  holds while a locked identity owes the unlock before that send
 *  (WEB_INTERFACE → The wallet window → "The `send` row"). */
export type SendAnswer = { refusal: string } | { key: string; unlock: HTMLElement | null };

/** How a $NOTIS faucet grant reads while it stands or after it lapses
 *  (WEB_INTERFACE → The faucet step). */
export type GrantView = { state: 'pending' } | { state: 'expired'; atHeight: number };

export interface WalletHandlers {
  // The send form (WEB_INTERFACE → The wallet window → "The `send` row").
  // beginSendPress opens every press: false while the extension checks a handle
  // — the press then does nothing, so one press is one check — and otherwise it
  // drops the answer the press before left and the ending the send before left
  // in the flight's place, in either build. In the extension pressSend hands
  // the App the press once its amount and recipient are read: the check, the
  // answer, the unlock a locked identity owes and the flow are the App's, and
  // the row draws each from it. The web build resolves a handle through
  // resolveRecipient and confirms in the row before `send`.
  beginSendPress: () => boolean;
  pressSend: (to: SendRecipient, amount: bigint) => void;
  resolveRecipient: (text: string) => Promise<ResolvedRecipient | { refusal: string }>;
  send: (toHex: string, toName: string | null, amount: bigint) => void;
  askFaucetCredits: () => void;
  unlockIdentity: (passphrase: string) => Promise<void>;
}

export interface WalletCtx {
  identity: { pubKeyHex: string; locked: boolean } | null;
  // credits null before the first read; sendFlight is the transient ending;
  // pendingSend the ledger entry that survives a reload; creditGrant a faucet
  // transfer in flight or one that lapsed; sendCheck the handle a press's
  // check runs for, `@` and the name as typed, which the flight's place reads
  // while it stands; sendAnswer the answer the App gave the press before, which
  // the form's lines read (WEB_INTERFACE → The wallet window → "The `send`
  // row"). status null before a /status answer stands; its blockHeight is the
  // tip the row's spendable-at-height filter reads (WEB_INTERFACE → The wallet),
  // and the faucet step, *no $NOTIS yet.* and a lapsed grant's `ask again` wait
  // for it (→ The wallet window → "The `balance` row").
  status: StatusResult | null;
  credits: CreditsResult | null;
  creditGrant: GrantView | null;
  sendFlight: Flight | null;
  pendingSend: { toHex: string; toName: string | null; amount: bigint } | null;
  sendCheck: string | null;
  sendAnswer: SendAnswer | null;
  // The send row's confirm — true on the web (the confirm row stands in the
  // form's slot), false in the extension (the prompt is the one confirmation —
  // WEB_INTERFACE → The wallet window → "The `send` row"). The App fills it
  // `!this.idm.policy`: the in-page module has no policy, the proxy has.
  confirmInRow: boolean;
  // The extension's verified-figures run — WEB_INTERFACE → The extension →
  // "The verified figures". `verdict === undefined` when the build has no
  // verifier, `null` while none has returned; `figures` is null until a run's
  // result lands. The pure `figuresLine` reads the three fields together and
  // the balance row renders the muted line beneath the figure, adding `clay`
  // to the hint and to the gold span under the full rule (→ "The `balance`
  // row").
  verdict: TipVerdict | null | undefined;
  figures: FiguresView | null;
}

function row(label: string): { row: HTMLElement; field: HTMLElement } {
  const r = el('div', 'row');
  r.appendChild(el('label', null, label));
  const field = el('div', 'field');
  r.appendChild(field);
  return { row: r, field };
}

function mono(text: string): HTMLElement {
  return el('span', 'mono', text);
}

/** The wallet window's body: `update` draws it from the state as it stands,
 *  and `resetSend` empties the send form — the one ending that clears it, an
 *  accepted submission (WEB_INTERFACE → The wallet window → "The form keeps its
 *  values on every ending but an accepted submission, which clears it"). */
export interface WalletBody extends WindowBody {
  resetSend(): void;
}

/** The @wallet window — WEB_INTERFACE → The wallet window. With no identity, one
 *  lead line pointing to the profile window; with one, the `.credits-field`
 *  wrapper carries the `balance` and `send` rows. `read` answers the state as
 *  it stands when called. The body is built for the identity `read` answers —
 *  a key, or none — and a draw that reads another builds it anew, ending every
 *  form in it. */
export function walletBody(handlers: WalletHandlers, read: () => WalletCtx): WalletBody {
  const b = el('div', 'winbody');
  let builtFor: string | null = null;
  let rows: CreditsRows | null = null;
  const build = (ctx: WalletCtx): void => {
    for (const field of b.querySelectorAll('input')) field.value = '';
    b.replaceChildren();
    builtFor = ctx.identity?.pubKeyHex ?? null;
    if (ctx.identity === null) {
      rows = null;
      b.appendChild(el('div', 'pf-lead', 'no identity in this browser. the profile window creates or imports one.'));
    } else {
      rows = creditsRows(b, handlers, read);
      rows.update(ctx);
    }
  };
  build(read());
  return {
    el: b,
    update: () => {
      const ctx = read();
      if ((ctx.identity?.pubKeyHex ?? null) !== builtFor) build(ctx);
      else rows?.update(ctx);
    },
    resetSend: () => rows?.resetSend(),
  };
}

function sumValues(boxes: readonly { value: string }[]): bigint {
  let s = 0n;
  for (const b of boxes) s += BigInt(b.value);
  return s;
}

/** A refusal in the form's line, taking away the key a press before it left
 *  beneath the field — that line names the key a send goes to
 *  (WEB_INTERFACE → The wallet window → "The `send` row"). */
function refuseIn(refusal: HTMLElement, resolvedKey: HTMLElement, text: string): void {
  resolvedKey.textContent = '';
  resolvedKey.hidden = true;
  refusal.textContent = text;
  refusal.hidden = false;
}

/** Write the answer the App holds into the send form standing in its slot
 *  (WEB_INTERFACE → The wallet window → "The `send` row"): a refusal in its
 *  line, or the key the send goes to beneath the field, whole, in mono — and
 *  after the form the unlock row the App holds while a locked identity owes
 *  it, the same node at every draw, so what is typed in it stands. With no
 *  answer held the two lines stand as the form's own press left them. */
function showSendAnswer(form: HTMLFormElement | null, answer: SendAnswer | null): void {
  if (answer === null || form === null) return;
  const refusal = form.querySelector<HTMLElement>('.pf-refusal')!;
  const resolvedKey = form.querySelector<HTMLElement>('.resolved-key')!;
  if ('refusal' in answer) {
    refuseIn(refusal, resolvedKey, answer.refusal);
    return;
  }
  resolvedKey.textContent = answer.key;
  resolvedKey.hidden = false;
  if (answer.unlock !== null && form.nextElementSibling !== answer.unlock) form.after(answer.unlock);
}

/** The unlock a locked identity owes before the send a press made — the row
 *  the App holds and the send row mounts after its form
 *  (WEB_INTERFACE → The wallet window → "The `send` row"). */
export function sendUnlockRow(
  pubKeyHex: string,
  onUnlock: (passphrase: string) => Promise<void>,
  onCancel: () => void,
): HTMLElement {
  const row = el('div', 'card-unlock');
  row.appendChild(unlockForm(pubKeyHex, onUnlock, onCancel));
  return row;
}

/** Append the verified-figures line beneath the balance figure — a `div.hint`,
 *  clay under the full rule (WEB_INTERFACE → The extension → "The verified
 *  figures", HOUSE_STYLE → Gold and clay are not interchangeable). `goldSpan`
 *  is the gold figure whose ink flips clay under the full rule; a locked-
 *  wallet branch has no gold to flip and passes null. */
function appendFiguresLine(
  line: HTMLElement,
  ctx: WalletCtx,
  boxCount: number,
  height: number,
  shown: bigint,
  goldSpan: HTMLElement | null,
): void {
  const fLine = figuresLine({
    ledger: 'credits',
    verdict: ctx.verdict,
    result: ctx.figures?.result ?? null,
    shown,
    suffixHeight: ctx.figures?.anchor.suffixHead.header.height ?? null,
    boxCount,
    height,
  });
  if (fLine === null) return;
  const hint = el('div', 'hint');
  hint.textContent = fLine.text;
  if (fLine.weight === 'clay') {
    hint.classList.add('clay');
    if (goldSpan !== null) goldSpan.classList.add('clay');
  }
  line.appendChild(hint);
}

/** The two rows as the body holds them. */
interface CreditsRows {
  update(ctx: WalletCtx): void;
  resetSend(): void;
}

/** What a press on the send form read, for the confirm row. */
interface Built {
  toHex: string;
  toName: string | null;
  amount: bigint;
}

/** The send form, and `reset`, which empties it. */
interface SendForm {
  el: HTMLFormElement;
  reset(): void;
}

function creditsRows(b: HTMLElement, handlers: WalletHandlers, read: () => WalletCtx): CreditsRows {
  const field = el('div', 'field credits-field');
  const { row: balanceRow, field: balanceField } = row('balance');
  balanceRow.classList.add('balance-row');
  const line = el('div', 'credits-line');
  balanceField.appendChild(line);
  field.appendChild(balanceRow);
  const { row: sendRow, field: sendField } = row('send');
  sendRow.classList.add('send-row');
  const formSlot = el('div', 'credits-form');
  const flight = el('div', 'credits-flight');
  sendField.append(formSlot, flight);
  sendRow.hidden = true; // update shows the row by one predicate
  field.appendChild(sendRow);
  b.appendChild(field);

  // The send form is one node while a box is spendable: the confirm row takes
  // its place in the slot and `keep` puts it back, its values as they were.
  let form: SendForm | null = null;
  let confirm: { wrap: HTMLElement; unlock: boolean } | null = null;

  const restoreForm = (): void => {
    if (confirm === null) return;
    endForm(confirm.wrap);
    confirm = null;
    if (form !== null) formSlot.replaceChildren(form.el);
  };
  const endSend = (): void => {
    if (confirm !== null) endForm(confirm.wrap);
    confirm = null;
    if (form !== null) endForm(form.el);
    form = null;
    formSlot.replaceChildren();
  };

  /** The confirm row for a send — the burn's pattern. `keep` and Esc put the
   *  form back with its values; `send` reads the lock when pressed, and a
   *  locked identity unlocks in the row's place first. The prefix is 16 glyphs
   *  (WEB_INTERFACE → The identity display). */
  const openConfirm = (built: Built): void => {
    const wrap = el('div', 'pf-confirm');
    const q = el('div', 'pf-refusal');
    const amount = formatCredits(built.amount);
    const prefix = shortHex(built.toHex, 16);
    if (built.toName !== null) {
      q.append('send ', amount, ' $NOTIS to @' + built.toName + ' · ', mono(prefix), '?');
    } else {
      q.append('send ', amount, ' $NOTIS to ', mono(prefix), '?');
    }
    wrap.appendChild(q);
    const actions = el('div', 'pf-actions');
    const sendBtn = el('button', 'word', 'send') as HTMLButtonElement;
    const keep = el('button', 'word', 'keep') as HTMLButtonElement;
    // The form returns with its values before the flight begins — every
    // ending but an accepted submission leaves them intact (WEB_INTERFACE →
    // The wallet).
    const go = (): void => {
      restoreForm();
      handlers.send(built.toHex, built.toName, built.amount);
    };
    sendBtn.addEventListener('click', () => {
      const asked = confirm;
      if (asked === null) return;
      const id = read().identity;
      if (id?.locked !== true) {
        go();
        return;
      }
      asked.unlock = true;
      wrap.replaceChildren(
        unlockForm(
          id.pubKeyHex,
          async (p) => {
            await handlers.unlockIdentity(p);
            go();
          },
          restoreForm,
        ),
      );
    });
    keep.addEventListener('click', restoreForm);
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') restoreForm();
    });
    actions.append(sendBtn, keep);
    wrap.appendChild(actions);
    confirm = { wrap, unlock: false };
    formSlot.replaceChildren(wrap);
    keep.focus();
  };

  const update = (ctx: WalletCtx): void => {
    const c = ctx.credits;
    const height = ctx.status?.blockHeight ?? 0;
    // Spendable at the current tip — WEB_INTERFACE → The wallet. The row and
    // readCreditContext read one implementation of the rule.
    const spendable = c === null ? 0n : sumValues(spendableCreditBoxes(c.boxes, height));

    // The form stands while a box is spendable and ends once none is.
    if (spendable > 0n) {
      if (form === null) {
        form = sendForm(handlers, read, openConfirm);
        formSlot.replaceChildren(form.el);
      }
    } else {
      endSend();
    }
    // The unlock in the confirm row's place ends once the identity reads
    // unlocked, wherever the unlock was made.
    if (confirm !== null && confirm.unlock && ctx.identity?.locked !== true) restoreForm();

    line.replaceChildren();
    if (c === null) {
      line.appendChild(el('span', 'inkmute', '—'));
    } else if (spendable > 0n) {
      // Balance in gold + "$NOTIS"; the locked-hint beneath names only what is
      // above the current height (WEB_INTERFACE → The wallet window). The
      // extension's verified-figures line follows, muted or clay by the pure
      // model's row (→ "The verified figures").
      const goldSpan = el('span', 'mono gold', formatCredits(spendable));
      line.append(goldSpan, ' $NOTIS');
      const locked = lockedCreditSummary(c.boxes, height);
      if (locked) {
        const hint = el('div', 'hint');
        hint.append(mono(formatCredits(locked.value)), ' $NOTIS more unlock by block ', mono(String(locked.height)), '.');
        line.appendChild(hint);
      }
      appendFiguresLine(line, ctx, c.boxCount, height, spendable, goldSpan);
    } else {
      // No box spendable at the /status height → the faucet step when a faucet is
      // set, else "no $NOTIS yet." — both, and the lapsed grant's `ask again`, only
      // once a /status answer stands, since a grant records the highest tip the
      // client has read; until then `—` stands in their place. A grant in flight
      // or one that lapsed reads its own line (WEB_INTERFACE → The wallet window →
      // "The `balance` row", → The faucet step). The locked hint still stands so
      // the reader knows what is on its way.
      const locked = lockedCreditSummary(c.boxes, height);
      if (ctx.creditGrant?.state === 'pending') {
        line.appendChild(el('span', 'inkmute', 'working…'));
      } else if (ctx.creditGrant?.state === 'expired') {
        line.appendChild(el('span', 'inkmute', "no block took the faucet's transfer by height "));
        line.appendChild(mono(String(ctx.creditGrant.atHeight)));
        line.appendChild(document.createTextNode('. '));
        if (ctx.status !== null) {
          const again = el('button', 'word', 'ask again') as HTMLButtonElement;
          again.addEventListener('click', () => handlers.askFaucetCredits());
          line.appendChild(again);
        }
      } else if (ctx.status === null) {
        line.appendChild(el('span', 'inkmute', '—'));
      } else if (prefs.faucet !== '') {
        const ask = el('button', 'word', 'ask the faucet for $NOTIS') as HTMLButtonElement;
        ask.addEventListener('click', () => handlers.askFaucetCredits());
        line.appendChild(ask);
      } else {
        line.appendChild(el('span', 'inkmute', 'no $NOTIS yet.'));
      }
      if (locked) {
        const hint = el('div', 'hint');
        hint.append(mono(formatCredits(locked.value)), ' $NOTIS more unlock by block ', mono(String(locked.height)), '.');
        line.appendChild(hint);
      }
      // The verified-figures line stands beneath every state this branch reads
      // — the faucet step, *no $NOTIS yet.*, a grant's *working…*, a lapsed
      // grant's line, and a listing whose boxes are all locked at `height` —
      // so the ledger's own facts (`holdings` and `unlisted`) reach the reader
      // there, and a fabricated locked box does not pass unremarked
      // (WEB_INTERFACE → The extension → "The verified figures" — "An empty
      // listing takes these lines as any listing does"; → The wallet window →
      // "A listing with no box reads its line too"). `shown` is 0 here, with
      // no gold to turn clay.
      appendFiguresLine(line, ctx, c.boxCount, height, 0n, null);
    }

    showSendAnswer(form !== null && confirm === null ? form.el : null, ctx.sendAnswer);

    // While a press's check runs the flight's place reads *checking @bob…* and
    // nothing else — the handle as typed, in the flight line's element and voice
    // (WEB_INTERFACE → The wallet window → "The `send` row"). The pending line
    // reads from the ledger — durable across a reload. The row renders it
    // directly rather than through stageLine, which prints only "submitted" on
    // that stage and would lose the amount and recipient (WEB_INTERFACE → The
    // wallet window; the identity display's 16-glyph prefix, → The identity
    // display).
    flight.replaceChildren();
    const ps = ctx.pendingSend;
    if (ctx.sendCheck !== null) {
      flight.appendChild(el('div', 'stage', `checking ${ctx.sendCheck}…`));
    } else if (ps !== null) {
      const who = ps.toName !== null ? '@' + ps.toName : shortHex(ps.toHex, 16);
      const l = el('div', 'stage');
      l.textContent = `${formatCredits(ps.amount)} $NOTIS to ${who} · submitted`;
      flight.appendChild(l);
    } else if (ctx.sendFlight) {
      if (ctx.sendFlight.stage === 'landed') {
        flight.appendChild(el('div', 'stage', 'sent'));
      } else {
        flight.appendChild(stageLine(ctx.sendFlight));
      }
    }

    // The `send` row stands while a box is spendable, and while a send's own
    // line stands — its check, its flight, the pending line, *sent* — so a send
    // of the whole balance still reads its ending (WEB_INTERFACE → The wallet
    // window → "The `send` row"). One predicate, read here.
    sendRow.hidden = !(spendable > 0n || ctx.pendingSend !== null || ctx.sendFlight !== null || ctx.sendCheck !== null);
  };

  return { update, resetSend: () => form?.reset() };
}

/** The send form — the recipient (a key or an @handle), the amount ($NOTIS
 *  through parseCredits, never `type=number` which drops decimals and refuses a
 *  locale), the word `send`, a refusal line, and the hint. On submit, unless the
 *  App is checking a handle: parse the amount, then the recipient — a 64-hex
 *  key, else an @handle stripped of one leading `@` and validated as a
 *  username. Without `confirmInRow` the extension hands the App the press from
 *  there, and the row draws its answer from what the App holds
 *  (WEB_INTERFACE → The wallet window → "in the extension there is no confirm row");
 *  with it, the web build resolves a handle at the press, refuses the reader's
 *  own key in place, and hands `confirm` what the press read. */
function sendForm(handlers: WalletHandlers, read: () => WalletCtx, confirm: (built: Built) => void): SendForm {
  const form = el('form', 'pf credits-form') as HTMLFormElement;

  const toInput = el('input') as HTMLInputElement;
  toInput.type = 'text';
  toInput.placeholder = 'a key or @handle';
  toInput.setAttribute('aria-label', 'the recipient — a 64-hex key or an @handle');
  toInput.autocomplete = 'off';
  toInput.autocapitalize = 'off';
  toInput.spellcheck = false;

  // The resolved-key line beneath the recipient — extension arm only, drawn
  // from the App's answer. It stands in the form, so `reset` clears it
  // alongside the inputs on an accepted submission.
  const resolvedKey = el('div', 'hint resolved-key mono');
  resolvedKey.hidden = true;

  const amountInput = el('input') as HTMLInputElement;
  amountInput.type = 'text';
  amountInput.setAttribute('inputmode', 'decimal');
  amountInput.placeholder = '$NOTIS';
  amountInput.setAttribute('aria-label', 'the amount in $NOTIS');
  amountInput.autocomplete = 'off';

  // The primary action's box, as the composer's `post` and the feed's `new post`
  // wear (HOUSE_STYLE → Interaction → "A box marks a commit pair and a surface's
  // primary action").
  const submit = el('button', 'btn btn-primary', 'send') as HTMLButtonElement;
  submit.type = 'submit';

  // The amount and the send on one line — the amount input a short field, since
  // an amount is never long (WEB_INTERFACE → The wallet window → "The `send` row").
  const amountRow = el('div', 'amount-row');
  amountRow.append(amountInput, submit);

  const refusal = el('div', 'pf-refusal');
  refusal.hidden = true;

  const hint = el('div', 'hint', '$NOTIS moves when a block takes the send, and a send cannot be undone.');

  form.append(toInput, resolvedKey, amountRow, refusal, hint);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submitForm();
  });

  const refuse = (text: string): void => refuseIn(refusal, resolvedKey, text);

  const submitForm = async (): Promise<void> => {
    // One press is one check: while a handle's check runs, a press does nothing
    // — the refusal line, the fields and the key beneath them stand as they are
    // (WEB_INTERFACE → The wallet window → "The `send` row").
    if (!handlers.beginSendPress()) return;
    refusal.hidden = true;
    // Amount first — a bad number never asks the network for a handle.
    const amount = parseCredits(amountInput.value);
    if (amount === null || amount === 0n) {
      refuse('an amount is digits with up to eight decimals.');
      return;
    }
    // Recipient: a bare 64 hex is a key; else an @handle (one leading @ stripped) validated as a username.
    const raw = toInput.value.trim();
    const asKey = raw.toLowerCase();
    let to: SendRecipient;
    if (/^[0-9a-f]{64}$/.test(asKey)) {
      to = { key: asKey };
    } else {
      const naked = raw.startsWith('@') ? raw.slice(1) : raw;
      if (!isValidUsernameBytes(new TextEncoder().encode(naked))) {
        refuse('that is not a key or a name.');
        return;
      }
      to = { name: naked };
    }
    if (!read().confirmInRow) {
      // The extension: the prompt is the one confirmation (WEB_INTERFACE → The
      // wallet window → "in the extension there is no confirm row"), and the
      // App takes the press from here.
      handlers.pressSend(to, amount);
      return;
    }
    // The web build: a handle resolved at the press, then the confirm row in
    // the form's slot.
    let toHex: string;
    let toName: string | null = null;
    if ('key' in to) {
      toHex = to.key;
    } else {
      const res = await handlers.resolveRecipient(to.name);
      if ('refusal' in res) {
        refuse(res.refusal);
        return;
      }
      toHex = res.key;
      toName = res.name;
    }
    if (toHex === read().identity?.pubKeyHex) {
      refuse('that is your own key.');
      return;
    }
    confirm({ toHex, toName, amount });
  };

  return {
    el: form,
    reset: () => {
      toInput.value = '';
      amountInput.value = '';
      refusal.hidden = true;
      resolvedKey.textContent = '';
      resolvedKey.hidden = true;
    },
  };
}
