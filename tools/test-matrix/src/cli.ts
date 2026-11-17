// TEST_MATRIX_INTERFACE → Place in the workspace: the command runs from
// source under Node's own type stripping — `node tools/test-matrix/src/cli.ts`.
// It reads the diff (→ What it reads → The diff), the workspace (→ The
// workspace) and the rows, calls place, and prints the answer (→ The
// output).
import { readDiff } from './diff.ts';
import { place } from './place.ts';
import { ROWS } from './rows.ts';
import type { PlaceResult, Workspace } from './types.ts';
import { diskReader, gitTreeReader, readWorkspace } from './workspace.ts';

interface Args {
  readonly rev: string | null;
  readonly base: string;
  readonly members: boolean;
  readonly json: boolean;
}

interface ArgError {
  readonly error: string;
}

function parseArgs(argv: readonly string[]): Args | ArgError {
  let rev: string | null = null;
  let base = 'master';
  let members = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--members') {
      members = true;
      continue;
    }
    if (a === '--rev') {
      const v = argv[i + 1];
      if (v === undefined) {
        return { error: 'test-matrix: refusing — --rev takes a value' };
      }
      rev = v;
      i += 1;
      continue;
    }
    if (a === '--base') {
      const v = argv[i + 1];
      if (v === undefined) {
        return { error: 'test-matrix: refusing — --base takes a value' };
      }
      base = v;
      i += 1;
      continue;
    }
    return { error: `test-matrix: refusing — unknown option: ${a}` };
  }
  return { rev, base, members, json };
}

// TEST_MATRIX_INTERFACE → The output: --members prints members "in the
// workspace's build order — every member after each member it declares,
// ties broken by name". Kahn's order with an alphabetical priority queue.
function buildOrder(workspace: Workspace): string[] {
  const names = workspace.members.map((m) => m.name);
  const nameSet = new Set(names);
  const inDeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const name of names) {
    inDeg.set(name, 0);
    dependents.set(name, []);
  }
  for (const m of workspace.members) {
    for (const d of m.reads) {
      if (!nameSet.has(d)) continue;
      inDeg.set(m.name, (inDeg.get(m.name) ?? 0) + 1);
      (dependents.get(d) as string[]).push(m.name);
    }
  }
  const queue: string[] = names
    .filter((n) => inDeg.get(n) === 0)
    .sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift() as string;
    order.push(n);
    for (const dep of dependents.get(n) ?? []) {
      const next = (inDeg.get(dep) ?? 0) - 1;
      inDeg.set(dep, next);
      if (next === 0) {
        let i = 0;
        while (i < queue.length && (queue[i] as string) < dep) i += 1;
        queue.splice(i, 0, dep);
      }
    }
  }
  return order;
}

function classifyUntracked(
  untracked: readonly string[],
  workspace: Workspace,
): { inside: string[]; outside: string[] } {
  const dirs = workspace.members.map((m) => `${m.dir}/`);
  const inside: string[] = [];
  const outside: string[] = [];
  for (const p of untracked) {
    if (dirs.some((d) => p.startsWith(d))) inside.push(p);
    else outside.push(p);
  }
  return { inside, outside };
}

function printEmpty(args: Args, workspace: Workspace): void {
  if (args.members) {
    process.stdout.write('\n');
    return;
  }
  if (args.json) {
    const payload = {
      runs: [],
      unplaced: [],
      membersLeftOut: workspace.members.map((m) => m.name),
      notCounted: [],
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write('empty diff\n');
}

function printMembers(
  result: PlaceResult,
  workspace: Workspace,
): void {
  const memberNames = new Set(workspace.members.map((m) => m.name));
  const selected = new Set<string>();
  for (const s of result.selected) {
    if (memberNames.has(s.run)) selected.add(s.run);
  }
  const order = buildOrder(workspace);
  const picked = order.filter((n) => selected.has(n));
  process.stdout.write(`${picked.join(' ')}\n`);
}

function printJson(
  result: PlaceResult,
  notCounted: readonly string[],
): void {
  const payload = {
    runs: result.selected,
    unplaced: result.unplaced,
    membersLeftOut: result.membersLeftOut,
    notCounted,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function printText(
  result: PlaceResult,
  notCounted: readonly string[],
): void {
  const lines: string[] = [];
  for (const s of result.selected) {
    lines.push(`run ${s.run}: ${s.path} (${s.rule})`);
  }
  for (const u of result.unplaced) {
    lines.push(`no-run: ${u.path} (${u.rule})`);
  }
  for (const m of result.membersLeftOut) {
    lines.push(`not-selected: ${m}`);
  }
  for (const p of notCounted) {
    lines.push(`not-counted: ${p}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  let root: string;
  let changed: readonly string[];
  let untracked: readonly string[];
  try {
    const diff = readDiff({
      cwd: process.cwd(),
      rev: parsed.rev,
      base: parsed.base,
    });
    root = diff.root;
    changed = diff.changed;
    untracked = diff.untracked;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  const reader =
    parsed.rev === null ? diskReader(root) : gitTreeReader(root, parsed.rev);
  let workspace: Workspace;
  try {
    workspace = readWorkspace(reader);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  const u = classifyUntracked(untracked, workspace);
  const paths = [...changed, ...u.inside];

  if (paths.length === 0 && u.outside.length === 0) {
    printEmpty(parsed, workspace);
    return 0;
  }

  const result = place(paths, workspace, ROWS);

  if (parsed.members) {
    printMembers(result, workspace);
    return 0;
  }
  if (parsed.json) {
    printJson(result, u.outside);
    return 0;
  }
  printText(result, u.outside);
  return 0;
}

process.exit(main());
