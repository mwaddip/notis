// MESH_INTERFACE → The client's node list — one event per node that
// `resolveTip` answers, keyed by the id read from the node's mesh URL:
// winner → success; verified, not the winner → behind; `too-short` → behind;
// `unreachable` → failure 'transport'; `http` → failure 'refused';
// `invalid` with a proof → lie 'proof-invalid'; `invalid` without a proof
// → lie 'malformed'. An unknown `refuseCode` is a change to read, not to
// guess: `tipEvents` throws.

import { describe, it, expect } from 'vitest';
import { tipEvents, type TipEvent } from '../src/client/tip-events.js';
import { meshBaseUrl } from '../src/mesh-url.js';
import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';

const idA = 'a'.repeat(64);
const idB = 'b'.repeat(64);
const idC = 'c'.repeat(64);

function node(id: string, overrides: Partial<NodeTipResult>): NodeTipResult {
  return {
    url: meshBaseUrl(id) + '/',
    verified: false,
    proof: null,
    verifyResult: null,
    refuseReason: null,
    refuseCode: null,
    behind: null,
    genesisHash: null,
    ...overrides,
  };
}

function result(nodes: NodeTipResult[], winnerIndex: number): TipResult {
  return {
    winner: winnerIndex >= 0 ? nodes[winnerIndex]! : null,
    winnerIndex,
    nodes,
    tip: null,
    suffixHead: null,
    splits: [],
  };
}

describe('tipEvents', () => {
  it('the winner answers success', () => {
    const r = result([node(idA, { verified: true, refuseCode: null })], 0);
    const events = tipEvents(r, 100);
    expect(events).toEqual<TipEvent[]>([{ id: idA, ev: 'success' }]);
  });

  it('a verified non-winner answers behind', () => {
    const r = result(
      [
        node(idA, { verified: true, refuseCode: null }),
        node(idB, { verified: true, refuseCode: null }),
      ],
      0,
    );
    const events = tipEvents(r, 100);
    expect(events).toEqual<TipEvent[]>([
      { id: idA, ev: 'success' },
      { id: idB, ev: 'behind' },
    ]);
  });

  it('a chain too short to prove answers behind', () => {
    const r = result(
      [node(idA, { verified: false, refuseCode: 'too-short', refuseReason: 'chain too short' })],
      -1,
    );
    const events = tipEvents(r, 100);
    expect(events).toEqual<TipEvent[]>([{ id: idA, ev: 'behind' }]);
  });

  it('an unreachable node answers failure transport', () => {
    const r = result(
      [node(idA, { verified: false, refuseCode: 'unreachable', refuseReason: 'unreachable: xyz' })],
      -1,
    );
    const events = tipEvents(r, 100);
    expect(events).toEqual<TipEvent[]>([{ id: idA, ev: 'failure', kind: 'transport' }]);
  });

  it('an HTTP refusal answers failure refused', () => {
    const r = result(
      [node(idA, { verified: false, refuseCode: 'http', refuseReason: 'HTTP 500: x' })],
      -1,
    );
    const events = tipEvents(r, 100);
    expect(events).toEqual<TipEvent[]>([{ id: idA, ev: 'failure', kind: 'refused' }]);
  });

  it('an invalid refusal with a proof answers lie proof-invalid', () => {
    const r = result(
      [
        node(idA, {
          verified: false,
          refuseCode: 'invalid',
          refuseReason: 'verify failed: bad header',
          // `proof` is a decoded NipopowProof; the mapping reads only its
          // non-nullness, so an opaque sentinel is enough for this case.
          proof: { prefix: [], suffixHead: {}, suffixTail: [] } as unknown as NodeTipResult['proof'],
        }),
      ],
      -1,
    );
    const events = tipEvents(r, 42);
    expect(events).toEqual<TipEvent[]>([
      {
        id: idA,
        ev: 'lie',
        evidence: { kind: 'proof-invalid', atMs: 42, detail: 'verify failed: bad header' },
      },
    ]);
  });

  it('an invalid refusal with no proof answers lie malformed', () => {
    const r = result(
      [
        node(idA, {
          verified: false,
          refuseCode: 'invalid',
          refuseReason: 'response missing proof field',
          proof: null,
        }),
      ],
      -1,
    );
    const events = tipEvents(r, 55);
    expect(events).toEqual<TipEvent[]>([
      {
        id: idA,
        ev: 'lie',
        evidence: { kind: 'malformed', atMs: 55, detail: 'response missing proof field' },
      },
    ]);
  });

  it('the id of each event is the node URL\'s key', () => {
    const r = result(
      [
        node(idA, { verified: true, refuseCode: null }),
        node(idB, { verified: false, refuseCode: 'unreachable', refuseReason: 'x' }),
        node(idC, { verified: false, refuseCode: 'http', refuseReason: 'y' }),
      ],
      0,
    );
    const events = tipEvents(r, 1);
    expect(events.map((e) => e.id)).toEqual([idA, idB, idC]);
  });

  it('an unknown refuseCode throws', () => {
    const r = result(
      [
        node(idA, {
          verified: false,
          refuseCode: 'future-rule' as unknown as NodeTipResult['refuseCode'],
          refuseReason: 'something new',
        }),
      ],
      -1,
    );
    expect(() => tipEvents(r, 0)).toThrow();
  });
});
