import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

async function importDbFresh() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

describe('post_received via and post_bodies_pulled_total', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  it('notePostReceived("pull") increments post_bodies_pulled_total; "packet" does not', async () => {
    const metrics = await import('../../src/metrics.js');

    const before = metrics.getCounters().postBodiesPulledTotal;
    metrics.notePostReceived('packet');
    expect(metrics.getCounters().postBodiesPulledTotal).toBe(before);

    metrics.notePostReceived('pull');
    expect(metrics.getCounters().postBodiesPulledTotal).toBe(before + 1);
  });
});

describe('/health shape', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  it('syncing is true when sync_phase is backfill', async () => {
    const { createAdminRouter } = await import('../../src/routes/admin.js');
    const express = await import('express');

    const app = express.default();
    const router = createAdminRouter({
      getConnectedPeers: () => [],
      syncPhase: () => 'backfill',
    });
    app.use(router);

    const db = await importDbFresh();
    db.initDb(':memory:');

    const { initJournal } = await import('../../src/journal.js');
    initJournal();

    const request = (await import('supertest')).default;
    const res = await request(app).get('/health');
    expect(res.body.syncing).toBe(true);
    expect(res.body.sync_phase).toBe('backfill');
    db.closeDb();
  });

  it('syncing is false when sync_phase is synced', async () => {
    const { createAdminRouter } = await import('../../src/routes/admin.js');
    const express = await import('express');

    const app = express.default();
    const router = createAdminRouter({
      getConnectedPeers: () => [],
      syncPhase: () => 'synced',
    });
    app.use(router);

    const request = (await import('supertest')).default;
    const res = await request(app).get('/health');
    expect(res.body.syncing).toBe(false);
    expect(res.body.sync_phase).toBe('synced');
  });

  it('/stats serves post_bodies_pulled_total', async () => {
    const { createAdminRouter } = await import('../../src/routes/admin.js');
    const express = await import('express');

    const app = express.default();
    const router = createAdminRouter({
      getConnectedPeers: () => [],
      syncPhase: () => 'synced',
    });
    app.use(router);

    const request = (await import('supertest')).default;
    const res = await request(app).get('/stats');
    expect(res.body.counters).toHaveProperty('post_bodies_pulled_total');
    expect(typeof res.body.counters.post_bodies_pulled_total).toBe('number');
  });
});
