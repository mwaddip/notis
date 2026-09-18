import { el } from '../dom';
import { prefs, BUILD_BASE, BUILD_FAUCET_BASE, type Theme, type IdTint } from '../prefs';
import { ID_ARC_START, ID_ARC_SPAN, ID_STOPS } from '../model/identity';

// The @settings window — WEB_INTERFACE → The settings window. The client's
// preferences in the .winbody/.row/label/.field pattern, no identity read, its
// ↻ disabled. The tint row carries two sample title bars above the four words —
// WEB_INTERFACE → The settings window → "The identity tint shows what it sets"
// — each a fixed stop of the identity arc, aria-hidden, no handler, not `.win`
// since the samples are thread bars, the shape the tint applies to. The tint is
// :root's attribute and custom properties (src/prefs.ts applyIdTint), so a
// press moves the samples with no re-render. The window renders the same with
// and without an identity.

/** The narrow shape the settings rows call. RenderCtx.Handlers satisfies it
 *  structurally, so the App passes its own handlers straight through. */
export interface SettingsHandlers {
  setTheme: (t: Theme) => void;
  setIdTint: (m: IdTint) => void;
  setNode: (origin: string) => void;
  setFaucet: (origin: string) => void;
  // The extension's binary sign policy — the row renders only when both hooks
  // are present (WEB_INTERFACE → The settings window; the extension's proxy).
  policy?: () => 'silent' | 'ask';
  setPolicy?: (p: 'silent' | 'ask') => Promise<void>;
  // The extension's faucet-origin permission gate — the faucet row's `set`
  // requests it from the press (WEB_INTERFACE → The extension).
  requestFaucetOrigin?: (origin: string) => Promise<boolean>;
}

const ID_TINTS: IdTint[] = ['spine', 'wash', 'both', 'off'];

// The two stops the tint preview shows — derived from ID_STOPS so a change to
// the arc moves the samples too (HOUSE_STYLE → Identity colour). Never a bare
// degree literal: identityHue's own table is the truth.
const SAMPLE_STOP_A = 2;
const SAMPLE_STOP_B = 8;
function stopHue(idx: number): number {
  return ID_ARC_START + idx * (ID_ARC_SPAN / ID_STOPS);
}

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
    const sampleB = el('div', 'bar tint-sample focused');
    sampleB.style.setProperty('--idh', String(stopHue(SAMPLE_STOP_B)));
    preview.append(sampleA, sampleB);
    field.appendChild(preview);
    const seg = el('div', 'seg');
    for (const v of ID_TINTS) {
      const btn = el('button', 'word', v);
      btn.setAttribute('aria-pressed', prefs.idtint === v ? 'true' : 'false');
      btn.addEventListener('click', () => handlers.setIdTint(v));
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

  // faucet — the same shape as node; empty means no faucet and no button. In
  // the extension the `set` requests host permission for the origin (a user
  // gesture, as the API requires); denied, the row's hint names the refusal
  // and the preference is not stored (WEB_INTERFACE → The extension).
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
