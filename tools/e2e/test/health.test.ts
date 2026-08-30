import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx } from '../src/tx/post.js';
import {
  postInvite,
  postPost,
  getKarma,
  getStatus,
  hasKarma,
  getBlockCurrent,
  adminGet,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 6;

const HEALTH_KEYS = [
  'status',
  'dag_tip_height',
  'peers_connected',
  'last_post_received_ms_ago',
  'sync_phase',
  'syncing',
  'uptime_seconds',
  'protocol_version',
  'protocol_version_schedule',
  'apiVersion',
  'journalEventsVersion',
] as const;

const COUNTER_KEYS = [
  'posts_received_total',
  'posts_validated_total',
  'pow_verifications_total',
  'pow_verification_failures_total',
  'post_bodies_pulled_total',
  'http_requests_total',
] as const;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('health', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row a: /health and /stats shapes and values across the mesh', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 1 });
    const miner = mesh.nodes[0]!;

    // ---- mine before followers join so they provably sync ----
    await mine(miner, mesh.miningSecret, 1);
    await mesh.addNode();
    await mesh.addNode();
    await waitHeight(mesh.nodes, 1);

    const tips = await Promise.all(mesh.nodes.map(getBlockCurrent));
    for (const tip of tips) {
      expect(tip.height).toBe(1);
      expect(tip.hash).toBe(tips[0]!.hash);
    }

    // ---- /health before any post: shape, values, null last_post ----
    for (const node of mesh.nodes) {
      const h = await adminGet(node, '/health');
      const keys = Object.keys(h).sort();
      expect(keys).toEqual([...HEALTH_KEYS].sort());

      expect(h['status']).toBe('ok');
      expect(h['dag_tip_height']).toBe(
        (await getBlockCurrent(node)).height,
      );

      const peersConnected = h['peers_connected'] as number;
      expect(typeof peersConnected).toBe('number');
      // H2: measure the mesh topology — bootstrap-first may be a star
      expect(peersConnected).toBeGreaterThanOrEqual(1);

      expect(h['sync_phase']).toBe(node === miner ? 'idle' : 'synced');
      expect(h['syncing']).toBe(false);
      expect(h['last_post_received_ms_ago']).toBeNull();
      expect(typeof h['uptime_seconds']).toBe('number');
      expect(h['uptime_seconds'] as number).toBeGreaterThanOrEqual(0);
      // the era at dag_tip_height + 1, and the profile's rows
      // (NODE_INTERFACE → Admin Listener)
      expect(h['protocol_version']).toBe(1);
      expect(h['protocol_version_schedule']).toEqual([
        { version: 1, from_height: 0 },
      ]);
      expect(h['apiVersion']).toBe('1.0');
      expect(h['journalEventsVersion']).toBe('1.0');
    }

    // H2: the miner (node 0) is the bootstrap target — every non-zero
    // node dials it, so its peer count is exactly nodeCount − 1.
    const minerHealth = await adminGet(miner, '/health');
    expect(minerHealth['peers_connected']).toBe(mesh.nodes.length - 1);

    // ---- /stats shape before any post ----
    for (const node of mesh.nodes) {
      const s = await adminGet(node, '/stats');
      expect(typeof s['since']).toBe('number');
      expect(s['statsVersion']).toBe('1.0');
      const counters = s['counters'] as Record<string, number>;
      const cKeys = Object.keys(counters).sort();
      expect(cKeys).toEqual([...COUNTER_KEYS].sort());
    }

    // ---- post one thread, confirm it ----
    const version = (await getStatus(miner)).protocolVersion;
    const alice = fresh();
    const bondAmount = 50n;
    const faucetKarma = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const invite = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetKarma),
      alice,
      bondAmount,
      faucetKarma.height,
      version,
    );
    await postInvite(miner, invite.json);

    await confirm(
      async () => await hasKarma(miner, alice.publicKeyHex),
      miner,
      mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const thread = buildThreadTx(
      alice,
      karmaBoxes(aliceK),
      'health check post',
      aliceK.height,
      version,
    );

    // Submit the post to every node via HTTP so each fires emitPostReceived
    // from the local path. The gossip relay path (index.ts:189) fires only
    // when validateTx succeeds — on devnet the block carrying the post
    // arrives before the standalone gossip tx, its inputs are consumed, and
    // the relay handler returns early at :189 without emitting.
    await Promise.all(mesh.nodes.map((n) => postPost(n, thread.json, thread.content)));

    await confirm(
      async () => {
        const s = await adminGet(miner, '/stats');
        const c = s['counters'] as Record<string, number>;
        return c['posts_received_total']! >= 1;
      },
      miner,
      mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- /health after post: last_post_received_ms_ago is a number ----
    for (const node of mesh.nodes) {
      const h = await adminGet(node, '/health');
      expect(typeof h['last_post_received_ms_ago']).toBe('number');
    }

    // ---- /stats after post: counter assertions on every node ----
    for (const node of mesh.nodes) {
      const s = await adminGet(node, '/stats');
      const c = s['counters'] as Record<string, number>;
      expect(c['posts_received_total']).toBeGreaterThanOrEqual(1);
    }

    // H1: non-miner nodes verified the relayed block's PoW
    for (const node of mesh.nodes.slice(1)) {
      const s = await adminGet(node, '/stats');
      const c = s['counters'] as Record<string, number>;
      expect(c['pow_verifications_total']).toBeGreaterThanOrEqual(1);
    }

    // http_requests_total counts public-app requests; our admin reads
    // do not increment it, but earlier /status, /blocks/current, /karma,
    // /invites, /posts did
    for (const node of mesh.nodes) {
      const s = await adminGet(node, '/stats');
      const c = s['counters'] as Record<string, number>;
      expect(c['http_requests_total']).toBeGreaterThanOrEqual(1);
    }

  });
});
