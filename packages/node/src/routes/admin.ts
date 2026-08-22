// NODE_INTERFACE → Admin Listener: a pure reader of metrics.ts and injected net deps.
import { Router } from 'express';
import {
  getDagTipHeight,
  getLastPostReceivedMsAgo,
  getUptimeSeconds,
  getSince,
  getCounters,
} from '../metrics.js';

export interface AdminDeps {
  getConnectedPeers: () => string[];
  syncPhase: () => 'idle' | 'syncing' | 'backfill' | 'synced';
}

export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const phase = deps.syncPhase();
    res.json({
      status: 'ok',
      dag_tip_height: getDagTipHeight(),
      peers_connected: deps.getConnectedPeers().length,
      last_post_received_ms_ago: getLastPostReceivedMsAgo(),
      syncing: phase === 'syncing' || phase === 'backfill',
      sync_phase: phase,
      uptime_seconds: getUptimeSeconds(),
      apiVersion: '1.0',
      journalEventsVersion: '1.0',
    });
  });

  router.get('/stats', (_req, res) => {
    const c = getCounters();
    res.json({
      since: getSince(),
      statsVersion: '1.0',
      counters: {
        posts_received_total: c.postsReceivedTotal,
        posts_validated_total: c.postsValidatedTotal,
        pow_verifications_total: c.powVerificationsTotal,
        pow_verification_failures_total: c.powVerificationFailuresTotal,
        http_requests_total: c.httpRequestsTotal,
        post_bodies_pulled_total: c.postBodiesPulledTotal,
      },
    });
  });

  return router;
}
