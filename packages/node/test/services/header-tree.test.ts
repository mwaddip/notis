import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDb, initDb } from '../../src/store/db.js';
import {
  insertHeader,
  getHeaderRow,
  getBestTip,
  getBestHashAt,
  rewriteBestChain,
  removeHeaderSubtree,
  pruneHeadersBelow,
  type HeaderRow,
} from '../../src/store/header-tree.js';
import { getDb } from '../../src/store/db.js';
import { defaultParams, makeChain, makeHeader, type ParentHeaderInfo } from '../helpers/make-header.js';
import { cumulativeWork } from '@dagsocial/validation';
import { config } from '../../src/config.js';

const PARAMS = defaultParams({
  anchorBits: 3072,
  floorBits: 2816,
  ceilingBits: 4096,
  idealMs: 60_000,
});
const SCHEDULE = config.protocolVersionSchedule;

function toRow(p: ParentHeaderInfo, work: bigint): HeaderRow {
  return {
    hash: p.hash,
    height: p.header.height,
    prevHash: p.header.prevBlockHash,
    header: p.header,
    interlinks: p.interlinks,
    chainWork: work,
    pathTa: p.pathTa,
  };
}

describe('header-tree store', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { closeDb(); });

  it('insertHeader round-trips every field', () => {
    const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
    const work = cumulativeWork([h1!.header]);
    insertHeader(toRow(h1!, work));

    const back = getHeaderRow(h1!.hash);
    expect(back).not.toBeNull();
    expect(back!.hash).toBe(h1!.hash);
    expect(back!.height).toBe(1);
    expect(back!.prevHash).toBe(h1!.header.prevBlockHash);
    expect(back!.chainWork).toBe(work);
    expect(back!.pathTa).toBe(h1!.header.createdAt);
    expect(back!.interlinks).toEqual(h1!.interlinks);
    expect(back!.header.powNonce).toBe(h1!.header.powNonce);
  });

  it('insertHeader is idempotent on hash', () => {
    const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
    const work = cumulativeWork([h1!.header]);
    insertHeader(toRow(h1!, work));
    insertHeader(toRow(h1!, work * 999n));

    const back = getHeaderRow(h1!.hash);
    expect(back!.chainWork).toBe(work);
  });

  it('getBestTip and getBestHashAt read the best_chain index', () => {
    const chain = makeChain({ parent: null, n: 4, params: PARAMS, schedule: SCHEDULE });
    let w = 0n;
    for (const h of chain) {
      w += cumulativeWork([h.header]);
      insertHeader(toRow(h, w));
    }
    expect(getBestTip()).toBeNull();

    rewriteBestChain(0, chain.map(h => h.hash));
    const tip = getBestTip();
    expect(tip).not.toBeNull();
    expect(tip!.height).toBe(4);
    expect(tip!.hash).toBe(chain[3]!.hash);

    expect(getBestHashAt(2)).toBe(chain[1]!.hash);
    expect(getBestHashAt(99)).toBeNull();
  });

  it('rewriteBestChain replaces every entry above the fork, in one transaction', () => {
    const chain = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE });
    let w = 0n;
    for (const h of chain) { w += cumulativeWork([h.header]); insertHeader(toRow(h, w)); }
    rewriteBestChain(0, chain.map(h => h.hash));

    const alt = makeChain({ parent: chain[0]!, n: 2, params: PARAMS, schedule: SCHEDULE, startAt: chain[0]!.header.createdAt + PARAMS.idealMs + 1 });
    let w2 = cumulativeWork([chain[0]!.header]);
    for (const h of alt) { w2 += cumulativeWork([h.header]); insertHeader(toRow(h, w2)); }
    rewriteBestChain(1, alt.map(h => h.hash));

    expect(getBestHashAt(1)).toBe(chain[0]!.hash);
    expect(getBestHashAt(2)).toBe(alt[0]!.hash);
    expect(getBestHashAt(3)).toBe(alt[1]!.hash);
    expect(getBestTip()!.hash).toBe(alt[1]!.hash);
  });

  it('removeHeaderSubtree deletes the row, every descendant, and their best_chain and staged rows', () => {
    const chain = makeChain({ parent: null, n: 3, params: PARAMS, schedule: SCHEDULE });
    let w = 0n;
    for (const h of chain) { w += cumulativeWork([h.header]); insertHeader(toRow(h, w)); }
    rewriteBestChain(0, chain.map(h => h.hash));
    getDb().prepare('INSERT INTO staged_blocks (hash, height, block_bytes, from_peer) VALUES (?, ?, ?, ?)')
      .run(chain[2]!.hash, 3, Buffer.from([1, 2, 3]), 'peerA');

    removeHeaderSubtree(chain[1]!.hash);

    expect(getHeaderRow(chain[0]!.hash)).not.toBeNull();
    expect(getHeaderRow(chain[1]!.hash)).toBeNull();
    expect(getHeaderRow(chain[2]!.hash)).toBeNull();
    expect(getBestHashAt(1)).toBe(chain[0]!.hash);
    expect(getBestHashAt(2)).toBeNull();
    expect(getBestHashAt(3)).toBeNull();
    const staged = getDb().prepare('SELECT COUNT(*) AS c FROM staged_blocks').get() as { c: number };
    expect(staged.c).toBe(0);
  });

  it('pruneHeadersBelow keeps best-chain rows and drops the rest with their staged blocks', () => {
    const chain = makeChain({ parent: null, n: 4, params: PARAMS, schedule: SCHEDULE });
    let w = 0n;
    for (const h of chain) { w += cumulativeWork([h.header]); insertHeader(toRow(h, w)); }
    rewriteBestChain(0, chain.map(h => h.hash));

    const side = makeHeader({ height: 2, parent: chain[0]!, params: PARAMS, schedule: SCHEDULE, createdAt: chain[0]!.header.createdAt + PARAMS.idealMs + 2 });
    insertHeader(toRow(side, w / 10n));
    getDb().prepare('INSERT INTO staged_blocks (hash, height, block_bytes, from_peer) VALUES (?, ?, ?, ?)')
      .run(side.hash, 2, Buffer.from([9]), 'peerB');

    pruneHeadersBelow(3);

    expect(getHeaderRow(chain[0]!.hash)).not.toBeNull();
    expect(getHeaderRow(chain[1]!.hash)).not.toBeNull();
    expect(getHeaderRow(chain[2]!.hash)).not.toBeNull();
    expect(getHeaderRow(chain[3]!.hash)).not.toBeNull();
    expect(getHeaderRow(side.hash)).toBeNull();
    const staged = getDb().prepare('SELECT COUNT(*) AS c FROM staged_blocks').get() as { c: number };
    expect(staged.c).toBe(0);
  });

  it('chain_work round-trips 40-byte big-endian bigints', () => {
    const [h1] = makeChain({ parent: null, n: 1, params: PARAMS, schedule: SCHEDULE });
    const big = (1n << 300n) + 42n;
    insertHeader(toRow(h1!, big));
    expect(getHeaderRow(h1!.hash)!.chainWork).toBe(big);
  });
});
