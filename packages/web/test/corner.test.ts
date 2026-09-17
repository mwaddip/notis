// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { cornerState, cornerTitle, renderCorner, CORNER_STALE_MS } from '../src/view/corner';

describe('cornerState — the dot from the client\'s own reads', () => {
  it('no read yet → none', () => {
    expect(cornerState({ lastTip: null, lastRiseAt: null, lastReadOk: null, now: 0 })).toBe('none');
  });

  it('the last read failed → down, even if a prior read had risen', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: 0, lastReadOk: false, now: 1000 })).toBe('down');
  });

  it('rose inside the ten-minute window → fresh', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: 0, lastReadOk: true, now: CORNER_STALE_MS })).toBe('fresh');
  });

  it('rose exactly at the ten-minute edge → still fresh', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: 0, lastReadOk: true, now: CORNER_STALE_MS })).toBe('fresh');
  });

  it('no rise for longer than the window → stale', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: 0, lastReadOk: true, now: CORNER_STALE_MS + 1 })).toBe('stale');
  });

  it('answered but never rose → stale', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: null, lastReadOk: true, now: 60_000 })).toBe('stale');
  });
});

describe('cornerTitle — the words the corner reads to a reader', () => {
  it('fresh names the tip', () => {
    expect(cornerTitle('fresh', 2295)).toBe('blocks progressing · tip 2295');
  });
  it('stale names ten minutes and the tip', () => {
    expect(cornerTitle('stale', 2295)).toBe('no new block for 10 minutes · tip 2295');
  });
  it('down names the last tip when one exists', () => {
    expect(cornerTitle('down', 2295)).toBe('the node did not answer · last tip 2295');
  });
  it('down without a last tip stays short', () => {
    expect(cornerTitle('down', null)).toBe('the node did not answer');
  });
  it('none says no tip yet', () => {
    expect(cornerTitle('none', null)).toBe('no tip yet');
  });
});

describe('renderCorner — the button holds a dot and a height', () => {
  it('renders a button.corner with a led carrying the state class and a mono tip', () => {
    const host = document.createElement('button');
    renderCorner(host, 'fresh', 2295);
    expect(host.className).toBe('corner');
    const led = host.querySelector('.led');
    const tip = host.querySelector('.tip');
    expect(led).not.toBeNull();
    expect(led!.classList.contains('fresh')).toBe(true);
    expect(tip).not.toBeNull();
    expect(tip!.classList.contains('mono')).toBe(true);
    expect(tip!.textContent).toBe('2295');
  });

  it('sets aria-label and the title from cornerTitle', () => {
    const host = document.createElement('button');
    renderCorner(host, 'stale', 2295);
    expect(host.getAttribute('aria-label')).toBe('chain status');
    expect(host.getAttribute('title')).toBe('no new block for 10 minutes · tip 2295');
  });

  it('renders — for a null tip', () => {
    const host = document.createElement('button');
    renderCorner(host, 'none', null);
    expect(host.querySelector('.tip')!.textContent).toBe('—');
    expect(host.querySelector('.led')!.classList.contains('none')).toBe(true);
  });

  it('a second call replaces the previous contents in place', () => {
    const host = document.createElement('button');
    renderCorner(host, 'none', null);
    renderCorner(host, 'fresh', 42);
    expect(host.querySelectorAll('.led').length).toBe(1);
    expect(host.querySelectorAll('.tip').length).toBe(1);
    expect(host.querySelector('.led')!.classList.contains('fresh')).toBe(true);
    expect(host.querySelector('.tip')!.textContent).toBe('42');
  });

  it('re-render across every state changes only the led class and the tip text', () => {
    const host = document.createElement('button');
    for (const [s, t] of [['fresh', 1], ['stale', 2], ['down', 3], ['none', null]] as const) {
      renderCorner(host, s, t);
      expect(host.querySelector('.led')!.classList.contains(s)).toBe(true);
      expect(host.querySelector('.tip')!.textContent).toBe(t === null ? '—' : String(t));
    }
  });
});
