// MESH_INTERFACE → Discovery → "A node the access point answers" — the
// cases for `readLocalIdentity` (the read's refusals, loopback drop,
// the answered result) and `noNodeAnswered` (the predicate the client
// decides at a check's end).

import { describe, it, expect } from 'vitest';
import {
  readLocalIdentity,
  noNodeAnswered,
  LOCAL_IDENTITY_URL,
} from '../../src/mesh/local-lookup.js';
import { generateKeyPair, bytesToHex } from '@dagsocial/types';
import { nodeKeyFromKeyPair, peerIdFromNotisId } from '@dagsocial/net/browser';
import type { HttpFetch } from '@dagsocial/node-reads';
import { MESH_IDENTITY_READ_BYTES } from '@dagsocial/node-reads';
import type { TipEvent } from '../../src/mesh/tip-events.js';

function makeIdentity(): { notisId: string; peerId: string } {
  const notisId = nodeKeyFromKeyPair(generateKeyPair()).notisId;
  const peerId = peerIdFromNotisId(notisId).toString();
  return { notisId, peerId };
}

function addrsForKey(peerId: string): { priv: string; loop4: string; loop6: string } {
  return {
    priv: `/ip4/192.168.2.6/udp/9733/webrtc-direct/certhash/uEiA/p2p/${peerId}`,
    loop4: `/ip4/127.0.0.1/udp/9734/webrtc-direct/certhash/uEiB/p2p/${peerId}`,
    loop6: `/ip6/::1/udp/9735/webrtc-direct/certhash/uEiC/p2p/${peerId}`,
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchOf(reply: Response | Error): HttpFetch {
  return async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

describe('readLocalIdentity', () => {
  it('a well-formed answer is answered with its key and addresses', async () => {
    const { notisId, peerId } = makeIdentity();
    const { priv } = addrsForKey(peerId);
    const res = await readLocalIdentity(
      fetchOf(okResponse({ notisId, peerId, multiaddrs: [], localAddrs: [priv] })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('answered');
    if (res.result === 'answered') {
      expect(res.notisId).toBe(notisId);
      expect(res.localAddrs).toEqual([priv]);
    }
  });

  it("the Pi's measured answer is answered with the private address alone, the loopback one dropped", async () => {
    // Spec §8: a `0.0.0.0` listen on a Pi with one interface expands
    // to its private address and `127.0.0.1`. The client drops the
    // loopback one and keeps the other.
    const { notisId, peerId } = makeIdentity();
    const { priv, loop4 } = addrsForKey(peerId);
    const res = await readLocalIdentity(
      fetchOf(okResponse({
        notisId,
        peerId,
        multiaddrs: [],
        localAddrs: [priv, loop4],
      })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('answered');
    if (res.result === 'answered') {
      expect(res.localAddrs, 'the loopback address is dropped').toEqual([priv]);
    }
  });

  it('an answer whose every address is loopback is refused', async () => {
    const { notisId, peerId } = makeIdentity();
    const { loop4, loop6 } = addrsForKey(peerId);
    const res = await readLocalIdentity(
      fetchOf(okResponse({ notisId, peerId, multiaddrs: [], localAddrs: [loop4, loop6] })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('refused');
    if (res.result === 'refused') {
      expect(res.reason).toMatch(/loopback/);
    }
  });

  it('a transport failure reads as failed', async () => {
    const res = await readLocalIdentity(
      fetchOf(new Error('ECONNREFUSED')),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('failed');
    if (res.result === 'failed') {
      expect(res.message).toContain('ECONNREFUSED');
    }
  });

  it('a timed-out read reads as failed', async () => {
    // `AbortSignal.timeout` rejects with a TimeoutError; `fetchJson`
    // reads that as a transport failure of status 0 with `timedOut:
    // true`. `readLocalIdentity` treats it as `failed`.
    const err: Error & { name: string } = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const res = await readLocalIdentity(fetchOf(err), LOCAL_IDENTITY_URL);
    expect(res.result).toBe('failed');
  });

  it('a 404 reads as failed', async () => {
    const httpFetch: HttpFetch = async () => new Response('not found', { status: 404 });
    const res = await readLocalIdentity(httpFetch, LOCAL_IDENTITY_URL);
    expect(res.result).toBe('failed');
    if (res.result === 'failed') {
      expect(res.message).toMatch(/404/);
    }
  });

  it('an HTML answer at a 2xx is refused and adds nothing', async () => {
    // Review Focus 3: another network's portal answers 200 HTML. The
    // body does not parse as JSON, so `fetchJson` answers an
    // `unparseable body` at the 2xx status, and `readLocalIdentity`
    // reads that as `refused`.
    const httpFetch: HttpFetch = async () => new Response(
      '<html><head><title>Portal</title></head></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
    const res = await readLocalIdentity(httpFetch, LOCAL_IDENTITY_URL);
    expect(res.result).toBe('refused');
    if (res.result === 'refused') {
      expect(res.reason).toMatch(/unparseable/);
    }
  });

  it('a body one byte over the cap is refused', async () => {
    const body = 'x'.repeat(MESH_IDENTITY_READ_BYTES + 1);
    const httpFetch: HttpFetch = async () => new Response(body, { status: 200 });
    const res = await readLocalIdentity(httpFetch, LOCAL_IDENTITY_URL);
    expect(res.result).toBe('refused');
    if (res.result === 'refused') {
      expect(res.reason).toContain(String(MESH_IDENTITY_READ_BYTES));
    }
  });

  it('an answer that is not an object is refused', async () => {
    const res = await readLocalIdentity(fetchOf(okResponse([])), LOCAL_IDENTITY_URL);
    expect(res.result).toBe('refused');
    if (res.result === 'refused') expect(res.reason).toMatch(/not an object/);
  });

  it('a notisId that is not 64 lowercase hex is refused', async () => {
    const { peerId } = makeIdentity();
    const res = await readLocalIdentity(
      fetchOf(okResponse({ notisId: 'ABC', peerId, multiaddrs: [], localAddrs: [] })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('refused');
    if (res.result === 'refused') expect(res.reason).toMatch(/notisId/);
  });

  it('a peerId that does not match the key is refused', async () => {
    const a = makeIdentity();
    const b = makeIdentity();
    const { priv } = addrsForKey(a.peerId);
    const res = await readLocalIdentity(
      fetchOf(okResponse({ notisId: a.notisId, peerId: b.peerId, multiaddrs: [], localAddrs: [priv] })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('refused');
    if (res.result === 'refused') expect(res.reason).toMatch(/peerId/);
  });

  it('a localAddrs that is not a non-empty array is refused', async () => {
    const { notisId, peerId } = makeIdentity();
    const r1 = await readLocalIdentity(
      fetchOf(okResponse({ notisId, peerId, multiaddrs: [], localAddrs: [] })),
      LOCAL_IDENTITY_URL,
    );
    expect(r1.result).toBe('refused');
    if (r1.result === 'refused') expect(r1.reason).toMatch(/localAddrs/);
    const r2 = await readLocalIdentity(
      fetchOf(okResponse({ notisId, peerId, multiaddrs: [], localAddrs: 'nope' })),
      LOCAL_IDENTITY_URL,
    );
    expect(r2.result).toBe('refused');
  });

  it("LOCAL_IDENTITY_URL is the access point's address, never a name", () => {
    expect(LOCAL_IDENTITY_URL).toBe('http://10.78.79.1/mesh/identity');
    expect(new URL(LOCAL_IDENTITY_URL).hostname).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('a localAddrs entry with a DNS component is refused', async () => {
    const { notisId, peerId } = makeIdentity();
    const dnsAddr = `/dns4/example.test/udp/9733/webrtc-direct/certhash/uEiA/p2p/${peerId}`;
    const res = await readLocalIdentity(
      fetchOf(okResponse({ notisId, peerId, multiaddrs: [], localAddrs: [dnsAddr] })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('refused');
    if (res.result === 'refused') expect(res.reason).toMatch(/this key does not own/);
  });

  it('a localAddrs entry without /webrtc-direct/ is refused', async () => {
    const { notisId, peerId } = makeIdentity();
    const tcpAddr = `/ip4/192.168.2.6/tcp/9733/p2p/${peerId}`;
    const res = await readLocalIdentity(
      fetchOf(okResponse({ notisId, peerId, multiaddrs: [], localAddrs: [tcpAddr] })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('refused');
  });

  it('a localAddrs entry whose trailing /p2p/ is another key is refused', async () => {
    const a = makeIdentity();
    const b = makeIdentity();
    const foreign = `/ip4/192.168.2.6/udp/9733/webrtc-direct/certhash/uEiA/p2p/${b.peerId}`;
    const res = await readLocalIdentity(
      fetchOf(okResponse({ notisId: a.notisId, peerId: a.peerId, multiaddrs: [], localAddrs: [foreign] })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('refused');
    if (res.result === 'refused') expect(res.reason).toMatch(/this key does not own/);
  });

  it('a localAddrs entry that does not parse as a multiaddr is refused', async () => {
    const { notisId, peerId } = makeIdentity();
    const garbage = '/not-a-multiaddr';
    const res = await readLocalIdentity(
      fetchOf(okResponse({ notisId, peerId, multiaddrs: [], localAddrs: [garbage] })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('refused');
  });

  it('`multiaddrs` is not read: a garbage value does not refuse the answer', async () => {
    // The passage says `multiaddrs is not read` — a private node's are
    // relay addresses through public nodes the access point cannot
    // reach. The reader treats any value there as nothing.
    const { notisId, peerId } = makeIdentity();
    const { priv } = addrsForKey(peerId);
    const res = await readLocalIdentity(
      fetchOf(okResponse({ notisId, peerId, multiaddrs: 'garbage not an array', localAddrs: [priv] })),
      LOCAL_IDENTITY_URL,
    );
    expect(res.result).toBe('answered');
  });
});

describe('noNodeAnswered', () => {
  const id = bytesToHex(new Uint8Array(32));

  it('true for an empty list', () => {
    expect(noNodeAnswered([])).toBe(true);
  });

  it('true when every event is failure of kind transport', () => {
    const ev1: TipEvent = { id, ev: 'failure', kind: 'transport', message: 'unreachable' };
    const ev2: TipEvent = { id, ev: 'failure', kind: 'transport', message: 'ECONNREFUSED' };
    expect(noNodeAnswered([{ event: ev1 }, { event: ev2 }])).toBe(true);
  });

  it('false when one event is a success', () => {
    const transport: TipEvent = { id, ev: 'failure', kind: 'transport', message: '' };
    const ok: TipEvent = { id, ev: 'success' };
    expect(noNodeAnswered([{ event: transport }, { event: ok }])).toBe(false);
  });

  it('false when one failure is of a non-transport kind', () => {
    // A `refused` failure is a non-2xx answer: the node answered, just
    // not as expected. That counts as a node answering.
    const transport: TipEvent = { id, ev: 'failure', kind: 'transport', message: '' };
    const refused: TipEvent = { id, ev: 'failure', kind: 'refused', message: '500' };
    expect(noNodeAnswered([{ event: transport }, { event: refused }])).toBe(false);
  });
});
