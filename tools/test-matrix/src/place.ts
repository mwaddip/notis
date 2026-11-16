// TEST_MATRIX_INTERFACE → How a path is placed: place is pure and has no
// I/O. It answers each selected run, each path under no run, and each
// member whose run is not selected. The rows argument is required.
import type { PlaceResult, Row, Workspace } from './types.ts';

export function place(
  _paths: readonly string[],
  workspace: Workspace,
  _rows: readonly Row[],
): PlaceResult {
  return {
    selected: [],
    unplaced: [],
    membersLeftOut: workspace.members.map((m) => m.name),
  };
}
