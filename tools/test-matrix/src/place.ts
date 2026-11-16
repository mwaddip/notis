// TEST_MATRIX_INTERFACE → How a path is placed, → Reach, → The output.
// place is pure and has no I/O. Each path is placed by the first rule
// that matches it; every row that names the path adds its selection,
// whichever rule placed the path.
import type {
  Member,
  PlaceResult,
  Row,
  Rule,
  Selected,
  Unplaced,
  Workspace,
} from './types.ts';

const RULE_1_ROOTS: readonly string[] = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'tsconfig.base.json',
  'vitest.shared.ts',
];

const TREE_DIRS = ['test', 'slow', 'shadow', 'bench'] as const;
type TreeDir = (typeof TREE_DIRS)[number];
const TREE_RULE: Readonly<Record<TreeDir, Rule>> = {
  test: 'test/',
  slow: 'slow/',
  shadow: 'shadow/',
  bench: 'bench/',
};

const CHECK_HARNESS_PREFIX = 'packages/web/scripts/extension-check/';

function matchRule1(path: string): boolean {
  if (RULE_1_ROOTS.includes(path)) return true;
  if (path.startsWith('patches/')) return true;
  if (path.startsWith('.github/')) return true;
  return false;
}

function matchRule2(path: string): boolean {
  if (path.startsWith('contracts/')) return true;
  if (path.startsWith('docs/')) return true;
  if (path.endsWith('.md')) return true;
  if (path.startsWith('scripts/')) return true;
  return false;
}

function matchRule3(path: string): boolean {
  return path.startsWith(CHECK_HARNESS_PREFIX);
}

export function place(
  paths: readonly string[],
  workspace: Workspace,
  rows: readonly Row[],
): PlaceResult {
  const members = workspace.members;
  const memberNames = new Set(members.map((m) => m.name));
  const everyRunList: readonly string[] = [
    ...members.map((m) => m.name),
    'node:slow',
    'check',
  ];

  // Reverse readers of each member, for reach closure: declarations plus
  // run-time rows whose target is a member name.
  const runTimeReadersOf = new Map<string, string[]>();
  for (const m of members) {
    for (const r of m.reads) {
      let list = runTimeReadersOf.get(r);
      if (list === undefined) {
        list = [];
        runTimeReadersOf.set(r, list);
      }
      list.push(m.name);
    }
  }
  for (const row of rows) {
    if (row.kind === 'run time' && memberNames.has(row.reads)) {
      let list = runTimeReadersOf.get(row.reads);
      if (list === undefined) {
        list = [];
        runTimeReadersOf.set(row.reads, list);
      }
      list.push(row.reader);
    }
  }

  // Rows that name a file path or a directory path (ending in '/'), not
  // a member name.
  const pathRows = rows.filter((r) => !memberNames.has(r.reads));

  const selectedOrder = new Map<string, Selected>();
  const unplaced: Unplaced[] = [];

  function add(run: string, path: string, rule: Rule): void {
    if (!selectedOrder.has(run)) {
      selectedOrder.set(run, { run, path, rule });
    }
  }

  // TEST_MATRIX_INTERFACE → The rows → "in a suite": a change in the target
  // member selects the reader's own run and reaches nothing. Fires when a
  // member is reached (rule 5), not when a test-tree path (rule 4) adds it.
  const inASuiteMemberReadersOf = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.kind === 'in a suite' && memberNames.has(row.reads)) {
      const list = inASuiteMemberReadersOf.get(row.reads) ?? [];
      list.push(row);
      inASuiteMemberReadersOf.set(row.reads, list);
    }
  }

  function reachFrom(start: string, path: string, rule: Rule): void {
    const reached = new Set<string>();
    const queue: string[] = [];
    const visit = (name: string): void => {
      if (reached.has(name)) return;
      reached.add(name);
      if (memberNames.has(name)) queue.push(name);
    };
    visit(start);
    while (queue.length > 0) {
      const m = queue.shift() as string;
      for (const r of runTimeReadersOf.get(m) ?? []) visit(r);
    }
    for (const r of reached) {
      add(r, path, rule);
      if (r === 'node') add('node:slow', path, rule);
      for (const row of inASuiteMemberReadersOf.get(r) ?? []) {
        add(row.reader, path, 'row in a suite');
      }
    }
  }

  function everyRun(path: string, rule: Rule): void {
    for (const r of everyRunList) add(r, path, rule);
  }

  // TEST_MATRIX_INTERFACE → How a path is placed: a path rule 3, 4 or 5
  // places also selects test-matrix, the matrix's suite reads every member.
  function selectMatrix(path: string): void {
    if (memberNames.has('test-matrix')) add('test-matrix', path, 'matrix');
  }

  interface TreeHit {
    member: string;
    dir: TreeDir;
  }
  function matchRule4(path: string): TreeHit | null {
    for (const m of members) {
      const prefix = `${m.dir}/`;
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      for (const dir of TREE_DIRS) {
        if (rest.startsWith(`${dir}/`)) return { member: m.name, dir };
      }
    }
    return null;
  }

  function memberOf(path: string): string | null {
    let best: Member | null = null;
    for (const m of members) {
      const prefix = `${m.dir}/`;
      if (path.startsWith(prefix)) {
        if (best === null || m.dir.length > best.dir.length) best = m;
      }
    }
    return best === null ? null : best.name;
  }

  function applyRows(path: string): void {
    for (const row of pathRows) {
      const matches = row.reads.endsWith('/')
        ? path.startsWith(row.reads)
        : row.reads === path;
      if (!matches) continue;
      if (row.kind === 'run time') {
        if (memberNames.has(row.reader)) {
          reachFrom(row.reader, path, 'row at run time');
        } else {
          add(row.reader, path, 'row at run time');
        }
      } else if (row.kind === 'in a suite') {
        add(row.reader, path, 'row in a suite');
      }
      // 'by no run' adds nothing — the row is a cover for the scan.
    }
  }

  for (const path of paths) {
    if (matchRule1(path)) {
      everyRun(path, 'every run');
      applyRows(path);
      continue;
    }
    if (matchRule2(path)) {
      unplaced.push({ path, rule: 'no run' });
      applyRows(path);
      continue;
    }
    if (matchRule3(path)) {
      applyRows(path);
      selectMatrix(path);
      continue;
    }
    const hit = matchRule4(path);
    if (hit !== null) {
      const rule = TREE_RULE[hit.dir];
      add(hit.member, path, rule);
      if (hit.member === 'node' && hit.dir === 'slow') {
        add('node:slow', path, rule);
      }
      applyRows(path);
      selectMatrix(path);
      continue;
    }
    const name = memberOf(path);
    if (name !== null) {
      reachFrom(name, path, 'reach');
      applyRows(path);
      selectMatrix(path);
      continue;
    }
    everyRun(path, 'other');
    applyRows(path);
  }

  const selected = Array.from(selectedOrder.values());
  const selectedRuns = new Set(selected.map((s) => s.run));
  const membersLeftOut = members
    .map((m) => m.name)
    .filter((n) => !selectedRuns.has(n));

  return { selected, unplaced, membersLeftOut };
}
