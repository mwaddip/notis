// WEB_INTERFACE → The settings window → "The debug row". The row the extension
// build adds to the settings body — ahead of code while the module's body lands
// in the next change. The type below is what main.ts composes and the App takes.

import type { DebugLog } from './debug-log';
import type { SnapshotSeams } from './debug-snapshot';

/** The debug seam main.ts composes and the App takes (WEB_INTERFACE → The
 *  settings window → "The debug row", → The extension → "The snapshot").
 *  `seams` is the snapshot's sub-seams the App adds its own reader to at the
 *  moment a snapshot is taken; `log` is the log's clear/list the row calls
 *  for its *clear log* and the saved file's events; `download` is the App's
 *  file save (`app.ts`'s own `download`) the row hands the file's text and
 *  name to. */
export interface DebugSeam {
  seams: Omit<SnapshotSeams, 'reader'>;
  log: Pick<DebugLog, 'clear' | 'list'>;
  download: (filename: string, text: string) => void;
}
