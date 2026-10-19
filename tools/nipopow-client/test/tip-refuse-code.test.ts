import { describe, it, expect } from 'vitest';
import { resolveTip } from '../src/tip.js';
import {
  buildMinedChain,
  createFakeNode,
  devnetProfile,
  clockAfterChain,
  proofHexForChain,
} from './helpers.js';

const M = 6;
const K = 6;
const CHAIN_LEN = M + K + 10;

// The five refuseCode values NodeTipResult carries — NODE_INTERFACE → Nipopow: the
// route answers 404 with `{ error: 'chain too short' }` below `m + k`.
describe('NodeTipResult.refuseCode', () => {
  const profile = devnetProfile();

  it("transport failure → 'unreachable'", async () => {
    const httpFetch = async (_url: string) => {
      throw new TypeError('fetch failed');
    };
    const result = await resolveTip(['http://a:3000'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes[0]!.verified).toBe(false);
    expect(result.nodes[0]!.refuseCode).toBe('unreachable');
  });

  it("404 with body `{ error: 'chain too short' }` → 'too-short'", async () => {
    const httpFetch = async (_url: string) => new Response(JSON.stringify({ error: 'chain too short' }), { status: 404 });
    const result = await resolveTip(['http://a:3000'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes[0]!.refuseCode).toBe('too-short');
  });

  it("404 with a non-JSON body → 'http', never 'too-short'", async () => {
    const httpFetch = async (_url: string) => new Response('Cannot GET /nipopow/proof/6/6', { status: 404 });
    const result = await resolveTip(['http://a:3000'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes[0]!.refuseCode).toBe('http');
  });

  it("404 with a JSON body whose error is not `chain too short` → 'http'", async () => {
    const httpFetch = async (_url: string) => new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const result = await resolveTip(['http://a:3000'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes[0]!.refuseCode).toBe('http');
  });

  it("any other non-ok status → 'http'", async () => {
    const httpFetch = async (_url: string) => new Response('internal error', { status: 500 });
    const result = await resolveTip(['http://a:3000'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes[0]!.refuseCode).toBe('http');
  });

  it("ok answer with no proof field → 'invalid'", async () => {
    const httpFetch = async (_url: string) => new Response(JSON.stringify({}), { status: 200 });
    const result = await resolveTip(['http://a:3000'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes[0]!.refuseCode).toBe('invalid');
    expect(result.nodes[0]!.refuseReason).toContain('missing proof field');
  });

  it("proof hex that fails to decode → 'invalid'", async () => {
    const httpFetch = async (_url: string) => new Response(JSON.stringify({ proof: 'deadbeef' }), { status: 200 });
    const result = await resolveTip(['http://a:3000'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes[0]!.refuseCode).toBe('invalid');
    expect(result.nodes[0]!.refuseReason).toContain('proof decode failed');
  });

  // TYPES_INTERFACE → Export table — hexToBytes is strict: even length and
  // [0-9a-f] only, or it throws. The throw lands in the try/catch already
  // around the decode, so a malformed or uppercase proof is the same 'invalid'
  // refusal as any other decode failure, never an exception out of resolveTip.
  it("proof hex with a non-hex character → 'invalid', the decode's own throw caught", async () => {
    const httpFetch = async (_url: string) => new Response(JSON.stringify({ proof: 'deadbeez' }), { status: 200 });
    const result = await resolveTip(['http://a:3000'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes[0]!.refuseCode).toBe('invalid');
    expect(result.nodes[0]!.refuseReason).toContain('proof decode failed');
  });

  it("proof hex in uppercase → 'invalid', never thrown out of resolveTip", async () => {
    const httpFetch = async (_url: string) => new Response(JSON.stringify({ proof: 'DEADBEEF' }), { status: 200 });
    const result = await resolveTip(['http://a:3000'], M, K, profile, Date.now, httpFetch);
    expect(result.nodes[0]!.refuseCode).toBe('invalid');
    expect(result.nodes[0]!.refuseReason).toContain('proof decode failed');
  });

  it("proof that verifyProof refuses → 'invalid'", async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const now = clockAfterChain(chain);
    const good = proofHexForChain(chain, M, K);
    const bytes = new Uint8Array(Buffer.from(good, 'hex'));
    const flipIdx = bytes.length - 10;
    bytes[flipIdx] = (bytes[flipIdx] ?? 0) ^ 0x01;
    const bad = Buffer.from(bytes).toString('hex');
    const node = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K, overrideProofHex: bad });
    const result = await resolveTip(['http://a:3000'], M, K, profile, now, node.fetch);
    expect(result.nodes[0]!.refuseCode).toBe('invalid');
    expect(result.nodes[0]!.refuseReason).toContain('verify failed');
  });

  it('verified → null', async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN });
    const now = clockAfterChain(chain);
    const node = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const result = await resolveTip(['http://a:3000'], M, K, profile, now, node.fetch);
    expect(result.nodes[0]!.verified).toBe(true);
    expect(result.nodes[0]!.refuseCode).toBeNull();
    expect(result.nodes[0]!.refuseReason).toBeNull();
  });
});
