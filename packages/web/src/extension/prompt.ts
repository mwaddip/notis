import { el } from '../dom';
import { unlockForm } from '../view/passphrase';
import { headingFor, linesFor } from './prompt-summary';
import type { SignRecord } from './protocol';

// The prompt page — WEB_INTERFACE → "`sign`, in the background, in order". The
// URL carries `?id=<record id>`; the background wrote the record to
// storage.session under `notis.sign.<id>` before opening this window. Approve
// signs; decline, Esc, or the window's close is a decline. If the seed is gone
// at approve time — locked from another tab meanwhile — the unlock form takes
// the body, and the flow continues once unlocked.

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
  container.appendChild(headingFor(record.summary));
  const lines = linesFor(record.summary, record.hint.content);
  if (lines.length) {
    const list = el('div', 'lines');
    for (const line of lines) list.appendChild(el('div', 'line', line));
    container.appendChild(list);
  }
  // The controls: sign and cancel — a boxed commit pair (HOUSE_STYLE →
  // Interaction; the composer's post and cancel are the other).
  const actions = el('div', 'actions');
  const sign = el('button', 'btn btn-primary', 'sign') as HTMLButtonElement;
  const cancel = el('button', 'btn btn-ghost', 'cancel');
  sign.addEventListener('click', () => void approve(sign));
  cancel.addEventListener('click', () => void decline());
  actions.append(sign, cancel);
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
  // so a stuck popup does not linger (WEB_INTERFACE → "`sign`, in the
  // background, in order").
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
  container.appendChild(box);
}

function isRecord(v: unknown): v is SignRecord {
  return typeof v === 'object' && v !== null && 'id' in v && 'txIdHex' in v && 'summary' in v;
}
