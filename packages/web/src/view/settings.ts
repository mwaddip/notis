import { el, setText } from '../dom';
import { prefs, BUILD_BASE, type Theme, type IdTint } from '../prefs';
import { stopHue } from '../model/identity';
import type { WindowBody } from '../model/state';

// The @settings window — WEB_INTERFACE → The settings window. The client's
// preferences in the .winbody/.row/label/.field pattern, no identity read, its
// ↻ disabled. The rows: theme; identity tint (two sample title bars above the
// four words — WEB_INTERFACE → The settings window → "The identity tint shows
// what it sets" — each a fixed stop of the identity arc, aria-hidden, no
// handler, not `.win` since the samples are thread bars, the shape the tint
// applies to); node; sign each rep action (extension only); a Notis link opens
// (extension only, in a build whose `notis-public` is not empty). The tint is
// :root's attribute and custom properties (src/prefs.ts applyIdTint), so a
// press moves the samples with no re-render. No `faucet` row: the faucet's base
// is the build's value (WEB_INTERFACE → The settings window → "No `faucet` row
// and no `arrangement` row"). The window renders the same with and without an
// identity.
//
// The body is one node from the window's open to its close (WEB_INTERFACE →
// The workspace → "A window's body stands while the window is open"). Every
// row is built once; `update` writes each word and pressed state from the
// preferences as they stand, and leaves text typed in `node` and not committed
// (→ "A draw updates a standing body in place"). The theme word reads the
// theme when pressed (→ "A window's controls act on the state as it stands at
// the press").

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
  // The extension's links preference — the row renders only when both hooks
  // are present (WEB_INTERFACE → The settings window; the extension's proxy,
  // in a build whose `notis-public` is not empty).
  links?: () => 'site' | 'here';
  setLinks?: (v: 'site' | 'here') => Promise<void>;
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

export function settingsBody(handlers: SettingsHandlers): WindowBody {
  const b = el('div', 'winbody');
  const draws: Array<() => void> = [];

  // theme — the control names and shows the theme it would switch TO
  // (HOUSE_STYLE → Colour), styled as the inverse ground.
  {
    const { row: r, field } = row('theme');
    const target = (): Theme => (prefs.theme === 'dark' ? 'light' : 'dark');
    const btn = el('button', 'theme-btn');
    btn.addEventListener('click', () => handlers.setTheme(target()));
    draws.push(() => {
      const t = target();
      setText(btn, t);
      btn.setAttribute('aria-label', `switch to ${t} theme`);
    });
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
    const words = ID_TINTS.map((v) => {
      const btn = el('button', 'word', v);
      btn.addEventListener('click', () => {
        // The tint follows :root's data-idtint and custom properties
        // (src/prefs.ts applyIdTint), so the press moves the four words'
        // pressed state in place and rebuilds nothing — the pressed word
        // keeps the keyboard's focus (WEB_INTERFACE → The settings window →
        // "The identity tint shows what it sets").
        press(v);
        handlers.setIdTint(v);
      });
      seg.appendChild(btn);
      return { v, btn };
    });
    const press = (now: IdTint): void => {
      for (const w of words) w.btn.setAttribute('aria-pressed', w.v === now ? 'true' : 'false');
    };
    draws.push(() => press(prefs.idtint));
    field.appendChild(seg);
    field.appendChild(el('div', 'hint', 'the 4px edge on a title bar, from the author key. never an identifier.'));
    b.appendChild(r);
  }

  // node — any origin works (NODE_INTERFACE → Cross-origin requests). The
  // field reads the node in force while the reader has typed nothing over it;
  // text typed and not committed stands through a draw.
  {
    const { row: r, field } = row('node');
    const input = el('input') as HTMLInputElement;
    input.placeholder = BUILD_BASE || 'same-origin (default)';
    input.setAttribute('aria-label', 'the node this client reads');
    input.addEventListener('change', () => handlers.setNode(input.value));
    let shown = input.value; // what the last draw wrote in the field
    draws.push(() => {
      if (input.value !== shown) return;
      shown = prefs.node;
      input.value = shown;
    });
    field.appendChild(input);
    field.appendChild(el('div', 'hint', 'blank resets to the build default. any origin works: the node answers every origin.'));
    b.appendChild(r);
  }

  // The extension's binary sign policy — visible only when both hooks are
  // present. *sign each rep action* controls whether rep writes prompt; sends
  // always prompt (WEB_INTERFACE → The settings window, → The extension).
  if (handlers.policy && handlers.setPolicy) {
    const policy = handlers.policy;
    const setPolicy = handlers.setPolicy;
    const { row: r, field } = row('sign each rep action');
    field.appendChild(choice([["don't ask", 'silent'], ['ask', 'ask']], policy, (v) => void setPolicy(v), draws));
    field.appendChild(el('div', 'hint', 'sending $NOTIS always asks. rep is silent while unlocked unless you ask.'));
    b.appendChild(r);
  }

  // The extension's links preference — visible only when both hooks are
  // present. A build's `notis-public` gates the proxy's members, so the row
  // stands only in an extension build wired to a public origin
  // (WEB_INTERFACE → The settings window, → The extension → "Links into the extension").
  if (handlers.links && handlers.setLinks) {
    const links = handlers.links;
    const setLinks = handlers.setLinks;
    const { row: r, field } = row('a Notis link opens');
    field.appendChild(choice([['on the site', 'site'], ['here', 'here']], links, (v) => void setLinks(v), draws));
    field.appendChild(el('div', 'hint', 'a link that opens a tab of its own lands in this workspace. a link followed inside a page stays there — its add to workspace brings it here.'));
    b.appendChild(r);
  }

  const update = (): void => {
    for (const draw of draws) draw();
  };
  update();
  return { el: b, update };
}

/** Two words for one preference: each sets its value, and each draw marks the
 *  one the preference reads as pressed. */
function choice<T extends string>(
  words: ReadonlyArray<readonly [label: string, value: T]>,
  read: () => T,
  set: (value: T) => void,
  draws: Array<() => void>,
): HTMLElement {
  const seg = el('div', 'seg');
  for (const [label, value] of words) {
    const btn = el('button', 'word', label);
    btn.addEventListener('click', () => set(value));
    draws.push(() => btn.setAttribute('aria-pressed', read() === value ? 'true' : 'false'));
    seg.appendChild(btn);
  }
  return seg;
}
