// WEB_INTERFACE → The settings window → "The debug row". The row the extension
// build adds to the settings body: `show` opens the snapshot's lines in place,
// the word reading `hide` while they stand; each value is a copy control, the
// key row's pattern (→ The profile window → "The key is a control, and a
// press copies it"); the box `include my key, name and transaction ids` is
// unticked at every open; `save as file` hands the file's text and name to
// the caller's `download`; `clear log` asks in place as `forget` does;
// `refresh` re-takes the snapshot. The row's whole text, its transport names
// and its format live here — the web bundle carries none of it, which
// `build-release.sh` holds by refusing `webrtc-direct`, `notis.debug` and
// `notis-debug/1` in it.
//
// The body stands while the window is open (WEB_INTERFACE → The workspace →
// "A window's body stands while the window is open"): the row is appended
// once at the settings body's build and nothing pushes an update for it, so
// a draw of the window updates the row in place by leaving it alone — its
// open/closed state, the box and the standing clear-log question stay as
// they are, and nothing re-takes the snapshot but `show` and `refresh`.

import { el, setText, shortHex } from '../dom';
import {
  takeSnapshot,
  type SnapshotSeams,
  type DebugSnapshot,
} from './debug-snapshot';
import { buildDebugFile } from './debug-file';
import { DEBUG_LOG_BYTES, type DebugLog } from './debug-log';

/** The debug seam main.ts composes and the App takes (WEB_INTERFACE → The
 *  settings window → "The debug row", → The extension → "The snapshot").
 *  `seams` is the snapshot's sub-seams the App adds its own reader to at the
 *  moment a snapshot is taken; `log` is the log's clear/list the row calls
 *  for its *clear log* and the saved file's events; `download` is the
 *  App's file save the row hands the file's text and name to. */
export interface DebugSeam {
  seams: Omit<SnapshotSeams, 'reader'>;
  log: Pick<DebugLog, 'clear' | 'list'>;
  download: (filename: string, text: string) => void;
}

/** The arguments `debugRow` takes. `reader` is the App's own — added into
 *  the full `SnapshotSeams` at the moment of a snapshot, so the reader part
 *  reads the App's state as it is then. `now` is the clock the file's name
 *  and its recorded `savedAt` are formed from. */
export interface DebugRowDeps {
  seam: DebugSeam;
  reader: SnapshotSeams['reader'];
  now: () => number;
}

/** Build the row the settings body appends. The HTMLElement is one node
 *  from the body's build to the window's close; its own state (open, the
 *  box, a standing clear-log question) lives in the closure. */
export function debugRow(deps: DebugRowDeps): HTMLElement {
  const row = el('div', 'row debug-row');
  row.appendChild(el('label', null, 'debug'));
  const field = el('div', 'field');
  row.appendChild(field);

  const toggle = el('button', 'word', 'show') as HTMLButtonElement;
  toggle.type = 'button';
  field.appendChild(toggle);

  const body = el('div', 'debug-body');
  let open = false;
  let ticked = false;
  let snapshot: DebugSnapshot | null = null;
  let askingClear = false;

  // WEB_INTERFACE → The extension → "The debug file" — one function takes
  // the snapshot; `takeAndRender` (the row's `show` and `refresh`) and the
  // `save as file` click handler both use it, and only the save reads the
  // log's `list`, beside it. The row's log line reads the log's `stats`
  // from the snapshot.
  const takeSnap = (): Promise<DebugSnapshot> => {
    const full: SnapshotSeams = { ...deps.seam.seams, reader: deps.reader };
    return takeSnapshot(full);
  };

  const takeAndRender = async (): Promise<void> => {
    snapshot = await takeSnap();
    render();
  };

  const render = (): void => {
    body.replaceChildren();
    askingClear = false;
    if (snapshot === null) return;
    body.appendChild(renderLines(snapshot));
    body.appendChild(renderInclude());
    body.appendChild(renderControls());
  };

  const renderLines = (snap: DebugSnapshot): HTMLElement => {
    const lines = el('div', 'debug-lines');
    if ('error' in snap.build) {
      lines.appendChild(muted(`build · ${snap.build.error}`));
    } else {
      const b = snap.build;
      lines.appendChild(valueLine('build', `${b.version} · ${b.commit} · ${b.network}`));
      lines.appendChild(valueLine('user agent', b.userAgent));
    }
    lines.appendChild(nodesBlock(snap));
    lines.appendChild(chainBlock(snap));
    lines.appendChild(logBlock(snap));
    return lines;
  };

  const renderInclude = (): HTMLElement => {
    const wrap = el('div', 'debug-include');
    const label = el('label', 'debug-include-label');
    const box = el('input') as HTMLInputElement;
    box.type = 'checkbox';
    box.checked = ticked;
    box.addEventListener('change', () => { ticked = box.checked; });
    label.appendChild(box);
    label.appendChild(el('span', null, ' include my key, name and transaction ids'));
    wrap.appendChild(label);
    return wrap;
  };

  const renderControls = (): HTMLElement => {
    const controls = el('div', 'debug-controls');

    const save = el('button', 'word', 'save as file') as HTMLButtonElement;
    save.type = 'button';
    save.addEventListener('click', () => {
      // WEB_INTERFACE → The extension → "The debug file" — "save as file
      // takes the snapshot and the events at the press, as `refresh` does,
      // and the row shows that snapshot after it". The press takes the
      // snapshot through the same `takeSnap` the row's `refresh` uses and
      // reads the log's events beside it, then hands the file to the
      // caller's download with a `savedAt` of the same moment.
      void (async () => {
        const [snap, evs] = await Promise.all([takeSnap(), deps.seam.log.list()]);
        snapshot = snap;
        const now = deps.now();
        const file = buildDebugFile({
          snapshot: snap, events: evs, identifying: ticked, savedAt: now, nowMs: now,
        });
        deps.seam.download(file.filename, file.text);
        render();
      })();
    });
    controls.appendChild(save);

    const clear = el('button', 'word', 'clear log') as HTMLButtonElement;
    clear.type = 'button';
    clear.addEventListener('click', () => { startClearAsk(); });
    controls.appendChild(clear);

    const refresh = el('button', 'word', 'refresh') as HTMLButtonElement;
    refresh.type = 'button';
    refresh.addEventListener('click', () => { void takeAndRender(); });
    controls.appendChild(refresh);

    return controls;
  };

  const startClearAsk = (): void => {
    if (askingClear) return;
    askingClear = true;
    const wrap = el('div', 'debug-clear-ask');
    wrap.appendChild(el('span', null, 'clear the log?'));
    const back = (): void => {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      askingClear = false;
    };
    const confirm = el('button', 'word', 'clear') as HTMLButtonElement;
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      void deps.seam.log.clear().finally(() => { back(); void takeAndRender(); });
    });
    const keep = el('button', 'word', 'keep') as HTMLButtonElement;
    keep.type = 'button';
    keep.addEventListener('click', back);
    wrap.appendChild(confirm);
    wrap.appendChild(keep);
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') back();
    });
    body.appendChild(wrap);
    keep.focus();
  };

  const muted = (text: string): HTMLElement => {
    const line = el('div', 'debug-line');
    line.appendChild(el('span', 'inkmute', text));
    return line;
  };

  const valueLine = (label: string, value: string): HTMLElement => {
    const line = el('div', 'debug-line');
    line.appendChild(el('span', 'debug-label inkmute', label + ' '));
    line.appendChild(copyControl(value));
    return line;
  };

  // A press copies `value`; the control shows `shown`, the value itself unless
  // a line shortens it.
  const copyControl = (value: string, shown: string = value): HTMLSpanElement => {
    const span = el('span', 'debug-value') as HTMLSpanElement;
    let copied = false;
    const btn = el('button', 'word mono debug-copy') as HTMLButtonElement;
    btn.type = 'button';
    btn.textContent = shown;
    btn.setAttribute('aria-label', 'copy ' + shown);
    const fallback = (): void => {
      if (!btn.parentNode) return;
      const monoNode = el('span', 'mono', value);
      const hand = el('span', null, ' — copy it by hand');
      btn.replaceWith(monoNode, hand);
    };
    btn.addEventListener('click', () => {
      if (copied) return;
      if (typeof navigator.clipboard?.writeText !== 'function') {
        fallback();
        return;
      }
      navigator.clipboard.writeText(value).then(
        () => {
          copied = true;
          btn.appendChild(el('span', 'debug-copy-note inkmute', ' copied'));
        },
        fallback,
      );
    });
    span.appendChild(btn);
    return span;
  };

  const nodesBlock = (snap: DebugSnapshot): HTMLElement => {
    const block = el('div', 'debug-block');
    block.appendChild(el('div', 'debug-head inkmute', 'nodes'));
    if ('error' in snap.mesh) {
      block.appendChild(muted(snap.mesh.error));
      return block;
    }
    const state = snap.mesh.state;
    const diag = snap.mesh.diagnostics;
    if (state.nodes.length === 0) {
      block.appendChild(muted('(no nodes)'));
    } else {
      for (const node of state.nodes) {
        const line = el('div', 'debug-line');
        line.appendChild(copyControl(node.notisId, shortHex(node.notisId, 16)));
        const conn = diag.connections.find((c) => c.peer === node.notisId);
        // WEB_INTERFACE → The settings window → "The debug row" — "over FIPS
        // `fips · through` the node its link rides"; every other transport
        // reads `<transport> · <path>`.
        const reach = conn !== undefined
          ? (conn.transport === 'fips' && node.via !== null && node.via !== undefined
              ? `fips · through ${shortHex(node.via, 16)}`
              : `${conn.transport ?? 'none'} · ${conn.path ?? 'none'}`)
          : node.api !== null ? node.api : 'not reached';
        line.appendChild(el('span', 'inkmute', ` · ${reach} · ${node.status}`));
        if (node.readMs !== null) line.appendChild(el('span', 'inkmute', ` · ${Math.round(node.readMs)} ms`));
        // WEB_INTERFACE → The settings window → "The debug row" — "a node
        // found at an access point reading `found on this network`".
        if (node.local === true) {
          line.appendChild(el('span', 'inkmute', ' · found on this network'));
        }
        block.appendChild(line);
      }
    }
    // WEB_INTERFACE → The settings window → "The debug row" — "the last
    // read of the access point's identity URL — `not looked up`,
    // `nothing answered`, `refused` or `found`".
    const last = state.localLookup.last;
    const word = last === null
      ? 'not looked up'
      : last.result === 'failed'
      ? 'nothing answered'
      : last.result === 'refused'
      ? 'refused'
      : 'found';
    block.appendChild(muted(`local lookup · ${word}`));
    return block;
  };

  const chainBlock = (snap: DebugSnapshot): HTMLElement => {
    const block = el('div', 'debug-block');
    block.appendChild(el('div', 'debug-head inkmute', 'chain'));
    if ('error' in snap.mesh) {
      block.appendChild(muted('chain · (no mesh)'));
      return block;
    }
    const state = snap.mesh.state;
    const tip = state.tip;
    if (tip !== null) {
      const line = el('div', 'debug-line');
      line.appendChild(el('span', 'inkmute', 'tip '));
      line.appendChild(el('span', 'mono', String(tip.height)));
      if (tip.hash !== null) {
        line.appendChild(el('span', null, ' · '));
        line.appendChild(copyControl(tip.hash));
      }
      block.appendChild(line);
    } else {
      block.appendChild(muted('tip · (none yet)'));
    }
    if (!('error' in snap.reader) && snap.reader.lastTipRun !== null) {
      const verdict = snap.reader.lastTipRun['verdict'];
      if (typeof verdict === 'string') block.appendChild(valueLine('verdict', verdict));
    }
    if (state.agreement !== null) {
      const ag = state.agreement;
      block.appendChild(muted(`agreement · ${ag.onChain} on · ${ag.offChain} off`));
    }
    return block;
  };

  const logBlock = (snap: DebugSnapshot): HTMLElement => {
    const block = el('div', 'debug-block');
    block.appendChild(el('div', 'debug-head inkmute', 'log'));
    if ('error' in snap.log) {
      block.appendChild(muted(snap.log.error));
      return block;
    }
    const log = snap.log;
    if (log.unavailable) {
      block.appendChild(muted('the browser gives this page no log.'));
      return block;
    }
    block.appendChild(muted(`${log.events} events · ${log.bytes} / ${DEBUG_LOG_BYTES} bytes`));
    return block;
  };

  toggle.addEventListener('click', () => {
    if (open) {
      open = false;
      snapshot = null;
      ticked = false;
      askingClear = false;
      setText(toggle, 'show');
      if (body.parentNode === field) field.removeChild(body);
      return;
    }
    open = true;
    ticked = false;
    setText(toggle, 'hide');
    field.appendChild(body);
    void takeAndRender();
  });

  return row;
}
