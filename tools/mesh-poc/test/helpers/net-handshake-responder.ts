// NET_INTERFACE → Handshake — a stand-in server-side handshake handler so
// a client test built around a mesh service (`startMeshNode`, which does
// not speak `net`'s handshake) still answers `net`'s reader handshake
// with `NODE_CAPABILITIES`. The helper reads the dialler's frame, writes
// back a frame of this host's own and closes. One handshake per
// connection — the one `readerHandshake` opens from the client side.
//
// This belongs beside the client tests so they run green against the
// client's handshake-before-read rule while `tools/mesh-poc/src/node/`
// still carries the PoC node; a later run that rebuilds the mesh-poc
// stage on integrated NetNodes deletes this file with `src/node/`.

import type { Libp2p } from '@libp2p/interface';
import {
  HANDSHAKE_PROTOCOL,
  NODE_CAPABILITIES,
  buildHandshakeFrame,
  decodeFrame,
  MAX_HANDSHAKE_FRAME_BYTES,
} from '@dagsocial/net/browser';

export interface HandshakeResponderOptions {
  readonly magic: number;
  readonly protocolVersion: number;
  readonly nodeName?: string;
  readonly chainHeight?: number;
  readonly capabilities?: readonly number[];
}

export async function attachNetHandshake(
  libp2p: Libp2p,
  opts: HandshakeResponderOptions,
): Promise<void> {
  const capabilities = opts.capabilities ?? NODE_CAPABILITIES;
  const nodeName = opts.nodeName ?? 'test-responder';
  const chainHeight = opts.chainHeight ?? 0;
  await libp2p.handle(HANDSHAKE_PROTOCOL, (stream) => {
    void (async () => {
      try {
        // Read the dialler's frame up to the shared cap.
        const chunks: Uint8Array[] = [];
        let total = 0;
        const iterable = stream as unknown as AsyncIterable<
          Uint8Array | { subarray(): Uint8Array }
        >;
        for await (const value of iterable) {
          const bytes = value instanceof Uint8Array ? value : value.subarray();
          chunks.push(bytes);
          total += bytes.length;
          if (total > MAX_HANDSHAKE_FRAME_BYTES) break;
        }
        if (total === 0 || total > MAX_HANDSHAKE_FRAME_BYTES) {
          await stream.close().catch(() => undefined);
          return;
        }
        const data = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { data.set(c, off); off += c.length; }
        // The reader's frame is what the dialler wrote. A malformed
        // frame is this helper's own problem; here it ends the stream
        // with nothing more to say.
        try { decodeFrame(opts.magic, data); } catch {
          await stream.close().catch(() => undefined);
          return;
        }
        // Write our own frame back carrying the capabilities asked for.
        const outFrame = buildHandshakeFrame(opts.magic, {
          agentName: 'test-responder',
          protocolVersion: opts.protocolVersion,
          nodeName,
          chainHeight,
          capabilities: [...capabilities],
        });
        const api = stream as unknown as {
          send: (b: Uint8Array) => boolean;
          onDrain: (ops?: { signal?: AbortSignal }) => Promise<void>;
          close: (ops?: { signal?: AbortSignal }) => Promise<void>;
        };
        if (!api.send(outFrame)) await api.onDrain();
        await api.close();
      } catch {
        try { await stream.close(); } catch { /* already gone */ }
      }
    })();
  });
}
