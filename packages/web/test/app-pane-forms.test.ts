// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import type { PostJson, PostResult, ThreadResult, FeedResult, UsernameResult, CreditsResult, KarmaResult, BondsResult, VouchesTargetResult } from '../src/api/dto';
import {
  ME, fullRow, harness, settle, lockableIdentity, recordingWrites,
  karmaWithBox, membershipGate,
  type Harness, type LockableIdentity, type RecordingWrites,
} from './app-light-shared';
import { karmaResult } from './karma-fixture';
import { setNode, setTheme } from '../src/prefs';

// WEB_INTERFACE → The profile window → "The six operations are forms in place,
// and each is a real `<form>`"; → The wallet window → "The `send` row"; → The
// settings window; → The author window. Every case drives through the
// product's own path — a header control, a card's authorbtn, a card's strip,
// or a row's own submit — and every redraw is caused by what causes one in
// the product: a held-back read released, a window's own ↻, another window
// opened or closed in another column, pollTick, start-up.

const OTHER = 'ee'.repeat(32);
const BOB = 'bb'.repeat(32);
const NEXT_KEY = 'cc'.repeat(32); // the key an identity change loads

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const headerBtn = (label: string): HTMLButtonElement => {
  const b = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (b === null) throw new Error('no header control for ' + label);
  return b;
};
const openProfile = (): void => { headerBtn('open profile').click(); };
const openWallet = (): void => { headerBtn('open wallet').click(); };
const openSettings = (): void => { headerBtn('open settings').click(); };

const wordIn = (root: ParentNode, text: string): HTMLButtonElement => {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === text);
  if (b === undefined) throw new Error('no control reads ' + text);
  return b;
};
const fieldOf = (root: ParentNode): HTMLInputElement => {
  const f = root.querySelector<HTMLInputElement>('input[type="password"]');
  if (f === null) throw new Error('no password field in root');
  return f;
};
const submit = (form: Element): void => {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
};

const cardOf = (root: ParentNode, id: string): HTMLElement => {
  const c = root.querySelector<HTMLElement>(`.card[data-post-id="${id}"]`);
  if (c === null) throw new Error('no card drawn for ' + id.slice(0, 8));
  return c;
};
const likeOf = (card: HTMLElement): HTMLButtonElement => wordIn(card.querySelector('.meta')!, 'like');
const replyCtl = (card: HTMLElement): HTMLButtonElement => card.querySelector<HTMLButtonElement>('.reply-ctl')!;
const authorBtnOf = (card: HTMLElement): HTMLButtonElement => {
  const b = card.querySelector<HTMLButtonElement>('.who .authorbtn');
  if (b === null) throw new Error('no authorbtn');
  return b;
};
const regionsOf = (panes: HTMLElement): HTMLElement[] =>
  [...panes.querySelectorAll<HTMLElement>('.region')];
/** The body of the window in front in a region. */
const bodyOf = (region: HTMLElement): HTMLElement => {
  const b = region.querySelector<HTMLElement>('.region-body > .winbody');
  if (b === null) throw new Error('no window body in front');
  return b;
};
const nodeFieldOf = (root: ParentNode): HTMLInputElement => {
  const f = root.querySelector<HTMLInputElement>('[aria-label="the node this client reads"]');
  if (f === null) throw new Error('no node field');
  return f;
};

/** Press the bar's close ✕ at (colIdx, barIdx). A column's bars are rendered
 *  in `column.wins` order. */
function closeAt(panes: HTMLElement, colIdx: number, barIdx: number): void {
  const col = regionsOf(panes)[colIdx];
  if (col === undefined) throw new Error('no column ' + colIdx);
  const bars = [...col.querySelectorAll<HTMLElement>('.bar')];
  const bar = bars[barIdx];
  if (bar === undefined) throw new Error('no bar ' + barIdx + ' in column ' + colIdx);
  const ctl = bar.querySelector<HTMLButtonElement>('[aria-label^="close "]');
  if (ctl === null) throw new Error('no close ctl at ' + colIdx + ',' + barIdx);
  ctl.click();
}

/** Press the bar's `←` or `→` at (colIdx, barIdx). */
function moveAt(panes: HTMLElement, colIdx: number, barIdx: number, glyph: '←' | '→'): void {
  const bar = [...(regionsOf(panes)[colIdx]?.querySelectorAll<HTMLElement>('.bar') ?? [])][barIdx];
  if (bar === undefined) throw new Error('no bar ' + barIdx + ' in column ' + colIdx);
  const ctl = [...bar.querySelectorAll<HTMLButtonElement>('[aria-label^="move this "]')].find((b) => b.textContent === glyph);
  if (ctl === undefined) throw new Error('no ' + glyph + ' at ' + colIdx + ',' + barIdx);
  ctl.click();
}

/** Press the bar's label at (colIdx, barIdx) to focus it. */
function focusAt(panes: HTMLElement, colIdx: number, barIdx: number): void {
  const col = regionsOf(panes)[colIdx];
  if (col === undefined) throw new Error('no column ' + colIdx);
  const bars = [...col.querySelectorAll<HTMLElement>('.bar')];
  const bar = bars[barIdx];
  if (bar === undefined) throw new Error('no bar ' + barIdx + ' in column ' + colIdx);
  const label = bar.querySelector<HTMLButtonElement>('.bar-label');
  if (label === null) throw new Error('no label at ' + colIdx + ',' + barIdx);
  label.click();
}

/** The focused bar's visible name — profile / wallet / settings / author /
 *  posts for @-windows (read from its `.name`), or the excerpt for a thread. */
function focusedName(region: HTMLElement): string | null {
  const bar = region.querySelector<HTMLElement>('.bar.focused');
  if (bar === null) return null;
  const name = bar.querySelector<HTMLElement>('.name')?.textContent;
  if (name !== undefined && name !== null) return name;
  return bar.querySelector<HTMLElement>('.excerpt')?.textContent ?? null;
}

// ---------------------------------------------------------------------------
// Fixtures and rig
// ---------------------------------------------------------------------------

const page = (posts: PostJson[]): FeedResult =>
  ({ posts, next: null, pending: [], pendingCount: 0 });
const thread = (root: PostJson, descendants: PostJson[] = []): ThreadResult => ({
  post: root, ancestors: [], ancestorCount: 0,
  descendants, descendantCount: descendants.length,
  next: null, pending: [], pendingCount: 0,
});
const asResult = (row: PostJson): PostResult => ({ ...row, confirmedAuthor: row.author });

/** A member's karma holding a rep box, with one invite available — the invite
 *  form's three gates (member, available, canAffordMinBond) are met. */
function memberKarma(): KarmaResult {
  return karmaResult({
    userId: ME, total: '227', effective: '227',
    boxes: [{ boxId: '11'.repeat(32), value: '227' }], boxCount: 1,
    member: true, invitesAvailable: 1, height: 10,
  });
}

function creditsWithBox(key: string): CreditsResult {
  return {
    userId: key, total: '1250000000',
    boxes: [{ boxId: '22'.repeat(32), value: '1250000000' }],
    boxCount: 1, next: null,
  };
}

function ownNameRow(): UsernameResult {
  return { name: 'alice', owner: ME, boxId: '33'.repeat(32), claimedAtBlock: 1 };
}

async function openFromFeed(h: Harness, id: string): Promise<void> {
  cardOf(h.feedEl, id).querySelector<HTMLButtonElement>('button.strip')!.click();
  await settle();
}

/** Press the strip of a card inside a pane region to open its thread. */
async function openFromPane(region: HTMLElement, id: string): Promise<void> {
  cardOf(region, id).querySelector<HTMLButtonElement>('button.strip')!.click();
  await settle();
}

interface Rig extends Harness {
  id: LockableIdentity;
  writes: RecordingWrites;
}

function rig(o: {
  feed?: PostJson[];
  threads?: ThreadResult[];
  locked?: boolean;
  member?: boolean;
  karma?: KarmaResult;
  credits?: CreditsResult;
  ownName?: UsernameResult;
  bonds?: BondsResult;
  endorsers?: VouchesTargetResult;
  boot?: 'mount' | 'start';
  membershipGate?: Promise<void>;
  /** The identity carries a sign policy, as the extension's proxy does: the
   *  wallet's send has no confirm row, and a locked send owes its unlock in a
   *  row the App holds (WEB_INTERFACE → The wallet window → "The `send` row"). */
  extension?: boolean;
}): Rig {
  const id = lockableIdentity(ME, o.locked ?? true);
  if (o.extension) {
    id.identity.policy = () => 'silent';
    id.identity.setPolicy = async () => {};
  }
  const writes = recordingWrites(id);
  const feedRows = o.feed ?? [];
  const feedResults: FeedResult[] = [page(feedRows)];
  const karma = o.karma ?? (o.member ? memberKarma() : karmaWithBox(ME));
  const h = harness({
    identityKey: ME, identity: id.identity, writeClient: writes.client,
    karma, credits: o.credits, ownName: o.ownName, bonds: o.bonds, endorsers: o.endorsers, feedResults,
    boot: o.boot, membershipGate: o.membershipGate,
  });
  for (const row of feedRows) h.fake.postById!.set(row.id, asResult(row));
  for (const t of o.threads ?? []) {
    const post = t.post as PostJson;
    h.fake.threadById!.set(post.id, t);
    h.fake.postById!.set(post.id, asResult(post));
    for (const d of t.descendants as PostJson[]) h.fake.postById!.set(d.id, asResult(d));
  }
  return { ...h, id, writes };
}

async function boot(h: Rig): Promise<void> {
  await h.drive.loadFeed();
  await h.drive.loadMembershipState();
  await settle();
}

/** The row whose label reads `label`. */
function rowByLabel(root: ParentNode, label: string): HTMLElement {
  const r = [...root.querySelectorAll<HTMLElement>('.row')].find(
    (x) => x.querySelector<HTMLElement>('label')?.textContent === label,
  );
  if (r === undefined) throw new Error('no row for ' + label);
  return r;
}

/** The ↻ button of the pane whose focused window is `label` — the profile
 *  reads `refresh rep`, the wallet `refresh the balance`, settings is disabled,
 *  a thread reads `refresh replies to this thread`. */
async function pressRefresh(panes: HTMLElement, ariaLabel: string): Promise<void> {
  const btn = panes.querySelector<HTMLButtonElement>(`[aria-label="${ariaLabel}"]`);
  if (btn === null) throw new Error('no ↻ for ' + ariaLabel);
  btn.click();
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
  setTheme('light');
});

// ===========================================================================
// Group A — the form's window is the focused window of its column, and a redraw
// is caused by another window opening in or closing from ANOTHER column, or by
// the window's own ↻ or its own open's read landing.
// ===========================================================================

// ---------------------------------------------------------------------------
// A.1  The profile, its own open's read in flight.
// ---------------------------------------------------------------------------

describe('the passphrase row\'s unlock form across the open\'s read landing', () => {
  it('a locked identity, the reads held back, the profile opened, unlock pressed and typed, then the reads released: the form is the same node, its field holds what was typed, and the focus is in the field', async () => {
    const h = rig({ feed: [], locked: true });
    await h.drive.loadFeed();
    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;

    openProfile();
    await settle();

    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    await settle(); // the form's own frame passes: its field has the focus before any draw
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();
    expect(document.activeElement).toBe(field);

    gate.release();
    await settle();

    expect(form.isConnected).toBe(true);
    expect(h.panes.querySelector('.pp-field form.pf')).toBe(form);
    expect(fieldOf(h.panes.querySelector('.pp-field')!)).toBe(field);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

// ---------------------------------------------------------------------------
// A.2  The profile, its own ↻.
// ---------------------------------------------------------------------------

async function refreshProfile(h: Rig): Promise<void> {
  await pressRefresh(h.panes, 'refresh rep');
}

describe('the passphrase row\'s unlock form across the profile\'s ↻', () => {
  it('locked after the first read landed, unlock pressed and typed, ↻ pressed with reads held back, released: the form is the same node, its field holds what was typed, and the focus is in the field', async () => {
    const h = rig({ feed: [], locked: true });
    await boot(h);
    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    await settle(); // the form's own frame passes: its field has the focus before any draw
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(form.isConnected).toBe(true);
    expect(h.panes.querySelector('.pp-field form.pf')).toBe(form);
    expect(fieldOf(h.panes.querySelector('.pp-field')!)).toBe(field);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the unlock row under the invite form across the profile\'s ↻', () => {
  it('member karma loaded with one invite available; invite submitted with a 64-hex key, unlock row mounted and typed; ↻ with reads held back, released: the row is the same node under the same form, both fields hold what was typed, and the focus is in the passphrase field', async () => {
    const h = rig({ feed: [], locked: true, member: true });
    await boot(h);
    openProfile();
    await settle();

    const inviteForm = h.panes.querySelector<HTMLFormElement>('form.invite-form')!;
    const keyInput = inviteForm.querySelector<HTMLInputElement>('input[type="text"]')!;
    keyInput.value = BOB;
    submit(inviteForm);
    await settle();

    const unlockRow = inviteForm.parentElement!.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(unlockRow);
    field.value = 'secret';
    field.focus();

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(unlockRow.isConnected).toBe(true);
    expect(h.panes.querySelector('form.invite-form')).toBe(inviteForm);
    expect(inviteForm.nextElementSibling).toBe(unlockRow);
    expect(keyInput.value).toBe(BOB);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the unlock row under the claim form across the profile\'s ↻', () => {
  it('no name held, locked, claim submitted with a valid name, unlock row mounted and typed; ↻ with reads held back, released: the row is the same node under the same form, both fields hold what was typed, and the focus is in the passphrase field', async () => {
    const h = rig({ feed: [], locked: true });
    await boot(h);
    openProfile();
    await settle();

    const claimForm = h.panes.querySelector<HTMLFormElement>('form.username-form')!;
    const nameInput = claimForm.querySelector<HTMLInputElement>('input')!;
    nameInput.value = 'alice';
    submit(claimForm);
    await settle();

    const unlockRow = claimForm.parentElement!.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(unlockRow);
    field.value = 'secret';
    field.focus();

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(unlockRow.isConnected).toBe(true);
    expect(h.panes.querySelector('form.username-form')).toBe(claimForm);
    expect(claimForm.nextElementSibling).toBe(unlockRow);
    expect(nameInput.value).toBe('alice');
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the export form across the profile\'s ↻', () => {
  it('unlocked, export pressed, both set-passphrase fields typed; ↻ with reads held back, released: the form is the same node, both fields hold what was typed, and the focus is in the first', async () => {
    const h = rig({ feed: [], locked: false });
    await boot(h);
    openProfile();
    await settle();

    const exportRow = rowByLabel(h.panes, 'export');
    wordIn(exportRow, 'export').click();
    await settle();

    const form = exportRow.querySelector<HTMLFormElement>('form.pf')!;
    const inputs = [...form.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    expect(inputs).toHaveLength(2);
    inputs[0]!.value = 'secret';
    inputs[1]!.value = 'secret';
    inputs[0]!.focus();

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(form.isConnected).toBe(true);
    expect(rowByLabel(h.panes, 'export').querySelector('form.pf')).toBe(form);
    expect(inputs.map((x) => x.value)).toEqual(['secret', 'secret']);
    expect(document.activeElement).toBe(inputs[0]);
  });
});

describe('the invite form\'s own typed key across the profile\'s ↻', () => {
  it('invite form open with its key typed and not yet submitted: ↻ with reads held back, released: the form is the same node, its field holds the key typed, and the focus is in the field', async () => {
    const h = rig({ feed: [], locked: false, member: true });
    await boot(h);
    openProfile();
    await settle();

    const inviteForm = h.panes.querySelector<HTMLFormElement>('form.invite-form')!;
    const keyInput = inviteForm.querySelector<HTMLInputElement>('input[type="text"]')!;
    keyInput.value = BOB;
    keyInput.focus();

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(h.panes.querySelector('form.invite-form')).toBe(inviteForm);
    expect(inviteForm.querySelector('input[type="text"]')).toBe(keyInput);
    expect(keyInput.value).toBe(BOB);
    expect(document.activeElement).toBe(keyInput);
  });
});

describe('the claim field\'s own typed name across the profile\'s ↻', () => {
  it('no name held, claim field typed and not submitted: ↻ with reads held back, released: the form is the same node, its field holds the name typed, and the focus is in the field', async () => {
    const h = rig({ feed: [], locked: false });
    await boot(h);
    openProfile();
    await settle();

    const claimForm = h.panes.querySelector<HTMLFormElement>('form.username-form')!;
    const nameInput = claimForm.querySelector<HTMLInputElement>('input')!;
    nameInput.value = 'alice';
    nameInput.focus();

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(h.panes.querySelector('form.username-form')).toBe(claimForm);
    expect(claimForm.querySelector('input')).toBe(nameInput);
    expect(nameInput.value).toBe('alice');
    expect(document.activeElement).toBe(nameInput);
  });
});

describe('the burn confirm across the profile\'s ↻', () => {
  it('a name is held, burn pressed, the question stands; ↻ with reads held back, released: the question is the same node in the username row, and the focus is on keep', async () => {
    const h = rig({ feed: [], locked: false, member: true, ownName: ownNameRow() });
    await boot(h);
    openProfile();
    await settle();

    const burnBtn = wordIn(h.panes, 'burn');
    burnBtn.click();
    await settle();
    const confirm = h.panes.querySelector<HTMLElement>('.pf-confirm')!;
    expect(confirm).not.toBeNull();
    const keep = wordIn(confirm, 'keep');
    expect(document.activeElement).toBe(keep);

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(confirm.isConnected).toBe(true);
    expect(rowByLabel(h.panes, 'username').querySelector('.pf-confirm')).toBe(confirm);
    expect(document.activeElement).toBe(keep);
  });
});

describe('the forget confirm across the profile\'s ↻', () => {
  it('forget pressed, the question stands; ↻ with reads held back, released: the question is the same node in the forget row, and the focus is on keep', async () => {
    const h = rig({ feed: [], locked: false });
    await boot(h);
    openProfile();
    await settle();

    const forgetBtn = wordIn(rowByLabel(h.panes, 'forget'), 'forget');
    forgetBtn.click();
    await settle();
    const confirm = rowByLabel(h.panes, 'forget').querySelector<HTMLElement>('.pf-confirm')!;
    expect(confirm).not.toBeNull();
    const keep = wordIn(confirm, 'keep');
    expect(document.activeElement).toBe(keep);

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(confirm.isConnected).toBe(true);
    expect(rowByLabel(h.panes, 'forget').querySelector('.pf-confirm')).toBe(confirm);
    expect(document.activeElement).toBe(keep);
  });
});

// ---------------------------------------------------------------------------
// A.3  Another window opens or closes in ANOTHER column while the form's
//      window stays the focused one of its own column.
//
//      The arrangement, by `openWindow` (`WEB_INTERFACE → The workspace →
//      "One placement rule"`):
//        Q (feed)                     → column 0
//        R (from Q's pane, ci=0)      → column 1
//        S (from R's pane, ci=1)      → column 2
//      The form's window joins column 0's stack (profile / wallet / settings
//      open from the header, target = 0) focused, or sits at column 2 (author
//      opened from R's pane, target = 2) focused. Opening S from R's pane
//      targets column 2 and creates it; closing a thread in another column
//      removes it.
// ---------------------------------------------------------------------------

/** The scaffold for a profile / wallet / settings redraw case: Q at column 0,
 *  R at column 1, and R's reply S unopened — a case opens it to drive a new
 *  column 2. The form's window opens into column 0 and is focused there — Q
 *  stays stacked under it. Answers column 1's region. */
async function withQR(h: Rig, Q: PostJson, R: PostJson): Promise<HTMLElement> {
  await boot(h);
  await openFromFeed(h, Q.id);
  const col0 = regionsOf(h.panes)[0]!;
  await openFromPane(col0, R.id); // column 1 [R]
  return regionsOf(h.panes)[1]!;
}

describe('the passphrase row\'s unlock form while the profile is focused in column 0 across a window opening in column 2', () => {
  it('profile opened over Q; a new thread opened from R\'s pane (column 2): the form is the same node, its field holds what was typed, and the focus is in the field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)], locked: true });
    const col1 = await withQR(h, Q, R);

    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    await settle(); // the form's own frame passes: its field has the focus before any draw
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    // The focused window of column 0 is now @profile — Q is stacked under.
    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('profile');

    // S is a reply to R inside R's thread; its strip opens S's thread.
    await openFromPane(col1, S.id); // column 2 [S]
    expect(regionsOf(h.panes)).toHaveLength(3);

    expect(form.isConnected).toBe(true);
    expect(regionsOf(h.panes)[0]!.querySelector('.pp-field form.pf')).toBe(form);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the passphrase row\'s unlock form while the profile is focused in column 0 across a window closing in column 2', () => {
  it('profile opened over Q; S already open in column 2 is closed by its ✕: the form is the same node, its field holds what was typed, and the focus is in the field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)], locked: true });
    const col1 = await withQR(h, Q, R);
    await openFromPane(col1, S.id); // column 2 [S]

    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    await settle(); // the form's own frame passes: its field has the focus before any draw
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('profile');

    closeAt(h.panes, 2, 0);
    await settle();
    expect(regionsOf(h.panes)).toHaveLength(2);

    expect(form.isConnected).toBe(true);
    expect(regionsOf(h.panes)[0]!.querySelector('.pp-field form.pf')).toBe(form);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the passphrase row\'s unlock form while the profile is focused in column 0 across the stacked-under thread closing', () => {
  it('profile opened over Q, unlock typed; Q (stacked under) closed by its ✕: the form is the same node, its field holds what was typed, and the focus is in the field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: true });
    await boot(h);
    await openFromFeed(h, Q.id);
    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    await settle(); // the form's own frame passes: its field has the focus before any draw
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    closeAt(h.panes, 0, 0);
    await settle();
    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('profile');

    expect(form.isConnected).toBe(true);
    expect(h.panes.querySelector('.pp-field form.pf')).toBe(form);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the author window\'s vouch unlock row while the author window is focused in column 2 across a window opening in column 0', () => {
  it('author window opened from R\'s pane (column 2); vouch pressed and typed; a thread opened from the feed joins column 0: the row is the same node under your vouch, its field holds what was typed, and the focus is in the field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const T = fullRow('T', { author: BOB });
    const h = rig({
      feed: [Q, T],
      threads: [thread(Q, [R]), thread(R), thread(T)],
      locked: true, member: true,
    });
    await boot(h);
    await openFromFeed(h, Q.id);
    const col0 = regionsOf(h.panes)[0]!;
    await openFromPane(col0, R.id); // column 1 [R]
    const col1 = regionsOf(h.panes)[1]!;
    // In R's pane press R's authorbtn — origin pane 1, target 2.
    authorBtnOf(cardOf(col1, R.id)).click();
    await settle();
    await settle();

    const col2 = regionsOf(h.panes)[2]!;
    wordIn(col2, 'vouch').click();
    await settle();
    const row = col2.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();

    // The author window is focused of column 2 and visible.
    expect(focusedName(regionsOf(h.panes)[2]!)).toBe('author');

    // Press T's strip from the feed — origin feed, target 0 → joins column
    // 0's stack. The author window stays in front in column 2 while every
    // region is drawn.
    await openFromFeed(h, T.id);
    expect(regionsOf(h.panes)).toHaveLength(3);
    expect(focusedName(regionsOf(h.panes)[0]!)).toBe(T.content);

    expect(row.isConnected).toBe(true);
    const now = regionsOf(h.panes)[2]!;
    expect(now.querySelector('.card-unlock')).toBe(row);
    expect(rowByLabel(now, 'your vouch').nextElementSibling).toBe(row);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the author window\'s vouch unlock row across the thread it was opened from closing', () => {
  it('author window opened from R\'s pane (column 2); vouch typed; R closed by its ✕ — its column goes and the author window stands in column 1: the row is the same node under your vouch, its field holds what was typed, and the focus is in the field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({
      feed: [Q], threads: [thread(Q, [R]), thread(R)],
      locked: true, member: true,
    });
    await boot(h);
    await openFromFeed(h, Q.id);
    const col0 = regionsOf(h.panes)[0]!;
    await openFromPane(col0, R.id); // column 1 [R]
    const col1 = regionsOf(h.panes)[1]!;
    // Author from R's pane — origin pane 1, target 2.
    authorBtnOf(cardOf(col1, R.id)).click();
    await settle();
    await settle();

    const col2 = regionsOf(h.panes)[2]!;
    wordIn(col2, 'vouch').click();
    await settle();
    const row = col2.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();

    expect(focusedName(regionsOf(h.panes)[2]!)).toBe('author');

    closeAt(h.panes, 1, 0);
    await settle();
    expect(regionsOf(h.panes).map(focusedName)).toEqual([Q.content, 'author']);

    expect(row.isConnected).toBe(true);
    const now = regionsOf(h.panes)[1]!;
    expect(now.querySelector('.card-unlock')).toBe(row);
    expect(rowByLabel(now, 'your vouch').nextElementSibling).toBe(row);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the wallet\'s send form while the wallet is focused in column 0 across a window opening in column 2', () => {
  it('wallet opened over Q; recipient and amount typed; a new thread opened from R\'s pane (column 2): the form is the same node, both fields hold what was typed, and the focus is in the recipient', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({
      feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)],
      locked: false, credits: creditsWithBox(ME),
    });
    const col1 = await withQR(h, Q, R);

    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    inputs[0]!.focus();

    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('wallet');

    await openFromPane(col1, S.id);
    expect(regionsOf(h.panes)).toHaveLength(3);

    expect(form.isConnected).toBe(true);
    expect(regionsOf(h.panes)[0]!.querySelector('form.credits-form')).toBe(form);
    expect([inputs[0]!.value, inputs[1]!.value]).toEqual([BOB, '1.5']);
    expect(document.activeElement).toBe(inputs[0]);
  });
});

describe('the wallet\'s send form while the wallet is focused in column 0 across a window closing in column 2', () => {
  it('wallet opened over Q; S already open in column 2 is closed: the form is the same node, both fields hold what was typed, and the focus is in the recipient', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({
      feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)],
      locked: false, credits: creditsWithBox(ME),
    });
    const col1 = await withQR(h, Q, R);
    await openFromPane(col1, S.id);

    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    inputs[0]!.focus();

    closeAt(h.panes, 2, 0);
    await settle();
    expect(regionsOf(h.panes)).toHaveLength(2);

    expect(form.isConnected).toBe(true);
    expect(regionsOf(h.panes)[0]!.querySelector('form.credits-form')).toBe(form);
    expect([inputs[0]!.value, inputs[1]!.value]).toEqual([BOB, '1.5']);
    expect(document.activeElement).toBe(inputs[0]);
  });
});

describe('the wallet\'s send form while the wallet is focused in column 0 across the stacked-under thread closing', () => {
  it('wallet opened over Q; typed; Q (stacked under) closed by its ✕: the form is the same node, both fields hold what was typed, and the focus is in the recipient', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: false, credits: creditsWithBox(ME) });
    await boot(h);
    await openFromFeed(h, Q.id);
    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    inputs[0]!.focus();

    closeAt(h.panes, 0, 0);
    await settle();
    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('wallet');

    expect(form.isConnected).toBe(true);
    expect(h.panes.querySelector('form.credits-form')).toBe(form);
    expect([inputs[0]!.value, inputs[1]!.value]).toEqual([BOB, '1.5']);
    expect(document.activeElement).toBe(inputs[0]);
  });
});

describe('the settings node field while settings is focused in column 0 across a window opening in column 2', () => {
  it('settings opened over Q; node typed; a new thread opened from R\'s pane (column 2): the field is the same node, it holds what was typed, and the focus is in it', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)], locked: false });
    const col1 = await withQR(h, Q, R);

    openSettings();
    await settle();
    const nodeInput = h.panes.querySelector<HTMLInputElement>(
      '[aria-label="the node this client reads"]',
    )!;
    nodeInput.value = 'https://example.test';
    nodeInput.focus();

    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('settings');

    await openFromPane(col1, S.id);
    expect(regionsOf(h.panes)).toHaveLength(3);

    expect(nodeInput.isConnected).toBe(true);
    expect(nodeFieldOf(regionsOf(h.panes)[0]!)).toBe(nodeInput);
    expect(nodeInput.value).toBe('https://example.test');
    expect(document.activeElement).toBe(nodeInput);
  });
});

describe('the settings node field while settings is focused in column 0 across a window closing in column 2', () => {
  it('settings opened over Q; typed; S in column 2 closed: the field is the same node, it holds what was typed, and the focus is in it', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)], locked: false });
    const col1 = await withQR(h, Q, R);
    await openFromPane(col1, S.id);

    openSettings();
    await settle();
    const nodeInput = h.panes.querySelector<HTMLInputElement>(
      '[aria-label="the node this client reads"]',
    )!;
    nodeInput.value = 'https://example.test';
    nodeInput.focus();

    closeAt(h.panes, 2, 0);
    await settle();
    expect(regionsOf(h.panes)).toHaveLength(2);

    expect(nodeInput.isConnected).toBe(true);
    expect(nodeFieldOf(regionsOf(h.panes)[0]!)).toBe(nodeInput);
    expect(nodeInput.value).toBe('https://example.test');
    expect(document.activeElement).toBe(nodeInput);
  });
});

describe('the settings node field while settings is focused in column 0 across the stacked-under thread closing', () => {
  it('settings opened over Q; typed; Q (stacked under) closed by its ✕: the field is the same node, it holds what was typed, and the focus is in it', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: false });
    await boot(h);
    await openFromFeed(h, Q.id);
    openSettings();
    await settle();
    const nodeInput = h.panes.querySelector<HTMLInputElement>(
      '[aria-label="the node this client reads"]',
    )!;
    nodeInput.value = 'https://example.test';
    nodeInput.focus();

    closeAt(h.panes, 0, 0);
    await settle();
    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('settings');

    expect(nodeInput.isConnected).toBe(true);
    expect(nodeFieldOf(h.panes)).toBe(nodeInput);
    expect(nodeInput.value).toBe('https://example.test');
    expect(document.activeElement).toBe(nodeInput);
  });
});

describe('the settings node field across the theme pressed in its own window', () => {
  it('text typed in node and not committed; theme pressed: the field is the same node holding the text, the focus in it, and the theme row reads the other word on the same control', async () => {
    const h = rig({ feed: [], locked: false });
    await boot(h);
    openSettings();
    await settle();
    const nodeInput = nodeFieldOf(h.panes);
    nodeInput.value = 'https://example.test';
    nodeInput.focus();
    const theme = rowByLabel(h.panes, 'theme').querySelector<HTMLButtonElement>('button')!;
    expect(theme.textContent).toBe('dark');

    theme.click();
    await settle();

    expect(document.documentElement.getAttribute('data-t')).toBe('dark');
    expect(nodeFieldOf(h.panes)).toBe(nodeInput);
    expect(nodeInput.value).toBe('https://example.test');
    expect(document.activeElement).toBe(nodeInput);
    expect(rowByLabel(h.panes, 'theme').querySelector('button')).toBe(theme);
    expect(theme.textContent).toBe('light');
  });
});

// ---------------------------------------------------------------------------
// A.4  The profile opened beside an open form in another column.
// ---------------------------------------------------------------------------

describe('the author window\'s vouch unlock row in column 2 across the profile opening in column 0 and its reads landing', () => {
  it('author window opened from R\'s pane (column 2); vouch typed; profile opened from header with reads held back, then released: the row is the same node under your vouch, its field holds what was typed, and the focus is in the field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R)], locked: true, member: true });
    await boot(h);
    await openFromFeed(h, Q.id);
    const col0 = regionsOf(h.panes)[0]!;
    await openFromPane(col0, R.id); // column 1 [R]
    const col1 = regionsOf(h.panes)[1]!;
    authorBtnOf(cardOf(col1, R.id)).click();
    await settle();
    await settle();

    const col2 = regionsOf(h.panes)[2]!;
    wordIn(col2, 'vouch').click();
    await settle();
    const row = col2.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();

    expect(focusedName(regionsOf(h.panes)[2]!)).toBe('author');

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    openProfile(); // targets column 0 and joins Q's column; every region is drawn
    await settle();
    expect(row.isConnected).toBe(true);
    expect(document.activeElement).toBe(field);

    gate.release();
    await settle();

    expect(row.isConnected).toBe(true);
    const now = regionsOf(h.panes)[2]!;
    expect(now.querySelector('.card-unlock')).toBe(row);
    expect(rowByLabel(now, 'your vouch').nextElementSibling).toBe(row);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

// ---------------------------------------------------------------------------
// A.5  Wallet's send-unlock row (held by the App — WEB_INTERFACE → The wallet
//      window → "The `send` row" — the extension's `confirmInRow: false` arm)
//      and the web build's confirm row across (a) a window opening in another
//      column and (b) the wallet's own ↻.
// ---------------------------------------------------------------------------

/** The row the App holds: with no identity policy (web build) the confirm row
 *  stands in the form slot; with policy present (extension), `pressSend` on a
 *  locked identity attaches the unlock row the App holds in its answer. The
 *  harness's identity has no `policy`, so the web arm is driven here.
 *  (WEB_INTERFACE → The wallet window → "The `send` row"). */

describe('the wallet\'s confirm row (web) across a window opening in column 2', () => {
  it('wallet opened over Q, send pressed with a key and amount, the confirm row stands; a new thread opened from R\'s pane: the row is the same node in the form\'s slot, the focus on keep, and keep puts back the form with what was typed', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({
      feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)],
      locked: false, credits: creditsWithBox(ME),
    });
    const col1 = await withQR(h, Q, R);

    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    submit(form);
    await settle();
    const confirm = h.panes.querySelector<HTMLElement>('.credits-form .pf-confirm')!;
    expect(confirm).not.toBeNull();
    const keep = wordIn(confirm, 'keep');
    expect(document.activeElement).toBe(keep);

    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('wallet');

    await openFromPane(col1, S.id);
    expect(regionsOf(h.panes)).toHaveLength(3);

    expect(confirm.isConnected).toBe(true);
    expect(regionsOf(h.panes)[0]!.querySelector('.credits-form .pf-confirm')).toBe(confirm);
    expect(document.activeElement).toBe(keep);

    keep.click();
    expect(h.panes.querySelector('.pf-confirm')).toBeNull();
    expect(h.panes.querySelector('form.credits-form')).toBe(form);
    expect([inputs[0]!.value, inputs[1]!.value]).toEqual([BOB, '1.5']);
  });
});

describe('the wallet\'s confirm row (web) across the wallet\'s own ↻', () => {
  it('wallet open, send pressed with a key and amount, the confirm row stands; wallet\'s ↻ pressed: the row is the same node in the form\'s slot', async () => {
    const h = rig({ feed: [], locked: false, credits: creditsWithBox(ME) });
    await boot(h);
    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    submit(form);
    await settle();
    const confirm = h.panes.querySelector<HTMLElement>('.credits-form .pf-confirm')!;
    expect(confirm).not.toBeNull();

    await pressRefresh(h.panes, 'refresh the balance');

    expect(confirm.isConnected).toBe(true);
    expect(h.panes.querySelector('.credits-form .pf-confirm')).toBe(confirm);
  });
});

describe('the unlock row a locked send owes (extension) across a window opening in column 2', () => {
  it('wallet opened over Q, a send pressed while locked, a passphrase typed in the row under the form; a new thread opened from R\'s pane: the row is the same node under the same form, every field holds what was typed, and the focus is in the passphrase field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({
      feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)],
      locked: true, credits: creditsWithBox(ME), extension: true,
    });
    const col1 = await withQR(h, Q, R);

    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    submit(form);
    await settle();
    const row = form.nextElementSibling as HTMLElement;
    expect(row.classList.contains('card-unlock')).toBe(true);
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();

    await openFromPane(col1, S.id);
    expect(regionsOf(h.panes)).toHaveLength(3);

    expect(row.isConnected).toBe(true);
    expect(regionsOf(h.panes)[0]!.querySelector('form.credits-form')).toBe(form);
    expect(form.nextElementSibling).toBe(row);
    expect([inputs[0]!.value, inputs[1]!.value, field.value]).toEqual([BOB, '1.5', 'secret']);
    expect(form.querySelector('.resolved-key')?.textContent).toBe(BOB);
    expect(document.activeElement).toBe(field);
  });
});

// ---------------------------------------------------------------------------
// A.6  Start-up — a restored arrangement with the profile open; the start-up
//      read held back.
// ---------------------------------------------------------------------------

describe('the passphrase row\'s unlock form across a start-up read landing', () => {
  it('a restored arrangement with the profile open; the start-up read held back; unlock pressed and typed; the read released: the form is the same node, its field holds what was typed, and the focus is in the field', async () => {
    localStorage.setItem('notis.layout', '@profile');
    const gate = membershipGate();
    const h = rig({ feed: [], locked: true, boot: 'start', membershipGate: gate.promise });
    await settle();

    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    await settle(); // the form's own frame passes: its field has the focus before any draw
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    gate.release();
    await settle();

    expect(form.isConnected).toBe(true);
    expect(h.panes.querySelector('.pp-field form.pf')).toBe(form);
    expect(field.value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

// ---------------------------------------------------------------------------
// A.7  The profile with no identity loaded.
// ---------------------------------------------------------------------------

describe('the create form with no identity loaded across the stacked-under thread closing', () => {
  it('profile opened over Q, create pressed, both passphrase fields typed; Q closed by its ✕: the form is the same node, both fields hold what was typed, and the focus is in the first', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = harness({ identityKey: null, feedResults: [page([Q])] });
    h.fake.threadById!.set(Q.id, thread(Q));
    h.fake.postById!.set(Q.id, asResult(Q));
    await h.drive.loadFeed();
    await settle();
    cardOf(h.feedEl, Q.id).querySelector<HTMLButtonElement>('button.strip')!.click();
    await settle();
    openProfile();
    await settle();

    wordIn(h.panes, 'create').click();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('.pf-inline form.pf')!;
    const inputs = [...form.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    expect(inputs).toHaveLength(2);
    inputs[0]!.value = 'new';
    inputs[1]!.value = 'new';
    inputs[0]!.focus();

    closeAt(h.panes, 0, 0);
    await settle();
    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('profile');

    expect(form.isConnected).toBe(true);
    expect(h.panes.querySelector('.pf-inline form.pf')).toBe(form);
    expect(inputs.map((x) => x.value)).toEqual(['new', 'new']);
    expect(document.activeElement).toBe(inputs[0]);
  });
});

// ===========================================================================
// Group B — the form's window is covered by another window of its column
// brought to the front, then brought back to the front through its bar.
// ===========================================================================

describe('the profile\'s passphrase unlock form across its window being covered by a stacked thread and brought back', () => {
  it('profile open over Q; unlock typed; Q brought to front by pressing its bar; profile brought back by pressing its bar: off the document while covered, and on return the form is the same node with what was typed in its field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: true });
    await boot(h);
    await openFromFeed(h, Q.id);
    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    await settle(); // the form's own frame passes: its field has the focus before any draw
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    // Column 0 wins = [Q, @profile]; bars are [Q bar, profile bar].
    focusAt(h.panes, 0, 0); // Q to front
    await settle();
    expect(form.isConnected).toBe(false);
    expect(field.value).toBe('secret');
    focusAt(h.panes, 0, 1); // profile back to front
    await settle();

    expect(form.isConnected).toBe(true);
    expect(h.panes.querySelector('.pp-field form.pf')).toBe(form);
    expect(fieldOf(h.panes.querySelector('.pp-field')!)).toBe(field);
    expect(field.value).toBe('secret');
  });
});

describe('a reply\'s composer with a draft across its thread being covered and brought back', () => {
  it('a reply drafted under Q in Q\'s pane; the profile opened over Q; Q brought back by its bar: the composer is the same node under Q\'s card, the draft in it', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: false });
    await boot(h);
    await openFromFeed(h, Q.id);
    replyCtl(cardOf(h.panes, Q.id)).click();
    await settle();
    const composer = h.panes.querySelector<HTMLElement>('.composer')!;
    const text = composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    text.value = 'a draft';
    text.dispatchEvent(new Event('input'));

    openProfile(); // column 0 [Q, profile]
    await settle();
    expect(composer.isConnected).toBe(false);

    focusAt(h.panes, 0, 0); // Q back to the front
    await settle();
    expect(composer.isConnected).toBe(true);
    expect(h.panes.querySelector('.composer')).toBe(composer);
    expect(cardOf(h.panes, Q.id).nextElementSibling).toBe(composer);
    expect(composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!.value).toBe('a draft');
  });
});

describe('a passphrase typed in a form whose window is covered is held in its field and nowhere else', () => {
  it('profile open over Q; a passphrase typed; Q brought to front: no field in the document holds it; profile brought back: one field holds it, the one it was typed in', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: true });
    await boot(h);
    await openFromFeed(h, Q.id);
    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    const field = fieldOf(pp);
    field.value = 'correct horse';
    const holding = (): HTMLInputElement[] =>
      [...document.querySelectorAll<HTMLInputElement>('input')].filter((x) => x.value === 'correct horse');
    expect(holding()).toEqual([field]);

    focusAt(h.panes, 0, 0); // Q to front
    await settle();
    expect(holding()).toEqual([]);
    expect(document.body.textContent).not.toContain('correct horse');
    expect(field.value).toBe('correct horse');

    focusAt(h.panes, 0, 1); // profile back to front
    await settle();
    expect(holding()).toEqual([field]);
    expect(h.id.unlocks).toEqual([]);
  });
});

describe('the author window\'s vouch unlock row across its window being covered by a stacked thread and brought back', () => {
  it('author in column 1 opened from Q\'s pane; vouch typed; R opened from Q\'s pane joins column 1 and covers author; author brought back by its bar: off the document while covered, and on return the row is the same node under your vouch with what was typed in its field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R)], locked: true, member: true });
    await boot(h);
    await openFromFeed(h, Q.id);
    const col0 = regionsOf(h.panes)[0]!;
    // From Q's pane open author of R — origin pane 0, target 1 → column 1 [author].
    authorBtnOf(cardOf(col0, Q.id)).click();
    await settle();
    await settle();
    const col1 = regionsOf(h.panes)[1]!;
    wordIn(col1, 'vouch').click();
    await settle();
    const row = col1.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();

    // R from Q's pane — joins column 1 and covers the author window.
    await openFromPane(regionsOf(h.panes)[0]!, R.id);
    expect(row.isConnected).toBe(false);
    expect(field.value).toBe('secret');
    // Column 1 wins = [author, R], bars = [author bar, R bar]. Focus author.
    focusAt(h.panes, 1, 0);
    await settle();

    expect(row.isConnected).toBe(true);
    const now = regionsOf(h.panes)[1]!;
    expect(now.querySelector('.card-unlock')).toBe(row);
    expect(rowByLabel(now, 'your vouch').nextElementSibling).toBe(row);
    expect(field.value).toBe('secret');
  });
});

describe('the wallet\'s send form across its window being covered by a stacked thread and brought back', () => {
  it('wallet over Q; recipient typed; Q brought to front; wallet brought back: off the document while covered, and on return the form is the same node with what was typed in its field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: false, credits: creditsWithBox(ME) });
    await boot(h);
    await openFromFeed(h, Q.id);
    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[0]!.focus();

    focusAt(h.panes, 0, 0); // Q
    await settle();
    expect(form.isConnected).toBe(false);
    expect(inputs[0]!.value).toBe(BOB);
    focusAt(h.panes, 0, 1); // wallet back
    await settle();

    expect(form.isConnected).toBe(true);
    expect(h.panes.querySelector('form.credits-form')).toBe(form);
    expect(inputs[0]!.value).toBe(BOB);
  });
});

describe('the unlock row a locked send owes (extension) across its window being covered by a stacked thread and brought back', () => {
  it('wallet over Q, a send pressed while locked, a passphrase typed; Q brought to front; wallet brought back: off the document while covered, and on return the row is the same node under the same form with what was typed in its field', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: true, credits: creditsWithBox(ME), extension: true });
    await boot(h);
    await openFromFeed(h, Q.id);
    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    submit(form);
    await settle();
    const row = form.nextElementSibling as HTMLElement;
    const field = fieldOf(row);
    field.value = 'secret';

    focusAt(h.panes, 0, 0); // Q
    await settle();
    expect(row.isConnected).toBe(false);
    expect(field.value).toBe('secret');
    focusAt(h.panes, 0, 1); // wallet back
    await settle();

    expect(row.isConnected).toBe(true);
    expect(h.panes.querySelector('form.credits-form')).toBe(form);
    expect(form.nextElementSibling).toBe(row);
    expect(field.value).toBe('secret');
  });
});

describe('the settings node field across its window being covered by a stacked thread and brought back', () => {
  it('settings over Q; node typed; Q brought to front; settings brought back: off the document while covered, and on return the field is the same node with what was typed in it', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: false });
    await boot(h);
    await openFromFeed(h, Q.id);
    openSettings();
    await settle();
    const nodeInput = h.panes.querySelector<HTMLInputElement>(
      '[aria-label="the node this client reads"]',
    )!;
    nodeInput.value = 'https://example.test';
    nodeInput.focus();

    focusAt(h.panes, 0, 0); // Q
    await settle();
    expect(nodeInput.isConnected).toBe(false);
    expect(nodeInput.value).toBe('https://example.test');
    focusAt(h.panes, 0, 1); // settings back
    await settle();

    expect(nodeInput.isConnected).toBe(true);
    expect(nodeFieldOf(h.panes)).toBe(nodeInput);
    expect(nodeInput.value).toBe('https://example.test');
  });
});

// ===========================================================================
// Group C — controls: pane forms that stand because the redraw path spares
// the form's region, and App-held rows outside the pane views that outlast a
// renderPanes.
// ===========================================================================

describe('the passphrase row\'s unlock form across a pollTick landing of the reader\'s own reply, with the thread covered in the profile\'s column', () => {
  it('reader submits a reply through Q\'s pane; profile opens over Q; passphrase locked, unlock typed; pollTick lands the reply (parent is Q, Q is not focused): no region is re-rendered — the form stands', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: false });
    await boot(h);
    await openFromFeed(h, Q.id);
    replyCtl(cardOf(h.panes, Q.id)).click();
    await settle();
    const composer = h.panes.querySelector<HTMLElement>('.composer')!;
    const text = composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    text.value = 'a reply';
    text.dispatchEvent(new Event('input'));
    wordIn(composer, 'post').click();
    await settle();
    const NEW = h.writes.nextPostId;

    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'lock').click();
    await settle();
    wordIn(h.panes.querySelector<HTMLElement>('.pp-field')!, 'unlock').click();
    const form = h.panes.querySelector<HTMLFormElement>('.pp-field form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    h.fake.postById!.set(NEW, asResult(fullRow('new', { id: NEW, content: 'a reply', parentRefs: [Q.id] })));
    h.fake.height = 11;
    await h.drive.pollTick();
    await settle();

    expect(form.isConnected).toBe(true);
    expect(fieldOf(h.panes.querySelector('.pp-field')!).value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the passphrase row\'s unlock form across a pollTick landing that re-renders a visible thread in another column', () => {
  it('reader submits a reply inside R\'s pane; profile opens over Q; passphrase locked, unlock typed; pollTick lands the reply (parent R, column 1 focused on R): column 1 is re-rendered, column 0\'s profile stands', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({
      feed: [Q], threads: [thread(Q, [R]), thread(R)],
      locked: false,
    });
    await boot(h);
    await openFromFeed(h, Q.id);
    const col0 = regionsOf(h.panes)[0]!;
    await openFromPane(col0, R.id); // column 1 [R]
    const col1 = regionsOf(h.panes)[1]!;
    replyCtl(cardOf(col1, R.id)).click();
    await settle();
    const composer = h.panes.querySelector<HTMLElement>('.composer')!;
    const text = composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    text.value = 'a reply';
    text.dispatchEvent(new Event('input'));
    wordIn(composer, 'post').click();
    await settle();
    const NEW = h.writes.nextPostId;

    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'lock').click();
    await settle();
    wordIn(h.panes.querySelector<HTMLElement>('.pp-field')!, 'unlock').click();
    const form = h.panes.querySelector<HTMLFormElement>('.pp-field form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    h.fake.postById!.set(NEW, asResult(fullRow('new', { id: NEW, content: 'a reply', parentRefs: [R.id] })));
    h.fake.height = 11;
    await h.drive.pollTick();
    await settle();

    expect(form.isConnected).toBe(true);
    expect(fieldOf(h.panes.querySelector('.pp-field')!).value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('a card\'s unlock row and the composer draft across the membership read landing', () => {
  it('card unlock row in R\'s pane (column 1); composer draft in the feed; profile opened over Q with reads held back, then released: both stand (the App holds the card row and the composer across every redraw)', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R)], locked: true });
    await boot(h);
    await openFromFeed(h, Q.id);
    const col0 = regionsOf(h.panes)[0]!;
    await openFromPane(col0, R.id); // column 1 [R]

    wordIn(h.feedEl.querySelector('.feed-head')!, 'new post').click();
    await settle();
    const composer = h.feedEl.querySelector<HTMLElement>('.composer')!;
    const text = composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    text.value = 'a draft';
    text.dispatchEvent(new Event('input'));

    const col1 = regionsOf(h.panes)[1]!;
    likeOf(cardOf(col1, R.id)).click();
    const unlock = cardOf(col1, R.id).querySelector<HTMLElement>('.card-unlock')!;
    fieldOf(unlock).value = 'half';

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    openProfile();
    await settle();

    gate.release();
    await settle();

    const col1After = regionsOf(h.panes)[1]!;
    expect(unlock.isConnected).toBe(true);
    expect(cardOf(col1After, R.id).querySelector('.card-unlock')).toBe(unlock);
    expect(fieldOf(unlock).value).toBe('half');

    expect(composer.isConnected).toBe(true);
    expect(h.feedEl.querySelector('.composer')).toBe(composer);
    expect(composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!.value).toBe('a draft');
  });
});

// ===========================================================================
// Group E — a draw adds or ends a form only where the state has changed
// whether its row offers it (WEB_INTERFACE → The workspace → "A draw updates a
// standing body in place").
// ===========================================================================

describe('a read that leaves no invite available ends the invite form', () => {
  it('the invite form with a key typed and its unlock row with a passphrase typed; the ↻\'s read answers no invite available: neither stands, both fields read empty, and the line reads the new count', async () => {
    const h = rig({ feed: [], locked: true, member: true });
    await boot(h);
    openProfile();
    await settle();
    const inviteForm = h.panes.querySelector<HTMLFormElement>('form.invite-form')!;
    const keyInput = inviteForm.querySelector<HTMLInputElement>('input[type="text"]')!;
    keyInput.value = BOB;
    submit(inviteForm);
    const unlockRow = rowByLabel(h.panes, 'invites').querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(unlockRow);
    field.value = 'secret';

    h.fake.karma = { ...memberKarma(), invitesAvailable: 0 };
    await refreshProfile(h);

    const row = rowByLabel(h.panes, 'invites');
    expect(row.querySelector('form')).toBeNull();
    expect(row.querySelector('.card-unlock')).toBeNull();
    expect(inviteForm.isConnected).toBe(false);
    expect(keyInput.value).toBe('');
    expect(field.value).toBe('');
    expect(row.querySelector('.invites-line')?.textContent).toBe('0 invites available.');
  });
});

describe('a read that leaves no box spendable ends the send form', () => {
  it('the send form with a recipient and an amount typed; the wallet\'s ↻ reads an empty listing: the form is gone, both fields read empty, and the send row is hidden', async () => {
    const h = rig({ feed: [], locked: false, credits: creditsWithBox(ME) });
    await boot(h);
    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';

    h.fake.credits = { userId: ME, total: '0', boxes: [], boxCount: 0, next: null };
    await pressRefresh(h.panes, 'refresh the balance');

    expect(h.panes.querySelector('form.credits-form')).toBeNull();
    expect(form.isConnected).toBe(false);
    expect([inputs[0]!.value, inputs[1]!.value]).toEqual(['', '']);
    expect(h.panes.querySelector<HTMLElement>('.send-row')!.hidden).toBe(true);
  });

  it('the confirm row standing in the form\'s place; the wallet\'s ↻ reads an empty listing: the row is gone and the fields behind it read empty', async () => {
    const h = rig({ feed: [], locked: false, credits: creditsWithBox(ME) });
    await boot(h);
    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    submit(form);
    await settle();
    const confirm = h.panes.querySelector<HTMLElement>('.credits-form .pf-confirm')!;
    expect(confirm).not.toBeNull();

    h.fake.credits = { userId: ME, total: '0', boxes: [], boxCount: 0, next: null };
    await pressRefresh(h.panes, 'refresh the balance');

    expect(confirm.isConnected).toBe(false);
    expect(h.panes.querySelector('.pf-confirm')).toBeNull();
    expect([inputs[0]!.value, inputs[1]!.value]).toEqual(['', '']);
  });
});

describe('a read that lands a name ends the claim form and places the username row above key', () => {
  it('the claim form with a name typed; the ↻\'s read answers a name held: the form is gone, its field reads empty, the row reads the handle and stands above key', async () => {
    const h = rig({ feed: [], locked: false });
    await boot(h);
    openProfile();
    await settle();
    const labels = (): Array<string | null> =>
      [...h.panes.querySelectorAll<HTMLElement>('.winbody > .row > label')].map((l) => l.textContent);
    expect(labels().slice(0, 2)).toEqual(['key', 'username']);
    const usernameRow = rowByLabel(h.panes, 'username');
    const claimForm = usernameRow.querySelector<HTMLFormElement>('form.username-form')!;
    const nameInput = claimForm.querySelector<HTMLInputElement>('input')!;
    nameInput.value = 'alice';

    h.fake.ownName = ownNameRow();
    await refreshProfile(h);

    expect(rowByLabel(h.panes, 'username')).toBe(usernameRow);
    expect(usernameRow.querySelector('form')).toBeNull();
    expect(claimForm.isConnected).toBe(false);
    expect(nameInput.value).toBe('');
    expect(usernameRow.querySelector('.handle')?.textContent).toBe('@alice');
    expect(labels().slice(0, 2)).toEqual(['username', 'key']);
  });
});

// ===========================================================================
// Group F — a window's controls act on the state as it stands at the press
// (WEB_INTERFACE → The workspace → "A window's controls act on the state as it
// stands at the press").
// ===========================================================================

describe('the profile\'s export reads the identity\'s lock when pressed', () => {
  it('the profile drawn unlocked, the lock flipped with no notice and no draw: export asks for the unlock first', async () => {
    const h = rig({ feed: [], locked: false });
    await boot(h);
    openProfile();
    await settle();
    const exportRow = rowByLabel(h.panes, 'export');

    h.id.setLocked(true); // locked in another page of the extension
    wordIn(exportRow, 'export').click();
    const fields = exportRow.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(fields).toHaveLength(1);
    expect(fields[0]!.autocomplete).toBe('current-password');
  });

  it('the profile drawn locked, the lock flipped with no notice and no draw: export goes to the file\'s set form', async () => {
    const h = rig({ feed: [], locked: true });
    await boot(h);
    openProfile();
    await settle();
    const exportRow = rowByLabel(h.panes, 'export');

    h.id.setLocked(false); // unlocked in another page of the extension
    wordIn(exportRow, 'export').click();
    const fields = exportRow.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(fields).toHaveLength(2);
    expect(fields[0]!.autocomplete).toBe('new-password');
  });
});

describe('the wallet\'s send reads the identity\'s lock when pressed', () => {
  it('the wallet drawn unlocked, the lock flipped with no notice and no draw: the confirm row\'s send asks for the unlock in the row\'s place, and nothing is signed', async () => {
    const h = rig({ feed: [], locked: false, credits: creditsWithBox(ME) });
    await boot(h);
    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';

    h.id.setLocked(true); // locked in another page of the extension
    submit(form);
    await settle();
    const confirm = h.panes.querySelector<HTMLElement>('.credits-form .pf-confirm')!;
    wordIn(confirm, 'send').click();
    await settle();

    expect(confirm.querySelector('input[type="password"]')).not.toBeNull();
    expect(h.panes.querySelector('.credits-flight')?.textContent).toBe('');
    expect(h.id.signed).toEqual([]);
  });

  it('the wallet drawn locked, the lock flipped with no notice and no draw: the confirm row\'s send asks for no unlock, and the form returns with what was typed', async () => {
    const h = rig({ feed: [], locked: true, credits: creditsWithBox(ME) });
    await boot(h);
    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';

    h.id.setLocked(false); // unlocked in another page of the extension
    submit(form);
    await settle();
    wordIn(h.panes.querySelector<HTMLElement>('.credits-form .pf-confirm')!, 'send').click();
    await settle();

    expect(h.panes.querySelector('.credits-field input[type="password"]')).toBeNull();
    expect(h.id.unlocks).toEqual([]);
    expect(h.panes.querySelector('form.credits-form')).toBe(form);
    expect([inputs[0]!.value, inputs[1]!.value]).toEqual([BOB, '1.5']);
  });
});

describe('a standing bond\'s name opens beside the column the profile stands in when pressed', () => {
  it('the profile moved by →, by ←, and left in column 0 by the column on its left closing: each press opens the invitee\'s window one column right of the profile', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const bonds: BondsResult = {
      bonds: [{ id: 'b1', value: '100', inviterId: ME, inviteePublicKey: BOB, inviterName: null, inviteeName: null }],
      bondCount: 1, next: null,
    };
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: false, member: true, bonds });
    await boot(h);
    await openFromFeed(h, Q.id);
    openProfile(); // column 0 [Q, profile]
    await settle();
    const names = (): Array<string | null> => regionsOf(h.panes).map(focusedName);
    const pressBond = async (): Promise<void> => {
      h.panes.querySelector<HTMLButtonElement>('.bond .authorbtn')!.click();
      await settle();
    };

    moveAt(h.panes, 0, 1, '→'); // column 1 [profile]
    await settle();
    expect(names()).toEqual([Q.content, 'profile']);
    await pressBond();
    expect(names()).toEqual([Q.content, 'profile', 'author']);

    closeAt(h.panes, 2, 0);
    await settle();
    moveAt(h.panes, 1, 0, '←'); // column 0 [Q, profile]
    await settle();
    expect(names()).toEqual(['profile']);
    await pressBond();
    expect(names()).toEqual(['profile', 'author']);

    closeAt(h.panes, 1, 0);
    await settle();
    moveAt(h.panes, 0, 1, '→'); // column 1 [profile]
    await settle();
    closeAt(h.panes, 0, 0); // Q's column goes: the profile stands in column 0
    await settle();
    expect(names()).toEqual(['profile']);
    await pressBond();
    expect(names()).toEqual(['profile', 'author']);
  });
});

describe('an endorser\'s name and posts open beside the column the author window stands in when pressed', () => {
  it('the author window moved by ←, by →, and left in column 1 by the column on its left closing: each press opens one column right of the author window', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const endorsers: VouchesTargetResult = {
      vouches: [{ voucherId: BOB, targetId: OTHER, voucherName: null, targetName: null }], count: 1, next: null,
    };
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R)], locked: false, member: true, endorsers });
    await boot(h);
    await openFromFeed(h, Q.id);
    await openFromPane(regionsOf(h.panes)[0]!, R.id); // column 1 [R]
    authorBtnOf(cardOf(regionsOf(h.panes)[1]!, R.id)).click(); // column 2 [author:OTHER]
    await settle();
    const names = (): Array<string | null> => regionsOf(h.panes).map(focusedName);
    const authorIn = (ci: number): HTMLElement => bodyOf(regionsOf(h.panes)[ci]!);
    expect(names()).toEqual([Q.content, R.content, 'author']);
    const body = authorIn(2);

    // ← folds the author window into R's column: its children open in column 2.
    moveAt(h.panes, 2, 0, '←');
    await settle();
    expect(names()).toEqual([Q.content, 'author']);
    expect(authorIn(1)).toBe(body);
    wordIn(rowByLabel(body, 'posts'), 'posts').click();
    await settle();
    expect(names()).toEqual([Q.content, 'author', 'posts']);
    closeAt(h.panes, 2, 0);
    await settle();

    // → gives it column 2 again: an endorser's window opens in column 3.
    moveAt(h.panes, 1, 1, '→');
    await settle();
    expect(names()).toEqual([Q.content, R.content, 'author']);
    expect(authorIn(2)).toBe(body);
    body.querySelector<HTMLButtonElement>('.endorser .authorbtn')!.click();
    await settle();
    expect(names()).toEqual([Q.content, R.content, 'author', 'author']);
    closeAt(h.panes, 3, 0);
    await settle();

    // R's column goes: the author window stands in column 1, and posts opens in column 2.
    closeAt(h.panes, 1, 0);
    await settle();
    expect(names()).toEqual([Q.content, 'author']);
    expect(authorIn(1)).toBe(body);
    wordIn(rowByLabel(body, 'posts'), 'posts').click();
    await settle();
    expect(names()).toEqual([Q.content, 'author', 'posts']);
  });
});

// ===========================================================================
// Group G — the identity's lock is state every standing body shows: a lock or
// an unlock made anywhere draws each body where it stands (WEB_INTERFACE → The
// workspace → "A draw updates a standing body in place", → "What ends a form
// in a window").
// ===========================================================================

/** Q's thread in column 0 with its author's window in column 1; the profile,
 *  then the wallet, opened over Q. Answers the profile's and the author
 *  window's bodies. */
async function profileWalletAuthor(h: Rig, Q: PostJson): Promise<{ author: HTMLElement }> {
  await boot(h);
  await openFromFeed(h, Q.id);
  authorBtnOf(cardOf(regionsOf(h.panes)[0]!, Q.id)).click(); // column 1 [author]
  await settle();
  return { author: bodyOf(regionsOf(h.panes)[1]!) };
}

describe('an unlock made under a card ends every unlock form in a window and turns the passphrase row', () => {
  it('an unlock form open in the profile (covered), in the wallet\'s confirm row (in front) and under an author window\'s your vouch; a feed card\'s unlock row submitted: all three have ended with their fields empty, the wallet\'s form is back with what was typed, and the passphrase row reads unlocked on return', async () => {
    const A = fullRow('A', { author: OTHER });
    const Q = fullRow('Q', { author: BOB });
    const h = rig({ feed: [A, Q], threads: [thread(Q)], locked: true, member: true, credits: creditsWithBox(ME) });
    const { author } = await profileWalletAuthor(h, Q);
    wordIn(author, 'vouch').click();
    const vouchField = fieldOf(author.querySelector<HTMLElement>('.card-unlock')!);
    vouchField.value = 'half';

    openProfile(); // column 0 [Q, profile]
    await settle();
    const profile = bodyOf(regionsOf(h.panes)[0]!);
    wordIn(profile.querySelector<HTMLElement>('.pp-field')!, 'unlock').click();
    const ppField = fieldOf(profile.querySelector<HTMLElement>('.pp-field')!);
    ppField.value = 'half';

    openWallet(); // column 0 [Q, profile, wallet] — the profile is covered
    await settle();
    const wallet = bodyOf(regionsOf(h.panes)[0]!);
    const sendForm = wallet.querySelector<HTMLFormElement>('form.credits-form')!;
    const sendInputs = sendForm.querySelectorAll<HTMLInputElement>('input');
    sendInputs[0]!.value = BOB;
    sendInputs[1]!.value = '1.5';
    submit(sendForm);
    await settle();
    wordIn(wallet.querySelector<HTMLElement>('.pf-confirm')!, 'send').click();
    const confirmField = fieldOf(wallet.querySelector<HTMLElement>('.pf-confirm')!);
    confirmField.value = 'half';

    // The unlock is made under a feed card.
    const feedCard = cardOf(h.feedEl, A.id);
    likeOf(feedCard).click();
    const cardRow = feedCard.querySelector<HTMLElement>('.card-unlock')!;
    fieldOf(cardRow).value = 'pw';
    submit(cardRow.querySelector('form.pf')!);
    await settle();
    expect(h.id.unlocks).toEqual(['pw']);

    for (const field of [vouchField, ppField, confirmField]) {
      expect(field.value).toBe('');
      expect(field.isConnected).toBe(false);
    }
    expect(author.querySelector('.card-unlock')).toBeNull();
    expect(wordIn(author, 'vouch')).not.toBeNull();
    expect(wallet.querySelector('.pf-confirm')).toBeNull();
    expect(wallet.querySelector('form.credits-form')).toBe(sendForm);
    expect([sendInputs[0]!.value, sendInputs[1]!.value]).toEqual([BOB, '1.5']);
    // No card but the one liked is replaced, and nothing is signed for a window.
    expect(bodyOf(regionsOf(h.panes)[0]!)).toBe(wallet);
    expect(bodyOf(regionsOf(h.panes)[1]!)).toBe(author);

    focusAt(h.panes, 0, 1); // the profile back to the front
    await settle();
    const pp = bodyOf(regionsOf(h.panes)[0]!).querySelector<HTMLElement>('.pp-field')!;
    expect(bodyOf(regionsOf(h.panes)[0]!)).toBe(profile);
    expect(pp.querySelector('form')).toBeNull();
    expect(pp.textContent).toContain('unlocked');
    expect(wordIn(pp, 'lock')).not.toBeNull();
  });
});

describe('an unlock made in the composer\'s foot turns the passphrase row of the profile in front', () => {
  it('the profile in front with its unlock form open and typed; a root posted from the feed\'s composer under the lock, unlocked in its foot: the profile\'s form has ended with its field empty and the row reads unlocked · lock', async () => {
    const h = rig({ feed: [], locked: true });
    await boot(h);
    openProfile();
    await settle();
    const profile = bodyOf(regionsOf(h.panes)[0]!);
    const pp = profile.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    const ppField = fieldOf(pp);
    ppField.value = 'half';

    wordIn(h.feedEl.querySelector('.feed-head')!, 'new post').click();
    await settle();
    const composer = h.feedEl.querySelector<HTMLElement>('.composer')!;
    const text = composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    text.value = 'a root';
    text.dispatchEvent(new Event('input'));
    wordIn(composer, 'post').click(); // locked: the unlock form takes the composer's foot
    await settle();
    const foot = composer.querySelector<HTMLElement>('.composer-foot')!;
    fieldOf(foot).value = 'pw';
    submit(foot.querySelector('form.pf')!);
    await settle();
    expect(h.id.unlocks).toEqual(['pw']);
    expect(h.writes.posts).toEqual(['a root']);

    expect(bodyOf(regionsOf(h.panes)[0]!)).toBe(profile);
    expect(ppField.value).toBe('');
    expect(ppField.isConnected).toBe(false);
    expect(pp.querySelector('form')).toBeNull();
    expect(pp.textContent).toContain('unlocked');
    expect(wordIn(pp, 'lock')).not.toBeNull();
  });
});

describe('the profile\'s lock is read by the wallet\'s send and an author window\'s vouch', () => {
  it('unlocked, the wallet and an author window open beside the profile; lock pressed in the profile: the row reads locked · unlock, the confirm row\'s send asks for the unlock, and vouch asks for it under its row — nothing signed', async () => {
    const Q = fullRow('Q', { author: BOB });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: false, member: true, credits: creditsWithBox(ME) });
    const { author } = await profileWalletAuthor(h, Q);
    openWallet(); // column 0 [Q, wallet]
    await settle();
    const wallet = bodyOf(regionsOf(h.panes)[0]!);
    openProfile(); // column 0 [Q, wallet, profile]
    await settle();
    const pp = bodyOf(regionsOf(h.panes)[0]!).querySelector<HTMLElement>('.pp-field')!;

    wordIn(pp, 'lock').click();
    await settle();
    expect(h.id.identity.current()?.locked).toBe(true);
    expect(pp.textContent).toContain('locked');
    expect(wordIn(pp, 'unlock')).not.toBeNull();

    wordIn(author, 'vouch').click();
    await settle();
    expect(rowByLabel(author, 'your vouch').nextElementSibling?.classList.contains('card-unlock')).toBe(true);

    focusAt(h.panes, 0, 1); // the wallet back to the front
    await settle();
    expect(bodyOf(regionsOf(h.panes)[0]!)).toBe(wallet);
    const sendForm = wallet.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = sendForm.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    submit(sendForm);
    await settle();
    wordIn(wallet.querySelector<HTMLElement>('.pf-confirm')!, 'send').click();
    await settle();
    expect(wallet.querySelector('.pf-confirm input[type="password"]')).not.toBeNull();
    expect(h.id.signed).toEqual([]);
    expect(h.id.unlocks).toEqual([]);
  });
});

describe('an unlock made in the profile ends the unlock row a locked send owes (extension)', () => {
  it('the wallet with the owed unlock row typed, covered by the profile; the profile\'s passphrase row unlocks: the owed row has ended with its field empty, the key stands beneath the recipient, and nothing is sent', async () => {
    const h = rig({ feed: [], locked: true, credits: creditsWithBox(ME), extension: true });
    await boot(h);
    openWallet();
    await settle();
    const wallet = bodyOf(regionsOf(h.panes)[0]!);
    const form = wallet.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    submit(form);
    await settle();
    const row = form.nextElementSibling as HTMLElement;
    const owedField = fieldOf(row);
    owedField.value = 'half';

    openProfile(); // column 0 [wallet, profile]
    await settle();
    const pp = bodyOf(regionsOf(h.panes)[0]!).querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    fieldOf(pp).value = 'pw';
    submit(pp.querySelector('form.pf')!);
    await settle();
    expect(h.id.unlocks).toEqual(['pw']);
    expect(owedField.value).toBe('');
    expect(h.id.signed).toEqual([]);

    focusAt(h.panes, 0, 0); // the wallet back to the front
    await settle();
    expect(bodyOf(regionsOf(h.panes)[0]!)).toBe(wallet);
    expect(wallet.querySelector('.card-unlock')).toBeNull();
    expect(wallet.querySelector('form.credits-form')).toBe(form);
    expect(form.querySelector<HTMLElement>('.resolved-key')!.textContent).toBe(BOB);
    expect([inputs[0]!.value, inputs[1]!.value]).toEqual([BOB, '1.5']);
    expect(h.id.signed).toEqual([]);
  });
});

// ===========================================================================
// Group D — what ends a window's body: its window closed, a change of the
// identity, a change of the node read (WEB_INTERFACE → The workspace → "What
// ends a form in a window").
// ===========================================================================

describe('a window closed with a form open ends the form, and the window opened again draws a fresh body', () => {
  it('the profile: the unlock form\'s field reads empty after ✕, and the reopened window is another node with no form', async () => {
    const h = rig({ feed: [], locked: true });
    await boot(h);
    openProfile();
    await settle();
    const body = bodyOf(regionsOf(h.panes)[0]!);
    wordIn(body.querySelector<HTMLElement>('.pp-field')!, 'unlock').click();
    const field = fieldOf(body);
    field.value = 'secret';

    closeAt(h.panes, 0, 0);
    await settle();
    expect(body.isConnected).toBe(false);
    expect(field.value).toBe('');

    openProfile();
    await settle();
    const again = bodyOf(regionsOf(h.panes)[0]!);
    expect(again).not.toBe(body);
    const pp = again.querySelector<HTMLElement>('.pp-field')!;
    expect(pp.querySelector('form')).toBeNull();
    expect(wordIn(pp, 'unlock')).not.toBeNull();
  });

  it('the wallet: the send form\'s fields read empty after ✕, and the reopened window is another node with an empty form', async () => {
    const h = rig({ feed: [], locked: false, credits: creditsWithBox(ME) });
    await boot(h);
    openWallet();
    await settle();
    const body = bodyOf(regionsOf(h.panes)[0]!);
    const inputs = body.querySelectorAll<HTMLInputElement>('form.credits-form input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';

    closeAt(h.panes, 0, 0);
    await settle();
    expect(body.isConnected).toBe(false);
    expect(inputs[0]!.value).toBe('');
    expect(inputs[1]!.value).toBe('');

    openWallet();
    await settle();
    const again = bodyOf(regionsOf(h.panes)[0]!);
    expect(again).not.toBe(body);
    const fresh = again.querySelectorAll<HTMLInputElement>('form.credits-form input');
    expect(fresh[0]!.value).toBe('');
    expect(fresh[1]!.value).toBe('');
  });

  it('the wallet in the extension: the unlock row a locked send owes is gone and its field reads empty after ✕, and the reopened window shows no row and no key beneath its field', async () => {
    const h = rig({ feed: [], locked: true, credits: creditsWithBox(ME), extension: true });
    await boot(h);
    openWallet();
    await settle();
    const form = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = BOB;
    inputs[1]!.value = '1.5';
    submit(form);
    await settle();
    const row = form.nextElementSibling as HTMLElement;
    const field = fieldOf(row);
    field.value = 'secret';

    closeAt(h.panes, 0, 0);
    await settle();
    expect(row.isConnected).toBe(false);
    expect([inputs[0]!.value, inputs[1]!.value, field.value]).toEqual(['', '', '']);

    openWallet();
    await settle();
    const again = bodyOf(regionsOf(h.panes)[0]!);
    expect(again.querySelector('.card-unlock')).toBeNull();
    expect(again.querySelector<HTMLElement>('.resolved-key')!.hidden).toBe(true);
    expect(h.id.unlocks).toEqual([]);
    expect(h.id.signed).toEqual([]);
  });

  it('the settings: text typed in node and not committed is gone after ✕, and the reopened window reads the node in force', async () => {
    const h = rig({ feed: [], locked: false });
    await boot(h);
    openSettings();
    await settle();
    const body = bodyOf(regionsOf(h.panes)[0]!);
    const field = nodeFieldOf(body);
    const inForce = field.value;
    field.value = 'https://example.test';

    closeAt(h.panes, 0, 0);
    await settle();
    expect(body.isConnected).toBe(false);
    expect(field.value).toBe('');

    openSettings();
    await settle();
    const again = bodyOf(regionsOf(h.panes)[0]!);
    expect(again).not.toBe(body);
    expect(nodeFieldOf(again).value).toBe(inForce);
  });

  it('an author window: the vouch\'s unlock row is gone and its field reads empty after ✕, and the reopened window is another node with no row', async () => {
    const A = fullRow('A', { author: OTHER });
    const h = rig({ feed: [A], locked: true, member: true });
    await boot(h);
    authorBtnOf(cardOf(h.feedEl, A.id)).click();
    await settle();
    const body = bodyOf(regionsOf(h.panes)[0]!);
    wordIn(body, 'vouch').click();
    const row = body.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'secret';

    closeAt(h.panes, 0, 0);
    await settle();
    expect(body.isConnected).toBe(false);
    expect(field.value).toBe('');

    authorBtnOf(cardOf(h.feedEl, A.id)).click();
    await settle();
    const again = bodyOf(regionsOf(h.panes)[0]!);
    expect(again).not.toBe(body);
    expect(again.querySelector('.card-unlock')).toBeNull();
    expect(wordIn(again, 'vouch')).not.toBeNull();
  });
});

/** The four windows open with a form in each: Q's thread in column 0 under
 *  `@profile`, `@wallet` and `@settings` — the last opened in front — and Q's
 *  author window in column 1. Answers each body and the fields typed into. */
async function fourWithForms(h: Rig, Q: PostJson): Promise<{
  bodies: { profile: HTMLElement; wallet: HTMLElement; settings: HTMLElement; author: HTMLElement };
  typed: HTMLInputElement[];
  node: HTMLInputElement;
}> {
  await boot(h);
  await openFromFeed(h, Q.id);
  authorBtnOf(cardOf(regionsOf(h.panes)[0]!, Q.id)).click(); // column 1 [author]
  await settle();
  const author = bodyOf(regionsOf(h.panes)[1]!);
  wordIn(author, 'vouch').click();
  const vouchField = fieldOf(author.querySelector<HTMLElement>('.card-unlock')!);
  vouchField.value = 'secret';

  openProfile(); // column 0 [Q, profile]
  await settle();
  const profile = bodyOf(regionsOf(h.panes)[0]!);
  wordIn(profile.querySelector<HTMLElement>('.pp-field')!, 'unlock').click();
  const unlockField = fieldOf(profile);
  unlockField.value = 'secret';

  openWallet(); // column 0 [Q, profile, wallet]
  await settle();
  const wallet = bodyOf(regionsOf(h.panes)[0]!);
  const send = wallet.querySelectorAll<HTMLInputElement>('form.credits-form input');
  send[0]!.value = BOB;
  send[1]!.value = '1.5';

  openSettings(); // column 0 [Q, profile, wallet, settings]
  await settle();
  const settings = bodyOf(regionsOf(h.panes)[0]!);
  const node = nodeFieldOf(settings);
  node.value = 'https://example.test';

  return { bodies: { profile, wallet, settings, author }, typed: [vouchField, unlockField, send[0]!, send[1]!], node };
}

describe('a change of the identity builds every window\'s body anew', () => {
  it('a form open in each of the four, then another key loaded: every field typed into reads empty, and each window in front is another node with no form', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: true, member: true, credits: creditsWithBox(ME) });
    const { bodies, typed, node } = await fourWithForms(h, Q);

    h.fake.feedQueue.push(page([Q])); // the feed, read again for the new key
    h.id.changeKey(NEXT_KEY);
    await settle();
    for (const field of [...typed, node]) expect(field.value).toBe('');
    for (const body of Object.values(bodies)) expect(body.isConnected).toBe(false);

    const settings = bodyOf(regionsOf(h.panes)[0]!);
    expect(settings).not.toBe(bodies.settings);
    expect(nodeFieldOf(settings).value).not.toBe('https://example.test');

    const author = bodyOf(regionsOf(h.panes)[1]!);
    expect(author).not.toBe(bodies.author);
    expect(author.querySelector('.card-unlock')).toBeNull();

    focusAt(h.panes, 0, 2); // the wallet
    await settle();
    const wallet = bodyOf(regionsOf(h.panes)[0]!);
    expect(wallet).not.toBe(bodies.wallet);
    for (const f of wallet.querySelectorAll<HTMLInputElement>('input')) expect(f.value).toBe('');

    focusAt(h.panes, 0, 1); // the profile
    await settle();
    const profile = bodyOf(regionsOf(h.panes)[0]!);
    expect(profile).not.toBe(bodies.profile);
    expect(profile.querySelector('.pp-field form')).toBeNull();
    expect(wordIn(profile.querySelector<HTMLElement>('.pp-field')!, 'unlock')).not.toBeNull();
  });
});

describe('a change of the node read builds every window\'s body anew', () => {
  it('a form open in each of the four, then the settings node committed: every other field typed into reads empty, and each window in front is another node with no form', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: true, member: true, credits: creditsWithBox(ME) });
    const { bodies, typed, node } = await fourWithForms(h, Q);

    h.fake.feedQueue.push(page([Q])); // the feed, read again from the new node
    node.dispatchEvent(new Event('change'));
    await settle();
    for (const field of typed) expect(field.value).toBe('');
    for (const body of Object.values(bodies)) expect(body.isConnected).toBe(false);

    const settings = bodyOf(regionsOf(h.panes)[0]!);
    expect(settings).not.toBe(bodies.settings);
    expect(nodeFieldOf(settings).value).toBe('https://example.test');

    const author = bodyOf(regionsOf(h.panes)[1]!);
    expect(author).not.toBe(bodies.author);
    expect(author.querySelector('.card-unlock')).toBeNull();

    focusAt(h.panes, 0, 2); // the wallet
    await settle();
    const wallet = bodyOf(regionsOf(h.panes)[0]!);
    expect(wallet).not.toBe(bodies.wallet);
    for (const f of wallet.querySelectorAll<HTMLInputElement>('input')) expect(f.value).toBe('');

    focusAt(h.panes, 0, 1); // the profile
    await settle();
    const profile = bodyOf(regionsOf(h.panes)[0]!);
    expect(profile).not.toBe(bodies.profile);
    expect(profile.querySelector('.pp-field form')).toBeNull();
    expect(wordIn(profile.querySelector<HTMLElement>('.pp-field')!, 'unlock')).not.toBeNull();
  });
});
