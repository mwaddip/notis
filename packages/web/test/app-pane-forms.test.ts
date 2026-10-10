// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import type { PostJson, PostResult, ThreadResult, FeedResult, UsernameResult, CreditsResult, KarmaResult } from '../src/api/dto';
import {
  ME, fullRow, harness, settle, lockableIdentity, recordingWrites,
  karmaWithBox, membershipGate,
  type Harness, type LockableIdentity, type RecordingWrites,
} from './app-light-shared';
import { karmaResult } from './karma-fixture';
import { setNode } from '../src/prefs';

// WEB_INTERFACE → The profile window → "The six operations are forms in place,
// and each is a real `<form>`"; → The wallet window → "The `send` row"; → The
// settings window; → The author window. Every case drives through the
// product's own path — a header control, a card's authorbtn, a card's strip,
// or a row's own submit — and every redraw is caused by what causes one in
// the product: a held-back read released, a window's own ↻, another window
// opened or closed in another column, pollTick, start-up.

const OTHER = 'ee'.repeat(32);
const BOB = 'bb'.repeat(32);

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
  boot?: 'mount' | 'start';
  membershipGate?: Promise<void>;
}): Rig {
  const id = lockableIdentity(ME, o.locked ?? true);
  const writes = recordingWrites(id);
  const feedRows = o.feed ?? [];
  const feedResults: FeedResult[] = [page(feedRows)];
  const karma = o.karma ?? (o.member ? memberKarma() : karmaWithBox(ME));
  const h = harness({
    identityKey: ME, identity: id.identity, writeClient: writes.client,
    karma, credits: o.credits, ownName: o.ownName, feedResults,
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
  it.fails('a locked identity, the reads held back, the profile opened, unlock pressed and typed, then the reads released: the node, its typed value and the focus are lost', async () => {
    const h = rig({ feed: [], locked: true });
    await h.drive.loadFeed();
    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;

    openProfile();
    await settle();

    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();
    expect(document.activeElement).toBe(field);

    gate.release();
    await settle();

    expect(form.isConnected).toBe(true);
    expect(fieldOf(h.panes.querySelector('.pp-field')!).value).toBe('secret');
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
  it.fails('locked after the first read landed, unlock pressed and typed, ↻ pressed with reads held back, released: the node, value and focus are lost', async () => {
    const h = rig({ feed: [], locked: true });
    await boot(h);
    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
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
    expect(fieldOf(h.panes.querySelector('.pp-field')!).value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the unlock row under the invite form across the profile\'s ↻', () => {
  it.fails('member karma loaded with one invite available; invite submitted with a 64-hex key, unlock row mounted and typed; ↻ with reads held back, released: the node is replaced', async () => {
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
  });
});

describe('the unlock row under the claim form across the profile\'s ↻', () => {
  it.fails('no name held, locked, claim submitted with a valid name, unlock row mounted and typed; ↻ with reads held back, released: the node is replaced', async () => {
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
  });
});

describe('the export form across the profile\'s ↻', () => {
  it.fails('unlocked, export pressed, both set-passphrase fields typed; ↻ with reads held back, released: the node is replaced', async () => {
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
  });
});

describe('the invite form\'s own typed key across the profile\'s ↻', () => {
  it.fails('invite form open with its key typed and not yet submitted: ↻ with reads held back, released: the new field reads empty', async () => {
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

    const after = h.panes.querySelector<HTMLFormElement>('form.invite-form')!;
    expect(after.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(BOB);
  });
});

describe('the claim field\'s own typed name across the profile\'s ↻', () => {
  it.fails('no name held, claim field typed and not submitted: ↻ with reads held back, released: the new field reads empty', async () => {
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

    const after = h.panes.querySelector<HTMLFormElement>('form.username-form')!;
    expect(after.querySelector<HTMLInputElement>('input')!.value).toBe('alice');
  });
});

describe('the burn confirm across the profile\'s ↻', () => {
  it.fails('a name is held, burn pressed, the confirm wrap stands; ↻ with reads held back, released: the node is replaced', async () => {
    const h = rig({ feed: [], locked: false, member: true, ownName: ownNameRow() });
    await boot(h);
    openProfile();
    await settle();

    const burnBtn = wordIn(h.panes, 'burn');
    burnBtn.click();
    await settle();
    const confirm = h.panes.querySelector<HTMLElement>('.pf-confirm')!;
    expect(confirm).not.toBeNull();

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(confirm.isConnected).toBe(true);
  });
});

describe('the forget confirm across the profile\'s ↻', () => {
  it.fails('forget pressed, the confirm wrap stands; ↻ with reads held back, released: the node is replaced', async () => {
    const h = rig({ feed: [], locked: false });
    await boot(h);
    openProfile();
    await settle();

    const forgetBtn = wordIn(rowByLabel(h.panes, 'forget'), 'forget');
    forgetBtn.click();
    await settle();
    const confirm = rowByLabel(h.panes, 'forget').querySelector<HTMLElement>('.pf-confirm')!;
    expect(confirm).not.toBeNull();

    const gate = membershipGate();
    h.fake.membershipGate = gate.promise;
    await refreshProfile(h);
    gate.release();
    await settle();

    expect(confirm.isConnected).toBe(true);
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
 *  R at column 1, S at column 2 pending. The form's window opens into column
 *  0 and is focused there — Q stays stacked under it. */
async function withQR(h: Rig, Q: PostJson, R: PostJson, S: PostJson): Promise<HTMLElement> {
  await boot(h);
  await openFromFeed(h, Q.id);
  const col0 = regionsOf(h.panes)[0]!;
  await openFromPane(col0, R.id); // column 1 [R]
  return regionsOf(h.panes)[1]!;
  // S remains unopened — a case opens it later to drive a new column 2.
  void S;
}

describe('the passphrase row\'s unlock form while the profile is focused in column 0 across a window opening in column 2', () => {
  it.fails('profile opened over Q; a new thread opened from R\'s pane (column 2): the node is replaced', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)], locked: true });
    const col1 = await withQR(h, Q, R, S);

    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
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
  });
});

describe('the passphrase row\'s unlock form while the profile is focused in column 0 across a window closing in column 2', () => {
  it.fails('profile opened over Q; S already open in column 2 is closed by its ✕: the node is replaced', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)], locked: true });
    const col1 = await withQR(h, Q, R, S);
    await openFromPane(col1, S.id); // column 2 [S]

    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('profile');

    closeAt(h.panes, 2, 0);
    await settle();

    expect(form.isConnected).toBe(true);
  });
});

describe('the passphrase row\'s unlock form while the profile is focused in column 0 across the stacked-under thread closing', () => {
  it.fails('profile opened over Q, unlock typed; Q (stacked under) closed by its ✕: the node is replaced', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: true });
    await boot(h);
    await openFromFeed(h, Q.id);
    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    closeAt(h.panes, 0, 0);
    await settle();

    expect(form.isConnected).toBe(true);
  });
});

describe('the author window\'s vouch unlock row while the author window is focused in column 2 across a window opening in column 1', () => {
  it.fails('author window opened from R\'s pane (column 2); vouch pressed and typed; a new thread opened from Q\'s pane (column 1): the node is replaced', async () => {
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
    // 0's stack. Column 2 (author) still visible but renderPanes rebuilds
    // every region.
    await openFromFeed(h, T.id);
    expect(regionsOf(h.panes).length).toBeGreaterThanOrEqual(3);

    expect(row.isConnected).toBe(true);
  });
});

describe('the author window\'s vouch unlock row while the author window is focused in column 1 across the thread it was opened from closing', () => {
  it.fails('author window opened from Q\'s pane (column 1); vouch typed; R closed by its ✕ (column 2 removed, author shifts): the node is replaced', async () => {
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

    expect(row.isConnected).toBe(true);
  });
});

describe('the wallet\'s send form while the wallet is focused in column 0 across a window opening in column 2', () => {
  it.fails('wallet opened over Q; recipient and amount typed; a new thread opened from R\'s pane (column 2): the new form reads empty', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({
      feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)],
      locked: false, credits: creditsWithBox(ME),
    });
    const col1 = await withQR(h, Q, R, S);

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

    const nowForm = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    const nowInputs = nowForm.querySelectorAll<HTMLInputElement>('input');
    expect(nowInputs[0]!.value).toBe(BOB);
  });
});

describe('the wallet\'s send form while the wallet is focused in column 0 across a window closing in column 2', () => {
  it.fails('wallet opened over Q; S already open in column 2 is closed: the new form reads empty', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({
      feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)],
      locked: false, credits: creditsWithBox(ME),
    });
    const col1 = await withQR(h, Q, R, S);
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

    const nowForm = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    expect(nowForm.querySelectorAll<HTMLInputElement>('input')[0]!.value).toBe(BOB);
  });
});

describe('the wallet\'s send form while the wallet is focused in column 0 across the stacked-under thread closing', () => {
  it.fails('wallet opened over Q; typed; Q (stacked under) closed by its ✕: the new form reads empty', async () => {
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

    const nowForm = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    expect(nowForm.querySelectorAll<HTMLInputElement>('input')[0]!.value).toBe(BOB);
  });
});

describe('the settings node field while settings is focused in column 0 across a window opening in column 2', () => {
  it.fails('settings opened over Q; node typed; a new thread opened from R\'s pane (column 2): the new field reads empty', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)], locked: false });
    const col1 = await withQR(h, Q, R, S);

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

    const nowInput = h.panes.querySelector<HTMLInputElement>(
      '[aria-label="the node this client reads"]',
    )!;
    expect(nowInput.value).toBe('https://example.test');
  });
});

describe('the settings node field while settings is focused in column 0 across a window closing in column 2', () => {
  it.fails('settings opened over Q; typed; S in column 2 closed: the new field reads empty', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)], locked: false });
    const col1 = await withQR(h, Q, R, S);
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

    const nowInput = h.panes.querySelector<HTMLInputElement>(
      '[aria-label="the node this client reads"]',
    )!;
    expect(nowInput.value).toBe('https://example.test');
  });
});

describe('the settings node field while settings is focused in column 0 across the stacked-under thread closing', () => {
  it.fails('settings opened over Q; typed; Q (stacked under) closed by its ✕: the new field reads empty', async () => {
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

    const nowInput = h.panes.querySelector<HTMLInputElement>(
      '[aria-label="the node this client reads"]',
    )!;
    expect(nowInput.value).toBe('https://example.test');
  });
});

// ---------------------------------------------------------------------------
// A.4  The profile opened beside an open form in another column.
// ---------------------------------------------------------------------------

describe('the author window\'s vouch unlock row in column 2 across the profile opening in column 0 and its reads landing', () => {
  it.fails('author window opened from R\'s pane (column 2); vouch typed; profile opened from header with reads held back, then released: the node is replaced', async () => {
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
    openProfile(); // targets column 0, joins Q's column; column 2 untouched by placement but renderPanes fires
    await settle();

    gate.release();
    await settle();

    expect(row.isConnected).toBe(true);
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
  it.fails('wallet opened over Q, send pressed with a key and amount, confirm wrap stands; a new thread opened from R\'s pane: the wrap\'s node is replaced', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const S = fullRow('S', { author: OTHER, parentRefs: [R.id] });
    const h = rig({
      feed: [Q], threads: [thread(Q, [R]), thread(R, [S]), thread(S)],
      locked: false, credits: creditsWithBox(ME),
    });
    const col1 = await withQR(h, Q, R, S);

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

    expect(focusedName(regionsOf(h.panes)[0]!)).toBe('wallet');

    await openFromPane(col1, S.id);
    expect(regionsOf(h.panes)).toHaveLength(3);

    expect(confirm.isConnected).toBe(true);
  });
});

describe('the wallet\'s confirm row (web) across the wallet\'s own ↻', () => {
  it('wallet open, send pressed with a key and amount, confirm wrap stands; wallet\'s ↻ pressed: the wrap stands (the form slot has children, `renderCreditsRow` leaves it alone)', async () => {
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

// ---------------------------------------------------------------------------
// A.6  Start-up — a restored arrangement with the profile open; the start-up
//      read held back.
// ---------------------------------------------------------------------------

describe('the passphrase row\'s unlock form across a start-up read landing', () => {
  it.fails('a restored arrangement with the profile open; the start-up read held back; unlock pressed and typed; the read released: the node is replaced', async () => {
    localStorage.setItem('notis.layout', '@profile');
    const gate = membershipGate();
    const h = rig({ feed: [], locked: true, boot: 'start', membershipGate: gate.promise });
    await settle();

    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    gate.release();
    await settle();

    expect(form.isConnected).toBe(true);
  });
});

// ===========================================================================
// Group B — the form's window is covered by another window of its column
// brought to the front, then brought back to the front through its bar.
// ===========================================================================

describe('the profile\'s passphrase unlock form across its window being covered by a stacked thread and brought back', () => {
  it.fails('profile open over Q; unlock typed; Q brought to front by pressing its bar; profile brought back by pressing its bar: the node is replaced', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q)], locked: true });
    await boot(h);
    await openFromFeed(h, Q.id);
    openProfile();
    await settle();
    const pp = h.panes.querySelector<HTMLElement>('.pp-field')!;
    wordIn(pp, 'unlock').click();
    const form = pp.querySelector<HTMLFormElement>('form.pf')!;
    const field = fieldOf(form);
    field.value = 'secret';
    field.focus();

    // Column 0 wins = [Q, @profile]; bars are [Q bar, profile bar].
    focusAt(h.panes, 0, 0); // Q to front
    await settle();
    focusAt(h.panes, 0, 1); // profile back to front
    await settle();

    expect(form.isConnected).toBe(true);
  });
});

describe('the author window\'s vouch unlock row across its window being covered by a stacked thread and brought back', () => {
  it.fails('author in column 1 opened from Q\'s pane; vouch typed; R opened from Q\'s pane joins column 1 and covers author; author brought back by its bar: the node is replaced', async () => {
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
    fieldOf(row).value = 'secret';
    fieldOf(row).focus();

    // R from Q's pane — joins column 1 and covers the author window.
    await openFromPane(regionsOf(h.panes)[0]!, R.id);
    // Column 1 wins = [author, R], bars = [author bar, R bar]. Focus author.
    focusAt(h.panes, 1, 0);
    await settle();

    expect(row.isConnected).toBe(true);
  });
});

describe('the wallet\'s send form across its window being covered by a stacked thread and brought back', () => {
  it.fails('wallet over Q; recipient typed; Q brought to front; wallet brought back: the new form reads empty', async () => {
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
    focusAt(h.panes, 0, 1); // wallet back
    await settle();

    const nowForm = h.panes.querySelector<HTMLFormElement>('form.credits-form')!;
    expect(nowForm.querySelectorAll<HTMLInputElement>('input')[0]!.value).toBe(BOB);
  });
});

describe('the settings node field across its window being covered by a stacked thread and brought back', () => {
  it.fails('settings over Q; node typed; Q brought to front; settings brought back: the new field reads empty', async () => {
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
    focusAt(h.panes, 0, 1); // settings back
    await settle();

    const nowInput = h.panes.querySelector<HTMLInputElement>(
      '[aria-label="the node this client reads"]',
    )!;
    expect(nowInput.value).toBe('https://example.test');
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
// Group D — what ends a window's body: its window closed (WEB_INTERFACE →
// The workspace → "What ends a form in a window").
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
