import { el, shortHex } from '../dom';
import { prefs } from '../prefs';
import { unlockForm, setPassphraseForm } from './passphrase';
import { stageLine, type Flight } from './card';
import { INVITE_BOND_VEST_PER_LIKES, USERNAME_BURN_PRICE, isValidUsernameBytes } from '@dagsocial/types';
import { figuresLine } from '../model/figures-line';
import type { FiguresView } from '../model/state';
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

export function profileBody(handlers: ProfileHandlers, ctx: ProfileCtx, origin: Origin): HTMLElement {
  const b = el('div', 'winbody');
  if (ctx.identity === null) emptyState(b, handlers);
  else loadedState(b, handlers, ctx, origin);
  return b;
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

function loadedState(b: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx, origin: Origin): void {
  const id = ctx.identity!;

  // WEB_INTERFACE → The username row → "A name is claimed and burned from the
  // profile window, in one row whose place follows the name": above key with a
  // name held, below it otherwise, decided when the window is built. A landing
  // updates the row in place (renderUsernameRow); the next build — a reopen,
  // the ↻, a reload — places it (HOUSE_STYLE → Motion).
  if (ctx.ownName !== null) appendUsernameRow(b, handlers, ctx);
  appendKeyRow(b, ctx, id.pubKeyHex);
  if (ctx.ownName === null) appendUsernameRow(b, handlers, ctx);

  // rep — the balance that spends, the faucet step, or the grant in flight.
  {
    const { row: r, field } = row('rep');
    field.classList.add('karma-field'); // the App updates this in place when a grant lands
    renderKarmaField(field, handlers, ctx);
    b.appendChild(r);
  }

  // invites — the tier line, the form, the flight, and the standing bonds.
  {
    const { row: r, field } = row('invites');
    invitesRow(field, handlers, ctx, origin);
    b.appendChild(r);
  }

  // passphrase — locked · unlock, or unlocked · lock.
  {
    const { row: r, field } = row('passphrase');
    field.classList.add('pp-field'); // inline flow: the word and its button on one line
    passphraseRow(field, handlers, id.pubKeyHex, id.locked);
    b.appendChild(r);
  }

  // export — a fresh sealed file; a locked identity unlocks first.
  {
    const { row: r, field } = row('export');
    const trigger = el('button', 'word', 'export') as HTMLButtonElement;
    const restore = (): void => {
      field.replaceChildren(trigger);
      trigger.focus();
    };
    trigger.addEventListener('click', () => exportFlow(field, handlers, id, restore));
    field.appendChild(trigger);
    b.appendChild(r);
  }

  // forget — the one path off a key, confirmed in place.
  {
    const { row: r, field } = row('forget');
    const trigger = el('button', 'word', 'forget') as HTMLButtonElement;
    const restore = (): void => {
      field.replaceChildren(trigger);
      trigger.focus();
    };
    trigger.addEventListener('click', () => forgetConfirm(field, handlers, ctx.backedUp, restore));
    field.appendChild(trigger);
    b.appendChild(r);
  }
}

/** WEB_INTERFACE → The profile window → "The key is a control, and a press
 *  copies it": the whole 64 hex, mono, the labels' size, wrapping by break-all,
 *  left-aligned, labelled *copy this key*. The press writes the clipboard and
 *  the word `copied` follows the key, muted, until the window is next built —
 *  no timer, the copy glyph's pattern (→ Links). Where the clipboard refuses,
 *  the control is replaced by the key as selectable mono text followed by
 *  *— copy it by hand*. The backup line stays beneath until the first export. */
function appendKeyRow(b: HTMLElement, ctx: ProfileCtx, pubKeyHex: string): void {
  const { row: r, field } = row('key');
  keyCopyControl(field, pubKeyHex);
  if (!ctx.backedUp) {
    field.appendChild(el('div', 'hint', 'this key lives in this browser only. export it to keep it.'));
  }
  b.appendChild(r);
}

function keyCopyControl(field: HTMLElement, pubKeyHex: string): void {
  let copied = false;
  const btn = el('button', 'word mono key-copy') as HTMLButtonElement;
  btn.type = 'button';
  btn.textContent = pubKeyHex;
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
  field.appendChild(btn);
}

function appendUsernameRow(b: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
  const { row: r, field } = row('username');
  field.classList.add('username-field');
  usernameRow(field, handlers, ctx);
  b.appendChild(r);
}

/** The invites row (WEB_INTERFACE → The profile window): the tier line, the form
 *  when an invite is available and the minimum bond is affordable, the flight, and
 *  the reader's standing bonds. Built into four slots so a landing can update the
 *  line, the flight and the bonds in place while the form the reader is filling
 *  for the next key stays put (renderInvitesRow). */
function invitesRow(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx, origin: Origin): void {
  field.classList.add('invites-field'); // the App updates it in place on an invite landing
  field.replaceChildren(el('div', 'invites-line'), el('div', 'invites-form'), el('div', 'invites-flight'), el('div', 'invites-bonds'));
  // The form is built once, here, and left alone by the in-place update.
  const k = ctx.karma;
  const isMember = k !== null && (k.member || k.invitesAvailable === null);
  const available = k !== null && (k.invitesAvailable === null || (k.invitesAvailable ?? 0) >= 1);
  if (isMember && available && ctx.canAffordMinBond && ctx.invite) {
    inviteForm(field.querySelector('.invites-form') as HTMLElement, handlers, ctx, ctx.invite);
  }
  updateInvites(field, handlers, ctx, origin);
}

/** Update the invites row's line, flight and standing bonds in place, leaving the
 *  form the reader may be filling untouched — the way the grant landing updates the
 *  karma field (renderKarmaField), so an unsolicited landing moves colour and text,
 *  not a form (WEB_INTERFACE → The profile window; HOUSE_STYLE → Motion). */
export function renderInvitesRow(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx, origin: Origin): void {
  updateInvites(field, handlers, ctx, origin);
}

function updateInvites(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx, origin: Origin): void {
  const line = field.querySelector('.invites-line');
  const flight = field.querySelector('.invites-flight');
  const bonds = field.querySelector('.invites-bonds');
  if (!line || !flight || !bonds) return;
  line.replaceChildren();
  flight.replaceChildren();
  bonds.replaceChildren();
  const k = ctx.karma;
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
  standingBonds(bonds as HTMLElement, handlers, ctx, origin);
}

/** A real `<form>` the password manager ignores — the invitee's key pasted out of
 *  band, the bond inside the range with the minimum as the default, and what
 *  happens under it. A locked identity unlocks in the row first. */
function inviteForm(
  field: HTMLElement,
  handlers: ProfileHandlers,
  ctx: ProfileCtx,
  params: { bondMin: string; bondMax: string; probationBlocks: number },
): void {
  const form = el('form', 'pf invite-form') as HTMLFormElement;

  const keyInput = el('input') as HTMLInputElement;
  keyInput.type = 'text';
  keyInput.placeholder = 'invitee public key — 64 hex';
  keyInput.setAttribute('aria-label', "the invitee's public key");

  const bondInput = el('input') as HTMLInputElement;
  bondInput.type = 'number';
  bondInput.min = params.bondMin;
  bondInput.max = params.bondMax;
  bondInput.step = '1';
  bondInput.value = params.bondMin; // default the minimum
  bondInput.setAttribute('aria-label', 'the bond, in rep');

  const submit = el('button', 'word', 'invite') as HTMLButtonElement;
  submit.type = 'submit';

  const copy = el('div', 'hint');
  copy.append(
    "they receive the bond's rep from the pool. your bond comes back as they receive likes, one rep per ",
    String(INVITE_BOND_VEST_PER_LIKES),
    ', and the rest goes to the pool after ',
    mono(String(params.probationBlocks)),
    ' blocks.',
  );

  const refusal = el('div', 'pf-refusal');
  refusal.hidden = true;

  form.append(keyInput, bondInput, submit, refusal, copy);
  // The effective ctx — an in-row unlock fires no onChange, so every submit
  // reads the identity from `cur`, which the unlock path replaces so the next
  // press goes straight to the flow (WEB_INTERFACE → The wallet).
  let cur = ctx;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = keyInput.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) {
      refusal.textContent = 'that is not a 64-character key.';
      refusal.hidden = false;
      return;
    }
    refusal.hidden = true;
    const bond = BigInt(bondInput.value || params.bondMin);
    const go = (): void => handlers.invite(key, bond);
    const id = cur.identity;
    if (id?.locked) {
      // The seed is not loaded and sign is synchronous, so unlock in a row under
      // the form first; on success the invite proceeds, Esc drops the row
      // (WEB_INTERFACE → The profile window).
      if (form.parentElement?.querySelector('.card-unlock')) return; // already open
      const urow = el('div', 'card-unlock');
      urow.appendChild(
        unlockForm(
          id.pubKeyHex,
          async (p) => {
            await handlers.unlockIdentity(p);
            cur = { ...cur, identity: { pubKeyHex: id.pubKeyHex, locked: false } };
            go();
          },
          () => urow.remove(),
        ),
      );
      form.insertAdjacentElement('afterend', urow);
      return;
    }
    go();
  });
  field.appendChild(form);
}

/** The reader's standing bonds — the invitee's identity (so the reader can vouch
 *  for their own invitee here) and the bond's value, following `next`. Empty:
 *  nothing (WEB_INTERFACE → The profile window). */
function standingBonds(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx, origin: Origin): void {
  const b = ctx.bonds;
  if (b === null || b.bonds.length === 0) return;
  for (const bond of b.bonds) {
    const bondRow = el('div', 'bond');
    // WEB_INTERFACE → The identity display — the handle where the row carries a
    // name, else the prefix; the same control, the handle clay where the chain
    // does not back it.
    const btn = el('button', bond.inviteeName !== null ? 'handle authorbtn' : 'hex authorbtn');
    if (bond.inviteeName !== null && ctx.nameClay(bond.inviteePublicKey, bond.inviteeName)) btn.classList.add('clay');
    btn.textContent = bond.inviteeName !== null ? '@' + bond.inviteeName : shortHex(bond.inviteePublicKey, 10);
    btn.setAttribute('aria-label', 'open this author');
    btn.addEventListener('click', () => handlers.openAuthor(bond.inviteePublicKey, origin));
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

/** The karma field's content, rebuilt from ctx — the App calls this in place when a
 *  grant lands or lapses, so the update is colour and text in a fixed box, never a
 *  full re-render of the window (HOUSE_STYLE → Motion). */
export function renderKarmaField(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
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
  // No karma box — a grant in flight, an expired one, the faucet step, or nothing.
  if (ctx.grant?.state === 'pending') {
    field.appendChild(el('span', 'inkmute', 'working…'));
    return;
  }
  if (ctx.grant?.state === 'expired') {
    field.appendChild(el('span', 'inkmute', 'no block took the faucet’s invite by height '));
    field.appendChild(mono(String(ctx.grant.atHeight)));
    field.appendChild(document.createTextNode('. '));
    const again = el('button', 'word', 'ask again') as HTMLButtonElement;
    again.addEventListener('click', () => handlers.askFaucet());
    field.appendChild(again);
    return;
  }
  const faucetBase = prefs.faucet;
  if (faucetBase !== '') {
    const ask = el('button', 'word', 'ask the faucet for rep') as HTMLButtonElement;
    ask.addEventListener('click', () => handlers.askFaucet());
    field.appendChild(ask);
    return;
  }
  field.appendChild(el('span', 'inkmute', 'no rep yet.'));
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

// Lock and unlock are local to the window — they fire no onChange, so the row
// re-renders itself rather than waiting for the App (WEB_INTERFACE → The profile
// window).
function passphraseRow(field: HTMLElement, handlers: ProfileHandlers, pubKeyHex: string, locked: boolean): void {
  field.replaceChildren();
  if (locked) {
    field.append(el('span', 'inkmute', 'locked'), ' ');
    const unlock = el('button', 'word', 'unlock') as HTMLButtonElement;
    unlock.addEventListener('click', () => {
      const restore = (): void => {
        passphraseRow(field, handlers, pubKeyHex, true);
        (field.querySelector('button') as HTMLButtonElement | null)?.focus();
      };
      field.replaceChildren(
        unlockForm(
          pubKeyHex,
          async (p) => {
            await handlers.unlockIdentity(p);
            passphraseRow(field, handlers, pubKeyHex, false); // now unlocked
          },
          restore,
        ),
      );
    });
    field.appendChild(unlock);
  } else {
    field.append(el('span', 'inkmute', 'unlocked'), ' ');
    const lock = el('button', 'word', 'lock') as HTMLButtonElement;
    lock.addEventListener('click', () => void (async () => {
      // Await the lock so the extension's proxy refreshes its snapshot before
      // the next draw reads current().locked (WEB_INTERFACE → The extension).
      await handlers.lockIdentity();
      passphraseRow(field, handlers, pubKeyHex, true);
    })());
    field.appendChild(lock);
  }
}

/** Export needs the seed: a locked identity unlocks first, then the export form
 *  appears (WEB_INTERFACE → The profile window). */
function exportFlow(
  field: HTMLElement,
  handlers: ProfileHandlers,
  id: { pubKeyHex: string; locked: boolean },
  restore: () => void,
): void {
  const showExport = (): void => {
    field.replaceChildren(
      setPassphraseForm(`${id.pubKeyHex} · file`, (p) => handlers.exportIdentity(p), restore),
    );
  };
  if (id.locked) {
    field.replaceChildren(
      unlockForm(
        id.pubKeyHex,
        async (p) => {
          await handlers.unlockIdentity(p);
          showExport();
        },
        restore,
      ),
    );
  } else {
    showExport();
  }
}

function forgetConfirm(field: HTMLElement, handlers: ProfileHandlers, backedUp: boolean, restore: () => void): void {
  const line = backedUp
    ? 'forget this key on this browser?'
    : 'forget this key on this browser? without an exported file it cannot be recovered.';
  const wrap = el('div', 'pf-confirm');
  wrap.appendChild(el('div', 'pf-refusal', line));
  const actions = el('div', 'pf-actions');
  const forget = el('button', 'word', 'forget') as HTMLButtonElement;
  forget.addEventListener('click', () => void handlers.forgetIdentity());
  const keep = el('button', 'word', 'keep') as HTMLButtonElement;
  keep.addEventListener('click', restore);
  actions.append(forget, keep);
  wrap.appendChild(actions);
  field.replaceChildren(wrap);
  keep.focus(); // focus on keep — the non-destructive choice
}


// ---------------------------------------------------------------------------
// The username row — WEB_INTERFACE → The username row.
// Three slots (.username-line, .username-form, .username-flight) built once and
// updated in place, the invites row's model.
// ---------------------------------------------------------------------------

function usernameRow(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
  field.replaceChildren(el('div', 'username-line'), el('div', 'username-form'), el('div', 'username-flight'));
  updateUsername(field, handlers, ctx);
}

/** Update the username row's three slots in place from the current ctx — the
 *  invites row's model (HOUSE_STYLE → Motion). */
export function renderUsernameRow(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
  updateUsername(field, handlers, ctx);
}

function updateUsername(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
  const line = field.querySelector<HTMLElement>('.username-line');
  const formSlot = field.querySelector<HTMLElement>('.username-form');
  const flight = field.querySelector<HTMLElement>('.username-flight');
  if (!line || !formSlot || !flight) return;
  line.replaceChildren();
  formSlot.replaceChildren();
  flight.replaceChildren();

  // The transient flight's ending renders in the flight slot alongside whatever
  // state the line/form are in.
  if (ctx.usernameFlight && (ctx.usernameFlight.stage === 'rejected' || ctx.usernameFlight.stage === 'expired')) {
    flight.appendChild(stageLine(ctx.usernameFlight));
  }

  if (!ctx.ownNameLoaded) {
    line.appendChild(el('span', 'inkmute', '—'));
    return;
  }

  const pending = ctx.pendingUsername;

  // A pending claim or burn — the ledger's entry, durable across a reload.
  if (pending) {
    const muted = el('span', 'handle inkmute');
    muted.textContent = '@' + pending.name;
    line.appendChild(muted);
    if (ctx.usernameFlight?.stage === 'submitting') {
      flight.replaceChildren(stageLine(ctx.usernameFlight));
    } else if (!ctx.usernameFlight || ctx.usernameFlight.stage === 'submitted') {
      flight.replaceChildren(stageLine({ stage: 'submitted' }));
    }
    return;
  }

  // Holding a name — the handle, burn, and the hint. In the extension a handle
  // the chain does not back is clay (WEB_INTERFACE → The identity display).
  if (ctx.ownName) {
    const handle = el('span', 'handle');
    handle.textContent = '@' + ctx.ownName.name;
    if (ctx.identity !== null && ctx.nameClay(ctx.identity.pubKeyHex, ctx.ownName.name)) handle.classList.add('clay');
    line.appendChild(handle);
    line.appendChild(document.createTextNode(' '));

    const burn = el('button', 'word', 'burn') as HTMLButtonElement;
    if (!ctx.canAffordBurn) {
      burn.disabled = true;
      burn.title = `a burn costs ${USERNAME_BURN_PRICE} rep; this key has less`;
    }
    burn.addEventListener('click', () => {
      burnConfirm(line, handlers, ctx, burn);
    });
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

  // Holding none — the claim form or the "no karma box" hint.
  if (!ctx.canSignClaim) {
    line.appendChild(el('div', 'hint', 'a claim spends and returns one rep box; this key has none.'));
    return;
  }
  claimForm(formSlot as HTMLElement, handlers, ctx);
}

function claimForm(slot: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
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
    const id = ctx.identity;
    if (id?.locked) {
      if (form.parentElement?.querySelector('.card-unlock')) return;
      const urow = el('div', 'card-unlock');
      urow.appendChild(
        unlockForm(
          id.pubKeyHex,
          async (p) => {
            await handlers.unlockIdentity(p);
            handlers.claimUsername(v);
          },
          () => urow.remove(),
        ),
      );
      form.insertAdjacentElement('afterend', urow);
      return;
    }
    handlers.claimUsername(v);
  });
  slot.appendChild(form);
}

function burnConfirm(line: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx, burnBtn: HTMLElement): void {
  const name = ctx.ownName?.name;
  if (!name) return;
  const saved = [...line.childNodes];
  const wrap = el('div', 'pf-confirm');
  const q = el('div', 'pf-refusal');
  q.textContent = `burn @${name} for ${USERNAME_BURN_PRICE} rep? the name is open to anyone again, and your free claim returns.`;
  wrap.appendChild(q);
  const actions = el('div', 'pf-actions');
  const confirm = el('button', 'word', 'burn') as HTMLButtonElement;
  confirm.addEventListener('click', () => {
    const id = ctx.identity;
    if (id?.locked) {
      wrap.replaceChildren(
        unlockForm(
          id.pubKeyHex,
          async (p) => {
            await handlers.unlockIdentity(p);
            handlers.burnUsername();
          },
          restore,
        ),
      );
      return;
    }
    handlers.burnUsername();
  });
  const keep = el('button', 'word', 'keep') as HTMLButtonElement;
  const onEscape = (e: KeyboardEvent): void => { if (e.key === 'Escape') restore(); };
  const restore = (): void => {
    line.removeEventListener('keydown', onEscape);
    line.replaceChildren(...saved);
    burnBtn.focus();
  };
  keep.addEventListener('click', restore);
  actions.append(confirm, keep);
  wrap.appendChild(actions);
  line.replaceChildren(wrap);
  keep.focus();

  line.addEventListener('keydown', onEscape);
}

