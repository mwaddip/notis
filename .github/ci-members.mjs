// The ci workflow's matrix, printed as `matrix=<json>` for $GITHUB_OUTPUT: one row for each workspace member that
// has a `test` script, and one more for a member that has a `test:slow` script. The members are the workspace's
// own — `pnpm -r exec` walks the globs of `pnpm-workspace.yaml` and needs no install — so a member added there is
// gated with no edit to the workflow.
import { execFileSync } from 'node:child_process';

const read = 'JSON.stringify((p => ({ name: p.name, scripts: Object.keys(p.scripts || {}) }))(require("./package.json")))';
const out = execFileSync('pnpm', ['-r', 'exec', '--', 'node', '-p', read], { encoding: 'utf8' });
const members = out.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
if (members.length === 0) throw new Error('the workspace answered no member');

const include = [];
for (const m of members) {
  if (m.scripts.includes('test')) include.push({ member: m.name, run: 'test', typecheck: m.scripts.includes('typecheck') });
  if (m.scripts.includes('test:slow')) include.push({ member: m.name, run: 'test:slow', typecheck: false });
}
process.stdout.write('matrix=' + JSON.stringify({ include }) + '\n');
