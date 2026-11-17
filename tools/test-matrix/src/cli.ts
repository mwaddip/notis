// TEST_MATRIX_INTERFACE → Place in the workspace: the command runs from
// source under Node's own type stripping — `node tools/test-matrix/src/cli.ts`.
// The entry answers an empty selection on exit 0 for every invocation;
// what reads the diff, the workspace and the rows, and formats the answer,
// lands beside it.
const argv = process.argv.slice(2);
if (argv.includes('--json')) {
  process.stdout.write(
    '{"runs":[],"unplaced":[],"membersLeftOut":[],"notCounted":[]}\n',
  );
} else if (argv.includes('--members')) {
  process.stdout.write('\n');
} else {
  process.stdout.write('empty diff\n');
}
process.exit(0);
