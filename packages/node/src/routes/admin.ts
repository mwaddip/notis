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
  syncPhase: () => 'idle' | 'syncing' | 'synced';
}

export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      dag_tip_height: getDagTipHeight(),
      peers_connected: deps.getConnectedPeers().length,
      last_post_received_ms_ago: getLastPostReceivedMsAgo(),
      syncing: deps.syncPhase() === 'syncing',
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
      },
    });
  });

  return router;
}
