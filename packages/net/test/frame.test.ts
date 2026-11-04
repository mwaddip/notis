import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, MAGIC_TESTNET, MAGIC_MAINNET } from '@dagsocial/net';
import { ReaderError } from '@dagsocial/wire';
import {
  encodeFrame as encodeFrameNode,
  decodeFrame as decodeFrameNode,
} from '../src/frame.js';
import { decodeHandshakeBody } from '../src/handshake.js';
import {
  encodeFrame as encodeFrameBrowser,
  decodeFrame as decodeFrameBrowser,
  buildHandshakeFrame as buildHandshakeFrameBrowser,
} from '../src/browser.js';

describe('net frame', () => {
  it('round-trips a message', () => {
    const body = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(MAGIC_TESTNET, 1, body);
    const { code, body: decoded } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(1);
    expect(decoded).toEqual(body);
  });

  it('rejects wrong network', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array(0));
    expect(() => decodeFrame(MAGIC_MAINNET, frame)).toThrow(ReaderError);
  });

  it('rejects corrupted frame', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 5, new Uint8Array([42]));
    const last = frame.length - 1;
    frame[last] = frame[last]! ^ 0xff;
    expect(() => decodeFrame(MAGIC_TESTNET, frame)).toThrow('checksum');
  });
});

// NET_INTERFACE → The browser entry → "The frame codec is one code with its
// checksum handed in". The Node entry's checksum is Node's
// `createHash('blake2b512')…subarray(0, 32)`; the browser entry's is
// `hash32` — `@noble/hashes`' `blake2b` with `dkLen: 64` then
// `slice(0, 32)` (TYPES_INTERFACE → The protocol hash → "Truncated BLAKE2b-512,
// never BLAKE2b-256"). The two answer the same 32 bytes, so the two codecs
// produce one frame.
describe('net frame — Node and browser bindings on one wire', () => {
  for (const size of [0, 1, 984, 4_194_304]) {
    it(`same bytes on ${size}-byte body: Node encode → browser decode, browser encode → Node decode, byte-equal encodings`, () => {
      const body = new Uint8Array(size);
      for (let i = 0; i < size; i++) body[i] = (i * 2654435761) >>> 24;
      const node = encodeFrameNode(MAGIC_TESTNET, 7, body);
      const browser = encodeFrameBrowser(MAGIC_TESTNET, 7, body);
      expect(browser).toEqual(node);
      const underBrowser = decodeFrameBrowser(MAGIC_TESTNET, node);
      expect(underBrowser.code).toBe(7);
      expect(underBrowser.body).toEqual(body);
      const underNode = decodeFrameNode(MAGIC_TESTNET, browser);
      expect(underNode.code).toBe(7);
      expect(underNode.body).toEqual(body);
    });
  }

  // NET_INTERFACE → The browser entry — the browser's handshake frame is
  // one the Node entry decodes.
  it("a handshake frame the browser entry builds is accepted by the Node entry's decodeFrame and decodeHandshakeBody", () => {
    const msg = {
      agentName: 'notis-net',
      protocolVersion: 2,
      nodeName: 'reader',
      chainHeight: 42,
      capabilities: [] as number[],
    };
    const frame = buildHandshakeFrameBrowser(MAGIC_TESTNET, msg);
    const decoded = decodeFrameNode(MAGIC_TESTNET, frame);
    expect(decoded.code).toBe(1);
    const body = decodeHandshakeBody(decoded.body);
    expect(body).not.toBeNull();
    expect(body!.agentName).toBe(msg.agentName);
    expect(body!.protocolVersion).toBe(msg.protocolVersion);
    expect(body!.nodeName).toBe(msg.nodeName);
    expect(body!.chainHeight).toBe(msg.chainHeight);
    expect(body!.capabilities).toEqual(msg.capabilities);
  });
});
