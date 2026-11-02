// MESH_INTERFACE → The node endpoint — a tiny upstream serving an
// ordering chain by `blockToJson`'s shape (NODE_INTERFACE → Blocks),
// and a `resolveTip` fake that answers over the same chains without
// calling `verifyProof`: each URL in order, verified against the
// winner's suffix as `tip.ts`'s `behindOnWinnerSuffix` does, a
// `too-short` on a chain below `k`, an `invalid` or an `unreachable`
// as `resolveTip` reports them.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type { NodeTipResult } from '@dagsocial/nipopow-client';
import { DEFAULT_K } from '@dagsocial/nipopow-client';
import type { NipopowProof, PoPowHeader, VerifyResult } from '@dagsocial/nipopow';

export interface ChainUpstream {
  base: string;
  setChain(c: OrderingBlock[]): void;
  close(): Promise<void>;
  /** Count of `/blocks/:h` hits since the server started. */
  heightReads(): number;
}

/**
 * An `http` server on `127.0.0.1:0` serving an ordering chain in
 * `blockToJson`'s shape (NODE_INTERFACE → Blocks): `GET /blocks/current`
 * answers `{ height, hash }` of the chain's last block (`blockHash`),
 * `GET /blocks/:h` answers that height's block, `404 { error: 'not
 * found' }` on every other path. `setChain` swaps what it serves — a
 * node advancing, or moving to a fork — without a restart.
 *
 * `options.heightReadDelayMs` (default 0): a `setTimeout` wait before
 * answering any `/blocks/:h` — the harness simulates a slow header read
 * without touching `/blocks/current`'s own time (MESH_INTERFACE → The
 * client's node list → "A check" — the speed is the tip read's).
 *
 * `options.extraUtxoTxIdsInJson` (default 0): the number of fake 64-hex
 * ids appended to each served block's `utxoTxTree.utxoTxIds` in the
 * JSON only — the real block is unchanged, and `readHeaderAt` reads
 * `data.header` alone, so the extra bytes inflate the body past
 * `/blocks/current`'s 1 KiB cap without touching header verification.
 */
export async function chainUpstream(
  chain: OrderingBlock[],
  options?: { heightReadDelayMs?: number; extraUtxoTxIdsInJson?: number },
): Promise<ChainUpstream> {
  let current = chain;
  let heightHits = 0;
  const heightDelayMs = options?.heightReadDelayMs ?? 0;
  const extraIds = options?.extraUtxoTxIdsInJson ?? 0;
  const srv: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/blocks/current') {
      const tip = current[current.length - 1];
      if (!tip) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const hash = blockHash(tip.header);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height: tip.header.height, hash }));
      return;
    }
    const m = /^\/blocks\/(\d+)$/.exec(url);
    if (m) {
      heightHits += 1;
      const h = Number(m[1]);
      const block = current.find((b) => b.header.height === h);
      const answer = (): void => {
        if (!block) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(blockToJson(block, extraIds)));
      };
      if (heightDelayMs > 0) {
        setTimeout(answer, heightDelayMs);
      } else {
        answer();
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    setChain(c: OrderingBlock[]): void {
      current = c;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => srv.close(() => resolve()));
    },
    heightReads(): number {
      return heightHits;
    },
  };
}

/**
 * The served shape of an ordering block (NODE_INTERFACE → Blocks):
 * `header` fields as served, `validatorId` lowercase hex,
 * `validatorSignature` lowercase hex, `utxoTxTree.utxoTxIds` and
 * `utxoTxTree.postIds` as arrays, `utxoTxTree.utxoTxs` empty. When
 * `extraIds` is positive, `utxoTxIds` is padded with that many fake
 * 64-hex ids after the block's own, inflating the body without
 * touching the header (used by cases that pin the fill's byte cap).
 */
function blockToJson(block: OrderingBlock, extraIds = 0): Record<string, unknown> {
  const ids: string[] = [...block.utxoTxTree.utxoTxIds];
  for (let i = 0; i < extraIds; i += 1) {
    ids.push(i.toString(16).padStart(64, '0'));
  }
  return {
    header: {
      protocolVersion: block.header.protocolVersion,
      height: block.header.height,
      prevBlockHash: block.header.prevBlockHash,
      utxoTxRoot: block.header.utxoTxRoot,
      stateRoot: block.header.stateRoot,
      validatorId: Buffer.from(block.header.validatorId).toString('hex'),
      powNonce: block.header.powNonce,
      powTargetBits: block.header.powTargetBits,
      createdAt: block.header.createdAt,
      interlinkRoot: block.header.interlinkRoot,
      adProofsRoot: block.header.adProofsRoot,
    },
    utxoTxTree: {
      utxoTxIds: ids,
      postIds: [] as string[],
      utxoTxs: [] as string[],
    },
    validatorSignature: Buffer.from(block.validatorSignature).toString('hex'),
  };
}

/**
 * `resolveTip`-shaped answers over ordering chains, without calling
 * `verifyProof`: each URL in order, `'invalid'` as `invalidWithProof`,
 * `'unreachable'` with `refuseCode: 'unreachable'`,
 * otherwise a verified `NodeTipResult` whose `proof.suffixHead.header`
 * and `proof.suffixTail` are the chain's last `k` headers and whose
 * `verifyResult` is `{ ok: true, headers: [block1, …suffix], tip,
 * suffixHead }`. The winner is the longest chain; a tie keeps the
 * first (`tip.ts`'s fold rule). `behind` is measured on the winner's
 * suffix by `blockHash`, as `tip.ts`'s `behindOnWinnerSuffix` does. A
 * chain shorter than `k` is `refuseCode: 'too-short'`.
 */
export function chainResolve(
  chainOf: (url: string) => OrderingBlock[] | 'invalid' | 'unreachable',
  k: number = DEFAULT_K,
): typeof import('@dagsocial/nipopow-client').resolveTip {
  return async (nodeUrls) => {
    const nodes: NodeTipResult[] = [];
    for (const url of nodeUrls) {
      const answer = chainOf(url);
      if (answer === 'unreachable') {
        nodes.push({
          url,
          verified: false,
          proof: null,
          verifyResult: null,
          refuseReason: 'unreachable',
          refuseCode: 'unreachable',
          behind: null,
          genesisHash: null,
        });
        continue;
      }
      if (answer === 'invalid') {
        nodes.push({
          url,
          verified: false,
          proof: {
            m: 24,
            k,
            prefix: [] as PoPowHeader[],
            suffixHead: {} as PoPowHeader,
            suffixTail: [] as BlockHeader[],
          } as NipopowProof,
          verifyResult: null,
          refuseReason: 'verify failed: bad header',
          refuseCode: 'invalid',
          behind: null,
          genesisHash: null,
        });
        continue;
      }
      const chain = answer;
      if (chain.length < k) {
        nodes.push({
          url,
          verified: false,
          proof: null,
          verifyResult: null,
          refuseReason: 'chain too short',
          refuseCode: 'too-short',
          behind: null,
          genesisHash: null,
        });
        continue;
      }
      const block1 = chain[0]!.header;
      const suffix = chain.slice(chain.length - k).map((b) => b.header);
      const suffixHead: PoPowHeader = { header: suffix[0]!, interlinks: [] };
      const suffixTail: BlockHeader[] = suffix.slice(1);
      const tip = suffix[suffix.length - 1]!;
      const proof: NipopowProof = {
        m: 24,
        k,
        prefix: [{ header: block1, interlinks: [] }],
        suffixHead,
        suffixTail,
      };
      const vr: VerifyResult = {
        ok: true,
        headers: [block1, ...suffix],
        tip,
        tipHeight: tip.height,
        suffixHead,
      };
      nodes.push({
        url,
        verified: true,
        proof,
        verifyResult: vr,
        refuseReason: null,
        refuseCode: null,
        behind: null,
        genesisHash: blockHash(block1),
      });
    }

    // Winner is the longest verified chain; a tie keeps the first.
    let winner: NodeTipResult | null = null;
    let winnerIndex = -1;
    let winnerSuffix: BlockHeader[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i]!;
      if (!n.verified) continue;
      const vr = n.verifyResult as VerifyResult & { ok: true };
      const nodeSuffix = [vr.suffixHead.header, ...(n.proof!.suffixTail)];
      const nodeTipHeight = nodeSuffix[nodeSuffix.length - 1]!.height;
      if (winner === null) {
        winner = n;
        winnerIndex = i;
        winnerSuffix = nodeSuffix;
        continue;
      }
      const winnerTipHeight = winnerSuffix[winnerSuffix.length - 1]!.height;
      if (nodeTipHeight > winnerTipHeight) {
        winner = n;
        winnerIndex = i;
        winnerSuffix = nodeSuffix;
      }
      // tie or shorter → keep winner
    }

    // Measure `behind` on the winner's suffix.
    if (winner !== null) {
      for (const n of nodes) {
        if (!n.verified) continue;
        const nvr = n.verifyResult as VerifyResult & { ok: true };
        n.behind = behindOnWinnerSuffix(nvr.tip, winnerSuffix);
      }
    }

    if (winner === null) {
      return { winner: null, winnerIndex: -1, nodes, tip: null, suffixHead: null, splits: [] };
    }
    const wvr = winner.verifyResult as VerifyResult & { ok: true };
    return {
      winner,
      winnerIndex,
      nodes,
      tip: wvr.tip,
      suffixHead: wvr.suffixHead,
      splits: [],
    };
  };
}

// WEB_INTERFACE → The extension → "The verified tip" — height narrows
// the suffix headers to hash; the match is equal blockHash at that
// height; the count is the last suffix index minus the index found.
// A null hash on either side is no match.
function behindOnWinnerSuffix(nodeTip: BlockHeader, suffix: BlockHeader[]): number | null {
  const nodeTipHash = blockHash(nodeTip);
  if (nodeTipHash === null) return null;
  for (let i = 0; i < suffix.length; i += 1) {
    const h = suffix[i]!;
    if (h.height !== nodeTip.height) continue;
    const suffixHash = blockHash(h);
    if (suffixHash === null) continue;
    if (suffixHash === nodeTipHash) return suffix.length - 1 - i;
  }
  return null;
}

