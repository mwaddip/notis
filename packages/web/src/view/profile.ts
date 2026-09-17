import { el, shortHex } from '../dom';
import { prefs, BUILD_BASE, BUILD_FAUCET_BASE, type Theme, type IdTint } from '../prefs';
import { unlockForm, setPassphraseForm } from './passphrase';
import { stageLine, type Flight } from './card';
import { INVITE_BOND_VEST_PER_LIKES, USERNAME_BURN_PRICE, isValidUsernameBytes } from '@dagsocial/types';
import { formatCredits, parseCredits } from '../model/credits';
import { spendableCreditBoxes, lockedCreditSummary } from '../wallet/reads';
import type { KarmaResult, BondsResult, CreditsResult, StatusResult, UsernameResult } from '../api/dto';
import type { Origin } from '../model/workspace';

// The @profile window — WEB_INTERFACE → The profile window. Identity, standing,
// karma and the faucet step, with the preference rows folded in from the settings
// window, in the .winbody/.row/label/.field pattern. No avatar and no identity
// colour: nothing here may invite a reader to check identity by colour
// (HOUSE_STYLE → Identity colour). The six operations are forms in place; each is a
// real <form> the browser's password manager can save from (→ passphrase.ts). The
// copy is the voice register (HOUSE_STYLE → Voice): what happens, never at the
// reader's expense, lowercase.
//
// The window declares the narrow shapes it reads and calls; the App's RenderCtx and
// Handlers satisfy them structurally, so there is one contract, not two.

/** How the faucet grant reads while it stands or after it lapses. */
export type GrantView = { state: 'pending' } | { state: 'expired'; atHeight: number };

/** The recipient the send form resolved at the press: a key with an optional
 *  handle (WEB_INTERFACE → The profile window). A handle read that came back
 *  empty is a refusal, so this is the success shape. */
export type ResolvedRecipient = { key: string; name: string | null };

export interface ProfileHandlers {
  // preferences, folded in from the settings window
  setTheme: (t: Theme) => void;
  setIdTint: (m: IdTint) => void;
  setNode: (origin: string) => void;
  setFaucet: (origin: string) => void;
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
  // The $NOTIS row — the send form and its resolution (WEB_INTERFACE → The
  // profile window). The App resolves an @handle to a key at the press.
  resolveRecipient: (text: string) => Promise<ResolvedRecipient | { refusal: string }>;
  send: (toHex: string, toName: string | null, amount: bigint) => void;
  askFaucetCredits: () => void;
  // The extension's binary sign policy (WEB_INTERFACE → The profile window).
  // Defined only in the extension build; the row renders only when both are set.
  policy?: () => 'silent' | 'ask';
  setPolicy?: (p: 'silent' | 'ask') => Promise<void>;
  // The extension's faucet-origin permission gate — the `set` on the faucet row
  // requests it from the press. Defined only in the extension build.
  requestFaucetOrigin?: (origin: string) => Promise<boolean>;
}

export interface ProfileCtx {
  arrangement: string; // the workspace as #r1,r2|r5 text
  identity: { pubKeyHex: string; locked: boolean } | null;
  backedUp: boolean;
  karma: KarmaResult | null; // the loaded key's /karma, once read
  grant: GrantView | null; // a faucet grant in flight, or one that lapsed
  membershipBars: { memberBar: number; memberLikesBar: number } | null; // from /status
  // The invites row (WEB_INTERFACE → The profile window).
  invite: { bondMin: string; bondMax: string; probationBlocks: number } | null; // from /status
  canAffordMinBond: boolean;   // the spendable covers the minimum bond
  bonds: BondsResult | null;   // the reader's standing bonds
  inviteFlight: Flight | null; // the invite in the row
  // The username row (WEB_INTERFACE → The username row).
  ownName: UsernameResult | null;
  ownNameLoaded: boolean;
  usernameFlight: Flight | null;
  pendingUsername: { kind: 'claim' | 'burn'; name: string } | null;
  canSignClaim: boolean;
  canAffordBurn: boolean;
  // The $NOTIS row (WEB_INTERFACE → The profile window). credits null before
  // the first read; sendFlight is the transient ending; pendingSend the ledger
  // entry that survives a reload; creditGrant a faucet transfer in flight or
  // one that lapsed. status.blockHeight is the tip the row's spendable-at-height
  // filter reads (WEB_INTERFACE → The wallet).
  status: StatusResult | null;
  credits: CreditsResult | null;
  creditGrant: GrantView | null;
  sendFlight: Flight | null;
  pendingSend: { toHex: string; toName: string | null; amount: bigint } | null;
}

const ID_TINTS: IdTint[] = ['spine', 'wash', 'both', 'off'];

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
  b.appendChild(el('hr', 'winrule'));
  for (const r of preferenceRows(handlers, ctx)) b.appendChild(r);
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
// An identity loaded — key, standing, karma, passphrase, export, forget.
// ---------------------------------------------------------------------------

function loadedState(b: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx, origin: Origin): void {
  const id = ctx.identity!;

  // key — the whole 64 hex, mono, selectable; the backup line until the first export.
  {
    const { row: r, field } = row('key');
    field.appendChild(mono(id.pubKeyHex));
    if (!ctx.backedUp) {
      field.appendChild(el('div', 'hint', 'this key lives in this browser only. export it to keep it.'));
    }
    b.appendChild(r);
  }

  // standing — the node's word, and a muted line beneath with its numbers.
  {
    const { row: r, field } = row('standing');
    standing(field, ctx.karma, ctx.membershipBars);
    b.appendChild(r);
  }

  // karma — the balance that spends, the faucet step, or the grant in flight.
  {
    const { row: r, field } = row('rep');
    field.classList.add('karma-field'); // the App updates this in place when a grant lands
    renderKarmaField(field, handlers, ctx);
    b.appendChild(r);
  }

  // $NOTIS — the balance in gold, the send form, its confirm and flight, or the
  // faucet's credits step (WEB_INTERFACE → The profile window).
  {
    const { row: r, field } = row('$NOTIS');
    field.classList.add('credits-field'); // the App updates this in place on a landing
    creditsRow(field, handlers, ctx);
    b.appendChild(r);
  }

  // invites — the tier line, the form, the flight, and the standing bonds.
  {
    const { row: r, field } = row('invites');
    invitesRow(field, handlers, ctx, origin);
    b.appendChild(r);
  }

  // username — the claim form or the held name and burn (WEB_INTERFACE → The username row).
  {
    const { row: r, field } = row('username');
    field.classList.add('username-field');
    usernameRow(field, handlers, ctx);
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

/** The standing word and its muted numbers line, for a key's own /karma. Shared
 *  with the author window, which reads it for another identity (WEB_INTERFACE →
 *  The author window: "the same function, given another key's KarmaResult"). */
export function standing(
  field: HTMLElement,
  k: KarmaResult | null,
  bars: { memberBar: number; memberLikesBar: number } | null,
): void {
  if (k === null) {
    field.appendChild(el('span', 'inkmute', '—'));
    return;
  }
  if (k.invitesAvailable === null) {
    field.appendChild(el('span', 'standing', 'root'));
    return;
  }
  if (k.member) {
    field.appendChild(el('span', 'standing', 'member'));
    const line = el('div', 'hint');
    line.append('since block ', mono(String(k.memberSinceBlock)), ' · ', mono(String(k.invitesAvailable)), ' invites available.');
    field.appendChild(line);
    return;
  }
  field.appendChild(el('span', 'standing', 'resident'));
  const vBar = bars?.memberBar ?? k.memberBar;
  const lBar = bars?.memberLikesBar ?? 0;
  const line = el('div', 'hint');
  line.append(
    "members are made by other members' vouches and likes. this key has ",
    mono(`${k.memberVouches} of ${vBar}`),
    ' vouches and ',
    mono(`${k.memberLikes} of ${lBar}`),
    ' likes.',
  );
  field.appendChild(line);
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
    // name, else the prefix; the same control.
    const btn = el('button', bond.inviteeName !== null ? 'handle authorbtn' : 'hex authorbtn');
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
    balance(field, k);
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

/** effective karma, or `E effective · T held` when decay has opened a gap — a
 *  client showing the face total would promise karma the next spend does not have. */
function balance(field: HTMLElement, k: KarmaResult): void {
  if (k.effective === k.total) {
    field.append(mono(k.effective), ' rep');
  } else {
    field.append(mono(k.effective), ' effective · ', mono(k.total), ' held');
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
// The $NOTIS row — WEB_INTERFACE → The profile window.
// Three slots (.credits-line, .credits-form, .credits-flight) built once and
// updated in place, the invites row's model — the form the reader is filling
// survives every in-place update, and clears only after an accepted submission.
// ---------------------------------------------------------------------------

function creditsRow(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
  field.replaceChildren(el('div', 'credits-line'), el('div', 'credits-form'), el('div', 'credits-flight'));
  // The form is built once, here, and left alone by the in-place update
  // (WEB_INTERFACE → The wallet). A subsequent build is owed only when the
  // spendable side turned from zero to non-zero — the App asks for it by
  // clearing the slot before renderCreditsRow.
  const c = ctx.credits;
  if (c !== null) {
    const height = ctx.status?.blockHeight ?? 0;
    const spendable = sumValues(spendableCreditBoxes(c.boxes, height));
    if (spendable > 0n) sendForm(field.querySelector('.credits-form') as HTMLElement, handlers, ctx);
  }
  updateCredits(field, handlers, ctx);
}

/** Update the $NOTIS row's line and flight in place from the current ctx —
 *  the invites row's model (HOUSE_STYLE → Motion: colour and text in a fixed
 *  box). The form slot is left alone; the send/confirm/restoreForm chain owns
 *  it, and the App calls `resetCreditsSendForm` on an accepted submission. */
export function renderCreditsRow(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
  // A spendable side turning from zero to non-zero owes a fresh form.
  const formSlot = field.querySelector<HTMLElement>('.credits-form');
  const c = ctx.credits;
  if (formSlot && c !== null && formSlot.children.length === 0) {
    const height = ctx.status?.blockHeight ?? 0;
    const spendable = sumValues(spendableCreditBoxes(c.boxes, height));
    if (spendable > 0n) sendForm(formSlot, handlers, ctx);
  }
  updateCredits(field, handlers, ctx);
}

/** Reset the send form's inputs — the App calls it after `result.ok` in the
 *  send flow (WEB_INTERFACE → The wallet). Every other ending leaves the
 *  values intact. */
export function resetCreditsSendForm(field: HTMLElement): void {
  const form = field.querySelector<HTMLFormElement>('form.credits-form');
  if (!form) return;
  for (const inp of form.querySelectorAll<HTMLInputElement>('input')) inp.value = '';
  const refusal = form.querySelector<HTMLElement>('.pf-refusal');
  if (refusal) refusal.hidden = true;
}

function sumValues(boxes: readonly { value: string }[]): bigint {
  let s = 0n;
  for (const b of boxes) s += BigInt(b.value);
  return s;
}

function updateCredits(field: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
  const line = field.querySelector<HTMLElement>('.credits-line');
  const formSlot = field.querySelector<HTMLElement>('.credits-form');
  const flight = field.querySelector<HTMLElement>('.credits-flight');
  if (!line || !formSlot || !flight) return;
  line.replaceChildren();
  flight.replaceChildren();

  const c = ctx.credits;
  if (c === null) {
    line.appendChild(el('span', 'inkmute', '—'));
    formSlot.replaceChildren();
    return;
  }

  // Spendable at the current tip — WEB_INTERFACE → The wallet. The row and
  // readCreditContext read one implementation of the rule.
  const height = ctx.status?.blockHeight ?? 0;
  const spendableBoxes = spendableCreditBoxes(c.boxes, height);
  const spendable = sumValues(spendableBoxes);

  if (spendable > 0n) {
    // Balance in gold + "$NOTIS"; the locked-hint beneath names only what is
    // above the current height (WEB_INTERFACE → The profile window).
    line.append(el('span', 'mono gold', formatCredits(spendable)), ' $NOTIS');
    const locked = lockedCreditSummary(c.boxes, height);
    if (locked) {
      const hint = el('div', 'hint');
      hint.append(mono(formatCredits(locked.value)), ' $NOTIS more unlock by block ', mono(String(locked.height)), '.');
      line.appendChild(hint);
    }
  } else {
    // No spendable box → the faucet step when a faucet is set, else "no $NOTIS yet."
    // The locked hint still stands so the reader knows what is on its way.
    const locked = lockedCreditSummary(c.boxes, height);
    if (ctx.creditGrant?.state === 'pending') {
      line.appendChild(el('span', 'inkmute', 'working…'));
    } else if (ctx.creditGrant?.state === 'expired') {
      line.appendChild(el('span', 'inkmute', "no block took the faucet's transfer by height "));
      line.appendChild(mono(String(ctx.creditGrant.atHeight)));
      line.appendChild(document.createTextNode('. '));
      const again = el('button', 'word', 'ask again') as HTMLButtonElement;
      again.addEventListener('click', () => handlers.askFaucetCredits());
      line.appendChild(again);
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
    // No spendable box means the form has nothing to spend — drop it.
    formSlot.replaceChildren();
  }

  // The pending line reads from the ledger — durable across a reload. The row
  // renders it directly rather than through stageLine, which prints only
  // "submitted" on that stage and would lose the amount and recipient
  // (WEB_INTERFACE → The profile window; the identity display's 16-glyph
  // prefix, → The identity display).
  const ps = ctx.pendingSend;
  if (ps !== null) {
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
}

/** The send form — the recipient (a key or an @handle), the amount ($NOTIS
 *  through parseCredits, never `type=number` which drops decimals and refuses a
 *  locale), the word `send`, a refusal line, and the hint. On submit: parse the
 *  amount, then the recipient — a 64-hex key straight through, else an @handle
 *  stripped of one leading `@` and validated as a username, resolved through the
 *  App at the press; the reader's own key refuses in place. */
function sendForm(slot: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
  const form = el('form', 'pf credits-form') as HTMLFormElement;

  const toInput = el('input') as HTMLInputElement;
  toInput.type = 'text';
  toInput.placeholder = 'a key or @handle';
  toInput.setAttribute('aria-label', 'the recipient — a 64-hex key or an @handle');
  toInput.autocomplete = 'off';
  toInput.autocapitalize = 'off';
  toInput.spellcheck = false;

  const amountInput = el('input') as HTMLInputElement;
  amountInput.type = 'text';
  amountInput.setAttribute('inputmode', 'decimal');
  amountInput.placeholder = '$NOTIS';
  amountInput.setAttribute('aria-label', 'the amount in $NOTIS');
  amountInput.autocomplete = 'off';

  const submit = el('button', 'word', 'send') as HTMLButtonElement;
  submit.type = 'submit';

  const refusal = el('div', 'pf-refusal');
  refusal.hidden = true;

  const hint = el('div', 'hint', '$NOTIS moves when a block takes the send, and a send cannot be undone.');

  form.append(toInput, amountInput, submit, refusal, hint);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submitForm();
  });

  const submitForm = async (): Promise<void> => {
    refusal.hidden = true;
    // Amount first — a bad number never asks the network for a handle.
    const amount = parseCredits(amountInput.value);
    if (amount === null || amount === 0n) {
      refusal.textContent = 'an amount is digits with up to eight decimals.';
      refusal.hidden = false;
      return;
    }
    // Recipient: a bare 64 hex is a key; else an @handle (one leading @ stripped) validated as a username.
    const raw = toInput.value.trim();
    const asKey = raw.toLowerCase();
    let toHex: string;
    let toName: string | null = null;
    if (/^[0-9a-f]{64}$/.test(asKey)) {
      toHex = asKey;
    } else {
      const naked = raw.startsWith('@') ? raw.slice(1) : raw;
      const bytes = new TextEncoder().encode(naked);
      if (!isValidUsernameBytes(bytes)) {
        refusal.textContent = 'that is not a key or a name.';
        refusal.hidden = false;
        return;
      }
      const res = await handlers.resolveRecipient(naked);
      if ('refusal' in res) {
        refusal.textContent = res.refusal;
        refusal.hidden = false;
        return;
      }
      toHex = res.key;
      toName = res.name;
    }
    if (toHex === ctx.identity?.pubKeyHex) {
      refusal.textContent = 'that is your own key.';
      refusal.hidden = false;
      return;
    }
    // The confirm row, in the form's slot; keep restores the form with its
    // values (the fourth ending, WEB_INTERFACE → The wallet). A locked identity
    // mounts the unlock form first.
    sendConfirm(slot, handlers, ctx, { toHex, toName, amount, raw, amountText: amountInput.value });
  };

  slot.appendChild(form);
}

/** The confirm row for a send — the burn's pattern. `keep` restores the form
 *  with its values so the reader made no mistake; `send` on a locked identity
 *  mounts the unlock form first, then proceeds. The prefix is 16 glyphs
 *  (WEB_INTERFACE → The identity display). */
function sendConfirm(
  slot: HTMLElement,
  handlers: ProfileHandlers,
  ctx: ProfileCtx,
  built: { toHex: string; toName: string | null; amount: bigint; raw: string; amountText: string },
): void {
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

  // The effective ctx — an in-row unlock fires no onChange, so every read of
  // the identity goes through `cur`, which the unlock path replaces so the
  // rebuilt form and any next press go straight to the flow (WEB_INTERFACE →
  // The wallet).
  let cur = ctx;

  const onEscape = (e: KeyboardEvent): void => { if (e.key === 'Escape') restoreForm(); };
  const restoreForm = (): void => {
    slot.removeEventListener('keydown', onEscape);
    slot.replaceChildren();
    sendForm(slot, handlers, cur);
    const f = slot.querySelector<HTMLFormElement>('form');
    if (f) {
      const inputs = f.querySelectorAll<HTMLInputElement>('input');
      if (inputs[0]) inputs[0].value = built.raw;
      if (inputs[1]) inputs[1].value = built.amountText;
    }
  };

  sendBtn.addEventListener('click', () => {
    const id = cur.identity;
    if (id?.locked) {
      wrap.replaceChildren(
        unlockForm(
          id.pubKeyHex,
          async (p) => {
            await handlers.unlockIdentity(p);
            cur = { ...cur, identity: { pubKeyHex: id.pubKeyHex, locked: false } };
            restoreForm();
            handlers.send(built.toHex, built.toName, built.amount);
          },
          restoreForm,
        ),
      );
      return;
    }
    // Restore the form with its values before the flight begins — every
    // ending but `result.ok` leaves them intact; the App clears them via
    // `resetCreditsSendForm` (WEB_INTERFACE → The wallet).
    restoreForm();
    handlers.send(built.toHex, built.toName, built.amount);
  });

  keep.addEventListener('click', restoreForm);
  actions.append(sendBtn, keep);
  wrap.appendChild(actions);
  slot.replaceChildren(wrap);
  keep.focus();
  slot.addEventListener('keydown', onEscape);
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

  // Holding a name — the handle, burn, and the hint.
  if (ctx.ownName) {
    const handle = el('span', 'handle');
    handle.textContent = '@' + ctx.ownName.name;
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

  const submit = el('button', 'word', 'claim') as HTMLButtonElement;
  submit.type = 'submit';

  const refusal = el('div', 'pf-refusal');
  refusal.hidden = true;

  const hint = el('div', 'hint');
  hint.append(
    `free, once per key. 1 to 24 letters, digits or _, shown as typed; one name is one name whatever its case. a later burn costs ${USERNAME_BURN_PRICE} rep and restores the claim.`,
  );

  form.append(input, submit, refusal, hint);
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

// ---------------------------------------------------------------------------
// The preferences — theme, identity tint, node, faucet, arrangement.
// ---------------------------------------------------------------------------

export function preferenceRows(handlers: ProfileHandlers, ctx: ProfileCtx): HTMLElement[] {
  const rows: HTMLElement[] = [];

  // Theme — the control names and shows the theme it would switch TO, never the
  // one already active (HOUSE_STYLE → Colour), styled as the inverse ground.
  {
    const { row: r, field } = row('theme');
    const target = prefs.theme === 'dark' ? 'light' : 'dark';
    const btn = el('button', 'theme-btn', target);
    btn.setAttribute('aria-label', `switch to ${target} theme`);
    btn.addEventListener('click', () => handlers.setTheme(target));
    field.appendChild(btn);
    rows.push(r);
  }

  // Identity tint — spine / wash / both / off, defaulting to spine.
  {
    const { row: r, field } = row('identity tint');
    const seg = el('div', 'seg');
    for (const v of ID_TINTS) {
      const btn = el('button', 'word', v);
      btn.setAttribute('aria-pressed', prefs.idtint === v ? 'true' : 'false');
      btn.addEventListener('click', () => handlers.setIdTint(v));
      seg.appendChild(btn);
    }
    field.appendChild(seg);
    field.appendChild(el('div', 'hint', 'the 4px edge on a title bar, from the author key. never an identifier.'));
    rows.push(r);
  }

  // Node — the effective base; any origin works (NODE_INTERFACE → Cross-origin requests).
  {
    const { row: r, field } = row('node');
    const input = el('input') as HTMLInputElement;
    input.value = prefs.node;
    input.placeholder = BUILD_BASE || 'same-origin (default)';
    input.setAttribute('aria-label', 'the node this client reads');
    input.addEventListener('change', () => handlers.setNode(input.value));
    field.appendChild(input);
    field.appendChild(el('div', 'hint', 'blank resets to the build default. any origin works: the node answers every origin.'));
    rows.push(r);
  }

  // Faucet — the same shape as node; empty means no faucet and no button. In
  // the extension the `set` requests host permission for the origin (a user
  // gesture, as the API requires); denied, the row's hint names the refusal
  // and the preference is not stored (WEB_INTERFACE → The profile window).
  {
    const { row: r, field } = row('faucet');
    const input = el('input') as HTMLInputElement;
    input.value = prefs.faucet;
    input.placeholder = BUILD_FAUCET_BASE || 'none';
    input.setAttribute('aria-label', 'the faucet this client asks for rep');
    const hint = el('div', 'hint', 'blank uses the build default. a foreign origin fails: the faucet answers its own origin only.');
    input.addEventListener('change', () => void (async () => {
      const value = input.value.trim();
      if (value !== '' && handlers.requestFaucetOrigin) {
        const granted = await handlers.requestFaucetOrigin(value);
        if (!granted) {
          hint.textContent = 'the browser refused access to that origin.';
          return;
        }
      }
      handlers.setFaucet(input.value);
    })());
    field.appendChild(input);
    field.appendChild(hint);
    rows.push(r);
  }

  // The extension's binary sign policy — visible only when both hooks are
  // present (the in-page module implements neither). *sign each rep action*
  // controls whether karma writes prompt (WEB_INTERFACE → The profile window).
  if (handlers.policy && handlers.setPolicy) {
    const { row: r, field } = row('sign each rep action');
    const current = handlers.policy();
    const seg = el('div', 'seg');
    for (const [label, value] of [['don\'t ask', 'silent'], ['ask', 'ask']] as const) {
      const btn = el('button', 'word', label);
      btn.setAttribute('aria-pressed', current === value ? 'true' : 'false');
      btn.addEventListener('click', () => { void handlers.setPolicy?.(value); });
      seg.appendChild(btn);
    }
    field.appendChild(seg);
    field.appendChild(el('div', 'hint', 'sending $NOTIS always asks. rep is silent while unlocked unless you ask.'));
    rows.push(r);
  }

  // Arrangement — the workspace as the #r1,r2|r5 text, readable and copyable.
  {
    const { row: r, field } = row('arrangement');
    const text = ctx.arrangement;
    field.appendChild(el('div', text ? 'arr' : 'arr empty', text || '(no windows open)'));
    rows.push(r);
  }

  return rows;
}
