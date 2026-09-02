import { describe, it, expect } from 'vitest';
import {
  newWorkspace, openWindow, closeWindow, moveLeft, moveRight, moveBelow, focusWindow, openSet, locate,
} from '../src/model/workspace';
import { serialise } from '../src/model/arrangement';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('workspace placement rule', () => {
  it('opens a feed click into column 0, and a pane click into the column immediately right', () => {
    const ws = newWorkspace();
    openWindow(ws, A, { from: 'feed' });
    expect(serialise(ws)).toBe(A);
    openWindow(ws, B, { from: 'pane', ci: 0 });
    expect(serialise(ws)).toBe(`${A}|${B}`);
  });

  it('reuses the target column rather than wedging a new one in as you drill', () => {
    const ws = newWorkspace();
    openWindow(ws, A, { from: 'feed' });
    openWindow(ws, B, { from: 'pane', ci: 0 });
    openWindow(ws, C, { from: 'pane', ci: 0 }); // same origin → stacks in column 1
    expect(serialise(ws)).toBe(`${A}|${B},${C}`);
  });

  it('raises an already-open window instead of duplicating it', () => {
    const ws = newWorkspace();
    openWindow(ws, A, { from: 'feed' });
    openWindow(ws, B, { from: 'pane', ci: 0 });
    const res = openWindow(ws, B, { from: 'pane', ci: 0 });
    expect(res.raised).toBe(true);
    expect(serialise(ws)).toBe(`${A}|${B}`);
    expect(openSet(ws)).toEqual(new Set([A, B]));
  });
});

describe('workspace move controls', () => {
  it('→ splits into a new column and ← merges it back — a round trip', () => {
    const ws = newWorkspace();
    openWindow(ws, A, { from: 'feed' });
    openWindow(ws, B, { from: 'pane', ci: 0 });
    openWindow(ws, C, { from: 'pane', ci: 0 }); // A | B,C
    moveRight(ws, C);
    expect(serialise(ws)).toBe(`${A}|${B}|${C}`);
    moveLeft(ws, C);
    expect(serialise(ws)).toBe(`${A}|${B},${C}`);
  });

  it('← is a no-op in the leftmost column', () => {
    const ws = newWorkspace();
    openWindow(ws, A, { from: 'feed' });
    moveLeft(ws, A);
    expect(serialise(ws)).toBe(A);
  });

  it('↓ opens a new region below in the same column', () => {
    const ws = newWorkspace();
    openWindow(ws, A, { from: 'feed' });
    openWindow(ws, B, { from: 'pane', ci: 0 });
    openWindow(ws, C, { from: 'pane', ci: 0 }); // A | B,C
    moveBelow(ws, C);
    expect(serialise(ws)).toBe(`${A}|${B}/${C}`);
  });
});

describe('workspace close', () => {
  it('removes a window and collapses the region and column it emptied', () => {
    const ws = newWorkspace();
    openWindow(ws, A, { from: 'feed' });
    openWindow(ws, B, { from: 'pane', ci: 0 });
    moveBelow(ws, B); // A | (B alone in its own region below the first)
    closeWindow(ws, B);
    expect(serialise(ws)).toBe(A);
    closeWindow(ws, A);
    expect(serialise(ws)).toBe('');
    expect(ws.columns.length).toBe(0);
  });

  it('focus follows the window and locate finds it', () => {
    const ws = newWorkspace();
    openWindow(ws, A, { from: 'feed' });
    openWindow(ws, B, { from: 'pane', ci: 0 });
    openWindow(ws, C, { from: 'pane', ci: 0 }); // column 1 stacks B,C, focus on C
    const at = locate(ws, C)!;
    expect(at.ci).toBe(1);
    expect(at.region.focus).toBe(at.idx);
    focusWindow(ws, B);
    expect(locate(ws, B)!.region.focus).toBe(locate(ws, B)!.idx);
  });
});
