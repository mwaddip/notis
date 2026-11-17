// WEB_INTERFACE → The extension → "The debug log". The module that starts the
// page's debug log over required seams; `main.ts`'s extension branch calls it
// with the browser's own values. This file is the scaffold: the behaviour it
// commits to is described by the cases in `test/extension/debug-start.test.ts`
// and lands with them.

import {
  createDebugLog,
  DEBUG_LOG_BYTES,
  type DebugLog,
  type DebugTimers,
  type DocumentHost,
  type EventHost,
} from './debug-log.js';

/** The seams the module takes. Nothing defaults in shipped code: the
 *  extension build hands each. `indexedDB` is `undefined` where the browser
 *  gives the page none (WEB_INTERFACE → The extension → "The debug log").
 *  `random` draws the page id. */
export interface DebugStartDeps {
  indexedDB: IDBFactory | undefined;
  now: () => number;
  random: () => number;
  timers: DebugTimers;
  document: DocumentHost;
  window: EventHost;
  version: string;
  commit: string;
  network: string;
  userAgent: string;
}

/** The batch's size (WEB_INTERFACE → The extension → "The debug log" — "A
 *  page writes its events in batches"). Local cadence. */
const BATCH_SIZE = 50;

/** The batch's interval in ms. Local cadence. */
const BATCH_INTERVAL_MS = 2_000;

/** The page id's length — eight lowercase hex (WEB_INTERFACE → The extension
 *  → "The debug log" — "each event carrying the page's id"). */
const PAGE_ID_HEX_LEN = 8;

export interface DebugStart {
  log: DebugLog;
  pageId: string;
}

export function startDebugLog(deps: DebugStartDeps): DebugStart {
  const pageId = drawPageId(deps.random);
  const log = createDebugLog({
    indexedDB: deps.indexedDB,
    now: deps.now,
    pageId,
    boundBytes: DEBUG_LOG_BYTES,
    batchSize: BATCH_SIZE,
    batchInterval: BATCH_INTERVAL_MS,
    timers: deps.timers,
  });
  return { log, pageId };
}

function drawPageId(random: () => number): string {
  const n = Math.floor(random() * 0x100000000) >>> 0;
  return n.toString(16).padStart(PAGE_ID_HEX_LEN, '0');
}
