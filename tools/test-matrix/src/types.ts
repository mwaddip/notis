// TEST_MATRIX_INTERFACE is the source of truth for every meaning here.

// TEST_MATRIX_INTERFACE → The rows
export type Kind = 'run time' | 'in a suite' | 'by no run';

// TEST_MATRIX_INTERFACE → The rows
export interface Row {
  readonly reader: string;
  readonly reads: string;
  readonly how: string;
  readonly kind: Kind;
}

// TEST_MATRIX_INTERFACE → The workspace
export interface Member {
  readonly name: string;
  readonly dir: string;
  readonly reads: readonly string[];
}

export interface Workspace {
  readonly members: readonly Member[];
}

// TEST_MATRIX_INTERFACE → The workspace: the reader is handed in,
// never defaulted.
export interface TreeReader {
  file(path: string): string | null;
  dirs(path: string): string[];
}

// TEST_MATRIX_INTERFACE → How a path is placed, → The rows
export type Rule =
  | 'every run'
  | 'no run'
  | 'check harness'
  | 'test/'
  | 'slow/'
  | 'shadow/'
  | 'bench/'
  | 'reach'
  | 'other'
  | 'row at run time'
  | 'row in a suite'
  | 'row by no run';

// TEST_MATRIX_INTERFACE → The output
export interface Selected {
  readonly run: string;
  readonly path: string;
  readonly rule: Rule;
}

export interface Unplaced {
  readonly path: string;
  readonly rule: Rule;
}

export interface PlaceResult {
  readonly selected: readonly Selected[];
  readonly unplaced: readonly Unplaced[];
  readonly membersLeftOut: readonly string[];
}
