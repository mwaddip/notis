// WEB_INTERFACE → The workspace → "At one column the screens are history"

export interface ScreenEntry {
  member: string;
  prev: string | null;
  depth: number;
}

export type MoveResult =
  | { kind: 'none' }
  | { kind: 'back' }
  | { kind: 'push'; entry: ScreenEntry };

/**
 * Decide whether a view move pushes, pops or does nothing
 * (WEB_INTERFACE → The workspace → "At one column the screens are history").
 */
export function decideMove(
  current: ScreenEntry | null,
  landed: string,
  same: (a: string, b: string) => boolean,
  by: 'tap' | 'swipe',
): MoveResult {
  if (current === null || same(landed, current.member)) return { kind: 'none' };
  if (current.prev !== null && current.depth > 0 && same(landed, current.prev)) return { kind: 'back' };
  if (by === 'tap') {
    return {
      kind: 'push',
      entry: { member: landed, prev: current.member, depth: current.depth + 1 },
    };
  }
  return { kind: 'none' };
}
