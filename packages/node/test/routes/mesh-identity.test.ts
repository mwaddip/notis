// NODE_INTERFACE → Mesh identity → "A mesh node answers its identity":
// `GET /mesh/identity` answers the identity line's four fields in order,
// read from `net` at the request; 404 on a node that runs no mesh or
// before its mesh has started. Every case enters through `createApp`
// (no hand-built twin of `server.ts`' deps).

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import type { MeshIdentity } from '@dagsocial/net';
import { createApp, type AppDeps } from '../../src/server.js';
import { makeTestConfig } from '../helpers.js';

const FIXTURE: MeshIdentity = {
  notisId: 'a'.repeat(64),
  peerId: '12D3KooWFixturePeerId000000000000000000000000000000000',
  multiaddrs: [
    '/ip4/127.0.0.1/udp/4011/webrtc-direct/certhash/uEiFixtureCertHash',
    '/ip4/127.0.0.1/tcp/4012',
  ],
  localAddrs: [
    '/ip4/192.168.1.10/udp/4013/webrtc-direct/certhash/uEiFixtureCertHash/p2p/12D3KooWFixturePeerId000000000000000000000000000000000',
  ],
};

function appWith(id: MeshIdentity | null) {
  const deps: AppDeps = { meshIdentity: () => id };
  return createApp(makeTestConfig({ port: 0 }), deps);
}

describe('GET /mesh/identity', () => {
  it('answers the identity\'s four fields in order', async () => {
    const res = await request(appWith(FIXTURE)).get('/mesh/identity');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['notisId', 'peerId', 'multiaddrs', 'localAddrs']);
    expect(res.body.notisId).toBe(FIXTURE.notisId);
    expect(res.body.peerId).toBe(FIXTURE.peerId);
    expect(res.body.multiaddrs).toEqual(FIXTURE.multiaddrs);
    expect(res.body.localAddrs).toEqual(FIXTURE.localAddrs);
  });

  it('answers 404 on an app with no mesh', async () => {
    const res = await request(appWith(null)).get('/mesh/identity');
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
  });

  it('answers 404 while the identity is null and 200 once it is not', async () => {
    let current: MeshIdentity | null = null;
    const deps: AppDeps = { meshIdentity: () => current };
    const app = createApp(makeTestConfig({ port: 0 }), deps);

    const before = await request(app).get('/mesh/identity');
    expect(before.status).toBe(404);

    current = FIXTURE;
    const after = await request(app).get('/mesh/identity');
    expect(after.status).toBe(200);
    expect(after.body.notisId).toBe(FIXTURE.notisId);
  });

  it('the answer carries access-control-allow-origin: *', async () => {
    const res = await request(appWith(FIXTURE)).get('/mesh/identity');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
