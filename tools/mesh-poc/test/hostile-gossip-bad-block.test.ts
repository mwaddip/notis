// MESH_INTERFACE → Acceptance 6 — "A mesh node publishing a block
// that fails its checks is blacklisted with its evidence, and the
// client does not forward it." The hostile gossip publisher's bad
// block is a pure byte builder — a tiny payload whose
// `readOrderingBlockSections` throws, so `BlockCheck.check` reads
// it as `reject` with `lie: true`. The publisher also answers a
// dialling reader's handshake (`HANDSHAKE_PROTOCOL`) with its own
// reply frame, built here as `buildResponderFrame`.

import { describe, expect, it } from 'vitest';
// eslint-disable-next-line import/extensions
import { badBlockBytes, scoresLine, buildResponderFrame } from '../stage/hostile-gossip.mjs';
import { BlockCheck } from '../src/block-check.js';
import { profileFor, PROTOCOL_VERSION } from '@dagsocial/types';
import {
  decodeFrame,
  decodeHandshakeBody,
  READER_CAPABILITIES,
  servesChain,
  MAGIC_DEVNET,
} from '@dagsocial/net';

describe('badBlockBytes — the publisher\'s block', () => {
  it('is a Uint8Array under MAX_ORDERING_BLOCK_BYTES', () => {
    const bytes = badBlockBytes(1);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(1024);
  });
  it('BlockCheck.check reads it as reject with lie: true', () => {
    const bytes = badBlockBytes(1);
    const profile = profileFor('devnet');
    const check = new BlockCheck({
      profile,
      scheduledTargetBits: () => null,
      standing: () => null,
      nowMs: () => Date.now(),
    });
    const verdict = check.check(bytes);
    expect(verdict.result).toBe('reject');
    if (verdict.result === 'reject') {
      expect(verdict.lie).toBe(true);
      expect(typeof verdict.detail).toBe('string');
      expect(verdict.detail.length).toBeGreaterThan(0);
    }
  });
  // MESH_INTERFACE → Block gossip → "A block is checked before it is
  // forwarded, and never applied" — gossipsub's `msgIdFn` keyes seen-cache lookups by the
  // bytes' hash, and `GOSSIP_SEEN_WINDOW_MS` holds a duplicate for 120 s
  // (`ignoreDuplicatePublishError: true` makes the publisher's own
  // re-emit a no-op). Each publish needs distinct bytes, else the first
  // publish's message is the only one honest peers ever see; a browser
  // that joins the mesh after it stays unaware.
  it('badBlockBytes(n) answers bytes distinct for each n', () => {
    const a = badBlockBytes(1);
    const b = badBlockBytes(2);
    expect(a).not.toEqual(b);
    // Three consecutive counters all differ pairwise.
    const bytes = [badBlockBytes(1), badBlockBytes(2), badBlockBytes(3)].map((b) => Buffer.from(b).toString('hex'));
    expect(new Set(bytes).size).toBe(3);
  });
  it('BlockCheck.check reads badBlockBytes(2) as reject with lie: true (every counter is a lie)', () => {
    const bytes = badBlockBytes(2);
    const profile = profileFor('devnet');
    const check = new BlockCheck({
      profile,
      scheduledTargetBits: () => null,
      standing: () => null,
      nowMs: () => Date.now(),
    });
    const verdict = check.check(bytes);
    expect(verdict.result).toBe('reject');
    if (verdict.result === 'reject') {
      expect(verdict.lie).toBe(true);
    }
  });
});

describe('scoresLine — the publisher\'s score line', () => {
  it('lists each subscriber with its score rounded to two decimals, in peer-id order', () => {
    expect(scoresLine(10, [{ peerId: 'b', score: -1.005 * 100 }, { peerId: 'a', score: 0.126 }]))
      .toBe('publish seq=10 scores=[a:0.13,b:-100.50]');
  });
  it('answers an empty list for no subscribers', () => {
    expect(scoresLine(20, [])).toBe('publish seq=20 scores=[]');
  });
});

// MESH_INTERFACE → Block gossip → "A client is a reader of every node
// it holds a connection to" — the browser dials the publisher and
// runs `readerHandshake` on `HANDSHAKE_PROTOCOL`. The responder's
// reply frame declares `READER_CAPABILITIES` (an empty array) so
// `servesChain(capabilities)` reads false at the dialler; `mesh-client`
// marks the connection `no-chain`, no read goes over it, but the
// libp2p connection stays open and gossip flows — the browser still
// receives the publisher's bad blocks and blacklists it on evidence.
describe("buildResponderFrame — the publisher's handshake reply", () => {
  it('decodes to a valid handshake body with READER_CAPABILITIES (empty) so servesChain reads false', () => {
    const frame = buildResponderFrame(MAGIC_DEVNET, {
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'dagsocial-hostile-publisher',
      nodeName: '',
    });
    const { code, body } = decodeFrame(MAGIC_DEVNET, frame);
    expect(code).toBe(1);
    const msg = decodeHandshakeBody(body);
    expect(msg).not.toBeNull();
    expect(msg!.capabilities).toEqual([...READER_CAPABILITIES]);
    expect(servesChain(msg!.capabilities)).toBe(false);
    expect(msg!.agentName).toBe('dagsocial-hostile-publisher');
    expect(msg!.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(msg!.chainHeight).toBe(0);
  });
  it("defaults the agentName and protocolVersion when opts are omitted", () => {
    const frame = buildResponderFrame(MAGIC_DEVNET);
    const { body } = decodeFrame(MAGIC_DEVNET, frame);
    const msg = decodeHandshakeBody(body);
    expect(msg).not.toBeNull();
    expect(msg!.agentName).toBe('dagsocial-hostile-publisher');
    expect(msg!.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(msg!.capabilities).toEqual([...READER_CAPABILITIES]);
  });
});
