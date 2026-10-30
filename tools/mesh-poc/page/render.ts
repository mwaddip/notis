// MESH_INTERFACE → No anchor reached / The client's node list — pure DOM
// rendering of a `ClientState`: the stage reads `<pre id="state">`,
// the tester reads the rest.
//
// Every string from a node — `notisId`, `addrs`, `droppedAddrs`,
// `evidence.detail`, `lastLeft.reason` — reaches the tree through
// `textContent`; no `innerHTML` and no `document.write`, so a hostile
// node's `detail` (`<img src=x onerror=alert(1)>`, the contract's lie
// row) stays a string. Pure, no fetch, no timer; the caller drives
// re-renders.

import type { ClientState } from '../src/client/mesh-client.js';
import type { NodeEntry } from '../src/client/node-list.js';

// MESH_INTERFACE → No anchor reached — the words the page says when
// `anchorReached` is false, byte-for-byte.
const NO_ANCHOR_WORDS = 'No anchor reached. Nothing shown here is verified.';

export function render(state: ClientState, root: HTMLElement): void {
  // Replace the whole subtree every call — the state is small, and a diff
  // between the stage's reads and the tester's view would widen the
  // surface the page's correctness rests on.
  while (root.firstChild !== null) root.removeChild(root.firstChild);

  if (!state.anchorReached) {
    const banner = document.createElement('div');
    banner.setAttribute('data-role', 'banner');
    banner.textContent = NO_ANCHOR_WORDS;
    root.appendChild(banner);
  }

  root.appendChild(renderInUse(state));
  root.appendChild(renderLastLeft(state));
  root.appendChild(renderTip(state));
  root.appendChild(renderNodes(state));

  // MESH_INTERFACE → Acceptance — the stage reads `#state`, no global.
  const pre = document.createElement('pre');
  pre.id = 'state';
  pre.textContent = JSON.stringify(state);
  root.appendChild(pre);
}

function renderInUse(state: ClientState): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-role', 'in-use');
  const h = document.createElement('h2');
  h.textContent = 'Node in use';
  section.appendChild(h);
  const dl = document.createElement('dl');
  dl.className = 'in-use';
  appendPair(dl, 'notisId', state.nodeId ?? 'none');
  appendPair(dl, 'transport', state.transport ?? 'none');
  appendPair(dl, 'path', state.path ?? 'none');
  section.appendChild(dl);
  return section;
}

function renderLastLeft(state: ClientState): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-role', 'last-left');
  const h = document.createElement('h2');
  h.textContent = 'Last left';
  section.appendChild(h);
  if (state.lastLeft === null) {
    const p = document.createElement('p');
    p.textContent = 'none';
    section.appendChild(p);
    return section;
  }
  const dl = document.createElement('dl');
  dl.className = 'in-use';
  appendPair(dl, 'notisId', state.lastLeft.nodeId);
  appendPair(dl, 'reason', state.lastLeft.reason);
  section.appendChild(dl);
  return section;
}

function renderTip(state: ClientState): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-role', 'tip');
  const h = document.createElement('h2');
  h.textContent = 'Tip';
  section.appendChild(h);
  if (state.tip === null) {
    const p = document.createElement('p');
    p.textContent = 'no tip yet';
    section.appendChild(p);
    return section;
  }
  const dl = document.createElement('dl');
  dl.className = 'in-use';
  appendPair(dl, 'height', String(state.tip.height));
  // The hash is `null` at the genesis marker (MESH_INTERFACE → The node
  // endpoint); render it as the word so a reader sees the shape.
  appendPair(dl, 'hash', state.tip.hash ?? 'null');
  section.appendChild(dl);
  return section;
}

function renderNodes(state: ClientState): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-role', 'nodes');
  const h = document.createElement('h2');
  h.textContent = 'Nodes';
  section.appendChild(h);
  const ul = document.createElement('ul');
  ul.className = 'nodes';
  for (const n of state.nodes) ul.appendChild(renderNode(n));
  section.appendChild(ul);
  return section;
}

function renderNode(n: NodeEntry): HTMLElement {
  const li = document.createElement('li');
  const idSpan = document.createElement('span');
  idSpan.className = 'id';
  idSpan.textContent = n.notisId;
  li.appendChild(idSpan);
  const meta = document.createElement('div');
  meta.className = 'meta';
  // Space-separated metadata the tester reads at a glance; textContent
  // keeps every value a string.
  meta.textContent = `${n.anchor ? 'anchor' : 'discovered'} · status=${n.status} · failures=${String(n.failures)}`;
  li.appendChild(meta);
  if (n.evidence !== null) {
    const ev = document.createElement('div');
    ev.className = 'evidence';
    // `detail` is a hostile node's string (MESH_INTERFACE → The client's
    // node list — lie row). textContent keeps it a string.
    ev.textContent = `evidence: kind=${n.evidence.kind} · detail=${n.evidence.detail}`;
    li.appendChild(ev);
  }
  // MESH_INTERFACE → The client's node list — "An entry keeps its last
  // failure's kind and message, for the page to show why a node is in
  // `retry`; the message is shown, never acted on." The message is a
  // libp2p / verifier string a hostile node has no control over, but
  // `textContent` is still what keeps it a string.
  if (n.lastFailure !== null && n.status === 'retry') {
    const lf = document.createElement('div');
    lf.className = 'last-failure';
    lf.textContent = `last failure: kind=${n.lastFailure.kind} · message=${n.lastFailure.message}`;
    li.appendChild(lf);
  }
  return li;
}

function appendPair(dl: HTMLElement, key: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = key;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}
