// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { settingsBody, type SettingsHandlers, type HandNodeSeam } from '../src/view/settings';
import { prefs, setNode } from '../src/prefs';
import type { TipVerdict } from '../src/model/tip-verdict';

// WEB_INTERFACE → The settings window — the `node` row holds the reader's
// question while the verdict reads `refused` · *your-node* — word for word —
// and the two word controls answer. The hand-added node's off state is kept
// as `notis.node.hand.off`, the row reads `off` with `turn on`; a page that
// starts with the node off does not add it.

const VALID_ADDR = '/ip4/127.0.0.1/udp/9733/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';

function handlers(over: Partial<SettingsHandlers> = {}): SettingsHandlers {
  return {
    setTheme: () => {},
    setIdTint: () => {},
    setNode: () => {},
    ...over,
  };
}

function rowField(body: HTMLElement, label: string): HTMLElement | null {
  for (const r of body.querySelectorAll('.row')) {
    if (r.querySelector('label')?.textContent === label) return r.querySelector('.field');
  }
  return null;
}

function off(): HandNodeSeam {
  return {
    address: () => VALID_ADDR,
    commit: () => null,
    off: () => false,
    setOff: () => {},
    answer: () => {},
  };
}

const memoryVerdict = (): TipVerdict => ({ kind: 'refused', reason: 'your-node', which: 'memory', height: 100 });
const heavierVerdict = (): TipVerdict => ({ kind: 'refused', reason: 'your-node', which: 'heavier', height: 100 });
const verifiedVerdict = (): TipVerdict => ({ kind: 'verified', nodes: 2, height: 100 });

beforeEach(() => {
  localStorage.clear();
  prefs.faucet = '';
  prefs.idtint = 'spine';
  prefs.theme = 'light';
  setNode('');
});

describe("the node row holds the question while the verdict reads refused · your-node", () => {
  // AssertionError: expected null not to be null (line 62: the .question element)
  it('the node row holds the question for which: memory, word for word, and the two answers', () => {
    const body = settingsBody(handlers({
      handNode: off(),
      verdict: () => memoryVerdict(),
    })).el;
    const field = rowField(body, 'node')!;
    // The question in clay, word for word.
    const question = field.querySelector('.question');
    expect(question).not.toBeNull();
    expect(question!.textContent).toBe('your node serves a chain that does not continue the one you verified. It may be compromised.');
    // The two word controls, no boxes.
    const words = [...field.querySelectorAll<HTMLButtonElement>('button.word')];
    const labels = words.map((w) => w.textContent);
    expect(labels).toContain('continue on this node');
    expect(labels).toContain('disable it');
  });

  // TypeError: Cannot read properties of null (reading 'textContent')
  it('the node row holds the question for which: heavier, word for word', () => {
    const body = settingsBody(handlers({
      handNode: off(),
      verdict: () => heavierVerdict(),
    })).el;
    const field = rowField(body, 'node')!;
    const question = field.querySelector('.question')!;
    expect(question.textContent).toBe('another node serves a heavier chain than your node. Your node may be compromised.');
  });

  // TypeError: Cannot read properties of undefined (reading 'click') — the
  // word control `continue on this node` is not rendered.
  it("continue on this node calls answer('continue') once and the row draws the next verdict", () => {
    const answer = vi.fn();
    let v: TipVerdict | null = memoryVerdict();
    const body = settingsBody(handlers({
      handNode: { ...off(), answer },
      verdict: () => v,
    }));
    const field = rowField(body.el, 'node')!;
    const cont = [...field.querySelectorAll<HTMLButtonElement>('button.word')]
      .find((w) => w.textContent === 'continue on this node')!;
    v = verifiedVerdict();
    cont.click();
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith('continue');
    body.update();
    // The next verdict stands; the question is gone.
    const after = rowField(body.el, 'node')!;
    expect(after.querySelector('.question')).toBeNull();
  });

  // TypeError: Cannot read properties of undefined (reading 'click') — the
  // word control `disable it` is not rendered.
  it("disable it calls answer('disable') once and stores the node off", () => {
    const answer = vi.fn();
    const setOff = vi.fn();
    let v: TipVerdict | null = heavierVerdict();
    const body = settingsBody(handlers({
      handNode: { ...off(), answer, setOff },
      verdict: () => v,
    }));
    const field = rowField(body.el, 'node')!;
    const dis = [...field.querySelectorAll<HTMLButtonElement>('button.word')]
      .find((w) => w.textContent === 'disable it')!;
    v = null;
    dis.click();
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith('disable');
  });
});

describe("the hand-added node's off state", () => {
  // AssertionError: expected undefined not to be undefined — the `turn on`
  // word is not rendered.
  it('a page that starts with the node off does not add it; turn on adds it back trusted', () => {
    // The row reads the address, `off`, and the word control `turn on`.
    let state = true;
    const setOff = vi.fn((v: boolean) => { state = v; });
    const body = settingsBody(handlers({
      handNode: {
        address: () => VALID_ADDR,
        commit: () => null,
        off: () => state,
        setOff,
        answer: () => {},
      },
      verdict: () => null,
    }));
    const field = rowField(body.el, 'node')!;
    // The address stands.
    const shown = field.querySelector('input')!;
    expect(shown.value).toBe(VALID_ADDR);
    // The off marker — the word `off` renders in a dedicated place, paired
    // with `turn on` as the word control.
    const words = [...field.querySelectorAll<HTMLButtonElement>('button.word')];
    const turnOn = words.find((w) => w.textContent === 'turn on');
    expect(turnOn).toBeDefined();
    // The off label stands as text alongside the address.
    const offLabel = field.querySelector('.off');
    expect(offLabel).not.toBeNull();
    expect(offLabel!.textContent).toBe('off');
    turnOn!.click();
    expect(setOff).toHaveBeenCalledTimes(1);
    expect(setOff).toHaveBeenCalledWith(false);
  });
});

describe("the web build's settings window", () => {
  it('has no question, no off state, and holds no write', () => {
    // No handNode seam — the row is the web form, and the verdict reader
    // (if even passed) does not produce a question or an off state.
    const body = settingsBody(handlers({ verdict: () => memoryVerdict() })).el;
    const field = rowField(body, 'node')!;
    expect(field.querySelector('.question')).toBeNull();
    expect(field.querySelector('.off')).toBeNull();
    expect([...field.querySelectorAll<HTMLButtonElement>('button.word')]
      .map((w) => w.textContent)).toEqual([]);
  });
});
