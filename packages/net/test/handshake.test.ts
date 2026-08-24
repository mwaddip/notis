import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildHandshakeFrame,
  decodeHandshakeBody,
  decodeHandshakePayload,
  handshakeCodec,
  handshakePenalty,
  parseHandshakeBody,
  validateHandshake,
} from '@dagsocial/net';
import {
  MAGIC_TESTNET,
  MAGIC_MAINNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
  decodeFrame,
  MAX_ADVERTISED_HEIGHT,
  MAX_NAME_BYTES,
  MAX_ADDRESS_BYTES,
  MAX_CAPABILITY_ENTRIES,
  MAX_CAPABILITY_CODE,
  MAX_UINT32,
} from '@dagsocial/net';
import { FRAME_VERSION } from '@dagsocial/wire';
import { PeerManager, PenaltyKind } from '@dagsocial/net';
import type { HandshakeMsg, NetConfig } from '@dagsocial/net';
import { encodeStruct } from '@dagsocial/types';

const testMsg: HandshakeMsg = {
  agentName: 'dagsocial/1.0.0',
  protocolVersion: 1,
  nodeName: 'test-node',
  chainHeight: 42,
  capabilities: [1, 2, 3, 4, 5, 8, 9],
  sessionMagic: 12345,
};

function validBody(overrides: Partial<HandshakeMsg> = {}): Uint8Array {
  return encodeStruct(handshakeCodec, { ...testMsg, ...overrides });
}

function validateEncoded(msg: HandshakeMsg): ReturnType<typeof validateHandshake> {
  return validateHandshake(parseHandshakeBody(validBody(msg)), [1]);
}

describe('handshake', () => {
  it('round-trips through frame', () => {
    const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(1);
    const parsed = decodeHandshakeBody(body);
    expect(parsed).toEqual(testMsg);
  });

  it('round-trips with declaredAddress', () => {
    const msg = { ...testMsg, declaredAddress: '/ip4/1.2.3.4/tcp/9000' };
    const frame = buildHandshakeFrame(MAGIC_TESTNET, msg);
    const parsed = decodeHandshakeBody(decodeFrame(MAGIC_TESTNET, frame).body);
    expect(parsed).toEqual(msg);
  });

  it('round-trips with empty capabilities', () => {
    const msg = { ...testMsg, capabilities: [] };
    const frame = buildHandshakeFrame(MAGIC_TESTNET, msg);
    const parsed = decodeHandshakeBody(decodeFrame(MAGIC_TESTNET, frame).body);
    expect(parsed!.capabilities).toEqual([]);
  });

  describe('frame rejection policy', () => {
    it('accepts a well-formed frame (control)', () => {
      const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
      const decoded = decodeHandshakePayload(MAGIC_TESTNET, frame);
      expect(decoded.kind).toBe('framed');
      if (decoded.kind === 'reject') return;
      expect(validateHandshake(parseHandshakeBody(decoded.body), [1]).ok).toBe(true);
    });

    it('rejects a frame from the wrong network', () => {
      const frame = buildHandshakeFrame(MAGIC_MAINNET, testMsg);
      expect(decodeHandshakePayload(MAGIC_TESTNET, frame))
        .toEqual({ kind: 'reject', code: 'wrong-magic' });
    });

    it('recognizes every canonical magic as a foreign network', () => {
      expect(KNOWN_FRAME_MAGICS).toContain(MAGIC_DEVNET);
      for (const magic of KNOWN_FRAME_MAGICS) {
        if (magic === MAGIC_TESTNET) continue;
        const frame = buildHandshakeFrame(magic, testMsg);
        expect(decodeHandshakePayload(MAGIC_TESTNET, frame))
          .toEqual({ kind: 'reject', code: 'wrong-magic' });
      }
    });

    it('rejects a checksum-mismatched frame', () => {
      const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
      frame[frame.length - 1] = frame[frame.length - 1]! ^ 0xff;
      expect(decodeHandshakePayload(MAGIC_TESTNET, frame))
        .toEqual({ kind: 'reject', code: 'checksum-mismatch' });
    });

    it('rejects a frame with a version above ours', () => {
      const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
      frame[4] = FRAME_VERSION + 1;
      expect(decodeHandshakePayload(MAGIC_TESTNET, frame))
        .toEqual({ kind: 'reject', code: 'unsupported-version' });
    });

    it('rejects unframed positional bytes', () => {
      const raw = validBody();
      expect(decodeHandshakePayload(MAGIC_TESTNET, raw))
        .toEqual({ kind: 'reject', code: 'not-a-frame' });
    });

    it('rejects a truncated frame', () => {
      const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
      const cut = frame.subarray(0, 6);
      expect(decodeHandshakePayload(MAGIC_TESTNET, cut))
        .toEqual({ kind: 'reject', code: 'not-a-frame' });
    });
  });

  it('validates compatible protocol version', () => {
    const result = validateHandshake(testMsg, [1]);
    expect(result.ok).toBe(true);
    expect(result.peerHeight).toBe(42);
    expect(result.msg).toEqual(testMsg);
  });

  it('rejects incompatible protocol version', () => {
    const result = validateHandshake({ ...testMsg, protocolVersion: 99 }, [1]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unsupported protocol version');
  });

  describe('ban policy', () => {
    const BAN_MS = 3_600_000;

    function makeMgr(): PeerManager {
      const config: NetConfig = {
        magic: 0x54444147,
        bootstrapPeers: [],
        listenAddrs: '/ip4/0.0.0.0/tcp/0',
        maxPeers: 10,
        penaltyScoreThreshold: 500,
        temporalBanDurationMs: BAN_MS,
        penaltySafeIntervalMs: 120_000,
        syncRequestTimeoutMs: 10_000,
      };
      const mgr = new PeerManager(config);
      mgr.addPeer({ id: 'peer1', multiaddrs: [], protocols: [], connectedAt: 0 });
      return mgr;
    }

    function applyMalformedPolicy(mgr: PeerManager): void {
      const decoded = decodeHandshakeBody(new Uint8Array([0xff]));
      expect(decoded).toBeNull();
      mgr.recordPenaltyKind(handshakePenalty('malformed'), 'peer1', 'handshake');
    }

    function applyVersionPolicy(mgr: PeerManager): void {
      const result = validateHandshake({ ...testMsg, protocolVersion: 99 }, [1]);
      expect(result.ok).toBe(false);
      mgr.recordPenaltyKind(handshakePenalty(result.rejection), 'peer1', 'handshake');
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('classifies an unsupported version as a compatibility mismatch', () => {
      const result = validateHandshake({ ...testMsg, protocolVersion: 99 }, [1]);
      expect(result.rejection).toBe('unsupported-version');
      expect(handshakePenalty(result.rejection)).toBe(PenaltyKind.Transient);
    });

    it('classifies malformed input as adversarial', () => {
      expect(handshakePenalty('malformed')).toBe(PenaltyKind.ProtocolViolation);
    });

    it('malformed body with bogus version classified as malformed (ordering pin)', () => {
      const body = validBody({ protocolVersion: 99, chainHeight: -1 as unknown as number });
      const decoded = decodeHandshakeBody(body);
      expect(decoded).toBeNull();
    });

    it('does NOT permanently ban a peer on an unsupported version', () => {
      const mgr = makeMgr();
      vi.spyOn(Date, 'now').mockReturnValue(0);
      applyVersionPolicy(mgr);
      expect(mgr.isBanned('peer1')).toBe(false);
      expect(mgr.getPeerCount()).toBe(1);
    });

    it('keeps a retrying version-mismatched peer on an expiring ban only', () => {
      const mgr = makeMgr();
      for (let i = 0; i < 13; i++) {
        vi.spyOn(Date, 'now').mockReturnValue(i * 12_000);
        applyVersionPolicy(mgr);
      }
      vi.spyOn(Date, 'now').mockReturnValue(12 * 12_000);
      expect(mgr.isBanned('peer1')).toBe(true);
      vi.spyOn(Date, 'now').mockReturnValue(12 * 12_000 + BAN_MS + 1);
      expect(mgr.isBanned('peer1')).toBe(false);
    });

    it('permanently bans a peer that sends a malformed handshake', () => {
      const mgr = makeMgr();
      vi.spyOn(Date, 'now').mockReturnValue(0);
      applyMalformedPolicy(mgr);
      expect(mgr.isBanned('peer1')).toBe(true);
      expect(mgr.getPeerCount()).toBe(0);
      vi.spyOn(Date, 'now').mockReturnValue(BAN_MS * 10);
      expect(mgr.isBanned('peer1')).toBe(true);
    });
  });

  it('rejects missing agentName', () => {
    const result = validateHandshake(testMsg, [1]);
    expect(result.ok).toBe(true);
    const decoded = decodeHandshakeBody(validBody({ agentName: '' }));
    expect(decoded).toBeNull();
  });

  describe('positional boundary', () => {
    it('returns null from parseHandshakeBody on garbage bytes', () => {
      expect(parseHandshakeBody(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBeNull();
    });

    it('rejects a null body in validateHandshake', () => {
      expect(validateHandshake(null, [1]).ok).toBe(false);
    });

    it('rejects truncated body', () => {
      const full = validBody();
      expect(decodeHandshakeBody(full.subarray(0, 3))).toBeNull();
    });

    it('rejects trailing bytes', () => {
      const full = validBody();
      const extra = new Uint8Array(full.length + 1);
      extra.set(full);
      expect(decodeHandshakeBody(extra)).toBeNull();
    });

    it('rejects agentName exceeding MAX_NAME_BYTES', () => {
      const decoded = decodeHandshakeBody(validBody({ agentName: 'a'.repeat(MAX_NAME_BYTES + 1) }));
      expect(decoded).toBeNull();
    });

    it('accepts agentName at exactly MAX_NAME_BYTES', () => {
      const decoded = decodeHandshakeBody(validBody({ agentName: 'a'.repeat(MAX_NAME_BYTES) }));
      expect(decoded).not.toBeNull();
      expect(decoded!.agentName).toHaveLength(MAX_NAME_BYTES);
    });

    it('rejects nodeName exceeding MAX_NAME_BYTES', () => {
      expect(decodeHandshakeBody(validBody({ nodeName: 'n'.repeat(MAX_NAME_BYTES + 1) }))).toBeNull();
    });

    it('rejects declaredAddress exceeding MAX_ADDRESS_BYTES', () => {
      expect(decodeHandshakeBody(validBody({
        declaredAddress: 'a'.repeat(MAX_ADDRESS_BYTES + 1),
      }))).toBeNull();
    });

    it('rejects capabilities count exceeding MAX_CAPABILITY_ENTRIES', () => {
      const caps = Array.from({length: MAX_CAPABILITY_ENTRIES + 1}, (_, i) => i);
      expect(decodeHandshakeBody(validBody({ capabilities: caps }))).toBeNull();
    });

    it('accepts capabilities at exactly MAX_CAPABILITY_ENTRIES', () => {
      const caps = Array.from({length: MAX_CAPABILITY_ENTRIES}, (_, i) => i);
      const decoded = decodeHandshakeBody(validBody({ capabilities: caps }));
      expect(decoded).not.toBeNull();
      expect(decoded!.capabilities).toHaveLength(MAX_CAPABILITY_ENTRIES);
    });

    it('rejects sessionMagic above MAX_UINT32', () => {
      expect(decodeHandshakeBody(validBody({ sessionMagic: MAX_UINT32 + 1 }))).toBeNull();
    });

    it('rejects chainHeight above MAX_ADVERTISED_HEIGHT', () => {
      expect(decodeHandshakeBody(validBody({ chainHeight: MAX_ADVERTISED_HEIGHT + 1 }))).toBeNull();
    });

    it('accepts chainHeight at exactly MAX_ADVERTISED_HEIGHT', () => {
      const decoded = decodeHandshakeBody(validBody({ chainHeight: MAX_ADVERTISED_HEIGHT }));
      expect(decoded).not.toBeNull();
      expect(decoded!.chainHeight).toBe(MAX_ADVERTISED_HEIGHT);
    });

    it('accepts absent declaredAddress', () => {
      const msg = { ...testMsg };
      delete msg.declaredAddress;
      const decoded = decodeHandshakeBody(encodeStruct(handshakeCodec, msg));
      expect(decoded).not.toBeNull();
      expect(decoded!.declaredAddress).toBeUndefined();
    });

    it('preserves unknown capability codes', () => {
      const decoded = decodeHandshakeBody(validBody({ capabilities: [1, 4242] }));
      expect(decoded).not.toBeNull();
      expect(decoded!.capabilities).toEqual([1, 4242]);
    });
  });
});
