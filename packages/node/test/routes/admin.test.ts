import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createAdminRouter } from '../../src/routes/admin.js';
import {
  noteTip,
  notePostReceived,
  notePostValidated,
  notePowVerification,
  noteHttpRequest,
  resetForTests,
} from '../../src/metrics.js';

function adminApp(deps?: {
  getConnectedPeers?: () => string[];
  syncPhase?: () => 'idle' | 'syncing' | 'synced';
}): express.Express {
  const app = express();
  app.use(createAdminRouter({
    getConnectedPeers: deps?.getConnectedPeers ?? (() => []),
    syncPhase: deps?.syncPhase ?? (() => 'idle'),
  }));
  return app;
}

async function get(
  app: express.Express,
  path: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      http
        .get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: body });
            }
          });
        })
        .on('error', (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('admin routes', () => {
  beforeEach(() => {
    resetForTests();
  });

  describe('GET /health', () => {
    it('returns 200', async () => {
      const { status } = await get(adminApp(), '/health');
      expect(status).toBe(200);
    });

    it('returns the contract shape with default state', async () => {
      const { data } = await get(adminApp(), '/health');
      const body = data as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.dag_tip_height).toBe(0);
      expect(body.peers_connected).toBe(0);
      expect(body.last_post_received_ms_ago).toBeNull();
      expect(body.syncing).toBe(false);
      expect(typeof body.uptime_seconds).toBe('number');
      expect(body.apiVersion).toBe('1.0');
      expect(body.journalEventsVersion).toBe('1.0');
      expect(body).not.toHaveProperty('validated_height');
      expect(body).not.toHaveProperty('indexed_height');
    });

    it('reflects injected deps and pushed metrics', async () => {
      noteTip(42);
      const { data } = await get(adminApp({
        getConnectedPeers: () => ['a', 'b', 'c'],
        syncPhase: () => 'syncing',
      }), '/health');
      const body = data as Record<string, unknown>;
      expect(body.dag_tip_height).toBe(42);
      expect(body.peers_connected).toBe(3);
      expect(body.syncing).toBe(true);
      expect(body.status).toBe('ok');
    });

    it('last_post_received_ms_ago is null before the first post', async () => {
      const { data } = await get(adminApp(), '/health');
      const body = data as Record<string, unknown>;
      expect(body.last_post_received_ms_ago).toBeNull();
    });

    it('last_post_received_ms_ago is a number after a post', async () => {
      notePostReceived();
      const { data } = await get(adminApp(), '/health');
      const body = data as Record<string, unknown>;
      expect(typeof body.last_post_received_ms_ago).toBe('number');
      expect(body.last_post_received_ms_ago).toBeGreaterThanOrEqual(0);
    });

    it('syncing reflects the phase dep', async () => {
      const { data: d1 } = await get(adminApp({ syncPhase: () => 'synced' }), '/health');
      expect((d1 as Record<string, unknown>).syncing).toBe(false);

      const { data: d2 } = await get(adminApp({ syncPhase: () => 'syncing' }), '/health');
      expect((d2 as Record<string, unknown>).syncing).toBe(true);

      const { data: d3 } = await get(adminApp({ syncPhase: () => 'idle' }), '/health');
      expect((d3 as Record<string, unknown>).syncing).toBe(false);
    });

    it('uptime_seconds increases over time', async () => {
      const { data: data1 } = await get(adminApp(), '/health');
      const uptime1 = (data1 as Record<string, unknown>).uptime_seconds as number;
      await new Promise((r) => setTimeout(r, 1100));
      const { data: data2 } = await get(adminApp(), '/health');
      const uptime2 = (data2 as Record<string, unknown>).uptime_seconds as number;
      expect(uptime2).toBeGreaterThanOrEqual(uptime1 + 1);
    }, 5000);
  });

  describe('GET /stats', () => {
    it('returns 200', async () => {
      const { status } = await get(adminApp(), '/stats');
      expect(status).toBe(200);
    });

    it('returns the contract shape with zero counters', async () => {
      const { data } = await get(adminApp(), '/stats');
      const body = data as Record<string, unknown>;
      expect(typeof body.since).toBe('number');
      expect(body.since).toBeGreaterThan(0);
      expect(body.statsVersion).toBe('1.0');
      const counters = body.counters as Record<string, unknown>;
      expect(counters.posts_received_total).toBe(0);
      expect(counters.posts_validated_total).toBe(0);
      expect(counters.pow_verifications_total).toBe(0);
      expect(counters.pow_verification_failures_total).toBe(0);
      expect(counters.http_requests_total).toBe(0);
      expect(counters).not.toHaveProperty('posts_created_total');
      expect(counters).not.toHaveProperty('peer_messages_in_total');
      expect(counters).not.toHaveProperty('peer_bytes_in_total');
      expect(counters).not.toHaveProperty('unknown_message_types_total');
    });

    it('reflects pushed counters', async () => {
      notePostReceived();
      notePostReceived();
      notePostValidated();
      notePowVerification(true);
      notePowVerification(false);
      noteHttpRequest();
      noteHttpRequest();
      noteHttpRequest();
      const { data } = await get(adminApp(), '/stats');
      const body = data as Record<string, unknown>;
      const counters = body.counters as Record<string, unknown>;
      expect(counters.posts_received_total).toBe(2);
      expect(counters.posts_validated_total).toBe(1);
      expect(counters.pow_verifications_total).toBe(2);
      expect(counters.pow_verification_failures_total).toBe(1);
      expect(counters.http_requests_total).toBe(3);
    });
  });
});
