import { el } from '../dom';
import { prefs, type IdTint } from '../prefs';
import type { Handlers, RenderCtx } from '../model/state';

// @settings — the second window kind, and the proof the frame holds more than
// threads. No avatar and no identity colour on it: nothing here may invite a
// reader to check identity by colour.

const ID_TINTS: IdTint[] = ['spine', 'wash', 'both', 'off'];

function row(label: string): { row: HTMLElement; field: HTMLElement } {
  const r = el('div', 'row');
  r.appendChild(el('label', null, label));
  const field = el('div', 'field');
  r.appendChild(field);
  return { row: r, field };
}

export function settingsBody(handlers: Handlers, ctx: RenderCtx): HTMLElement {
  const b = el('div', 'winbody');

  // Theme — the control names and shows the theme it would switch TO, never the
  // one already active (HOUSE_STYLE → Colour). Styled as the inverse of the
  // current ground.
  {
    const { row: r, field } = row('theme');
    const target = prefs.theme === 'dark' ? 'light' : 'dark';
    const btn = el('button', 'theme-btn', target);
    btn.setAttribute('aria-label', `switch to ${target} theme`);
    btn.addEventListener('click', () => handlers.setTheme(target));
    field.appendChild(btn);
    b.appendChild(r);
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
    b.appendChild(r);
  }

  // Node — same-origin by default; a foreign origin fails until the node gains
  // CORS, and the field says so rather than failing silently.
  {
    const { row: r, field } = row('node');
    const input = el('input') as HTMLInputElement;
    input.value = prefs.node;
    input.placeholder = 'same-origin (default)';
    input.setAttribute('aria-label', 'the node this client reads');
    input.addEventListener('change', () => handlers.setNode(input.value));
    field.appendChild(input);
    field.appendChild(el('div', 'hint', 'blank reads this page’s own origin. a foreign origin needs CORS the node does not send yet, and will fail.'));
    b.appendChild(r);
  }

  // Arrangement — the workspace as the #r1,r2|r5 text form, readable and
  // copyable.
  {
    const { row: r, field } = row('arrangement');
    const text = ctx.arrangement;
    const arr = el('div', text ? 'arr' : 'arr empty', text || '(no windows open)');
    field.appendChild(arr);
    b.appendChild(r);
  }

  return b;
}
