// The tiling workspace: columns of windows. A column is one stack of windows,
// shown as title bars in a fixed block with the body of the focused one below.
// A thread is one kind of window; @profile is the other. These are pure state
// transforms — the controller decides what to re-render from what each returns
// (WEB_INTERFACE → The workspace).
//
//   workspace := column+
//   column    := window+   (stacked as title bars, one body shown)

export interface Column {
  uid: number;
  wins: string[];
  focus: number;
  report: string | null;
}
export interface Workspace {
  columns: Column[];
}

/** Where an open came from — the feed sits left of column 0, so a feed click
 *  targets column 0 and a pane click targets the column immediately right. */
export type Origin = { from: 'feed' } | { from: 'pane'; ci: number };

let uidSeq = 0;
export function newColumn(wins: string[]): Column {
  return { uid: ++uidSeq, wins: wins.slice(), focus: 0, report: null };
}

export function newWorkspace(): Workspace {
  return { columns: [] };
}

export function openSet(ws: Workspace): Set<string> {
  const s = new Set<string>();
  for (const col of ws.columns) for (const k of col.wins) s.add(k);
  return s;
}

export interface Located {
  ci: number;
  idx: number;
  column: Column;
}

export function locate(ws: Workspace, k: string): Located | null {
  for (let ci = 0; ci < ws.columns.length; ci++) {
    const column = ws.columns[ci]!;
    const idx = column.wins.indexOf(k);
    if (idx !== -1) return { ci, idx, column };
  }
  return null;
}

export interface OpenResult {
  raised: boolean; // true if k was already open and merely focused
  column: Column;
}

/** Opening targets the column immediately right of the surface the click came
 *  from, and creates it only if it is not already there — which is what stops
 *  columns multiplying as you drill. An already-open window is raised, never
 *  duplicated (WEB_INTERFACE → The workspace → "One placement rule"). */
export function openWindow(ws: Workspace, k: string, origin?: Origin): OpenResult {
  const at = locate(ws, k);
  if (at) {
    at.column.focus = at.idx;
    at.column.report = null;
    return { raised: true, column: at.column };
  }

  const target = origin && origin.from === 'pane' ? origin.ci + 1 : 0;
  if (!ws.columns[target]) {
    const column = newColumn([k]);
    ws.columns.splice(target, 0, column);
    return { raised: false, column };
  }
  const column = ws.columns[target]!;
  column.wins.push(k);
  column.focus = column.wins.length - 1;
  column.report = null;
  return { raised: false, column };
}

export function closeWindow(ws: Workspace, k: string): void {
  const at = locate(ws, k);
  if (!at) return;
  at.column.wins.splice(at.idx, 1);
  at.column.report = null;
  if (at.column.focus >= at.column.wins.length) at.column.focus = at.column.wins.length - 1;
  if (!at.column.wins.length) ws.columns.splice(at.ci, 1);
}

/** ← is the inverse of →: it rejoins the stack in the column to its left rather
 *  than carving out another one (WEB_INTERFACE → The workspace). */
export function moveLeft(ws: Workspace, k: string): void {
  const at = locate(ws, k);
  if (!at || at.ci === 0) return;
  at.column.wins.splice(at.idx, 1);
  if (at.column.focus >= at.column.wins.length) at.column.focus = at.column.wins.length - 1;
  if (!at.column.wins.length) ws.columns.splice(at.ci, 1);
  // Columns left of at.ci are unshifted by the removal above.
  const column = ws.columns[at.ci - 1]!;
  column.wins.push(k);
  column.focus = column.wins.length - 1;
  column.report = null;
}

export function moveRight(ws: Workspace, k: string): void {
  const at = locate(ws, k);
  if (!at) return;
  at.column.wins.splice(at.idx, 1);
  if (at.column.focus >= at.column.wins.length) at.column.focus = at.column.wins.length - 1;
  let colRemoved = false;
  if (!at.column.wins.length) {
    ws.columns.splice(at.ci, 1);
    colRemoved = true;
  }
  const insertAt = colRemoved ? at.ci : at.ci + 1;
  ws.columns.splice(Math.min(insertAt, ws.columns.length), 0, newColumn([k]));
}

export function focusWindow(ws: Workspace, k: string): Column | null {
  const at = locate(ws, k);
  if (!at) return null;
  at.column.focus = at.idx;
  at.column.report = null;
  return at.column;
}
