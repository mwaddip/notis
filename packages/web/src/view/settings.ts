import { el, setText } from '../dom';
import { prefs, BUILD_BASE, type Theme, type IdTint } from '../prefs';
import { stopHue } from '../model/identity';
import type { WindowBody } from '../model/state';
import type { TipVerdict } from '../model/tip-verdict';

// The @settings window — WEB_INTERFACE → The settings window. The client's
// preferences in the .winbody/.row/label/.field pattern, no identity read, its
// ↻ disabled. The rows: theme; identity tint (two sample title bars above the
// four words — WEB_INTERFACE → The settings window → "The identity tint shows
// what it sets" — each a fixed stop of the identity arc, aria-hidden, no
// handler, not `.win` since the samples are thread bars, the shape the tint
// applies to); node; sign each rep action (extension only); a Notis link opens
// (extension only, in a build whose `notis-public` is not empty). The tint is
// :root's attribute and custom properties, applied by `applyIdTint`, so a
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
  // The extension's hand-added node — the row renders the hand-added form
  // when this hook is present, else the web build's `node` row stands
  // (WEB_INTERFACE → The settings window → "In the extension the row adds
  // a node by hand").
  handNode?: HandNodeSeam;
  // The extension's binary sign policy — the row renders only when both hooks
  // are present (WEB_INTERFACE → The settings window; the extension's proxy).
  policy?: () => 'silent' | 'ask';
  setPolicy?: (p: 'silent' | 'ask') => Promise<void>;
  // The extension's links preference — the row renders only when both hooks
  // are present (WEB_INTERFACE → The settings window; the extension's proxy,
  // in a build whose `notis-public` is not empty).
  links?: () => 'site' | 'here';
  setLinks?: (v: 'site' | 'here') => Promise<void>;
  // The latest tip verdict — the row reads it to decide whether the question
  // stands (WEB_INTERFACE → The settings window → "While it disagrees the row
  // holds the question"). `undefined` is a build with no verifier, `null` is
  // one whose first verdict has not returned.
  verdict?: () => TipVerdict | null | undefined;
  // The extension's serve-posts seam — the row renders only with it
  // (WEB_INTERFACE → The settings window → "The serve row").
  serve?: ServeSeam;
}

/** The extension's hand-added node seam (WEB_INTERFACE → The settings window →
 *  "In the extension the row adds a node by hand"). `address` reads the stored
 *  address, or `''` when none. `commit` parses, calls the mesh client's
 *  `addByHand` or `removeByHand`, and answers `null` on success, or an error
 *  line to show beside the field. `off` / `setOff` hold the reader's off
 *  switch (`notis.node.hand.off`); `answer` hands the mesh client the
 *  reader's answer to a standing disagreement (MESH_INTERFACE → Discovery →
 *  "A node added by hand"). */
export interface HandNodeSeam {
  address(): string;
  commit(addr: string): string | null;
  off(): boolean;
  setOff(off: boolean): void;
  answer(decision: 'continue' | 'disable'): void;
}

/** The extension's serve-posts seam (WEB_INTERFACE → The settings window →
 *  "The serve row"). `on` reads the choice as stored; `set(on)` writes the
 *  choice and calls the mesh client's `setServing(on)`, which closes every
 *  connection the client holds and dials again so each new handshake
 *  declares the new set (MESH_INTERFACE → Block gossip → "A client that
 *  serves answers the nodes it reads"). */
export interface ServeSeam {
  on(): boolean;
  set(on: boolean): void;
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
        // The tint follows :root's data-idtint and custom properties,
        // applied by `applyIdTint`, so the press moves the four words'
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
  // text typed and not committed stands through a draw. In the extension the
  // row adds a node by hand (WEB_INTERFACE → The settings window → "In the
  // extension the row adds a node by hand"): the input holds the stored
  // address, the commit calls the seam, an error from it stands beside the
  // field, and the hint names the address format. The row also holds the
  // off state and the reader's question while the verdict reads
  // `refused` · *your-node* (→ "The reader may switch it off",
  // → "While it disagrees the row holds the question"); the update owns both
  // so nothing else in the page moves (`HOUSE_STYLE → Motion`).
  if (handlers.handNode) {
    const handNode = handlers.handNode;
    const readVerdict = handlers.verdict ?? ((): TipVerdict | null | undefined => undefined);
    const { row: r, field } = row('node');
    const input = el('input') as HTMLInputElement;
    input.placeholder = '/ip4/…/udp/…/p2p/…';
    input.setAttribute('aria-label', 'the node this client adds by hand');
    const errLine = el('div', 'error');
    errLine.hidden = true;
    input.addEventListener('change', () => {
      const result = handNode.commit(input.value);
      if (result === null) {
        errLine.hidden = true;
        errLine.textContent = '';
        // Drop the element so the test's `querySelector('.error')` reads null
        // after a successful commit.
        if (errLine.parentNode) errLine.parentNode.removeChild(errLine);
        shown = handNode.address();
        input.value = shown;
      } else {
        errLine.textContent = result;
        errLine.hidden = false;
        if (!errLine.parentNode) field.appendChild(errLine);
      }
    });
    let shown = input.value;
    field.appendChild(input);
    // The off label and the `turn on` word — stood up on demand by `update`.
    const offLabel = el('span', 'off', 'off');
    const turnOn = el('button', 'word', 'turn on') as HTMLButtonElement;
    turnOn.addEventListener('click', () => { handNode.setOff(false); });
    // The question slot and its two word controls — stood up on demand by
    // `update` while the verdict reads `refused` · *your-node*.
    const question = el('div', 'question');
    const contWord = el('button', 'word', 'continue on this node') as HTMLButtonElement;
    contWord.addEventListener('click', () => { handNode.answer('continue'); });
    const disWord = el('button', 'word', 'disable it') as HTMLButtonElement;
    disWord.addEventListener('click', () => { handNode.answer('disable'); });
    const hint = el('div', 'hint', 'the address a node prints at start, its /p2p/<peer id> included. blank removes the hand-added node.');
    field.appendChild(hint);
    // The off piece and the question piece live between the input and the
    // hint; placed and taken by `update`, and never by anything else.
    const placeBefore = (node: Node, before: Node): void => {
      if (node.parentNode === field && node.nextSibling === before) return;
      field.insertBefore(node, before);
    };
    const takeOut = (node: Node): void => {
      if (node.parentNode === field) field.removeChild(node);
    };
    draws.push(() => {
      if (input.value === shown) {
        shown = handNode.address();
        input.value = shown;
      }
      // The off state: `off` beside the address and `turn on` in place.
      const isOff = handNode.off();
      if (isOff) {
        placeBefore(offLabel, hint);
        placeBefore(turnOn, hint);
      } else {
        takeOut(offLabel);
        takeOut(turnOn);
      }
      // The question: word for word, with the two word controls, while the
      // verdict reads `refused` · *your-node* (WEB_INTERFACE → The settings
      // window → "While it disagrees the row holds the question").
      const v = readVerdict();
      const yn = v !== null && v !== undefined && v.kind === 'refused' && v.reason === 'your-node'
        ? v : null;
      if (yn !== null) {
        question.textContent = yn.which === 'memory'
          ? 'your node serves a chain that does not continue the one you verified. It may be compromised.'
          : 'another node serves a heavier chain than your node. Your node may be compromised.';
        placeBefore(question, hint);
        placeBefore(contWord, hint);
        placeBefore(disWord, hint);
      } else {
        takeOut(question);
        takeOut(contWord);
        takeOut(disWord);
      }
    });
    b.appendChild(r);
  } else {
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
