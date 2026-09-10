// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import { karmaResult } from './karma-fixture';

const HEX = (c: string): string => c.repeat(64);

function fakeApi(): Api {
  return {
    feed: async () => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async () => null,
    status: async () => ({
      networkType: 'test', blockHeight: 1, protocolVersion: 1, postCount: 0, pendingPosts: 0,
      totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0,
      vouchCooldownBlocks: 0, inviteBondMin: '0', inviteBondMax: '0',
      membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
    }),
    currentBlock: async () => ({ height: 1, hash: null }),
    karma: async () => karmaResult({ userId: 'x', height: 1 }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
  };
}

// A distinctive substring of the ring path — stable across regeneration only if
// the radius changes, and the ring path is the mark's most recognisable piece.
const RING_PATH = 'M 128 500 A 372 372 0 1 0 872 500';

describe('mark in the workspace header', () => {
  it('renders svg.mark with the ring path and no <use>', () => {
    const appbar = document.createElement('div');
    const feed = document.createElement('section'); feed.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    document.body.append(appbar, feed, panes);

    const app = new App(fakeApi());
    app.mount(appbar, feed, panes);

    const mark = appbar.querySelector('svg.mark');
    expect(mark).toBeTruthy();
    expect(mark!.innerHTML).toContain(RING_PATH);
    expect(document.querySelector('use')).toBeNull();
  });
});

describe('mark in the standalone header', () => {
  it('renders svg.mark with the ring path and no <use>', () => {
    const appbar = document.createElement('div');
    const feed = document.createElement('section'); feed.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    document.body.append(appbar, feed, panes);

    const app = new App(fakeApi());
    app.mount(appbar, feed, panes, { kind: 'standalone', id: HEX('a'), base: '/' });

    const mark = appbar.querySelector('svg.mark');
    expect(mark).toBeTruthy();
    expect(mark!.innerHTML).toContain(RING_PATH);
    expect(document.querySelector('use')).toBeNull();
  });
});
