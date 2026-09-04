import { el } from '../dom';
import { prefs, BUILD_BASE, BUILD_FAUCET_BASE, type Theme, type IdTint } from '../prefs';
import { unlockForm, setPassphraseForm } from './passphrase';
import type { KarmaResult } from '../api/dto';

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

export interface ProfileHandlers {
  // preferences, folded in from the settings window
  setTheme: (t: Theme) => void;
  setIdTint: (m: IdTint) => void;
  setNode: (origin: string) => void;
  setFaucet: (origin: string) => void;
  // identity operations
  inspectFile: (text: string) => { kind: 'clear' | 'encrypted'; pubKeyHex: string };
  draftIdentity: () => { pubKeyHex: string }; // a key held before the passphrase, so the form names it
  createIdentity: (passphrase: string) => Promise<void>; // seals and stores the drafted key
  discardDraft: () => void; // the reader cancelled create
  importIdentity: (text: string, passphrase: string) => Promise<void>;
  exportIdentity: (password: string) => Promise<void>;
  forgetIdentity: () => void;
  lockIdentity: () => void;
  unlockIdentity: (passphrase: string) => Promise<void>;
  askFaucet: () => void;
}

export interface ProfileCtx {
  arrangement: string; // the workspace as #r1,r2|r5 text
  identity: { pubKeyHex: string; locked: boolean } | null;
  backedUp: boolean;
  karma: KarmaResult | null; // the loaded key's /karma, once read
  grant: GrantView | null; // a faucet grant in flight, or one that lapsed
  membershipBars: { memberBar: number; memberLikesBar: number } | null; // from /status
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

export function profileBody(handlers: ProfileHandlers, ctx: ProfileCtx): HTMLElement {
  const b = el('div', 'winbody');
  if (ctx.identity === null) emptyState(b, handlers);
  else loadedState(b, handlers, ctx);
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

  const create = el('button', 'mini', 'create') as HTMLButtonElement;
  create.addEventListener('click', () => {
    // Draft the key first so the form shows its prefix as the username — the key
    // exists before the passphrase, so the manager's saved entry names it
    // (WEB_INTERFACE → The profile window). Cancelling discards the draft.
    const { pubKeyHex } = handlers.draftIdentity();
    field.replaceChildren(
      setPassphraseForm(pubKeyHex, (p) => handlers.createIdentity(p), () => {
        handlers.discardDraft();
        restoreInline();
      }),
    );
  });

  const importBtn = el('button', 'mini', 'import') as HTMLButtonElement;
  importBtn.addEventListener('click', () => pickFile((text) => revealImport(field, handlers, text, restoreInline)));

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
function revealImport(field: HTMLElement, handlers: ProfileHandlers, text: string, restore: () => void): void {
  let inspected: { kind: 'clear' | 'encrypted'; pubKeyHex: string };
  try {
    inspected = handlers.inspectFile(text);
  } catch (e) {
    const line = el('div', 'pf-refusal', e instanceof Error ? e.message : String(e));
    const back = el('button', 'mini', 'back') as HTMLButtonElement;
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

function loadedState(b: HTMLElement, handlers: ProfileHandlers, ctx: ProfileCtx): void {
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
    standing(field, ctx);
    b.appendChild(r);
  }

  // karma — the balance that spends, the faucet step, or the grant in flight.
  {
    const { row: r, field } = row('karma');
    field.classList.add('karma-field'); // the App updates this in place when a grant lands
    renderKarmaField(field, handlers, ctx);
    b.appendChild(r);
  }

  // passphrase — locked · unlock, or unlocked · lock.
  {
    const { row: r, field } = row('passphrase');
    field.classList.add('pp-field'); // inline flow: the word and its button on one line
    passphraseRow(field, handlers, id);
    b.appendChild(r);
  }

  // export — a fresh sealed file; a locked identity unlocks first.
  {
    const { row: r, field } = row('export');
    const trigger = el('button', 'mini', 'export') as HTMLButtonElement;
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
    const trigger = el('button', 'mini', 'forget') as HTMLButtonElement;
    const restore = (): void => {
      field.replaceChildren(trigger);
      trigger.focus();
    };
    trigger.addEventListener('click', () => forgetConfirm(field, handlers, ctx.backedUp, restore));
    field.appendChild(trigger);
    b.appendChild(r);
  }
}

function standing(field: HTMLElement, ctx: ProfileCtx): void {
  const k = ctx.karma;
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
  const vBar = ctx.membershipBars?.memberBar ?? k.memberBar;
  const lBar = ctx.membershipBars?.memberLikesBar ?? 0;
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
    const again = el('button', 'mini', 'ask again') as HTMLButtonElement;
    again.addEventListener('click', () => handlers.askFaucet());
    field.appendChild(again);
    return;
  }
  const faucetBase = prefs.faucet;
  if (faucetBase !== '') {
    const ask = el('button', 'mini', 'ask the faucet for karma') as HTMLButtonElement;
    ask.addEventListener('click', () => handlers.askFaucet());
    field.appendChild(ask);
    return;
  }
  field.appendChild(el('span', 'inkmute', 'no karma yet.'));
}

/** effective karma, or `E effective · T held` when decay has opened a gap — a
 *  client showing the face total would promise karma the next spend does not have. */
function balance(field: HTMLElement, k: KarmaResult): void {
  if (k.effective === k.total) {
    field.append(mono(k.effective), ' karma');
  } else {
    field.append(mono(k.effective), ' effective · ', mono(k.total), ' held');
  }
}

function passphraseRow(field: HTMLElement, handlers: ProfileHandlers, id: { pubKeyHex: string; locked: boolean }): void {
  field.replaceChildren();
  if (id.locked) {
    field.append(el('span', 'inkmute', 'locked'), ' ');
    const unlock = el('button', 'mini', 'unlock') as HTMLButtonElement;
    unlock.addEventListener('click', () => {
      const restore = (): void => {
        passphraseRow(field, handlers, id);
        (field.querySelector('button') as HTMLButtonElement | null)?.focus();
      };
      field.replaceChildren(unlockForm(id.pubKeyHex, (p) => handlers.unlockIdentity(p), restore));
    });
    field.appendChild(unlock);
  } else {
    field.append(el('span', 'inkmute', 'unlocked'), ' ');
    const lock = el('button', 'mini', 'lock') as HTMLButtonElement;
    lock.addEventListener('click', () => handlers.lockIdentity());
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
  const forget = el('button', 'mini', 'forget') as HTMLButtonElement;
  forget.addEventListener('click', () => handlers.forgetIdentity());
  const keep = el('button', 'mini', 'keep') as HTMLButtonElement;
  keep.addEventListener('click', restore);
  actions.append(forget, keep);
  wrap.appendChild(actions);
  field.replaceChildren(wrap);
  keep.focus(); // focus on keep — the non-destructive choice
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
      const btn = el('button', null, v);
      btn.setAttribute('aria-pressed', prefs.idtint === v ? 'true' : 'false');
      btn.addEventListener('click', () => handlers.setIdTint(v));
      seg.appendChild(btn);
    }
    field.appendChild(seg);
    field.appendChild(el('div', 'hint', 'the 4px edge on a title bar, from the author key. never an identifier.'));
    rows.push(r);
  }

  // Node — the effective base; a foreign origin fails until the node gains CORS.
  {
    const { row: r, field } = row('node');
    const input = el('input') as HTMLInputElement;
    input.value = prefs.node;
    input.placeholder = BUILD_BASE || 'same-origin (default)';
    input.setAttribute('aria-label', 'the node this client reads');
    input.addEventListener('change', () => handlers.setNode(input.value));
    field.appendChild(input);
    field.appendChild(el('div', 'hint', 'blank resets to the build default. a foreign origin needs CORS the node does not send yet, and will fail.'));
    rows.push(r);
  }

  // Faucet — the same shape as node; empty means no faucet and no button.
  {
    const { row: r, field } = row('faucet');
    const input = el('input') as HTMLInputElement;
    input.value = prefs.faucet;
    input.placeholder = BUILD_FAUCET_BASE || 'none';
    input.setAttribute('aria-label', 'the faucet this client asks for karma');
    input.addEventListener('change', () => handlers.setFaucet(input.value));
    field.appendChild(input);
    field.appendChild(el('div', 'hint', 'blank uses the build default. a foreign origin needs CORS the faucet does not send yet, and will fail.'));
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
