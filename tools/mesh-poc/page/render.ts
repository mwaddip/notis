// MESH_INTERFACE → What the client remembers / Discovery / The client's node
// list — pure DOM rendering of a `ClientState`: the stage reads `<pre
// id="state">`, the tester reads the rest.
//
// Every string from a node — `notisId`, `addrs`, `droppedAddrs`,
// `evidence.detail`, `lastLeft.reason`, the disagreement's hashes —
// reaches the tree through `textContent`; no `innerHTML` and no
// `document.write`, so a hostile node's `detail` (`<img src=x
// onerror=alert(1)>`, the contract's lie row) stays a string. Pure, no
// fetch, no timer; the caller drives re-renders.

import type { ClientState } from '@dagsocial/web/mesh';
import type { NodeEntry } from '@dagsocial/web/mesh';
import type { Disagreement, MeshClient } from '@dagsocial/web/mesh';

// MESH_INTERFACE → What the client remembers → "When no node continues
// it" — the words the page says when `notContinued` is true, byte for
// byte.
const NOT_CONTINUED_WORDS = 'No node reached continues the chain you verified.';

// MESH_INTERFACE → Discovery → "A disagreement is the reader's question,
// never the client's choice" — the two message forms, byte for byte,
// read against `disagreement.which`.
const DISAGREEMENT_MEMORY =
  'your node serves a chain that does not continue the one you verified. It may be compromised.';
const DISAGREEMENT_HEAVIER =
  'another node serves a heavier chain than your node. Your node may be compromised.';

export interface RenderOptions {
  /**
   * MESH_INTERFACE → Discovery → "A disagreement is the reader's
   * question, never the client's choice" — the two buttons the page
   * shows while a disagreement stands each call `client.answer` once.
   * `null` means no client is bound and the buttons are omitted (e.g.
   * a cold snapshot render in a case). The page wires this with the
   * running client; a test may bind a stub whose `answer` records the
   * call.
   */
  client: Pick<MeshClient, 'answer'> | null;
}

const DEFAULT_OPTS: RenderOptions = { client: null };

export function render(
  state: ClientState,
  root: HTMLElement,
  opts: RenderOptions = DEFAULT_OPTS,
): void {
  // MESH_INTERFACE → Acceptance 1 — the mesh's answers equal the node's
  // direct HTTP answers byte for byte, and the stage's CDP reads `<pre
  // id="probe">` for that byte-for-byte check. The state renderer owns
  // one subtree under `#root` (a `<div data-role="state-root">`) and
  // the probe owns `<pre id="probe">` as a sibling; a render replaces
  // its own container's children, leaving the probe in place.
  let container = root.querySelector(':scope > [data-role="state-root"]') as HTMLElement | null;
  if (container === null) {
    container = document.createElement('div');
    container.setAttribute('data-role', 'state-root');
    // Insert at the top so a later `<pre id="probe">` stays after the
    // state's own subtree in the DOM.
    root.insertBefore(container, root.firstChild);
  } else {
    while (container.firstChild !== null) container.removeChild(container.firstChild);
  }

  // MESH_INTERFACE → What the client remembers → "The agreement counts"
  // — sits above the banners; before the first check (`agreement ===
  // null`) it reads `On this chain: —`.
  container.appendChild(renderAgreement(state));

  // MESH_INTERFACE → Discovery → "A disagreement is the reader's
  // question, never the client's choice" — a standing disagreement
  // shows its words and two buttons, each calling `client.answer`
  // once. The banner for `notContinued` is shown only when no
  // disagreement stands — a disagreement already names a question the
  // reader has to answer.
  if (state.disagreement !== null) {
    container.appendChild(renderDisagreement(state.disagreement, opts.client));
  } else if (state.notContinued) {
    const banner = document.createElement('div');
    banner.setAttribute('data-role', 'banner');
    banner.textContent = NOT_CONTINUED_WORDS;
    container.appendChild(banner);
  }

  container.appendChild(renderInUse(state));
  container.appendChild(renderLastLeft(state));
  container.appendChild(renderTip(state));
  container.appendChild(renderTraffic(state));
  container.appendChild(renderNodes(state));

  // MESH_INTERFACE → Acceptance — the stage reads `#state`, no global.
  const pre = document.createElement('pre');
  pre.id = 'state';
  pre.textContent = JSON.stringify(state);
  container.appendChild(pre);
}

function renderAgreement(state: ClientState): HTMLElement {
  // MESH_INTERFACE → What the client remembers → "The agreement counts"
  // — the page shows `On this chain` and `Not on this chain's last 20
  // blocks` after each check; before the first check it reads `On this
  // chain: —`.
  const div = document.createElement('div');
  div.setAttribute('data-role', 'agreement');
  if (state.agreement === null) {
    div.textContent = 'On this chain: —';
  } else {
    const { onChain, offChain } = state.agreement;
    div.textContent =
      `On this chain: ${String(onChain)}`
      + ` · Not on this chain's last 20 blocks: ${String(offChain)}`;
  }
  return div;
}

function renderDisagreement(
  d: Disagreement,
  client: Pick<MeshClient, 'answer'> | null,
): HTMLElement {
  // MESH_INTERFACE → Discovery → "A disagreement is the reader's
  // question, never the client's choice" — the words, the two tips and
  // their fork, and the two buttons that call `client.answer`. The
  // `other` tip is `null` under `memory` (the kept chain is the other).
  const section = document.createElement('section');
  section.setAttribute('data-role', 'disagreement');

  const words = document.createElement('p');
  words.setAttribute('data-role', 'disagreement-words');
  words.textContent = d.which === 'memory' ? DISAGREEMENT_MEMORY : DISAGREEMENT_HEAVIER;
  section.appendChild(words);

  const dl = document.createElement('dl');
  dl.className = 'disagreement';
  appendPair(dl, 'which', d.which);
  appendPair(dl, 'yours height', String(d.yours.height));
  appendPair(dl, 'yours hash', d.yours.hash);
  if (d.other !== null) {
    appendPair(dl, 'other height', String(d.other.height));
    appendPair(dl, 'other hash', d.other.hash);
  }
  appendPair(dl, 'fork', d.fork);
  section.appendChild(dl);

  const buttons = document.createElement('div');
  buttons.setAttribute('data-role', 'disagreement-buttons');
  const cont = document.createElement('button');
  cont.type = 'button';
  cont.setAttribute('data-role', 'disagreement-continue');
  cont.textContent = 'continue on this node';
  const disable = document.createElement('button');
  disable.type = 'button';
  disable.setAttribute('data-role', 'disagreement-disable');
  disable.textContent = 'disable it';
  if (client !== null) {
    cont.addEventListener('click', () => { client.answer('continue'); });
    disable.addEventListener('click', () => { client.answer('disable'); });
  }
  buttons.appendChild(cont);
  buttons.appendChild(disable);
  section.appendChild(buttons);
  return section;
}

function renderInUse(state: ClientState): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-role', 'in-use');
  const h = document.createElement('h2');
  // MESH_INTERFACE → The client's node list → "A routed read goes to
  // a node its need allows" — the heading names the latest routed
  // read's node; the three rows keep their keys (the stage reads
  // them).
  h.textContent = 'Last read from';
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

function renderTraffic(state: ClientState): HTMLElement {
  // MESH_INTERFACE → Block gossip → "A refused block is evidence as
  // `net` weighs it" / The client's node list — the counts the client
  // keeps per check: how many nipopow proofs were read; the bytes it
  // read for the tip, each header, each proof and each gossip
  // message; and the number of blocks it forwarded on delivery.
  const section = document.createElement('section');
  section.setAttribute('data-role', 'traffic');
  const h = document.createElement('h2');
  h.textContent = 'Traffic';
  section.appendChild(h);
  const dl = document.createElement('dl');
  dl.className = 'in-use';
  const t = state.traffic;
  appendPair(dl, 'Proofs read', String(t.proofReads));
  appendPair(dl, 'tip', String(t.tipBytes));
  appendPair(dl, 'header', String(t.headerBytes));
  appendPair(dl, 'proof', String(t.proofBytes));
  appendPair(dl, 'gossip', String(t.gossipBytes));
  appendPair(dl, 'forwarded', String(t.forwarded));
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
  // MESH_INTERFACE → Discovery — every entry is one of four kinds; the
  // precedence is `yours > firstContact > known > discovered`, since a
  // yours entry is the reader's own trust assertion and a first-contact
  // one the client's build list, each a stronger claim than the DHT-
  // walked or peer-listed `known` one.
  meta.textContent = `${kindOf(n)} · status=${n.status} · failures=${String(n.failures)}`
    + ` · transport=${n.transport ?? 'none'} · path=${n.path ?? 'none'}`;
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

function kindOf(n: NodeEntry): string {
  if (n.yours) return 'yours';
  if (n.firstContact) return 'first contact';
  if (n.known) return 'known';
  return 'discovered';
}

function appendPair(dl: HTMLElement, key: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = key;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}
