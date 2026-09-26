import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, type Context } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { build, type Plugin, type Rollup } from 'vite';
import {
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  PROTOCOL_VERSION,
  STORAGE_RENT_PER_BYTE,
  boxRecordBytes,
  bytesToHex,
  decodeTx,
  encodeOrderingBlock,
  encodeTx,
  profileFor,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  CreditBox,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';
import { applyBlock } from '@dagsocial/consensus';
import type { ApplyContext, ApplyResult } from '@dagsocial/consensus';
import { run } from './bundle-entry.js';
import { canonical, encodeScenario, viewOf, type Seed } from './bundle-scenario.js';
import {
  applyContextFor,
  burnTx,
  candidateBlock,
  changeOf,
  claimTx,
  consolidateTx,
  creditSendTx,
  finish,
  hex,
  identityRecord,
  inviteTx,
  karmaBox,
  likeTx,
  protocolBox,
  replyTx,
  seedProvenance,
  seededIdentity,
  threadTx,
  unvouchTx,
  vouchTx,
  withdrawTx,
  writeEffects,
  type Built,
  type TestIdentity,
} from './helpers.js';

/**
 * The bundle test (CONSENSUS_INTERFACE → Tests): `applyBlock` built for a
 * browser with vite, every Node built-in a module imports failing the build, and
 * the bundle run in a `vm` context holding the ECMAScript built-ins,
 * `TextEncoder` and `TextDecoder` alone — no `crypto`, so the run holds the
 * package's no-randomness rule too (CONSENSUS_INTERFACE → Applying a block).
 * Inside the context a chain of signed blocks is applied over a stub view, both
 * built there from primitives, and the results come back as one string that
 * must equal, byte for byte, what the same function answers from source under
 * Node.
 */

/** Each hook and test that runs a vite build carries this timeout, not vitest's default. */
const BUILD_TIMEOUT = 60_000;

const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = fileURLToPath(new URL('./bundle-entry.ts', import.meta.url));

// Every `@dagsocial/*` import resolves to that package's `src/index.ts`, the
// mapping every suite resolves by (ARCHITECTURE → Build and test resolution),
// so the bundle and the Node run execute one tree and no `dist` can make the
// comparison stale.
const WORKSPACE_ALIAS = Object.fromEntries(
  ['types', 'wire', 'validation', 'nipopow', 'consensus', 'net', 'node'].map((pkg) => [
    `@dagsocial/${pkg}`,
    `${PACKAGES_DIR}${pkg}/src/index.ts`,
  ]),
);

/**
 * Fails the build at an import of a Node built-in — `node:`-prefixed, or bare
 * as `node:module`'s `builtinModules` lists it. vite alone refuses only a named
 * import from one: a namespace or a default import builds against an empty
 * stand-in, and a bare `Buffer` or `process` builds untouched. This plugin is
 * the refusal.
 */
function refuseNodeBuiltins(): Plugin {
  const builtins = new Set(builtinModules);
  return {
    name: 'refuse-node-builtins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('node:') || builtins.has(source)) {
        throw new Error(`refuse-node-builtins: "${source}" is a Node built-in, imported by ${importer ?? 'the entry'}`);
      }
      return null;
    },
  };
}

/** Serves `code` as the module `id`, which is no file: a throwaway entry. */
function entrySource(id: string, code: string): Plugin {
  return {
    name: 'entry-source',
    enforce: 'pre',
    resolveId: (source) => (source === id ? id : null),
    load: (loaded) => (loaded === id ? code : null),
  };
}

interface Bundle {
  code: string;
  /** Every module the bundle holds, by id. */
  modules: string[];
}

/** `entry` as vite builds it for a browser: one IIFE, ES2022, unminified, nothing written. */
async function buildIife(entry: string, plugins: Plugin[] = []): Promise<Bundle> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: PACKAGE_DIR,
    resolve: { alias: WORKSPACE_ALIAS },
    plugins: [refuseNodeBuiltins(), ...plugins],
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry, formats: ['iife'], name: 'ConsensusBundle' },
    },
  });
  const chunks = (Array.isArray(result) ? result : [result])
    .flatMap((output) => ('output' in output ? output.output : []))
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk');
  const [chunk] = chunks;
  if (chunks.length !== 1 || chunk === undefined) throw new Error(`the build answered ${chunks.length} chunks, not one`);
  return { code: chunk.code, modules: Object.keys(chunk.modules) };
}

/**
 * `TextEncoder` and `TextDecoder` as classes of the context's own realm: the
 * source evaluates inside the context to a function that installs them, given
 * two Node-side functions that take and answer strings — UTF-8 as a binary
 * string, one character a byte, and `null` for bytes a fatal decoder refuses.
 *
 * Those three functions cross the context's boundary and nothing else does:
 * every value they carry is a string, a boolean or `null`, so no array crosses
 * in either direction. An array made outside is an instance of Node's
 * `Uint8Array` and fails `instanceof Uint8Array` inside, where the packages'
 * byte checks refuse it — and Node's own `TextEncoder.encode` answers one. Here
 * the codecs, their instances, their output and what they throw are the
 * context's, while the UTF-8 itself is Node's. A label other than UTF-8's, or a
 * streaming decode, throws rather than answering something the context does not
 * implement.
 */
const CONTEXT_CODECS = `(utf8Encode, utf8Decode) => {
  'use strict';
  const UTF8_LABELS = ['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf-8', 'utf8', 'x-unicode20utf8'];
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input = '') {
      const binary = utf8Encode(String(input));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
  }
  class TextDecoder {
    #fatal;
    #ignoreBOM;
    constructor(label = 'utf-8', options = {}) {
      if (!UTF8_LABELS.includes(String(label).trim().toLowerCase())) {
        throw new RangeError('TextDecoder: this context decodes UTF-8 alone, not ' + String(label));
      }
      this.#fatal = Boolean(options.fatal);
      this.#ignoreBOM = Boolean(options.ignoreBOM);
    }
    get encoding() { return 'utf-8'; }
    get fatal() { return this.#fatal; }
    get ignoreBOM() { return this.#ignoreBOM; }
    decode(input = new Uint8Array(0), options = {}) {
      if (options.stream) throw new TypeError('TextDecoder: this context decodes no stream');
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const text = utf8Decode(binary, this.#fatal, this.#ignoreBOM);
      if (text === null) throw new TypeError('The encoded data was not valid for encoding utf-8');
      return text;
    }
  }
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}`;

interface BrowserContext {
  context: Context;
  /** How many times each of the context's codecs reached Node's. */
  calls: { encode: number; decode: number };
}

/**
 * A context holding the ECMAScript built-ins, `TextEncoder` and `TextDecoder`:
 * V8 gives every new context `console` and `WebAssembly` too, neither of them
 * ECMAScript, and both are deleted.
 */
function browserContext(): BrowserContext {
  const context = createContext({});
  runInContext('delete globalThis.console; delete globalThis.WebAssembly;', context);
  const calls = { encode: 0, decode: 0 };
  const encoder = new TextEncoder();
  const install = runInContext(CONTEXT_CODECS, context) as (
    utf8Encode: (text: string) => string,
    utf8Decode: (binary: string, fatal: boolean, ignoreBOM: boolean) => string | null,
  ) => void;
  install(
    (text) => {
      calls.encode += 1;
      return Buffer.from(encoder.encode(text)).toString('latin1');
    },
    (binary, fatal, ignoreBOM) => {
      calls.decode += 1;
      try {
        return new TextDecoder('utf-8', { fatal, ignoreBOM }).decode(Buffer.from(binary, 'latin1'));
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return null;
        throw error;
      }
    },
  );
  return { context, calls };
}

/** The names on a context's global object, sorted. */
function globalNames(context: Context): string[] {
  return (runInContext('Object.getOwnPropertyNames(globalThis).join("\\n")', context) as string).split('\n').sort();
}

/** The first line two texts differ at, with each side's line there; `null` when they are equal. */
function firstDifference(
  bundle: string,
  source: string,
): { line: number; bundle: string | undefined; source: string | undefined } | null {
  const [a, b] = [bundle.split('\n'), source.split('\n')];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { line: i + 1, bundle: a[i], source: b[i] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The scenario — built and signed under Node, handed in as primitives
// ---------------------------------------------------------------------------

/** Devnet's numbers, the timescales shortened so the cooldown, the probation, decay and rent come due within a few blocks. */
const ctx: ApplyContext = {
  ...applyContextFor(profileFor('devnet')),
  inviteProbationBlocks: 3,
  storageRentPeriodBlocks: 4,
  vouchCooldownBlocks: 3,
  decayCfg: { staleThresholdBlocks: 6, decayIntervalBlocks: 3, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM },
};
const CREDIT = 10n ** 8n;
const miner = seededIdentity('bundle/miner');
const [r1, r2, r3] = [seededIdentity('bundle/root-1'), seededIdentity('bundle/root-2'), seededIdentity('bundle/root-3')];
const [t, x] = [seededIdentity('bundle/target'), seededIdentity('bundle/second-target')];
const [u, v, w] = [seededIdentity('bundle/name-holder'), seededIdentity('bundle/passing-name'), seededIdentity('bundle/withdrawer')];
const [l1, l2] = [seededIdentity('bundle/liker-1'), seededIdentity('bundle/liker-2')];
const [c1, c2] = [seededIdentity('bundle/credit-sender'), seededIdentity('bundle/credit-recipient')];
const invitee = seededIdentity('bundle/invitee');

/** Three roots, residents holding karma and a record, a credit holder, and the protocol boxes. */
function genesis(): { seed: Seed; credit: CreditBox } {
  const boxes: AnyBox[] = [];
  const records: Seed['records'] = [];
  let nonce = 1;
  for (const [who, values] of [[r1, [1000n]], [r2, [1000n]], [r3, [6n, 6n]]] as const) {
    for (const value of values) boxes.push(karmaBox(who.userId, value, nonce++, 0));
    records.push({ identityId: who.userId, record: identityRecord({ memberSinceBlock: 1 }) });
  }
  for (const who of [t, x, u, v, w, l1, l2]) {
    boxes.push(karmaBox(who.userId, 100n, nonce++, 0));
    records.push({ identityId: who.userId, record: identityRecord() });
  }
  const credit = seedProvenance<CreditBox>(
    { boxType: 'credit', value: 100n * CREDIT, createdAtBlock: 0, owner: c1.userId },
    0,
    nonce++,
  );
  boxes.push(
    credit,
    protocolBox('emission', profileFor('devnet').creditEmissionTotal, nonce++),
    protocolBox('karma_pool', 1_000_000n, nonce++),
  );
  return { seed: { network: { memberCount: 3 }, boxes, records }, credit };
}

/** The block with body entry `i` changed and re-encoded; its declared id, which no signature enters, stays. */
function withEntry(block: OrderingBlock, i: number, change: (tx: UtxoTransaction) => void): OrderingBlock {
  const utxoTxs = [...block.utxoTxTree.utxoTxs];
  const tx = decodeTx(utxoTxs[i]!);
  change(tx);
  utxoTxs[i] = encodeTx(tx);
  return { ...block, utxoTxTree: { ...block.utxoTxTree, utxoTxs } };
}

/** A copy of the signature with its first bit flipped. */
function flipped(signature: Uint8Array): Uint8Array {
  const out = Uint8Array.from(signature);
  out[0] = out[0]! ^ 1;
  return out;
}

const REFUSED = 'Rejected block height=2: a signature in the body does not verify';

/**
 * The chain both runs apply, built and signed under Node: genesis, then blocks
 * 1 to 6 and 8, each settled by the producer's build over the state the blocks
 * before it left — and ahead of block 2, block 2 with the name claim's
 * signature corrupted, which the body check refuses. Beside the text `run`
 * takes, the results the blocks answered as they were built.
 */
function scenario(): { input: string; results: ApplyResult[] } {
  const { seed, credit } = genesis();
  const view = viewOf(seed);
  const blocks: OrderingBlock[] = [];
  const results: ApplyResult[] = [];
  const apply = (block: OrderingBlock): ApplyResult => {
    const result = applyBlock(view, block, ctx);
    if (result.ok) writeEffects(view, result.effects, block.header.height);
    blocks.push(block);
    results.push(result);
    return result;
  };
  const accepted = (block: OrderingBlock): void => {
    const result = apply(block);
    if (!result.ok) throw new Error(`block ${block.header.height} was refused: ${result.reason}`);
  };
  const step = (height: number, txs: Built[]): void => accepted(candidateBlock(view, height, txs, miner.userId, ctx));
  const largest = (who: TestIdentity): KarmaBox => {
    const box = view.getKarmaBoxes(who.userId)[0];
    if (!box) throw new Error(`${hex(who.userId).slice(0, 8)} holds no karma`);
    return box;
  };

  // 1: a thread, and a reply and a like in the block confirming it; a thread withdrawn at 5.
  const tThread = threadTx(t, largest(t), 'the target opens a thread', 1);
  const wThread = threadTx(w, largest(w), 'a thread its author withdraws', 1);
  step(1, [
    tThread,
    replyTx(r2, largest(r2), 'a reply in the block that confirms its parent', tThread.postId, t.userId, 1),
    likeTx(r1, largest(r1), tThread.postId, t.userId, 1),
    wThread,
  ]);

  // 2: a consolidation and a vouch from its change, a vouch, a like and an invite
  // from its change, a name claimed, credits sent with a fee, a like and a reply
  // from its change. Applied first with the claim's signature corrupted.
  const r3Consolidate = consolidateTx(r3, view.getKarmaBoxes(r3.userId), 2);
  const r1Vouch = vouchTx(r1, largest(r1), t.userId, 2);
  const r2Like = likeTx(r2, largest(r2), tThread.postId, t.userId, 2);
  const uClaim = claimTx(u, largest(u), 'Pinned', 2);
  const c1Send = creditSendTx(c1, credit, 40n * CREDIT, c2.userId, CREDIT, 2);
  const l1Like = likeTx(l1, largest(l1), tThread.postId, t.userId, 2);
  const body2 = [
    r3Consolidate,
    vouchTx(r3, changeOf(r3Consolidate), x.userId, 2),
    r1Vouch,
    r2Like,
    inviteTx(r2, changeOf(r2Like), invitee.userId, 25n, 2),
    uClaim,
    c1Send,
    l1Like,
    replyTx(l1, changeOf(l1Like), 'a reply paid from its own change', wThread.postId, w.userId, 2),
  ];
  const block2 = candidateBlock(view, 2, body2, miner.userId, ctx);
  const claimant = hex(u.userId);
  apply(withEntry(block2, body2.indexOf(uClaim), (tx) => {
    tx.signatures[claimant] = flipped(tx.signatures[claimant]!);
  }));
  accepted(block2);

  // 3: a name claimed and burned in one block.
  const vClaim = claimTx(v, largest(v), 'Fleeting', 3);
  step(3, [vClaim, burnTx(v, changeOf(vClaim), vClaim.out[1]!, 3)]);

  // 4: a burn, its owner's next claim, and another's claim of the burned name.
  const uBurn = burnTx(u, largest(u), uClaim.out[1]!, 4);
  step(4, [uBurn, claimTx(u, changeOf(uBurn), 'Second', 4), claimTx(w, largest(w), 'pinned', 4)]);

  // 5: a like and a withdrawal of one post, an unvouch, and the invite's bond settling.
  step(5, [
    likeTx(l2, largest(l2), wThread.postId, w.userId, 5),
    withdrawTx(w, largest(w), wThread.postId, 5),
    unvouchTx(r1, r1Vouch.out[1]! as VouchBox, ctx.vouchCooldownBlocks, 5),
  ]);

  // 6: an empty body, whose settlement releases the unvouch's escrow.
  step(6, []);

  // 8: decay on the stale owners the body touches, one of them posting, and rent
  // collected from a box dormant since 2.
  const dormant = c1Send.out[0]! as CreditBox;
  const charge = STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(dormant, dormant.txId, dormant.index).length);
  const rent = finish({
    inputs: [dormant.id!],
    outputs: [
      { boxType: 'credit', value: dormant.value - charge, createdAtBlock: 8, owner: dormant.owner } as AnyBoxCandidate,
      { boxType: 'fee', value: charge, createdAtBlock: 8 } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, null);
  step(8, [consolidateTx(l2, view.getKarmaBoxes(l2.userId), 8), threadTx(x, largest(x), 'a stale owner posts', 8), rent]);

  return {
    input: encodeScenario({ ctx, seed, blocks: blocks.map((block) => bytesToHex(encodeOrderingBlock(block))) }),
    results,
  };
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe('the build refuses a Node built-in', () => {
  const REFUSED_ENTRY = `${PACKAGE_DIR}refused-entry.js`;

  for (const specifier of ['crypto', 'node:crypto']) {
    it(`an entry importing ${specifier} as a namespace fails the build with the plugin's refusal`, async () => {
      const code = `import * as crypto from '${specifier}';\nexport const probe = () => crypto;\n`;
      await expect(buildIife(REFUSED_ENTRY, [entrySource(REFUSED_ENTRY, code)]))
        .rejects.toThrow(`refuse-node-builtins: "${specifier}" is a Node built-in`);
    }, BUILD_TIMEOUT);
  }
});

describe('applyBlock built for a browser runs with browser globals alone', () => {
  let bundle: Bundle;
  let scene: { input: string; results: ApplyResult[] };

  beforeAll(async () => {
    scene = scenario();
    bundle = await buildIife(ENTRY);
  }, BUILD_TIMEOUT);

  it('is built from source: every workspace module it holds is a src or test file', () => {
    const workspace = bundle.modules.filter((id) => id.startsWith(PACKAGES_DIR) && !id.includes('/node_modules/'));
    expect(workspace).toContain(`${PACKAGES_DIR}consensus/src/apply-block.ts`);
    expect(workspace.filter((id) => !/^[^/]+\/(src|test)\//.test(id.slice(PACKAGES_DIR.length)))).toEqual([]);
  });

  it('runs in a context holding the ECMAScript built-ins, TextEncoder and TextDecoder, and nothing else', () => {
    const { context } = browserContext();
    const ecmascript = globalNames(createContext({})).filter((name) => name !== 'console' && name !== 'WebAssembly');
    expect(globalNames(context)).toEqual([...ecmascript, 'TextDecoder', 'TextEncoder'].sort());
    for (const name of ['Buffer', 'process', 'require', 'crypto', 'console', 'setTimeout', 'WebAssembly']) {
      expect(runInContext(`typeof ${name}`, context), name).toBe('undefined');
    }
  });

  it("the context's codecs answer the context's own arrays, where an array made outside fails instanceof", () => {
    const { context } = browserContext();
    expect(runInContext('new TextEncoder().encode("é") instanceof Uint8Array', context)).toBe(true);
    expect(runInContext('new TextDecoder("utf-8").decode(new TextEncoder().encode("é"))', context)).toBe('é');
    expect(runInContext(
      'try { new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])); "decoded" } catch (e) { e instanceof TypeError }',
      context,
    )).toBe(true);
    // Node's own encoder's array, handed in: the trap the codecs above avoid.
    const isContextBytes = runInContext('(bytes) => bytes instanceof Uint8Array', context) as (bytes: unknown) => boolean;
    expect(isContextBytes(new TextEncoder().encode('é'))).toBe(false);
  });

  it('the scenario reaches signed transactions, posts, likes, names and a withdrawal, and refuses block 2 first for its corrupted signature', () => {
    const reach = scene.results.map((result) => result.ok
      ? {
          txs: result.effects.appliedTxs.length,
          posts: result.effects.posts.length,
          likes: result.effects.likeRecords.length,
          withdrawals: result.effects.withdrawals.length,
          writes: [...new Set(result.effects.mutations.map((m) => m.kind))].sort(),
        }
      : result.reason);
    expect(reach).toEqual([
      /* 1 */ { txs: 4, posts: 3, likes: 1, withdrawals: 0, writes: ['box', 'record'] },
      /* 2 */ REFUSED,
      /* 2 */ { txs: 9, posts: 1, likes: 2, withdrawals: 0, writes: ['box', 'holder', 'network', 'record', 'username'] },
      /* 3 */ { txs: 2, posts: 0, likes: 0, withdrawals: 0, writes: ['box', 'holder', 'username'] },
      /* 4 */ { txs: 3, posts: 0, likes: 0, withdrawals: 0, writes: ['box', 'holder', 'username'] },
      /* 5 */ { txs: 3, posts: 0, likes: 1, withdrawals: 1, writes: ['box', 'network', 'record'] },
      /* 6 */ { txs: 0, posts: 0, likes: 0, withdrawals: 0, writes: ['box'] },
      /* 8 */ { txs: 3, posts: 1, likes: 0, withdrawals: 0, writes: ['box', 'record'] },
    ]);
  });

  it('crosses as primitives whole: the source run over its text answers what the blocks answered as they were built', () => {
    expect(run(scene.input)).toBe(canonical(scene.results));
  });

  it('answers inside the context what the source answers under Node, byte for byte', () => {
    const { context, calls } = browserContext();
    const before = globalNames(context);
    runInContext(bundle.code, context);
    calls.encode = 0;
    calls.decode = 0;
    const fromBundle: unknown = runInContext(`ConsensusBundle.run(${JSON.stringify(scene.input)})`, context);
    expect(typeof fromBundle).toBe('string');
    expect(firstDifference(fromBundle as string, run(scene.input))).toBeNull();
    // The run reached both codecs, and the bundle left no global but its own name.
    expect(calls.encode).toBeGreaterThan(0);
    expect(calls.decode).toBeGreaterThan(0);
    expect(globalNames(context)).toEqual([...before, 'ConsensusBundle'].sort());
  });
});
