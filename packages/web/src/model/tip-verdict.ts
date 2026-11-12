// The verdict — the shape the mesh client's `meshVerdict` answers and the
// corner, the figures-line and the names-verdict read
// (WEB_INTERFACE → The extension → "The verified tip"). The rows are the
// contract's table, the first that holds; the mesh client's check is where the
// verdict reads, so this module carries the type alone.

export type TipVerdict =
  | { kind: 'verified'; nodes: number; height: number }
  | { kind: 'thin'; reason: 'no-proof' | 'too-short' | 'one-node' | 'split' | 'not-continued'; height: number | null }
  | { kind: 'refused'; reason: 'invalid-proof'; height: number | null }
  | { kind: 'refused'; reason: 'your-node'; which: 'memory' | 'heavier'; height: number | null };
