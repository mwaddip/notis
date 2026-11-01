// MESH_INTERFACE → Place in the workspace — "libp2p is pinned." The
// member reaches a few libp2p internals that libp2p does not promise
// to keep across releases:
//   - the dial queue's `dial-queue:calculated-addresses` progress
//     event and the `AggregateError.errors` order, for per-address
//     attribution (`mesh-client.ts`).
// Each reach is held by a case against the real libp2p so an upgrade
// that moves it fails its case. The WSS listener's reach
// (`wss.ts:resolveInternals`), the private node's relay listen after
// start (`mesh-node.ts`), and the `node:stream` shim (`vite.config.ts`
// alias, `page/shims/node-stream.ts`) are not held here: the first by
// `wss.test.ts` ('a client reaches the node by key over WSS'), the
// second by `mesh-node.test.ts` ('a private node announces its
// circuit addresses alone').
//
// In-process, Node.js, TCP only, no root.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { createServer, type Server as NetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { generateKeyPair } from '@dagsocial/types';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { privateKeyFromRaw } from '@libp2p/crypto/keys';
import {
  attributeAggregateDialErrors,
  createDialProgressRecorder,
  unwrapAggregate,
} from '../src/client/mesh-client.js';
import { seedOfSecretKey } from '../src/identity.js';

/**
 * Bind a TCP server on a kernel-chosen loopback port and keep it open
 * for the whole case: a dial to the server's port can proceed through
 * the TCP handshake but every connection is destroyed before any
 * payload — libp2p reads the drop as a transport failure and emits
 * one AggregateError.errors entry per dial. Keeping the server open
 * holds the port against another process grabbing it mid-case.
 */
async function openRefusingServer(sinks: NetServer[]): Promise<number> {
  const s = createServer((sock) => {
    sock.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      s.removeListener('error', reject);
      resolve();
    });
  });
  sinks.push(s);
  return (s.address() as AddressInfo).port;
}

describe('libp2p-reaches — attribution against real libp2p', () => {
  let host: Libp2p | null = null;
  const sinks: NetServer[] = [];

  beforeEach(() => {
    // every afterEach cleans both lists; nothing to do before the
    // case except start fresh.
  });

  afterEach(async () => {
    try {
      await host?.stop();
    } catch {
      // already stopped
    }
    host = null;
    await Promise.all(
      sinks.splice(0).map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve())),
      ),
    );
  });

  it('dials two closed loopback TCP addresses for one key and the attribution records both', async () => {
    // Two refusing TCP servers on loopback, held open for the case's
    // duration — the ports stay out of the kernel's reuse pool so a
    // concurrent process can't grab them mid-dial.
    const port1 = await openRefusingServer(sinks);
    const port2 = await openRefusingServer(sinks);

    host = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });

    // One target key — two addresses for the same peer id. libp2p
    // dedups equal addresses, so the two ports differ.
    const kp = generateKeyPair();
    const seed = seedOfSecretKey(kp.secretKey);
    const privateKey = privateKeyFromRaw(seed);
    const targetPeerId = peerIdFromPrivateKey(privateKey).toString();
    const addr1 = `/ip4/127.0.0.1/tcp/${port1}/p2p/${targetPeerId}`;
    const addr2 = `/ip4/127.0.0.1/tcp/${port2}/p2p/${targetPeerId}`;

    const recorder = createDialProgressRecorder();
    const signal = AbortSignal.timeout(15_000);

    let caught: unknown = null;
    try {
      await host.dial(
        [multiaddr(addr1), multiaddr(addr2)],
        { signal, onProgress: recorder.onProgress },
      );
      throw new Error('expected the dial to fail — the ports refuse every connection');
    } catch (e) {
      caught = e;
    }

    // The two reaches held by this case:
    //   1. libp2p's dial queue fires `dial-queue:calculated-addresses`
    //      with every address it dialled, in its sorted order; a
    //      rename of that event string in `createDialProgressRecorder`
    //      leaves `recorder.reported` empty.
    //   2. libp2p throws AggregateError with one `errors` entry per
    //      address it dialled, in the matching positional order; a
    //      count mismatch returns `null` from
    //      `attributeAggregateDialErrors` and the case fails.
    expect(
      recorder.reported.length,
      `reported addresses = [${recorder.reported.join(', ')}]`,
    ).toBe(2);
    expect(recorder.reported).toContain(addr1);
    expect(recorder.reported).toContain(addr2);

    const inner = unwrapAggregate(caught);
    expect(
      inner.length,
      `inner errors from caught = ${(caught as Error)?.message ?? String(caught)}`,
    ).toBe(2);

    const attributed = attributeAggregateDialErrors(recorder.reported, inner);
    expect(
      attributed,
      `attribution for reported ${recorder.reported.length} / errors ${inner.length}`,
    ).not.toBeNull();
    const attributedAddrs = attributed!.map((r) => r.addr);
    expect(attributedAddrs).toContain(addr1);
    expect(attributedAddrs).toContain(addr2);
    // Every row carries a classified failure (not a wrong-key, since
    // nothing on the port answered a key).
    for (const row of attributed!) {
      expect(row.wrongKey, `wrongKey for ${row.addr}`).toBeNull();
      expect(row.kind, `kind for ${row.addr}`).toMatch(/transport|timeout/);
      expect(row.message.length, `message for ${row.addr}`).toBeGreaterThan(0);
    }
  }, 60_000);
});
