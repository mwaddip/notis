import { el } from '../dom';
import { unlockForm } from '../view/passphrase';
import { whatFor, amountFor, targetFor, feeFor } from './prompt-summary';
import type { SignRecord } from './protocol';

// The prompt page — WEB_INTERFACE → The extension → "The prompt window". The
// URL carries `?id=<record id>`; the background wrote the record to
// storage.session under `notis.sign.<id>` before opening this window. Approve
// signs; decline, Esc, or the window's close is a decline. If the seed is gone
// at approve time — locked from another tab meanwhile — the unlock form takes
// the body above the pair, and the flow continues once unlocked.
//
// The layout is a padded column filling the popup — the lines at the top in
// the page face, the commit pair bottom-aligned right (WEB_INTERFACE → The
// extension → "The prompt window"; HOUSE_STYLE → Interaction → "A box marks a
// commit pair and a surface's primary action"). The first line is a `<div>`,
// not an `<h1>` — the App's heading rules must not apply.

const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
const root = document.getElementById('prompt');
if (!root) throw new Error('missing prompt root');

let armed = false;

void render();

async function render(): Promise<void> {
  if (!id) {
    root!.replaceChildren(el('div', 'refusal', 'no record id in the URL'));
    return;
  }
  const record = await readRecord();
  if (!record) {
    // The record may still be being written; wait once on storage.onChanged.
    await waitForRecord();
    return;
  }
  drawPrompt(record);
}

async function readRecord(): Promise<SignRecord | null> {
  const key = 'notis.sign.' + id;
  const got = await chrome.storage.session.get(key);
  const v = got[key];
  return isRecord(v) ? v : null;
}

function waitForRecord(): Promise<void> {
  const key = 'notis.sign.' + id;
  return new Promise((resolve) => {
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: 'local' | 'session' | 'sync' | 'managed'): void => {
      if (area !== 'session') return;
      const change = changes[key];
      if (!change) return;
      const v = change.newValue;
      if (isRecord(v)) {
        chrome.storage.onChanged.removeListener(handler);
        drawPrompt(v);
        resolve();
      }
    };
    chrome.storage.onChanged.addListener(handler);
  });
}

function drawPrompt(record: SignRecord): void {
  const container = el('div', 'prompt');
  const lines = el('div', 'lines');

  // Line 1 — what. The browser's tab name matches at draw so its frame names
  // the transaction too (WEB_INTERFACE → The extension → "The prompt window").
  const what = whatFor(record.summary);
  document.title = what;
  lines.appendChild(el('div', 'line what', what));

  // Line 2 — the amount, absent for a withdrawal, a claim, an unvouch.
  const amount = amountFor(record.summary);
  if (amount !== null) lines.appendChild(el('div', 'line amount', amount));

  // Line 3 — the target, the value whole, in mono, wrapped. One line per
  // payment for a transfer (WEB_INTERFACE → The extension → "The prompt reads
  // as three lines: what, how much, to whom").
  const targets = targetFor(record.summary);
  if (targets !== null) {
    for (const t of targets) {
      const line = el('div', 'line target');
      if (t.label !== '') {
        line.appendChild(el('span', 'target-label', t.label));
        line.appendChild(document.createTextNode(' '));
      }
      line.appendChild(el('span', 'target-value', t.value));
      lines.appendChild(line);
    }
  }

  // Fee — a `fee` box only.
  const fee = feeFor(record.summary);
  if (fee !== null) lines.appendChild(el('div', 'line fee', fee));

  // A post's verified content follows as a fourth line (WEB_INTERFACE → The
  // extension → "The prompt reads as three lines: what, how much, to whom").
  const content = record.hint.content;
  if (typeof content === 'string' && (record.summary.kind === 'thread' || record.summary.kind === 'reply')) {
    lines.appendChild(el('div', 'line content', content));
  }

  container.appendChild(lines);

  // The commit pair — cancel then sign, right-aligned; the pair is bottom-
  // aligned by `.actions { margin-top: auto }` on `main#prompt`. HOUSE_STYLE →
  // Interaction → "A box marks a commit pair and a surface's primary action"
  // — the extension prompt's `sign` and `cancel` are the pair.
  const actions = el('div', 'actions');
  const cancel = el('button', 'btn btn-ghost', 'cancel');
  const sign = el('button', 'btn btn-primary', 'sign') as HTMLButtonElement;
  cancel.addEventListener('click', () => void decline());
  sign.addEventListener('click', () => void approve(sign));
  actions.append(cancel, sign);
  container.appendChild(actions);

  root!.replaceChildren(container);
  sign.focus();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !armed) { e.preventDefault(); void decline(); }
  });
}

async function approve(button: HTMLButtonElement): Promise<void> {
  if (armed) return;
  armed = true;
  button.textContent = 'working…';
  button.disabled = true;
  const answer = await chrome.runtime.sendMessage({ kind: 'approve', id });
  if (answer && typeof answer === 'object' && 'error' in answer) {
    // The seed is gone — mount the unlock form. Once unlocked, retry approve.
    armed = false;
    button.textContent = 'sign';
    button.disabled = false;
    const record = await readRecord();
    if (!record) return;
    showUnlockThenApprove(record, button);
    return;
  }
  // The background's `windows.remove` swallows a failure; close ourselves too
  // so a stuck popup does not linger (WEB_INTERFACE → The extension → "`sign`,
  // in the background, in order").
  window.close();
}

async function decline(): Promise<void> {
  if (armed) return;
  await chrome.runtime.sendMessage({ kind: 'decline', id });
  // The background closes the window on success. If it doesn't, close ourselves.
  window.close();
}

function showUnlockThenApprove(record: SignRecord, button: HTMLButtonElement): void {
  const container = root!.querySelector('.prompt') as HTMLElement;
  const actions = container.querySelector('.actions');
  const box = el('div', 'unlock-in-prompt');
  const form = unlockForm(record.pubKeyHex, async (p) => {
    const r = await chrome.runtime.sendMessage({ kind: 'unlock', passphrase: p });
    if (r && typeof r === 'object' && 'error' in r) throw new Error((r as { error: string }).error);
    // Once unlocked, retry approve.
    await approve(button);
  }, () => {
    box.remove();
  });
  box.appendChild(form);
  // The form mounts above the pair, so the pair stays where the reader looks
  // for it (WEB_INTERFACE → The extension → "The prompt window").
  container.insertBefore(box, actions);
}

function isRecord(v: unknown): v is SignRecord {
  return typeof v === 'object' && v !== null && 'id' in v && 'txIdHex' in v && 'summary' in v;
}
