import { el, shortHex, endForm, setText } from '../dom';
import { prefs } from '../prefs';
import { unlockForm, setPassphraseForm } from './passphrase';
import { stageLine, type Flight } from './card';
import { markHandle } from './name-handle';
import { INVITE_BOND_VEST_PER_LIKES, USERNAME_BURN_PRICE, isValidUsernameBytes } from '@dagsocial/types';
import { figuresLine } from '../model/figures-line';
import type { FiguresView, WindowBody } from '../model/state';
import type { TipVerdict } from '../model/tip-verdict';
import type { KarmaResult, BondsResult, UsernameResult } from '../api/dto';
import type { Origin } from '../model/workspace';

// The @profile window — WEB_INTERFACE → The profile window. The key's own
// rows — key, rep, invites, username, passphrase, export, forget — in the
// .winbody/.row/label/.field pattern. Everything $NOTIS is the wallet's
// (WEB_INTERFACE → The wallet window) and every preference the settings
// window's (WEB_INTERFACE → The settings window). No avatar and no identity
// colour: nothing here may invite a reader to check identity by colour
// (HOUSE_STYLE → Identity colour). The six operations are forms in place;
// each is a real <form> the browser's password manager can save from
// (→ passphrase.ts). The copy is the voice register (HOUSE_STYLE → Voice):
// what happens, never at the reader's expense, lowercase.
//
// The body is one node from the window's open to its close (WEB_INTERFACE →
// The workspace → "A window's body stands while the window is open"). Each row
// is built once and drawn by its `update`: the figures, lines and words from
// the state handed in, a form open in the row and a field with text in it left
// alone, a form added or ended only where the state has changed whether the
// row offers it (→ "A draw updates a standing body in place"). A control reads
// the state through `read` when it is pressed, never from the draw that made
// it (→ "A window's controls act on the state as it stands at the press"), and
// every form ends through `endForm` (→ "What ends a form in a window").
//
// The window declares the narrow shapes it reads and calls; the App's RenderCtx and
// Handlers satisfy them structurally, so there is one contract, not two.

/** How the faucet grant reads while it stands or after it lapses. */
export type GrantView = { state: 'pending' } | { state: 'expired'; atHeight: number };

export interface ProfileHandlers {
  // identity operations
  inspectFile: (text: string) => Promise<{ kind: 'clear' | 'encrypted'; pubKeyHex: string }>;
  draftIdentity: () => Promise<{ pubKeyHex: string }>; // a key held before the passphrase, so the form names it
  createIdentity: (passphrase: string) => Promise<void>; // seals and stores the drafted key
  discardDraft: () => void; // the reader cancelled create
  importIdentity: (text: string, passphrase: string) => Promise<void>;
  exportIdentity: (password: string) => Promise<void>;
  forgetIdentity: () => Promise<void>;
  lockIdentity: () => Promise<void>;
  unlockIdentity: (passphrase: string) => Promise<void>;
  askFaucet: () => void;
  // membership actions — the invites row (WEB_INTERFACE → The profile window)
  invite: (inviteeKey: string, bond: bigint) => void;
  openAuthor: (key: string, origin: Origin) => void; // a standing bond's invitee window
  vouch: (key: string) => void;                       // vouch a standing bond's invitee
  moreBonds: () => void;
  // The username row (WEB_INTERFACE → The username row).
  claimUsername: (name: string) => void;
  burnUsername: () => void;
}

export interface ProfileCtx {
  identity: { pubKeyHex: string; locked: boolean } | null;
  backedUp: boolean;
  karma: KarmaResult | null; // the loaded key's /karma, once read
  grant: GrantView | null; // a faucet grant in flight, or one that lapsed
  // The invites row (WEB_INTERFACE → The profile window).
  invite: { bondMin: string; bondMax: string; probationBlocks: number } | null; // from /status
  canAffordMinBond: boolean;   // the spendable covers the minimum bond
  bonds: BondsResult | null;   // the reader's standing bonds
  inviteFlight: Flight | null; // the invite in the row
  // The username row (WEB_INTERFACE → The username row).
  ownName: UsernameResult | null;
  ownNameLoaded: boolean;
  nameClay: (key: string, name: string) => boolean; // a handle reads clay (→ The extension → "The verified names")
  usernameFlight: Flight | null;
  pendingUsername: { kind: 'claim' | 'burn'; name: string } | null;
  canSignClaim: boolean;
  canAffordBurn: boolean;
  // The extension's verified-figures run — WEB_INTERFACE → The extension →
  // "The verified figures", → The profile window → "The `rep` row is the
  // `effective` number alone". `verdict === undefined` when the build has no
  // verifier, `null` while none has returned; `figures` is null until a run's
  // result lands. The pure `figuresLine` reads the three fields together and
  // the karma field renders the muted line beneath the number, adding `clay`
  // to the hint and to the mono span under the full rule.
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

/** One row of the window: its node, and the draw of it from the state handed
 *  in. */
interface BodyRow {
  row: HTMLElement;
  update(ctx: ProfileCtx): void;
}

/** The profile window's body: `update` draws every row and places the
 *  username row; `karma`, `invites` and `username` draw one row where it
 *  stands, for a landing that moves text and colour in a fixed row
 *  (HOUSE_STYLE → Motion). */
export interface ProfileBody extends WindowBody {
  karma(): void;
  invites(): void;
  username(): void;
}

/** `read` answers the state as it stands when called, and `origin` the column
 *  the window stands in. The body is built for the identity `read` answers —
 *  a key, or none — and a draw that reads another builds it anew, ending every
 *  form in it. */
export function profileBody(handlers: ProfileHandlers, read: () => ProfileCtx, origin: () => Origin): ProfileBody {
  const b = el('div', 'winbody');
  let builtFor: string | null = null;
  let rows: LoadedRows | null = null;
  const build = (ctx: ProfileCtx): void => {
    for (const field of b.querySelectorAll('input')) field.value = '';
    b.replaceChildren();
    builtFor = ctx.identity?.pubKeyHex ?? null;
    if (ctx.identity === null) {
      rows = null;
      emptyState(b, handlers);
    } else {
      rows = loadedState(b, handlers, read, origin, ctx.identity.pubKeyHex, ctx);
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
    karma: () => rows?.rep.update(read()),
    invites: () => rows?.invites.update(read()),
    username: () => rows?.username.update(read()),
  };
}

// ---------------------------------------------------------------------------
// No identity — the shipped read surface with a way in.
// ---------------------------------------------------------------------------

function emptyState(b: HTMLElement, handlers: ProfileHandlers): void {
  b.appendChild(el('div', 'pf-lead', 'no identity in this browser. create one, or import a file.'));
  const field = el('div', 'field pf-inline');

  const create = el('button', 'word', 'create') as HTMLButtonElement;
  create.addEventListener('click', () => void (async () => {
    // Draft the key first so the form shows its prefix as the username — the key
    // exists before the passphrase, so the manager's saved entry names it
    // (WEB_INTERFACE → The profile window). Cancelling discards the draft.
    const { pubKeyHex } = await handlers.draftIdentity();
    field.replaceChildren(
      setPassphraseForm(pubKeyHex, (p) => handlers.createIdentity(p), () => {
        handlers.discardDraft();
        restoreInline();
      }),
    );
  })());

  const importBtn = el('button', 'word', 'import') as HTMLButtonElement;
  importBtn.addEventListener('click', () => pickFile((text) => void revealImport(field, handlers, text, restoreInline)));

  const restoreInline = (): void => {
    for (const form of field.querySelectorAll('form')) endForm(form);
    field.replaceChildren(create, importBtn);
    create.focus();
  };

  field.append(create, importBtn);
  b.appendChild(field);
}

/** Open a native file picker and hand back the chosen file's text. */
function pickFile(onText: (text: string) => void): void {
  const input = el('input') as HTMLInputElement;
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void file.text().then(onText);
  });
  input.click();
}

/** Inspect the file and reveal the form its kind needs: a clear file sets a
 *  passphrase, an encrypted one is opened by the passphrase that admits it. */
async function revealImport(field: HTMLElement, handlers: ProfileHandlers, text: string, restore: () => void): Promise<void> {
  let inspected: { kind: 'clear' | 'encrypted'; pubKeyHex: string };
  try {
    inspected = await handlers.inspectFile(text);
  } catch (e) {
    const line = el('div', 'pf-refusal', e instanceof Error ? e.message : String(e));
    const back = el('button', 'word', 'back') as HTMLButtonElement;
    back.addEventListener('click', restore);
    field.replaceChildren(line, back);
    return;
  }
  const onSubmit = (p: string): Promise<void> => handlers.importIdentity(text, p);
  const form =
    inspected.kind === 'clear'
      ? setPassphraseForm(inspected.pubKeyHex, onSubmit, restore)
      : unlockForm(inspected.pubKeyHex, onSubmit, restore);
  field.replaceChildren(form);
}

// ---------------------------------------------------------------------------
// An identity loaded — the username row above key when a name is held, below it
// otherwise, and then rep, invites, passphrase, export, forget.
// ---------------------------------------------------------------------------

interface LoadedRows {
  update(ctx: ProfileCtx): void;
  rep: BodyRow;
  invites: BodyRow;
  username: BodyRow;
}

function loadedState(
  b: HTMLElement,
  handlers: ProfileHandlers,
  read: () => ProfileCtx,
  origin: () => Origin,
  pubKeyHex: string,
  ctx: ProfileCtx,
): LoadedRows {
  const username = usernameRow(handlers, read);
  const key = keyRow(pubKeyHex);
  const rep = repRow(handlers);
  const invites = invitesRow(handlers, read, origin);
  const rest = [passphraseRow(handlers, read, pubKeyHex), exportRow(handlers, read, pubKeyHex), forgetRow(handlers, read)];
  b.append(key.row, rep.row, invites.row, ...rest.map((r) => r.row));
  const all = [username, key, rep, invites, ...rest];

  // WEB_INTERFACE → The username row → "A name is claimed and burned from the
  // profile window, in one row whose place follows the name": above key with a
  // name held, below it otherwise. A draw of the window places the row; the
  // row's own draw (`username`) leaves it where it stands, so a landing moves
  // text and colour and never a row (HOUSE_STYLE → Motion).
  const update = (now: ProfileCtx): void => {
    for (const r of all) r.update(now);
    if (now.ownName !== null) {
      if (username.row.nextElementSibling !== key.row) key.row.before(username.row);
    } else if (key.row.nextElementSibling !== username.row) {
      key.row.after(username.row);
    }
  };
  update(ctx);
  return { update, rep, invites, username };
}

/** WEB_INTERFACE → The profile window → "The key is a control, and a press
 *  copies it": the whole 64 hex, mono, the labels' size, wrapping by break-all,
 *  left-aligned, labelled *copy this key*. The press writes the clipboard and
 *  the word `copied` follows the key, muted, until the window is next drawn —
 *  no timer, the copy glyph's pattern (→ Links). Where the clipboard refuses,
 *  the control is replaced by the key as selectable mono text followed by
 *  *— copy it by hand*, until the window is next drawn. The backup line stays
 *  beneath until the first export. */
function keyRow(pubKeyHex: string): BodyRow {
  const { row: r, field } = row('key');
  let copied = false;
  const btn = el('button', 'word mono key-copy') as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('aria-label', 'copy this key');
  const fallback = (): void => {
    if (!btn.parentNode) return; // guard against a rejection after the button is gone
    btn.replaceWith(mono(pubKeyHex), el('span', null, ' — copy it by hand'));
  };
  btn.addEventListener('click', () => {
    if (copied) return;
    if (typeof navigator.clipboard?.writeText !== 'function') {
      fallback();
      return;
    }
    navigator.clipboard.writeText(pubKeyHex).then(
      () => {
        copied = true;
        btn.appendChild(el('span', 'key-copy-note inkmute', ' copied'));
      },
      fallback,
    );
  });
  const hint = el('div', 'hint', 'this key lives in this browser only. export it to keep it.');
  return {
    row: r,
    update: (ctx) => {
      copied = false;
      setText(btn, pubKeyHex);
      setChildren(field, ctx.backedUp ? [btn] : [btn, hint]);
    },
  };
}

/** Put `kids` in `parent`, touching the document only where they are not its
 *  children already — a node that stays keeps the focus it holds. */
function setChildren(parent: Element, kids: Node[]): void {
  const now = [...parent.childNodes];
  if (now.length === kids.length && now.every((n, i) => n === kids[i])) return;
  parent.replaceChildren(...kids);
}

/** rep — the balance that spends, the faucet step, or the grant in flight. */
function repRow(handlers: ProfileHandlers): BodyRow {
  const { row: r, field } = row('rep');
  field.classList.add('karma-field');
  return { row: r, update: (ctx) => renderKarmaField(field, handlers, ctx) };
}

/** The invites row (WEB_INTERFACE → The profile window → "The `invites` row"):
 *  the tier line, the form while an invite is available and the minimum bond
 *  is affordable, the flight, and the reader's standing bonds — four slots.
 *  The line, the flight and the bonds are drawn from the state at every
 *  update; the form the reader is filling stands through it, and ends, with
 *  the unlock row under it, once the row no longer offers it. */
function invitesRow(handlers: ProfileHandlers, read: () => ProfileCtx, origin: () => Origin): BodyRow {
  const { row: r, field } = row('invites');
  field.classList.add('invites-field');
  const line = el('div', 'invites-line');
  const formSlot = el('div', 'invites-form');
  const flight = el('div', 'invites-flight');
  const bonds = el('div', 'invites-bonds');
  field.append(line, formSlot, flight, bonds);

  let form: InviteForm | null = null;
  let unlock: HTMLElement | null = null; // the unlock row under the form
  const endUnlock = (): void => {
    if (unlock !== null) endForm(unlock);
    unlock = null;
  };
  const endInvite = (): void => {
    endUnlock();
    if (form !== null) endForm(form.el);
    form = null;
  };

  // A locked identity unlocks in a row under the form first; a correct
  // passphrase ends the row and the invite proceeds, Esc and `cancel` end it
  // (WEB_INTERFACE → The identity module).
  const submit = (inviteeKey: string, bond: bigint): void => {
    const id = read().identity;
    if (id?.locked !== true) {
      handlers.invite(inviteeKey, bond);
      return;
    }
    if (unlock !== null || form === null) return;
    const urow = el('div', 'card-unlock');
    urow.appendChild(
      unlockForm(
        id.pubKeyHex,
        async (p) => {
          await handlers.unlockIdentity(p);
          endUnlock();
          handlers.invite(inviteeKey, bond);
        },
        endUnlock,
      ),
    );
    unlock = urow;
    form.el.after(urow);
  };

  const update = (ctx: ProfileCtx): void => {
    const k = ctx.karma;
    const offered =
      k !== null && ctx.invite !== null && ctx.canAffordMinBond &&
      (k.invitesAvailable === null || (k.member && k.invitesAvailable >= 1));
    if (!offered || ctx.invite === null) {
      endInvite();
    } else {
      if (form === null) {
        form = inviteForm(ctx.invite, submit);
        formSlot.appendChild(form.el);
      }
      form.range(ctx.invite);
    }
    if (ctx.identity?.locked !== true) endUnlock();

    line.replaceChildren();
    flight.replaceChildren();
    bonds.replaceChildren();
    if (k === null) {
      line.appendChild(el('span', 'inkmute', '—'));
      return;
    }
    if (k.invitesAvailable === null) {
      line.appendChild(el('div', 'hint', 'as many as your rep covers.'));
    } else if (k.member) {
      const l = el('div', 'hint');
      l.append(mono(String(k.invitesAvailable)), k.invitesAvailable === 1 ? ' invite available.' : ' invites available.');
      line.appendChild(l);
    } else {
      // A resident: no form, no bonds (WEB_INTERFACE → The profile window).
      line.appendChild(el('div', 'hint', 'invites come with membership.'));
      return;
    }
    if (ctx.inviteFlight) flight.appendChild(stageLine(ctx.inviteFlight));
    standingBonds(bonds, handlers, ctx, origin);
  };
  return { row: r, update };
}

interface InviteParams {
  bondMin: string;
  bondMax: string;
  probationBlocks: number;
}

/** The invite form, and `range`, which writes the bond's bounds and the
 *  probation into it from /status as it stands, leaving what is typed. */
interface InviteForm {
  el: HTMLFormElement;
  range(params: InviteParams): void;
}

/** A real `<form>` the password manager ignores — the invitee's key pasted out of
 *  band, the bond inside the range with the minimum as the default, and what
 *  happens under it. */
function inviteForm(params: InviteParams, onSubmit: (inviteeKey: string, bond: bigint) => void): InviteForm {
  const form = el('form', 'pf invite-form') as HTMLFormElement;

  const keyInput = el('input') as HTMLInputElement;
  keyInput.type = 'text';
  keyInput.placeholder = 'invitee public key — 64 hex';
  keyInput.setAttribute('aria-label', "the invitee's public key");

  const bondInput = el('input') as HTMLInputElement;
  bondInput.type = 'number';
  bondInput.step = '1';
  bondInput.value = params.bondMin; // default the minimum
  bondInput.setAttribute('aria-label', 'the bond, in rep');

  const submit = el('button', 'word', 'invite') as HTMLButtonElement;
  submit.type = 'submit';

  const probation = mono('');
  const copy = el('div', 'hint');
  copy.append(
    "they receive the bond's rep from the pool. your bond comes back as they receive likes, one rep per ",
    String(INVITE_BOND_VEST_PER_LIKES),
    ', and the rest goes to the pool after ',
    probation,
    ' blocks.',
  );

  const refusal = el('div', 'pf-refusal');
  refusal.hidden = true;

  form.append(keyInput, bondInput, submit, refusal, copy);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = keyInput.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) {
      refusal.textContent = 'that is not a 64-character key.';
      refusal.hidden = false;
      return;
    }
    refusal.hidden = true;
    onSubmit(key, BigInt(bondInput.value || bondInput.min));
  });
  return {
    el: form,
    range: (p) => {
      bondInput.min = p.bondMin;
      bondInput.max = p.bondMax;
      setText(probation, String(p.probationBlocks));
    },
  };
}

/** The reader's standing bonds — the invitee's identity (so the reader can vouch
 *  for their own invitee here) and the bond's value, following `next`. Empty:
 *  nothing (WEB_INTERFACE → The profile window). A press on an invitee opens
 *  their window beside the column this window stands in when pressed. */
function standingBonds(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx, origin: () => Origin): void {
  const b = ctx.bonds;
  if (b === null || b.bonds.length === 0) return;
  for (const bond of b.bonds) {
    const bondRow = el('div', 'bond');
    // WEB_INTERFACE → The identity display — the handle where the row carries a
    // name, else the prefix; the same control, the handle clay where the chain
    // does not back it.
    const btn = el('button', bond.inviteeName !== null ? 'handle authorbtn' : 'hex authorbtn');
    if (bond.inviteeName !== null && ctx.nameClay(bond.inviteePublicKey, bond.inviteeName)) btn.classList.add('clay');
    if (bond.inviteeName !== null) markHandle(btn, bond.inviteePublicKey, bond.inviteeName);
    btn.textContent = bond.inviteeName !== null ? '@' + bond.inviteeName : shortHex(bond.inviteePublicKey, 10);
    btn.setAttribute('aria-label', 'open this author');
    btn.addEventListener('click', () => handlers.openAuthor(bond.inviteePublicKey, origin()));
    bondRow.appendChild(btn);
    const value = el('span', 'hint');
    value.append(mono(bond.value), ' rep');
    bondRow.appendChild(value);
    field.appendChild(bondRow);
  }
  if (b.next !== null) {
    const more = el('button', 'word', 'more');
    more.setAttribute('aria-label', 'load more standing bonds');
    more.addEventListener('click', () => handlers.moreBonds());
    field.appendChild(more);
  }
}

/** The karma field's content, drawn from ctx — colour and text in a fixed box
 *  (HOUSE_STYLE → Motion). */
function renderKarmaField(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
  const k = ctx.karma;
  field.replaceChildren();
  if (k === null) {
    field.appendChild(el('span', 'inkmute', '—'));
    return;
  }
  if (k.boxCount > 0) {
    balance(field, k, ctx);
    return;
  }
  // No karma box — a grant in flight, an expired one, the faucet step, or
  // nothing. The verified-figures line stands beneath each empty state so the
  // ledger's own facts (`holdings`, `unlisted`, the record) reach the reader
  // beneath the faucet step too (WEB_INTERFACE → The extension → "The verified
  // figures" — "An empty listing takes these lines as any listing does";
  // → The profile window → "A listing with no box reads its line too").
  if (ctx.grant?.state === 'pending') {
    field.appendChild(el('span', 'inkmute', 'working…'));
  } else if (ctx.grant?.state === 'expired') {
    field.appendChild(el('span', 'inkmute', 'no block took the faucet’s invite by height '));
    field.appendChild(mono(String(ctx.grant.atHeight)));
    field.appendChild(document.createTextNode('. '));
    const again = el('button', 'word', 'ask again') as HTMLButtonElement;
    again.addEventListener('click', () => handlers.askFaucet());
    field.appendChild(again);
  } else {
    const faucetBase = prefs.faucet;
    if (faucetBase !== '') {
      const ask = el('button', 'word', 'ask the faucet for rep') as HTMLButtonElement;
      ask.addEventListener('click', () => handlers.askFaucet());
      field.appendChild(ask);
    } else {
      field.appendChild(el('span', 'inkmute', 'no rep yet.'));
    }
  }
  // `k.height` is the listing's height — the figures line uses it only when a
  // listed credit box carries a lock; here boxCount is 0, so the value is not
  // read on this path. `shown` is 0n, with no mono number to turn clay.
  appendKarmaFiguresLine(field, ctx, 0, k.height);
}

/** Append the verified-figures line beneath the karma field — a `div.hint`,
 *  clay under the full rule. Mirrors the wallet's `appendFiguresLine`. The
 *  karma field renders `balance()` for `k.boxCount > 0`, which calls the pure
 *  `figuresLine` and marks the mono number clay under the full rule; this
 *  helper serves the empty-listing branches, where no number stands to turn
 *  clay. */
function appendKarmaFiguresLine(
  field: HTMLElement,
  ctx: ProfileCtx,
  boxCount: number,
  height: number,
): void {
  const fLine = figuresLine({
    ledger: 'karma',
    verdict: ctx.verdict,
    result: ctx.figures?.result ?? null,
    shown: 0n,
    suffixHeight: ctx.figures?.anchor.suffixHead.header.height ?? null,
    boxCount,
    height,
  });
  if (fLine === null) return;
  const hint = el('div', 'hint');
  hint.textContent = fLine.text;
  if (fLine.weight === 'clay') hint.classList.add('clay');
  field.appendChild(hint);
}

/** The row's label counts what the number counts, so the number stands alone —
 *  the effective view, the value every sufficiency check on the node reads, never
 *  the face total (WEB_INTERFACE → The profile window → "The `rep` row is the
 *  `effective` number alone"). In the extension, one muted line beneath the
 *  number says what the verified-figures run could not prove, and under the
 *  full rule the number and the line are clay (→ "The verified figures").
 *  The number stays the live `effective` in every state; the line describes
 *  it, and never replaces it. */
function balance(field: HTMLElement, k: KarmaResult, ctx: ProfileCtx): void {
  const monoSpan = mono(k.effective);
  field.append(monoSpan);
  const fLine = figuresLine({
    ledger: 'karma',
    verdict: ctx.verdict,
    result: ctx.figures?.result ?? null,
    shown: BigInt(k.effective),
    suffixHeight: ctx.figures?.anchor.suffixHead.header.height ?? null,
    boxCount: k.boxCount,
    height: k.height,
  });
  if (fLine !== null) {
    const hint = el('div', 'hint');
    hint.textContent = fLine.text;
    if (fLine.weight === 'clay') {
      // HOUSE_STYLE → Gold and clay are not interchangeable — the full rule.
      // The number gives up its ink for clay only while the node's own proof
      // of the rep fails, as the corner's height does on `refused`.
      hint.classList.add('clay');
      monoSpan.classList.add('clay');
    }
    field.appendChild(hint);
  }
}

/** passphrase — `locked` and `unlock`, the unlock form in their place, or
 *  `unlocked` and `lock`. The words follow the identity's lock as each update
 *  reads it; the unlock form stands while the identity is locked and ends once
 *  it is not, wherever the unlock was made (WEB_INTERFACE → The workspace →
 *  "What ends a form in a window"). */
function passphraseRow(handlers: ProfileHandlers, read: () => ProfileCtx, pubKeyHex: string): BodyRow {
  const { row: r, field } = row('passphrase');
  field.classList.add('pp-field'); // inline flow: the word and its button on one line
  let form: HTMLFormElement | null = null;
  let shown: boolean | null = null; // the lock the words on screen read; null while the form stands
  const endUnlock = (): void => {
    if (form !== null) endForm(form);
    form = null;
  };
  const update = (ctx: ProfileCtx): void => {
    const locked = ctx.identity?.locked === true;
    if (form !== null && locked) return;
    endUnlock();
    if (shown === locked) return;
    shown = locked;
    const word = el('button', 'word', locked ? 'unlock' : 'lock') as HTMLButtonElement;
    word.addEventListener('click', locked ? openUnlock : lock);
    field.replaceChildren(el('span', 'inkmute', locked ? 'locked' : 'unlocked'), ' ', word);
  };
  const openUnlock = (): void => {
    shown = null;
    form = unlockForm(
      pubKeyHex,
      async (p) => {
        await handlers.unlockIdentity(p);
        endUnlock();
        update(read());
      },
      () => {
        endUnlock();
        update(read());
        field.querySelector('button')?.focus();
      },
    );
    field.replaceChildren(form);
  };
  // Await the lock so the extension's proxy refreshes its snapshot before the
  // row reads current().locked (WEB_INTERFACE → The extension).
  const lock = (): void => void (async () => {
    await handlers.lockIdentity();
    update(read());
  })();
  return { row: r, update };
}

/** export — a fresh sealed file. Export needs the seed: an identity locked at
 *  the press unlocks first, then the set form appears (WEB_INTERFACE → The
 *  profile window). */
function exportRow(handlers: ProfileHandlers, read: () => ProfileCtx, pubKeyHex: string): BodyRow {
  const { row: r, field } = row('export');
  const trigger = el('button', 'word', 'export') as HTMLButtonElement;
  let unlock: HTMLFormElement | null = null;
  let set: HTMLFormElement | null = null;
  const end = (focus: boolean): void => {
    for (const form of [unlock, set]) if (form !== null) endForm(form);
    unlock = null;
    set = null;
    setChildren(field, [trigger]);
    if (focus) trigger.focus();
  };
  const showSet = (): void => {
    set = setPassphraseForm(
      `${pubKeyHex} · file`,
      async (p) => {
        await handlers.exportIdentity(p);
        end(true);
      },
      () => end(true),
    );
    field.replaceChildren(set);
  };
  trigger.addEventListener('click', () => {
    if (read().identity?.locked !== true) {
      showSet();
      return;
    }
    unlock = unlockForm(
      pubKeyHex,
      async (p) => {
        await handlers.unlockIdentity(p);
        end(false);
        showSet();
      },
      () => end(true),
    );
    field.replaceChildren(unlock);
  });
  field.appendChild(trigger);
  return {
    row: r,
    update: (ctx) => {
      if (unlock !== null && ctx.identity?.locked !== true) end(false);
    },
  };
}

/** forget — the one path off a key, asked in place, the never-exported fact
 *  first when the key is not backed up at the press. */
function forgetRow(handlers: ProfileHandlers, read: () => ProfileCtx): BodyRow {
  const { row: r, field } = row('forget');
  const trigger = el('button', 'word', 'forget') as HTMLButtonElement;
  trigger.addEventListener('click', () => {
    const wrap = el('div', 'pf-confirm');
    wrap.appendChild(el('div', 'pf-refusal', read().backedUp
      ? 'forget this key on this browser?'
      : 'forget this key on this browser? without an exported file it cannot be recovered.'));
    const actions = el('div', 'pf-actions');
    const forget = el('button', 'word', 'forget') as HTMLButtonElement;
    forget.addEventListener('click', () => void handlers.forgetIdentity());
    const keep = el('button', 'word', 'keep') as HTMLButtonElement;
    keep.addEventListener('click', () => {
      field.replaceChildren(trigger);
      trigger.focus();
    });
    actions.append(forget, keep);
    wrap.appendChild(actions);
    field.replaceChildren(wrap);
    keep.focus(); // focus on keep — the non-destructive choice
  });
  field.appendChild(trigger);
  return { row: r, update: () => {} };
}

// ---------------------------------------------------------------------------
// The username row — WEB_INTERFACE → The username row. Three slots
// (.username-line, .username-form, .username-flight). The flight slot is drawn
// from the state at every update. The form slot holds the claim form while the
// row offers it — a name read, none held, nothing pending, a rep box to spend —
// and the unlock row under it while the identity is locked. The line slot
// holds the row's words, or the burn question in their place — and the unlock
// form in the question's — while the name it was asked for is held and can be
// burned.
// ---------------------------------------------------------------------------

function usernameRow(handlers: ProfileHandlers, read: () => ProfileCtx): BodyRow {
  const { row: r, field } = row('username');
  field.classList.add('username-field');
  const line = el('div', 'username-line');
  const formSlot = el('div', 'username-form');
  const flight = el('div', 'username-flight');
  field.append(line, formSlot, flight);

  let claim: HTMLFormElement | null = null;
  let claimUnlock: HTMLElement | null = null;
  let question: { wrap: HTMLElement; name: string; unlock: boolean } | null = null;
  const endClaimUnlock = (): void => {
    if (claimUnlock !== null) endForm(claimUnlock);
    claimUnlock = null;
  };
  const endClaim = (): void => {
    endClaimUnlock();
    if (claim !== null) endForm(claim);
    claim = null;
  };
  const endQuestion = (): void => {
    if (question !== null) endForm(question.wrap);
    question = null;
  };

  const update = (ctx: ProfileCtx): void => {
    const locked = ctx.identity?.locked === true;
    const pending = ctx.ownNameLoaded ? ctx.pendingUsername : null;
    const held = ctx.ownNameLoaded && pending === null ? ctx.ownName : null;

    // The flight's ending stands beside whatever the line and the form read; a
    // pending claim or burn reads its stage — the ledger's entry, durable
    // across a reload.
    const f = ctx.usernameFlight;
    let stage: Flight | null = f !== null && (f.stage === 'rejected' || f.stage === 'expired') ? f : null;
    if (pending !== null) {
      if (f?.stage === 'submitting') stage = f;
      else if (f === null || f.stage === 'submitted') stage = { stage: 'submitted' };
    }
    flight.replaceChildren(...(stage === null ? [] : [stageLine(stage)]));

    if (ctx.ownNameLoaded && pending === null && ctx.ownName === null && ctx.canSignClaim) {
      if (claim === null) {
        claim = claimForm();
        formSlot.appendChild(claim);
      }
    } else {
      endClaim();
    }
    if (!locked) endClaimUnlock();

    if (question !== null && (held?.name !== question.name || !ctx.canAffordBurn || (question.unlock && !locked))) {
      endQuestion();
    }
    if (question !== null) return;

    line.replaceChildren();
    if (!ctx.ownNameLoaded) {
      line.appendChild(el('span', 'inkmute', '—'));
      return;
    }
    if (pending !== null) {
      const muted = el('span', 'handle inkmute');
      muted.textContent = '@' + pending.name;
      line.appendChild(muted);
      return;
    }
    // Holding a name — the handle, burn, and the hint. In the extension a handle
    // the chain does not back is clay (WEB_INTERFACE → The identity display).
    if (ctx.ownName !== null) {
      const handle = el('span', 'handle');
      handle.textContent = '@' + ctx.ownName.name;
      if (ctx.identity !== null && ctx.nameClay(ctx.identity.pubKeyHex, ctx.ownName.name)) handle.classList.add('clay');
      if (ctx.identity !== null) markHandle(handle, ctx.identity.pubKeyHex, ctx.ownName.name);
      line.appendChild(handle);
      line.appendChild(document.createTextNode(' '));

      const burn = el('button', 'word', 'burn') as HTMLButtonElement;
      if (!ctx.canAffordBurn) {
        burn.disabled = true;
        burn.title = `a burn costs ${USERNAME_BURN_PRICE} rep; this key has less`;
      }
      burn.addEventListener('click', openQuestion);
      line.appendChild(burn);

      const hint = el('div', 'hint');
      hint.append(
        `held since block `,
        mono(String(ctx.ownName.claimedAtBlock)),
        `. a burn costs ${USERNAME_BURN_PRICE} rep and restores your free claim.`,
      );
      line.appendChild(hint);
      return;
    }
    // Holding none and no rep box — the claim form's gate.
    if (!ctx.canSignClaim) {
      line.appendChild(el('div', 'hint', 'a claim spends and returns one rep box; this key has none.'));
    }
  };

  const claimForm = (): HTMLFormElement => {
    const form = el('form', 'pf username-form') as HTMLFormElement;

    const input = el('input') as HTMLInputElement;
    input.setAttribute('aria-label', 'the name to claim');
    input.placeholder = 'a name';
    input.maxLength = 24;
    input.autocomplete = 'off';
    (input as HTMLInputElement).autocapitalize = 'off';
    input.spellcheck = false;

    // HOUSE_STYLE → Interaction → "A box marks a commit pair and a surface's
    // primary action": `claim` wears the primary-action box, green as the
    // wallet's `send` (WEB_INTERFACE → The username row → "Holding none, nothing
    // pending, a rep box to spend").
    const submit = el('button', 'btn btn-primary', 'claim') as HTMLButtonElement;
    submit.type = 'submit';

    // The input and the boxed claim on one line, the wallet's send-row pattern.
    const nameRow = el('div', 'name-row');
    nameRow.append(input, submit);

    const refusal = el('div', 'pf-refusal');
    refusal.hidden = true;

    const hint = el('div', 'hint');
    hint.append(
      `free, once per key. 1 to 24 letters, digits or _, shown as typed; one name is one name whatever its case. a later burn costs ${USERNAME_BURN_PRICE} rep and restores the claim.`,
    );

    form.append(nameRow, refusal, hint);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let v = input.value.trim();
      if (v.startsWith('@')) v = v.slice(1);
      const bytes = new TextEncoder().encode(v);
      if (!isValidUsernameBytes(bytes)) {
        refusal.textContent = 'a name is 1 to 24 letters, digits or _.';
        refusal.hidden = false;
        return;
      }
      refusal.hidden = true;
      const id = read().identity;
      if (id?.locked !== true) {
        handlers.claimUsername(v);
        return;
      }
      if (claimUnlock !== null) return;
      const urow = el('div', 'card-unlock');
      urow.appendChild(
        unlockForm(
          id.pubKeyHex,
          async (p) => {
            await handlers.unlockIdentity(p);
            endClaimUnlock();
            handlers.claimUsername(v);
          },
          endClaimUnlock,
        ),
      );
      claimUnlock = urow;
      form.after(urow);
    });
    return form;
  };

  // `burn` asks in place, as `forget` does; `keep` and Esc bring the words
  // back with the focus on `burn`. The question's `burn` signs — a locked
  // identity through the unlock form in the question's place first.
  function openQuestion(): void {
    const name = read().ownName?.name;
    if (!name || question !== null) return;
    const wrap = el('div', 'pf-confirm');
    const q = el('div', 'pf-refusal');
    q.textContent = `burn @${name} for ${USERNAME_BURN_PRICE} rep? the name is open to anyone again, and your free claim returns.`;
    wrap.appendChild(q);
    const back = (): void => {
      endQuestion();
      update(read());
      line.querySelector('button')?.focus();
    };
    const actions = el('div', 'pf-actions');
    const confirm = el('button', 'word', 'burn') as HTMLButtonElement;
    confirm.addEventListener('click', () => {
      const asked = question;
      if (asked === null) return;
      const id = read().identity;
      if (id?.locked !== true) {
        endQuestion();
        update(read());
        handlers.burnUsername();
        return;
      }
      asked.unlock = true;
      wrap.replaceChildren(
        unlockForm(
          id.pubKeyHex,
          async (p) => {
            await handlers.unlockIdentity(p);
            endQuestion();
            update(read());
            handlers.burnUsername();
          },
          back,
        ),
      );
    });
    const keep = el('button', 'word', 'keep') as HTMLButtonElement;
    keep.addEventListener('click', back);
    actions.append(confirm, keep);
    wrap.appendChild(actions);
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && question?.wrap === wrap) back();
    });
    question = { wrap, name, unlock: false };
    line.replaceChildren(wrap);
    keep.focus();
  }

  return { row: r, update };
}
