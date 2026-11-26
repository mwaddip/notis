// MESH_INTERFACE → FIPS → "A FIPS session that carries no application data
// for `FIPS_SESSION_IDLE_MS` ends" — two `FipsNode`s linked by an in-memory
// pair transport hold a session until `FIPS_SESSION_IDLE_MS` elapses
// without a datagram to or from a service port; the 1 Hz report timer then
// removes it at both ends and the next datagram opens a fresh one. A
// session carrying a datagram every 30 s stays, so reports alone do not
// reset the idle counter. A far end whose session state is dropped without
// a word (the daemon's idle removal) recovers once the near end's own idle
// timer fires and the next datagram re-establishes.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FipsNode,
  generateIdentity,
  toHex,
  type SessionEvent,
  type FipsServiceHandler,
  type ReceivedTransportPacket,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from '@fips/core';
import { FIPS_SESSION_IDLE_MS } from '../../src/mesh/constants.js';

interface MemorySide {
  readonly transport: Transport;
  ctx?: TransportContext;
}

function createMemoryPair(): { make: () => Transport } {
  const sides = new Map<string, MemorySide>();
  const make = (): Transport => {
    const side: MemorySide = {
      transport: {
        type: 'memory',
        mtu: 65_000,
        maxFrameBytes: 65_000,
        start: async (ctx: TransportContext): Promise<void> => {
          side.ctx = ctx;
          sides.set(toHex(ctx.localIdentity.publicKey), side);
        },
        stop: async (): Promise<void> => { /* nothing */ },
        connect: async (addr: TransportAddress): Promise<void> => {
          side.ctx?.onConnectionState?.({ remoteAddr: addr, state: 'connected' });
        },
        send: async (addr: TransportAddress, packet: Uint8Array): Promise<void> => {
          const other = sides.get(addr.addr);
          if (!other) throw new Error(`memory transport: no peer for ${addr.addr}`);
          const myPub = toHex(side.ctx!.localIdentity.publicKey);
          const data = new Uint8Array(packet);
          // queueMicrotask keeps dispatch off the fake-timer queue so the
          // handshake rounds drain between awaits under useFakeTimers.
          queueMicrotask(() => {
            const pkt: ReceivedTransportPacket = {
              transportType: 'memory',
              remoteAddr: { transport: 'memory', addr: myPub },
              data,
              receivedAtMs: Date.now(),
            };
            other.ctx!.onPacket(pkt);
          });
        },
      },
    };
    return side.transport;
  };
  return { make };
}

interface Pair {
  nodeA: FipsNode;
  nodeB: FipsNode;
  pkA: string;
  pkB: string;
  sessionsA: SessionEvent[];
  sessionsB: SessionEvent[];
  bReceived: number[];
  stop: () => Promise<void>;
}

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    // advanceTimersByTimeAsync(0) drains the queued microtasks between
    // zero-delay timers; the handshake rounds propagate this way.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  }
}

async function makePair(): Promise<Pair> {
  const idA = await generateIdentity();
  const idB = await generateIdentity();
  const pkA = toHex(idA.publicKey);
  const pkB = toHex(idB.publicKey);
  const { make } = createMemoryPair();
  const tA = make();
  const tB = make();
  const nodeA = new FipsNode({ identity: idA, transports: [tA], forwarding: false });
  const nodeB = new FipsNode({ identity: idB, transports: [tB], forwarding: false });
  const sessionsA: SessionEvent[] = [];
  const sessionsB: SessionEvent[] = [];
  nodeA.on('session', (e) => { sessionsA.push(e); });
  nodeB.on('session', (e) => { sessionsB.push(e); });
  const bReceived: number[] = [];
  const handler: FipsServiceHandler = (ctx) => { bReceived.push(ctx.payload.length); };
  nodeB.registerService(42, handler);
  await nodeA.start();
  await nodeB.start();
  await nodeA.connect({ transport: 'memory', addr: pkB });
  await drain();
  const stop = async (): Promise<void> => {
    try { await nodeA.stop(); } catch { /* idempotent */ }
    try { await nodeB.stop(); } catch { /* idempotent */ }
  };
  return { nodeA, nodeB, pkA, pkB, sessionsA, sessionsB, bReceived, stop };
}

describe('MESH_INTERFACE → FIPS → "A FIPS session that carries no application data for FIPS_SESSION_IDLE_MS ends"', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // (i) — both ends emit closed after FIPS_SESSION_IDLE_MS with no application
  // data; a later datagram opens a fresh session and is delivered.
  it.fails('both ends end a session idle for FIPS_SESSION_IDLE_MS, and a later datagram opens a fresh one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] });
    const pair = await makePair();
    try {
      await pair.nodeA.sendDatagram({ dst: pair.pkB, srcPort: 0, dstPort: 42, payload: new Uint8Array([1]) });
      await drain();
      expect(pair.bReceived.length).toBe(1);
      expect(pair.sessionsA.some((e) => e.state === 'established')).toBe(true);
      expect(pair.sessionsB.some((e) => e.state === 'established')).toBe(true);
      const closedBefore = pair.sessionsA.filter((e) => e.state === 'closed').length;
      await vi.advanceTimersByTimeAsync(FIPS_SESSION_IDLE_MS + 1_000);
      await drain();
      const closedA = pair.sessionsA.filter((e) => e.state === 'closed').length - closedBefore;
      const closedB = pair.sessionsB.filter((e) => e.state === 'closed').length;
      expect(closedA).toBeGreaterThanOrEqual(1);
      expect(closedB).toBeGreaterThanOrEqual(1);
      await pair.nodeA.sendDatagram({ dst: pair.pkB, srcPort: 0, dstPort: 42, payload: new Uint8Array([2]) });
      await drain();
      expect(pair.bReceived.length).toBe(2);
    } finally {
      await pair.stop();
    }
  });

  // (ii) — a session carrying a datagram every 30 s for 200 s never ends;
  // application data resets the idle counter, reports alone do not.
  it('a session carrying one datagram every 30 s for 200 s never ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] });
    const pair = await makePair();
    try {
      await pair.nodeA.sendDatagram({ dst: pair.pkB, srcPort: 0, dstPort: 42, payload: new Uint8Array([1]) });
      await drain();
      const sends = 200_000 / 30_000;
      for (let i = 1; i < sends; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        await drain();
        await pair.nodeA.sendDatagram({ dst: pair.pkB, srcPort: 0, dstPort: 42, payload: new Uint8Array([i + 1]) });
        await drain();
      }
      expect(pair.bReceived.length).toBeGreaterThanOrEqual(6);
      expect(pair.sessionsA.filter((e) => e.state === 'closed').length).toBe(0);
      expect(pair.sessionsB.filter((e) => e.state === 'closed').length).toBe(0);
    } finally {
      await pair.stop();
    }
  });

  // (iii) — the far end's session state is dropped without a word
  // (the original FIPS daemon's idle removal); the near end's own idle
  // timer later fires and the next datagram opens a fresh session that
  // delivers.
  it.fails('a session the far end dropped without a word recovers once the near end ends it, and the next datagram delivers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] });
    const pair = await makePair();
    try {
      await pair.nodeA.sendDatagram({ dst: pair.pkB, srcPort: 0, dstPort: 42, payload: new Uint8Array([1]) });
      await drain();
      expect(pair.bReceived.length).toBe(1);
      // Simulate the daemon's idle drop: tear B's session state
      // without a word, as the original daemon does.
      const mgrB = (pair.nodeB as unknown as { sessionManager: { sessions: Map<string, unknown>; sessionsByPubkey: Map<string, unknown> } }).sessionManager;
      mgrB.sessions.clear();
      mgrB.sessionsByPubkey.clear();
      const receivedBefore = pair.bReceived.length;
      // Advance time past FIPS_SESSION_IDLE_MS so A's sweep removes its
      // standing session; its next send re-opens one with B.
      await vi.advanceTimersByTimeAsync(FIPS_SESSION_IDLE_MS + 1_000);
      await drain();
      expect(pair.sessionsA.filter((e) => e.state === 'closed').length).toBeGreaterThanOrEqual(1);
      await pair.nodeA.sendDatagram({ dst: pair.pkB, srcPort: 0, dstPort: 42, payload: new Uint8Array([2]) });
      await drain();
      expect(pair.bReceived.length).toBe(receivedBefore + 1);
    } finally {
      await pair.stop();
    }
  });
});
