import { el } from '../dom';
import { prefs, BUILD_BASE, type Theme, type IdTint } from '../prefs';
import { stopHue } from '../model/identity';

// The @settings window — WEB_INTERFACE → The settings window. The client's
// preferences in the .winbody/.row/label/.field pattern, no identity read, its
// ↻ disabled. The tint row carries two sample title bars above the four words —
// WEB_INTERFACE → The settings window → "The identity tint shows what it sets"
// — each a fixed stop of the identity arc, aria-hidden, no handler, not `.win`
// since the samples are thread bars, the shape the tint applies to. The tint is
// :root's attribute and custom properties (src/prefs.ts applyIdTint), so a
// press moves the samples with no re-render. No `faucet` row: the faucet's base
// is the build's value (WEB_INTERFACE → The settings window → "No `faucet` row
// and no `arrangement` row"). The window renders the same with and without an
// identity.

/** The narrow shape the settings rows call. Handlers satisfies it structurally,
 *  so the App passes its own handlers straight through. */
export interface SettingsHandlers {
  setTheme: (t: Theme) => void;
  setIdTint: (m: IdTint) => void;
  setNode: (origin: string) => void;
  // The extension's binary sign policy — the row renders only when both hooks
  // are present (WEB_INTERFACE → The settings window; the extension's proxy).
  policy?: () => 'silent' | 'ask';
  setPolicy?: (p: 'silent' | 'ask') => Promise<void>;
}

const ID_TINTS: IdTint[] = ['spine', 'wash', 'both', 'off'];

// The two stops the tint preview shows — a fixed pair on the identity arc, read
// through stopHue so a change to the arc moves the samples too
// (HOUSE_STYLE → Identity colour).
const SAMPLE_STOP_A = 2;
const SAMPLE_STOP_B = 8;

function row(label: string): { row: HTMLElement; field: HTMLElement } {
  const r = el('div', 'row');
  r.appendChild(el('label', null, label));
  const field = el('div', 'field');
  r.appendChild(field);
  return { row: r, field };
}

export function settingsBody(handlers: SettingsHandlers): HTMLElement {
  const b = el('div', 'winbody');

  // theme — the control names and shows the theme it would switch TO
  // (HOUSE_STYLE → Colour), styled as the inverse ground.
  {
    const { row: r, field } = row('theme');
    const target: Theme = prefs.theme === 'dark' ? 'light' : 'dark';
    const btn = el('button', 'theme-btn', target);
    btn.setAttribute('aria-label', `switch to ${target} theme`);
    btn.addEventListener('click', () => handlers.setTheme(target));
    field.appendChild(btn);
    b.appendChild(r);
  }

  // identity tint — the preview above the four words: two sample title bars,
  // one focused and one not, each a fixed stop of the identity arc, inert
  // (WEB_INTERFACE → The settings window; HOUSE_STYLE → Identity colour).
  {
    const { row: r, field } = row('identity tint');
    const preview = el('div', 'tint-preview');
    preview.setAttribute('aria-hidden', 'true');
    const sampleA = el('div', 'bar tint-sample');
    sampleA.style.setProperty('--idh', String(stopHue(SAMPLE_STOP_A)));
    sampleA.appendChild(el('span', 'bar-label', 'a title bar'));
    const sampleB = el('div', 'bar tint-sample focused');
    sampleB.style.setProperty('--idh', String(stopHue(SAMPLE_STOP_B)));
    sampleB.appendChild(el('span', 'bar-label', 'the focused title bar'));
    preview.append(sampleA, sampleB);
    field.appendChild(preview);
    const seg = el('div', 'seg');
    for (const v of ID_TINTS) {
      const btn = el('button', 'word', v);
      btn.setAttribute('aria-pressed', prefs.idtint === v ? 'true' : 'false');
      btn.addEventListener('click', () => {
        // The tint follows :root's data-idtint and custom properties
        // (src/prefs.ts applyIdTint), so the press moves the four words'
        // pressed state in place and rebuilds nothing — the pressed word
        // keeps the keyboard's focus (WEB_INTERFACE → The settings window →
        // "The identity tint shows what it sets").
        for (const w of seg.querySelectorAll<HTMLButtonElement>('.word')) {
          w.setAttribute('aria-pressed', w === btn ? 'true' : 'false');
        }
        handlers.setIdTint(v);
      });
      seg.appendChild(btn);
    }
    field.appendChild(seg);
    field.appendChild(el('div', 'hint', 'the 4px edge on a title bar, from the author key. never an identifier.'));
    b.appendChild(r);
  }

  // node — any origin works (NODE_INTERFACE → Cross-origin requests).
  {
    const { row: r, field } = row('node');
    const input = el('input') as HTMLInputElement;
    input.value = prefs.node;
    input.placeholder = BUILD_BASE || 'same-origin (default)';
    input.setAttribute('aria-label', 'the node this client reads');
    input.addEventListener('change', () => handlers.setNode(input.value));
    field.appendChild(input);
    field.appendChild(el('div', 'hint', 'blank resets to the build default. any origin works: the node answers every origin.'));
    b.appendChild(r);
  }

  // The extension's binary sign policy — visible only when both hooks are
  // present. *sign each rep action* controls whether rep writes prompt; sends
  // always prompt (WEB_INTERFACE → The settings window, → The extension).
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
    b.appendChild(r);
  }

  return b;
}
