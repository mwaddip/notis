// The extension's seams built on a mesh client (WEB_INTERFACE → The extension
// → "The mesh is the extension's first path"). `createMeshSeams` takes a
// started client and answers the seven seams the App needs: the read client
// reads at the client's own base; the write client walks the client's order
// for a tip write; the tip verifier awaits one check and answers the
// verdict and the anchor off the client's state; the figures and names
// verifiers run against `client.base('tip')` through `client.fetch`; the
// post resolver walks `client.order('older')` through the same fetch; and
// the hand-added-node seam reads the stored address, parses a new one as a
// multiaddr ending in `/p2p/<peer id>`, and calls the client's
// `addByHand`/`removeByHand`.
//
// This module is pure wiring. `main.ts`'s extension branch starts the
// client, kicks the first check without awaiting it, listens on `pagehide`
// to stop, and hands the seams to the App.

import { NodeClient } from '../api/client.js';
import { WriteClient, type WriteObserver } from '../api/write.js';
import { HAND_NODE_KEY, HAND_NODE_OFF_KEY, SERVE_KEY } from './storage-keys.js';
import { LOCAL_IDENTITY_URL } from '../mesh/local-lookup.js';
import { createMeshTipVerifier } from './mesh-tip-verifier.js';
import { createFiguresVerifier } from './figures-verifier.js';
import { createNamesVerifier } from './names-verifier.js';
import { createPostResolver } from './post-resolver.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { notisIdFromPeerId } from '@dagsocial/net/browser';
import { profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';
import type { PostCheck } from '@dagsocial/nipopow-client';
import { createMeshMemoryStore, type MemorySnapshot } from '../mesh/memory-store.js';
import { continues as proofContinues } from '../mesh/memory.js';
import { decodeNipopowProof } from '@dagsocial/nipopow';
import type { Anchor, FiguresResult, Listing, NameClaim, NameResult } from '@dagsocial/nipopow-client';
import type { MeshClient, MeshContact, MeshEvent, StartMeshClientOptions, StorageLike } from '../mesh/index.js';
import type { HttpFetch } from '@dagsocial/node-reads';
import type { PostTextProvider } from '@dagsocial/net/browser';
import type { TipRun } from '../model/state.js';
import { routeShape, type DebugEventKind, type DebugLog } from './debug-log.js';
export type { StorageLike };
import type {
  FiguresVerifier,
  NamesVerifier,
  PostResolver,
  TipVerifier,
} from '../model/state.js';
import type { HandNodeSeam, ServeSeam } from '../view/settings.js';

/** The seams the App's extension build takes. */
export interface MeshSeams {
  readClient: NodeClient;
  writeClient: WriteClient;
  tipVerifier: TipVerifier;
  figuresVerifier: FiguresVerifier;
  namesVerifier: NamesVerifier;
  postResolver: PostResolver;
  handNodeSeam: HandNodeSeam;
  serveSeam: ServeSeam;
}

export interface CreateMeshSeamsOptions {
  client: MeshClient;
  network: NetworkType;
  check: (rows: unknown[]) => PostCheck[];
  /** The storage the hand-added-node address is held in. */
  storage: StorageLike;
  /** The log the write client's walk observer writes `write` events into
   *  (WEB_INTERFACE → The extension → "The debug log"). The extension build
   *  hands one; tests that bypass the debug record path omit it. */
  debugLog?: DebugLog;
}

/** Parses an address as a multiaddr ending in `/p2p/<peer id>` with no DNS
 *  component. Returns `{ notisId, addr }` on success or `{ error }` with the
 *  line to show beside the field. */
export function parseHandNodeAddress(input: string): { notisId: string; addr: string } | { error: string } {
  const addr = input.trim();
  if (addr === '') return { error: 'the address is blank' };
  if (addr.includes('/dns4/') || addr.includes('/dns6/') || addr.includes('/dnsaddr/')) {
    return { error: 'addresses with DNS names are not accepted' };
  }
  const m = /\/p2p\/([^/]+)$/.exec(addr);
  if (!m) return { error: 'address must end in /p2p/<peer id>' };
  let notisId: string;
  try {
    notisId = notisIdFromPeerId(peerIdFromString(m[1]!));
  } catch {
    return { error: 'peer id is not a Notis key' };
  }
  return { notisId, addr };
}

export function createMeshSeams(opts: CreateMeshSeamsOptions): MeshSeams {
  const client = opts.client;
  const fetch: HttpFetch = client.fetch;

  const readClient = new NodeClient({
    base: () => client.base('tip') ?? '',
    fetch,
  });
  const writeClient = new WriteClient({
    bases: () => client.order('tip'),
    fetch,
    ...(opts.debugLog !== undefined ? { observer: makeWriteObserver(opts.debugLog) } : {}),
  });
  const tipVerifier = createMeshTipVerifier({ client });

  const figuresInner = createFiguresVerifier({ network: opts.network, fetch });
  const figuresVerifier: FiguresVerifier = {
    run(_readingBase, user, listing, anchor) {
      // WEB_INTERFACE → The extension → "The verified figures" — "the run's
      // every read to that one base". The seam overrides the App's
      // readingBase so figures proofs go to `client.base('tip')` for the
      // whole run.
      return figuresInner.run(client.base('tip') ?? '', user, listing, anchor);
    },
  };

  const namesInner = createNamesVerifier({ fetch });
  const namesVerifier: NamesVerifier = {
    run(_readingBase, claim, anchor) {
      return namesInner.run(client.base('tip') ?? '', claim, anchor);
    },
  };

  const postResolver = createPostResolver({
    nodes: () => client.order('older'),
    fetch: fetch as unknown as typeof globalThis.fetch,
    check: opts.check,
  });

  const handNodeSeam: HandNodeSeam = {
    address(): string {
      return opts.storage.getItem(HAND_NODE_KEY) ?? '';
    },
    commit(input: string): string | null {
      const trimmed = input.trim();
      if (trimmed === '') {
        const old = opts.storage.getItem(HAND_NODE_KEY);
        if (old !== null) {
          const parsed = parseHandNodeAddress(old);
          if ('notisId' in parsed) {
            try { client.removeByHand(parsed.notisId); } catch { /* malformed stored id; drop anyway */ }
          }
          opts.storage.removeItem(HAND_NODE_KEY);
        }
        return null;
      }
      const parsed = parseHandNodeAddress(trimmed);
      if ('error' in parsed) return parsed.error;
      // Remove the prior stored address's entry so a swap leaves no stale key.
      const old = opts.storage.getItem(HAND_NODE_KEY);
      if (old !== null && old !== trimmed) {
        const oldParsed = parseHandNodeAddress(old);
        if ('notisId' in oldParsed && oldParsed.notisId !== parsed.notisId) {
          try { client.removeByHand(oldParsed.notisId); } catch { /* ignore */ }
        }
      }
      try {
        client.addByHand(parsed.notisId, [parsed.addr], true);
      } catch (e) {
        return (e as Error).message;
      }
      opts.storage.setItem(HAND_NODE_KEY, trimmed);
      return null;
    },
    off(): boolean {
      return opts.storage.getItem(HAND_NODE_OFF_KEY) === '1';
    },
    setOff(off: boolean): void {
      // WEB_INTERFACE → The settings window → "The reader may switch it off".
      // Off: the key is written and the entry removed from the client's list.
      // On: the key is cleared and the stored address is re-added as a
      // trusted by-hand node.
      const stored = opts.storage.getItem(HAND_NODE_KEY);
      if (off) {
        opts.storage.setItem(HAND_NODE_OFF_KEY, '1');
        if (stored !== null) {
          const parsed = parseHandNodeAddress(stored);
          if ('notisId' in parsed) {
            try { client.removeByHand(parsed.notisId); } catch { /* ignore */ }
          }
        }
        return;
      }
      opts.storage.removeItem(HAND_NODE_OFF_KEY);
      if (stored !== null) {
        const parsed = parseHandNodeAddress(stored);
        if ('notisId' in parsed) {
          try { client.addByHand(parsed.notisId, [parsed.addr], true); } catch { /* ignore */ }
        }
      }
    },
    answer(decision: 'continue' | 'disable'): void {
      // MESH_INTERFACE → Discovery → "A disagreement is the reader's
      // question, never the client's choice". *disable* also writes the off
      // key, so a page that loads next starts without the node until the
      // reader turns it on.
      client.answer(decision);
      if (decision === 'disable') {
        opts.storage.setItem(HAND_NODE_OFF_KEY, '1');
      }
    },
  };

  const serveSeam: ServeSeam = {
    on(): boolean {
      // WEB_INTERFACE → The settings window → "The serve row": `'1'` while
      // on, any other value or none off.
      return opts.storage.getItem(SERVE_KEY) === '1';
    },
    set(on: boolean): void {
      // WEB_INTERFACE → The settings window → "The serve row": a press that
      // changes it writes the choice and redials every node at once
      // (MESH_INTERFACE → Block gossip → "A client that serves answers the
      // nodes it reads"). `client.setServing` closes every connection the
      // client holds and dials again so each new handshake declares the
      // new set.
      if (on) {
        opts.storage.setItem(SERVE_KEY, '1');
      } else {
        opts.storage.removeItem(SERVE_KEY);
      }
      void client.setServing(on);
    },
  };

  return { readClient, writeClient, tipVerifier, figuresVerifier, namesVerifier, postResolver, handNodeSeam, serveSeam };
}

/** The extension's bootstrap: starts the mesh client, kicks the first check
 *  without awaiting it, listens on `pagehide` to stop, re-adds a stored
 *  hand-added address as a trusted by-hand node, and builds the seams. `main.ts`
 *  calls this with the real `startMeshClient`; tests pass a fake.
 *
 *  `window` is the page's own; a `pagehide` on it stops the client once. */
export interface StartExtensionMeshOptions {
  firstContact: MeshContact[];
  network: NetworkType;
  agentName: string;
  httpFetch: HttpFetch;
  check: (rows: unknown[]) => PostCheck[];
  storage: StorageLike;
  /**
   * The Web Lock manager the memory store runs its read-then-write under
   * (`WEB_INTERFACE → The extension → "What the extension remembers"`).
   * `main.ts` wraps `navigator.locks` as it does for the waiting seam;
   * Node tests pass a seam that runs `fn` straight through.
   */
  locks: { request(name: string, fn: () => Promise<void>): Promise<void> };
  window: Pick<Window, 'addEventListener'>;
  startMeshClient: (o: StartMeshClientOptions) => Promise<MeshClient>;
  /**
   * WEB_INTERFACE → The settings window → "The serve row",
   * → The extension → "The post cache" → "A serving read is answered from
   * it". The provider the serving reader answers `ModifierRequest` from —
   * `postTextsFromCache(postCache)` in the extension build. The start
   * reads `SERVE_KEY` from storage and passes `serving: { on, texts }` to
   * `startMeshClient`.
   */
  postTexts: PostTextProvider;
  /**
   * WEB_INTERFACE → The extension → "The debug log" — the page's own log.
   * The start builds the mesh client's events sink over it, tees the mesh
   * client's log lines through it as `error` events naming the mesh
   * client, and wraps the three verifiers so a run's ending records a
   * `verdict` event carrying the run's answer field by field.
   */
  debugLog: DebugLog;
}

export async function startExtensionMesh(
  opts: StartExtensionMeshOptions,
): Promise<{ client: MeshClient; seams: MeshSeams }> {
  const profile = profileFor(opts.network);
  // WEB_INTERFACE → The extension → "What the extension remembers",
  // MESH_INTERFACE → What the client remembers — one record per network,
  // read at load and written after every check through one lock.
  const store = createMeshMemoryStore({
    storage: opts.storage,
    locks: opts.locks,
    network: opts.network,
    // Each proof decodes alone: a stored proof that does not decode answers
    // `true`, so the next snapshot's proof replaces it (MESH_INTERFACE →
    // What the client remembers); a next proof that does not decode answers
    // `false`, so the kept one stands. The comparison itself runs outside
    // every catch — a decode that succeeded both ways carries no failure
    // mode `proofContinues` is total against.
    continues: (kept, next) => {
      let keptProof;
      try {
        keptProof = decodeNipopowProof(kept);
      } catch {
        return true;
      }
      let nextProof;
      try {
        nextProof = decodeNipopowProof(next);
      } catch {
        return false;
      }
      return proofContinues(keptProof, nextProof, profile, Date.now());
    },
  });
  // A record kept under another pinned genesis is cleared and the page
  // starts as a first-time client (MESH_INTERFACE → What the client
  // remembers — "A client remembers, per network, … keyed by the genesis
  // the network's profile pins"). An unpinned profile reads the record
  // without that check; `write` keeps the genesis coherent going forward.
  let stored = store.read();
  if (stored !== null && profile.genesisId !== '' && stored.genesis !== profile.genesisId) {
    store.clear();
    stored = null;
  }
  // The `onChecked` callback reads the mesh client back through this
  // closure; the client is known once `startMeshClient` resolves.
  let seatedClient: MeshClient | null = null;
  const debugLog = opts.debugLog;
  const startOpts: StartMeshClientOptions = {
    firstContact: opts.firstContact,
    network: opts.network,
    profile,
    agentName: opts.agentName,
    httpFetch: opts.httpFetch,
    // WEB_INTERFACE → The extension → "The mesh client's faults reach the
    // page's console". Each line is also written as an `error` event in the
    // debug log, naming the mesh client as its source
    // (→ "The debug log" — "each line the mesh client logs").
    log: (line) => {
      console.error(line);
      debugLog.record('error', { source: 'mesh-client', message: line });
    },
    // WEB_INTERFACE → The extension → "The debug log" — the mesh client's
    // sink records each report under its own kind; a `request` is stored
    // with the node (the mesh URL's id, or the API base's origin) and
    // `routeShape`'s path and query in the URL's place, never the URL
    // (→ "What the log never holds").
    events: makeDebugSink(debugLog),
    onChecked: (snapshot: MemorySnapshot) => {
      const chain = seatedClient !== null ? seatedClient.state().chain : null;
      const genesis = profile.genesisId !== '' ? profile.genesisId : chain;
      if (genesis === null) return;
      // A failed write is logged here — the store's inner work runs under
      // the lock, and a rejection is surfaced where the page can see it,
      // never thrown into the check path that fired it.
      store.write(snapshot, genesis).catch((reason: unknown) => {
        console.error('notis.mesh.memory: write rejected', reason);
      });
    },
  };
  if (stored !== null) {
    startOpts.seeds = stored.nodes;
    startOpts.memory = {
      proof: base64ToBytes(stored.proof),
      answered: stored.answered,
    };
  }
  // WEB_INTERFACE → The settings window → "The serve row": the reader's
  // choice is read at the mesh client's start and declares the serving
  // reader's capabilities on the first handshake.
  startOpts.serving = {
    on: opts.storage.getItem(SERVE_KEY) === '1',
    texts: opts.postTexts,
  };
  // WEB_INTERFACE → The extension → "The extension looks for an access
  // point's node". The client reads `LOCAL_IDENTITY_URL` at the end of
  // a check in which no node answered.
  startOpts.localLookup = { url: LOCAL_IDENTITY_URL };
  // WEB_INTERFACE → The extension → "The mesh is the extension's first
  // path" — the reader runs a FIPS node (MESH_INTERFACE → FIPS →
  // "A reader links when a node's every other address failed"), so a node
  // whose other addresses failed is reached over FIPS through a connection
  // the reader holds.
  startOpts.fips = true;
  const client = await opts.startMeshClient(startOpts);
  seatedClient = client;
  // The App starts at once — the first check never blocks a read
  // (WEB_INTERFACE → The extension → "The mesh is the extension's first
  // path"). The check is kicked here.
  void client.check();
  // Pagehide stops the client — one stop per page.
  const stopOnHide = (): void => { void client.stop(); };
  opts.window.addEventListener('pagehide', stopOnHide, { once: true });
  // A stored hand-added address is re-added as a trusted by-hand node after
  // start — unless the reader has switched it off (WEB_INTERFACE → The
  // settings window → "The reader may switch it off"). A page that starts
  // with the off key set does not add the node.
  const handAddr = opts.storage.getItem(HAND_NODE_KEY);
  const handOff = opts.storage.getItem(HAND_NODE_OFF_KEY) === '1';
  if (handAddr !== null && !handOff) {
    const parsed = parseHandNodeAddress(handAddr);
    if ('notisId' in parsed) {
      try { client.addByHand(parsed.notisId, [parsed.addr], true); } catch { /* malformed; ignore */ }
    }
  }
  const seams = createMeshSeams({
    client,
    network: opts.network,
    check: opts.check,
    storage: opts.storage,
    debugLog,
  });
  // WEB_INTERFACE → The extension → "The debug log" — each of the three
  // verifiers records a `verdict` event at its run's ending, carrying the
  // run's answer read field by field: never the posts, names or amounts it
  // proved.
  const wrappedSeams: MeshSeams = {
    ...seams,
    tipVerifier: wrapTipVerifier(seams.tipVerifier, debugLog),
    figuresVerifier: wrapFiguresVerifier(seams.figuresVerifier, debugLog),
    namesVerifier: wrapNamesVerifier(seams.namesVerifier, debugLog),
  };
  return { client, seams: wrappedSeams };
}

/** Sink: writes each mesh event to the debug log. `request` is transformed —
 *  no 64-hex run reaches the store — and every other kind is stored under
 *  its own kind with its fields. */
function makeDebugSink(debugLog: DebugLog): (e: MeshEvent) => void {
  return (e) => {
    if (e.kind === 'request') {
      const shape = routeShape(e.url);
      const node = nodeOfRequestUrl(e.url);
      const fields: Record<string, unknown> = {
        number: e.number,
        route: e.route,
        node,
        path: shape.path,
        query: shape.query,
        head: e.head,
      };
      if (e.connection !== undefined) fields['connection'] = e.connection;
      debugLog.record('request', fields);
      return;
    }
    // Every other event records every field but `kind`. The sink stamps
    // `t` and `page` from the log's seams; `kind` is the second argument.
    const { kind, ...rest } = e as unknown as { kind: DebugEventKind } & Record<string, unknown>;
    debugLog.record(kind, rest);
  };
}

/** For a request URL, the node the request went to:
 *   • `notis-mesh://<id>/…` → the Notis id (32-byte key hex).
 *   • `http[s]://host[:port]/…` → the URL's origin.
 *  A URL the `URL` constructor refuses answers the empty string; nothing
 *  else can reach the sink. */
function nodeOfRequestUrl(url: string): string {
  if (url.startsWith('notis-mesh://')) {
    const rest = url.substring('notis-mesh://'.length);
    const slash = rest.indexOf('/');
    return slash === -1 ? rest : rest.substring(0, slash);
  }
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function wrapTipVerifier(inner: TipVerifier, debugLog: DebugLog): TipVerifier {
  return {
    async run(): Promise<TipRun> {
      const t0 = Date.now();
      const r = await inner.run();
      debugLog.record('verdict', {
        run: 'tip',
        ms: Date.now() - t0,
        verdict: r.verdict,
      });
      return r;
    },
  };
}

function wrapFiguresVerifier(inner: FiguresVerifier, debugLog: DebugLog): FiguresVerifier {
  return {
    async run(readingBase: string, user: string, listing: Listing, anchor: Anchor): Promise<FiguresResult> {
      const t0 = Date.now();
      const r = await inner.run(readingBase, user, listing, anchor);
      // The event carries each ledger's holdings status, the record's
      // status, the heightAfter and the `failed` flag — never a box's
      // value, lock, id or the identity record's bytes.
      debugLog.record('verdict', {
        run: 'figures',
        ms: Date.now() - t0,
        karma: r.karma.holdings,
        credits: r.credits.holdings,
        record: r.record.status,
        heightAfter: r.heightAfter,
        failed: r.failed,
      });
      return r;
    },
  };
}

function wrapNamesVerifier(inner: NamesVerifier, debugLog: DebugLog): NamesVerifier {
  return {
    async run(readingBase: string, claim: NameClaim, anchor: Anchor): Promise<NameResult> {
      const t0 = Date.now();
      const r = await inner.run(readingBase, claim, anchor);
      // The event carries only the check's status — no owner, no name, no
      // boxId, no verdict sentence (it may hold a name or an owner).
      debugLog.record('verdict', {
        run: 'names',
        ms: Date.now() - t0,
        status: r.status,
      });
      return r;
    },
  };
}

/**
 * Base64 (standard, with padding) to bytes. The store keeps the kept
 * proof as base64; the seam hands bytes to the mesh client, which decodes
 * them again under its constructor's rules. `atob` sits in the DOM lib
 * and under vitest alike (`MESH_INTERFACE → Place in the workspace`).
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The write observer the extension hands the write client — one `write`
 *  event per walk's ending (WEB_INTERFACE → The extension → "The debug log").
 *  `route` and `query` are `routeShape`'s, `node` the request URL's node as
 *  the `request` events name it, and the URL itself never reaches the store. */
function makeWriteObserver(debugLog: DebugLog): WriteObserver {
  return (ending): void => {
    const shape = ending.url !== '' ? routeShape(ending.url) : { path: '', query: {} };
    const node = ending.url !== '' ? nodeOfRequestUrl(ending.url) : null;
    const fields: Record<string, unknown> = {
      route: shape.path,
      query: shape.query,
      node,
      tried: ending.tried,
      status: ending.status,
    };
    if (ending.message !== undefined) fields['message'] = ending.message;
    if (ending.noAnswer) fields['noAnswer'] = true;
    if (ending.txId !== undefined) fields['txId'] = ending.txId;
    debugLog.record('write', fields);
  };
}
