// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createTabs } from '../src/tabs';

// createTabs().offer — WEB_INTERFACE → The way into the workspace →
// "The page offers the thread to an extension first". The event is a
// convention any extension or client may implement on either side, so its
// name, its detail and its cancelability are the contract's.

const HEX = 'a'.repeat(64);

describe('createTabs().offer', () => {
  it('with no listener returns false and the event is not cancelled', () => {
    const tabs = createTabs();
    const events: Event[] = [];
    const spy = (e: Event): void => { events.push(e); };
    document.addEventListener('notis:open', spy);
    try {
      expect(tabs.offer(HEX)).toBe(false);
      expect(events.length).toBe(1);
      expect(events[0]!.defaultPrevented).toBe(false);
    } finally {
      document.removeEventListener('notis:open', spy);
    }
  });

  it('a document listener that calls preventDefault() → offer returns true', () => {
    const tabs = createTabs();
    const listener = (e: Event): void => { e.preventDefault(); };
    document.addEventListener('notis:open', listener);
    try {
      expect(tabs.offer(HEX)).toBe(true);
    } finally {
      document.removeEventListener('notis:open', listener);
    }
  });

  it('the listener sees a CustomEvent named notis:open, cancelable, detail exactly the id', () => {
    const tabs = createTabs();
    let seen: Event | null = null;
    const listener = (e: Event): void => { seen = e; };
    document.addEventListener('notis:open', listener);
    try {
      tabs.offer(HEX);
    } finally {
      document.removeEventListener('notis:open', listener);
    }
    expect(seen).not.toBeNull();
    const ev = seen! as CustomEvent<string>;
    expect(ev).toBeInstanceOf(CustomEvent);
    expect(ev.type).toBe('notis:open');
    expect(ev.cancelable).toBe(true);
    expect(ev.detail).toBe(HEX);
  });

  it('the event is dispatched on document — a bubble-phase window listener does not see the non-bubbling event, though a capture-phase one does', () => {
    // happy-dom follows the DOM spec on both halves: a window listener in the
    // capture phase is on the ancestor chain and sees the event, and a
    // bubble-phase one does not because the event was constructed without
    // bubbles. Both facts pin the dispatch to `document` — the target the
    // extension's bridge listens on.
    const tabs = createTabs();
    const windowBubble: Event[] = [];
    const windowCapture: Event[] = [];
    const wbub = (e: Event): void => { windowBubble.push(e); };
    const wcap = (e: Event): void => { windowCapture.push(e); };
    window.addEventListener('notis:open', wbub, false);
    window.addEventListener('notis:open', wcap, true);
    try {
      tabs.offer(HEX);
    } finally {
      window.removeEventListener('notis:open', wbub, false);
      window.removeEventListener('notis:open', wcap, true);
    }
    expect(windowBubble).toEqual([]);
    expect(windowCapture.length).toBe(1);
    expect(windowCapture[0]!.target).toBe(document);
  });

  it('a listener that does not cancel → offer returns false', () => {
    const tabs = createTabs();
    const listener = (): void => { /* takes note but does not preventDefault */ };
    document.addEventListener('notis:open', listener);
    try {
      expect(tabs.offer(HEX)).toBe(false);
    } finally {
      document.removeEventListener('notis:open', listener);
    }
  });
});

describe('createTabs().offer — no document', () => {
  it('returns false when document is undefined and touches no dispatch', () => {
    const orig = globalThis.document;
    delete (globalThis as { document?: Document }).document;
    try {
      const tabs = createTabs();
      expect(tabs.offer(HEX)).toBe(false);
    } finally {
      (globalThis as { document?: Document }).document = orig;
    }
  });
});
