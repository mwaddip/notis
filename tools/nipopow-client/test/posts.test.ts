// WEB_INTERFACE → The extension → "The post check" — the rule the tests hold
// checkPosts to. Each case builds a real signed transaction over
// `computeTxId`, as the extension's write surface does
// (`packages/web/src/wallet/builders.ts` + the extension's background signer
// over `ed25519.sign`).

import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  PROTOCOL_VERSION,
  bytesToHex,
  computeContentHash,
  computePostId,
  computeTxId,
  encodeTx,
  hexToBytes,
} from '@dagsocial/types';
import type { PostCommit, UtxoTransaction } from '@dagsocial/types';
import { verifyEd25519, verifyEd25519Batch } from '@dagsocial/validation';
import { checkPosts } from '../src/posts.js';
import type { PostCheck } from '../src/posts.js';

interface Keypair {
  seed: Uint8Array;
  pub: Uint8Array;
  pubHex: string;
}

function makeKey(seedByte = 1): Keypair {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubHex: bytesToHex(pub) };
}

interface BuiltRow {
  tx: UtxoTransaction;
  txHex: string;
  txId: string;
  postId: string;
  commit: PostCommit;
  row: Record<string, unknown>;
  content: string;
}

function buildPostTransaction(opts: {
  signer: Keypair;
  authorPub?: Uint8Array;
  content?: string;
  parentRefs?: string[];
  type?: 'regular' | 'profile';
  protocolVersion?: number;
  inputId?: string;
  omitSignature?: boolean;
  signOverOtherMessage?: Uint8Array;
}): BuiltRow {
  const authorPub = opts.authorPub ?? opts.signer.pub;
  const content = opts.content ?? 'hello world';
  const parentRefs = opts.parentRefs ?? [];
  const type = opts.type ?? 'regular';
  const protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION;
  const inputId = opts.inputId ?? 'aa'.repeat(32);

  const commit: PostCommit = {
    contentHash: computeContentHash(content),
    author: authorPub,
    parentRefs,
    protocolVersion,
    type,
  };

  const tx: UtxoTransaction = {
    inputs: [inputId],
    outputs: [],
    signatures: {},
    protocolVersion,
    post: commit,
  };

  const txId = computeTxId(tx);
  if (!opts.omitSignature) {
    const message = opts.signOverOtherMessage ?? hexToBytes(txId);
    tx.signatures[bytesToHex(opts.signer.pub)] = ed25519.sign(message, opts.signer.seed);
  }

  const txHex = bytesToHex(encodeTx(tx));
  const postId = computePostId(txId, 0);

  const row: Record<string, unknown> = {
    id: postId,
    txId,
    tx: txHex,
    content,
    contentHash: bytesToHex(commit.contentHash),
    author: bytesToHex(authorPub),
    parentRefs: [...parentRefs],
    protocolVersion,
    type,
    status: 'confirmed',
    blockHeight: 10,
    blockIndex: 0,
    blockCreatedAt: 1_000_000,
    likeCount: 0,
    descendantCount: 0,
    authorName: null,
    likedByViewer: null,
  };

  return { tx, txHex, txId, postId, commit, row, content };
}

describe('checkPosts — WEB_INTERFACE → The extension → "The post check"', () => {
  it('a real signed transaction binds its row — id, txBytes, author, parent null', () => {
    const key = makeKey();
    const built = buildPostTransaction({ signer: key });
    const [res] = checkPosts([built.row]);
    expect(res).toEqual({
      status: 'bound',
      id: built.postId,
      txBytes: hexToBytes(built.txHex),
      author: key.pubHex,
      parent: null,
    });
  });

  it("a reply binds with its parent carried on the result", () => {
    const key = makeKey(2);
    const parent = 'cd'.repeat(32);
    const built = buildPostTransaction({ signer: key, parentRefs: [parent] });
    const [res] = checkPosts([built.row]);
    expect(res).toMatchObject({ status: 'bound', parent });
  });

  it('a withdrawn row is nothing-to-bind, with no verifier called', () => {
    const verifyBatch = vi.fn(() => true);
    const verifyOne = vi.fn(() => true);
    const rows: unknown[] = [{ kind: 'withdrawn', id: 'ab'.repeat(32) }];
    const results = checkPosts(rows, { verifyBatch, verifyOne });
    expect(results).toEqual([{ status: 'nothing-to-bind' }]);
    expect(verifyBatch).not.toHaveBeenCalled();
    expect(verifyOne).not.toHaveBeenCalled();
  });

  it('tx: null is unserved — the node holds no bytes', () => {
    const row = { id: 'ab'.repeat(32), tx: null };
    const [res] = checkPosts([row]);
    expect(res).toEqual({ status: 'unserved' });
  });

  it('tx absent is unbound no-tx', () => {
    const row = { id: 'ab'.repeat(32) };
    const [res] = checkPosts([row]);
    expect(res?.status).toBe('unbound');
    if (res?.status === 'unbound') expect(res.reason).toBe('no-tx');
  });

  it('tx not a string is unbound no-tx', () => {
    const [res] = checkPosts([{ tx: 12 }]);
    expect(res?.status).toBe('unbound');
    if (res?.status === 'unbound') expect(res.reason).toBe('no-tx');
  });

  it('tx is odd-length hex is unbound undecodable', () => {
    const [res] = checkPosts([{ id: 'ab'.repeat(32), tx: 'abc' }]);
    if (res?.status === 'unbound') expect(res.reason).toBe('undecodable');
    else throw new Error('expected unbound');
  });

  it('tx is non-hex is unbound undecodable', () => {
    const [res] = checkPosts([{ id: 'ab'.repeat(32), tx: 'zz' }]);
    if (res?.status === 'unbound') expect(res.reason).toBe('undecodable');
    else throw new Error('expected unbound');
  });

  it('tx is bytes decodeTx refuses is unbound undecodable', () => {
    // Random bytes that decodeTx will not read.
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const [res] = checkPosts([{ id: 'ab'.repeat(32), tx: bytesToHex(bytes) }]);
    if (res?.status === 'unbound') expect(res.reason).toBe('undecodable');
    else throw new Error('expected unbound');
  });

  it('a transaction that carries no post is unbound no-post', () => {
    const key = makeKey(3);
    const tx: UtxoTransaction = {
      inputs: ['aa'.repeat(32)],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const txId = computeTxId(tx);
    tx.signatures[key.pubHex] = ed25519.sign(hexToBytes(txId), key.seed);
    const row = {
      id: computePostId(txId, 0),
      txId,
      tx: bytesToHex(encodeTx(tx)),
      content: 'x',
      contentHash: 'aa'.repeat(32),
      author: key.pubHex,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('no-post');
    else throw new Error('expected unbound');
  });

  it("another row's txId is unbound tx-id", () => {
    const key = makeKey();
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, txId: 'bc'.repeat(32) };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('tx-id');
    else throw new Error('expected unbound');
  });

  it("another row's id is unbound post-id", () => {
    const key = makeKey();
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, id: 'cd'.repeat(32) };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('post-id');
    else throw new Error('expected unbound');
  });

  it("another row's author is unbound commit (shape still 64 hex)", () => {
    const key = makeKey();
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, author: 'de'.repeat(32) };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('commit');
    else throw new Error('expected unbound');
  });

  it("another row's parentRefs is unbound commit", () => {
    const key = makeKey();
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, parentRefs: ['ef'.repeat(32)] };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('commit');
    else throw new Error('expected unbound');
  });

  it("another row's contentHash is unbound commit", () => {
    const key = makeKey();
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, contentHash: '01'.repeat(32) };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('commit');
    else throw new Error('expected unbound');
  });

  it("another row's type is unbound commit", () => {
    const key = makeKey();
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, type: 'profile' };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('commit');
    else throw new Error('expected unbound');
  });

  it("another row's protocolVersion is unbound commit", () => {
    const key = makeKey();
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, protocolVersion: built.commit.protocolVersion + 999 };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('commit');
    else throw new Error('expected unbound');
  });

  it("another row's content (whose hash differs) is unbound content", () => {
    const key = makeKey();
    const built = buildPostTransaction({ signer: key, content: 'first' });
    const row = { ...built.row, content: 'second' };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('content');
    else throw new Error('expected unbound');
  });

  it('a transaction whose post names author A, signed by B alone, is unbound unsigned', () => {
    const authorA = makeKey(10);
    const signerB = makeKey(11);
    const built = buildPostTransaction({
      signer: signerB,
      authorPub: authorA.pub,
    });
    // Row's author is A — matches commit.author (A). But signatures carries only B's key.
    const row = { ...built.row, author: authorA.pubHex };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('unsigned');
    else throw new Error('expected unbound');
  });

  it('a signature under the author that does not verify is unbound signature', () => {
    const key = makeKey(12);
    // Sign over the wrong message so the shape passes (64 bytes under author's
    // key) but the verifier refuses.
    const built = buildPostTransaction({
      signer: key,
      signOverOtherMessage: new Uint8Array(32).fill(7),
    });
    const [res] = checkPosts([built.row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('signature');
    else throw new Error('expected unbound');
  });

  it('a page of one bad row and several good: the batch is called once, the single check once per candidate, and the others stay bound', () => {
    const kA = makeKey(20);
    const kB = makeKey(21);
    const kC = makeKey(22);
    const bA = buildPostTransaction({ signer: kA, inputId: '11'.repeat(32) });
    const bB = buildPostTransaction({ signer: kB, inputId: '22'.repeat(32) });
    const bC = buildPostTransaction({
      signer: kC,
      inputId: '33'.repeat(32),
      signOverOtherMessage: new Uint8Array(32).fill(9), // bad signature
    });

    const verifyBatch = vi.fn(() => false);
    const verifyOne = vi.fn((sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) =>
      verifyEd25519(sig, msg, pub));
    const results = checkPosts([bA.row, bB.row, bC.row], { verifyBatch, verifyOne });

    expect(verifyBatch).toHaveBeenCalledTimes(1);
    expect(verifyOne).toHaveBeenCalledTimes(3); // one per candidate after batch failed
    expect(results[0]?.status).toBe('bound');
    expect(results[1]?.status).toBe('bound');
    expect(results[2]?.status).toBe('unbound');
    if (results[2]?.status === 'unbound') expect(results[2].reason).toBe('signature');
  });

  it('a page of good rows calls the batch once and the single check never', () => {
    const kA = makeKey(30);
    const kB = makeKey(31);
    const bA = buildPostTransaction({ signer: kA, inputId: '44'.repeat(32) });
    const bB = buildPostTransaction({ signer: kB, inputId: '55'.repeat(32) });

    const verifyBatch = vi.fn(() => true);
    const verifyOne = vi.fn(() => true);
    const results = checkPosts([bA.row, bB.row], { verifyBatch, verifyOne });

    expect(verifyBatch).toHaveBeenCalledTimes(1);
    expect(verifyOne).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe('bound');
    expect(results[1]?.status).toBe('bound');
  });

  it('a placeholder row (content: null) is bound without its text', () => {
    const key = makeKey(40);
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, content: null };
    const [res] = checkPosts([row]);
    expect(res?.status).toBe('bound');
  });

  it('tx: null stays unserved even on an otherwise malformed row', () => {
    const [res] = checkPosts([{ tx: null, id: 'nothex' }]);
    expect(res).toEqual({ status: 'unserved' });
  });

  it('an empty page answers [] and calls no verifier', () => {
    const verifyBatch = vi.fn(() => true);
    const verifyOne = vi.fn(() => true);
    const results = checkPosts([], { verifyBatch, verifyOne });
    expect(results).toEqual([]);
    expect(verifyBatch).not.toHaveBeenCalled();
    expect(verifyOne).not.toHaveBeenCalled();
  });

  it('null row is unbound malformed', () => {
    const [res] = checkPosts([null]);
    if (res?.status === 'unbound') expect(res.reason).toBe('malformed');
    else throw new Error('expected unbound');
  });

  it('a number row is unbound malformed', () => {
    const [res] = checkPosts([42]);
    if (res?.status === 'unbound') expect(res.reason).toBe('malformed');
    else throw new Error('expected unbound');
  });

  it('an empty object is unbound no-tx', () => {
    const [res] = checkPosts([{}]);
    if (res?.status === 'unbound') expect(res.reason).toBe('no-tx');
    else throw new Error('expected unbound');
  });

  it("a row whose parentRefs is a string is unbound malformed", () => {
    const key = makeKey(50);
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, parentRefs: 'x' };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('malformed');
    else throw new Error('expected unbound');
  });

  it("a row whose id is not 64 hex is unbound malformed", () => {
    const key = makeKey(51);
    const built = buildPostTransaction({ signer: key });
    const row = { ...built.row, id: 'not-hex' };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('malformed');
    else throw new Error('expected unbound');
  });

  it.each(['id', 'txId', 'author', 'contentHash'])(
    'a row whose %s is upper case is unbound malformed',
    (field) => {
      const built = buildPostTransaction({ signer: makeKey(52) });
      const value = built.row[field] as string;
      const row = { ...built.row, [field]: value.toUpperCase() };
      expect(row[field]).not.toBe(value);
      const [res] = checkPosts([row]);
      if (res?.status === 'unbound') expect(res.reason).toBe('malformed');
      else throw new Error('expected unbound');
    },
  );

  it('a row whose parent ref is upper case is unbound malformed', () => {
    const parent = 'cd'.repeat(32);
    const built = buildPostTransaction({ signer: makeKey(53), parentRefs: [parent] });
    const row = { ...built.row, parentRefs: ['CD'.repeat(32)] };
    const [res] = checkPosts([row]);
    if (res?.status === 'unbound') expect(res.reason).toBe('malformed');
    else throw new Error('expected unbound');
  });

  it('a verdict is one line of text — no newlines in any status', () => {
    const results = checkPosts([
      null,
      { tx: 12 },
      { id: 'ab'.repeat(32), tx: 'zz' },
    ]);
    for (const r of results) {
      if (r.status === 'unbound') expect(r.verdict).not.toMatch(/\n/);
    }
  });

  it('the default deps use validation — a real batch verifies real signatures', () => {
    // No deps override: production verifyEd25519Batch is called under the hood.
    const kA = makeKey(60);
    const kB = makeKey(61);
    const bA = buildPostTransaction({ signer: kA, inputId: '66'.repeat(32) });
    const bB = buildPostTransaction({ signer: kB, inputId: '77'.repeat(32) });
    const results = checkPosts([bA.row, bB.row]);
    expect(results[0]?.status).toBe('bound');
    expect(results[1]?.status).toBe('bound');
    // Sanity: the real batch would accept these entries.
    const entries = [
      { signature: bA.tx.signatures[kA.pubHex]!, message: hexToBytes(bA.txId), publicKey: kA.pub },
      { signature: bB.tx.signatures[kB.pubHex]!, message: hexToBytes(bB.txId), publicKey: kB.pub },
    ];
    expect(verifyEd25519Batch(entries)).toBe(true);
  });

  it('results are returned in rows order, even with mixed statuses', () => {
    const key = makeKey(70);
    const good = buildPostTransaction({ signer: key });
    const rows: unknown[] = [
      { kind: 'withdrawn' },
      { tx: null },
      good.row,
      null,
    ];
    const results: PostCheck[] = checkPosts(rows);
    expect(results[0]?.status).toBe('nothing-to-bind');
    expect(results[1]?.status).toBe('unserved');
    expect(results[2]?.status).toBe('bound');
    expect(results[3]?.status).toBe('unbound');
  });
});
