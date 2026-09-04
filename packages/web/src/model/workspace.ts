// The tiling workspace: columns of regions, each region a stack of windows. A
// thread is one kind of window; @profile is the other. These are pure state
// transforms — the
// controller decides what to re-render from what each returns.
//
//   workspace := column+
//   column    := region+   (stacked vertically)
//   region    := window+   (stacked as title bars, one body shown)

export interface Region {
  uid: number;
  wins: string[];
  focus: number;
  report: string | null;
}
export interface Column {
  regions: Region[];
}
export interface Workspace {
  columns: Column[];
}

/** Where an open came from — the feed sits left of column 0, so a feed click
 *  targets column 0 and a pane click targets the column immediately right. */
export type Origin = { from: 'feed' } | { from: 'pane'; ci: number };

let uidSeq = 0;
export function newRegion(wins: string[]): Region {
  return { uid: ++uidSeq, wins: wins.slice(), focus: 0, report: null };
}

export function newWorkspace(): Workspace {
  return { columns: [] };
}

export function openSet(ws: Workspace): Set<string> {
  const s = new Set<string>();
  for (const col of ws.columns) for (const r of col.regions) for (const k of r.wins) s.add(k);
  return s;
}

export interface Located {
  ci: number;
  ri: number;
  idx: number;
  region: Region;
  col: Column;
}

export function locate(ws: Workspace, k: string): Located | null {
  for (let ci = 0; ci < ws.columns.length; ci++) {
    const col = ws.columns[ci]!;
    for (let ri = 0; ri < col.regions.length; ri++) {
      const region = col.regions[ri]!;
      const idx = region.wins.indexOf(k);
      if (idx !== -1) return { ci, ri, idx, region, col };
    }
  }
  return null;
}

export interface OpenResult {
  raised: boolean; // true if k was already open and merely focused
  region: Region;
}

/** Opening targets the column immediately right of the surface the click came
 *  from, and creates it only if it is not already there — which is what stops
 *  panes multiplying as you drill. An already-open window
 *  is raised, never duplicated. */
export function openWindow(ws: Workspace, k: string, origin?: Origin): OpenResult {
  const at = locate(ws, k);
  if (at) {
    at.region.focus = at.idx;
    at.region.report = null;
    return { raised: true, region: at.region };
  }

  const target = origin && origin.from === 'pane' ? origin.ci + 1 : 0;
  if (!ws.columns[target]) {
    const region = newRegion([k]);
    ws.columns.splice(target, 0, { regions: [region] });
    return { raised: false, region };
  }
  const region = ws.columns[target]!.regions[0]!;
  region.wins.push(k);
  region.focus = region.wins.length - 1;
  region.report = null;
  return { raised: false, region };
}

export function closeWindow(ws: Workspace, k: string): void {
  const at = locate(ws, k);
  if (!at) return;
  at.region.wins.splice(at.idx, 1);
  at.region.report = null;
  if (at.region.focus >= at.region.wins.length) at.region.focus = at.region.wins.length - 1;
  if (!at.region.wins.length) at.col.regions.splice(at.ri, 1);
  if (!at.col.regions.length) ws.columns.splice(at.ci, 1);
}

/** ← is the inverse of →: it rejoins the stack in the column to its left rather
 *  than carving out another one. */
export function moveLeft(ws: Workspace, k: string): void {
  const at = locate(ws, k);
  if (!at || at.ci === 0) return;
  at.region.wins.splice(at.idx, 1);
  if (at.region.focus >= at.region.wins.length) at.region.focus = at.region.wins.length - 1;
  if (!at.region.wins.length) {
    at.col.regions.splice(at.ri, 1);
    if (!at.col.regions.length) ws.columns.splice(at.ci, 1);
  }
  // Columns left of at.ci are unshifted by the removal above.
  const region = ws.columns[at.ci - 1]!.regions[0]!;
  region.wins.push(k);
  region.focus = region.wins.length - 1;
  region.report = null;
}

export function moveRight(ws: Workspace, k: string): void {
  const at = locate(ws, k);
  if (!at) return;
  at.region.wins.splice(at.idx, 1);
  if (at.region.focus >= at.region.wins.length) at.region.focus = at.region.wins.length - 1;
  let colRemoved = false;
  if (!at.region.wins.length) {
    at.col.regions.splice(at.ri, 1);
    if (!at.col.regions.length) {
      ws.columns.splice(at.ci, 1);
      colRemoved = true;
    }
  }
  const insertAt = colRemoved ? at.ci : at.ci + 1;
  ws.columns.splice(Math.min(insertAt, ws.columns.length), 0, { regions: [newRegion([k])] });
}

export function moveBelow(ws: Workspace, k: string): void {
  const at = locate(ws, k);
  if (!at) return;
  at.region.wins.splice(at.idx, 1);
  if (at.region.focus >= at.region.wins.length) at.region.focus = at.region.wins.length - 1;
  let regionRemoved = false;
  if (!at.region.wins.length) {
    at.col.regions.splice(at.ri, 1);
    regionRemoved = true;
  }
  const insertAt = regionRemoved ? at.ri : at.ri + 1;
  at.col.regions.splice(Math.min(insertAt, at.col.regions.length), 0, newRegion([k]));
}

export function focusWindow(ws: Workspace, k: string): Region | null {
  const at = locate(ws, k);
  if (!at) return null;
  at.region.focus = at.idx;
  at.region.report = null;
  return at.region;
}
