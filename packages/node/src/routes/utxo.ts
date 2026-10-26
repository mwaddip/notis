import { Router, Response } from 'express';
import type {
  UtxoTransaction,
  KarmaBox,
  CreditBox,
  BondBox,
  DecayCfg,
  IdentityRecord,
} from '@dagsocial/types';
import { effectiveKarma, EMPTY_IDENTITY_RECORD, membershipBar } from '@dagsocial/types';
import { sendCredits } from '../services/credits.js';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { availableInvites, isMember } from '@dagsocial/consensus';
import type { NetworkRecord } from '../store/identity-records.js';
import type { Page, PageResult, BoxKey } from '../store/index.js';
import { getNet } from '../services/net-instance.js';
import { checkRequestTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import { parseLimit, isLimitError, parseAfter, isAfterError, parseFlag, isFlagError, formatKey, resolveIdentityParam, isResolveError } from './page.js';
import type { UsernameLookup } from './page.js';
import { nameFor } from '../services/name-cache.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface UtxoDeps {
  getKarmaTotal(owner: Uint8Array): bigint;
  getKarmaBoxesPage(owner: Uint8Array, page: Page<BoxKey>): PageResult<KarmaBox, BoxKey>;
  getIdentityRecord(owner: Uint8Array): IdentityRecord | null;
  getCreditValue(owner: Uint8Array): bigint;
  getCreditBoxesPage(owner: Uint8Array, page: Page<BoxKey>): PageResult<CreditBox, BoxKey>;
  getBondBoxesPage(inviterId: Uint8Array, page: Page<string>): PageResult<BondBox, string>;
  // NODE_INTERFACE → UTXO queries → "`pending=1` answers the pending view,
  // as admission spends from it": the pool's view, asked by owner and type
  // (NODE_INTERFACE → Store Interface → Mempool).
  getBoxesPageWithPending(
    owner: Uint8Array,
    boxType: 'karma' | 'credit',
    page: Page<BoxKey>,
  ): PageResult<KarmaBox | CreditBox, BoxKey>;
  getBoxTotalWithPending(owner: Uint8Array, boxType: 'karma' | 'credit'): bigint;
  // Admission's `held` and `owed` readers (NODE_INTERFACE → Karma transition
  // rules → "Engine inputs the rule needs"): the two numbers the flag's
  // `effective` on `/karma` reads at `tip + 1`.
  admissionHeld(owner: Uint8Array): bigint;
  admissionOwed(owner: Uint8Array, height: number): bigint;
  getCurrentHeight(): number;
  getUtxoEngineDeps(): UtxoEngineDeps;
  decayCfg: DecayCfg;
  getNetworkRecord(): NetworkRecord;
  membershipBarMultiplier: number;
  getUsername: UsernameLookup;
  getUsernameByOwner: (owner: Uint8Array | string) => { name: string } | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: UtxoDeps): Router {
  const router = Router();

  function parseUserId(param: string, res: Response): Uint8Array | null {
    const resolved = resolveIdentityParam(param, deps.getUsername);
    if (isResolveError(resolved)) {
      res.status(resolved.status).json({ error: resolved.error });
      return null;
    }
    return new Uint8Array(Buffer.from(resolved.hex, 'hex'));
  }

  // GET /karma/:userId
  router.get('/karma/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const limit = parseLimit(req.query as Record<string, unknown>);
    if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
    const after = parseAfter(req.query as Record<string, unknown>, 'box');
    if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }
    // NODE_INTERFACE → UTXO queries → "`pending=1` answers the pending
    // view, as admission spends from it": the five fields range the pool's
    // view under the flag, every other field reads as without it.
    const pending = parseFlag(req.query as Record<string, unknown>, 'pending');
    if (isFlagError(pending)) { res.status(400).json({ error: pending.error }); return; }

    const record = deps.getIdentityRecord(userIdBytes);
    const height = deps.getCurrentHeight();

    let total: bigint;
    let eff: bigint;
    let pageResult: PageResult<KarmaBox | CreditBox, BoxKey>;
    if (pending) {
      pageResult = deps.getBoxesPageWithPending(userIdBytes, 'karma', {
        limit, after: after as BoxKey | undefined,
      });
      total = deps.getBoxTotalWithPending(userIdBytes, 'karma');
      // NODE_INTERFACE → Karma transition rules → "A karma spend is covered
      // by effective karma, over the block's body as a whole": `remaining`
      // is `held − owed` at `tip + 1`, clamped at `0`.
      const held = deps.admissionHeld(userIdBytes);
      const owed = deps.admissionOwed(userIdBytes, height + 1);
      eff = held > owed ? held - owed : 0n;
    } else {
      pageResult = deps.getKarmaBoxesPage(userIdBytes, {
        limit, after: after as BoxKey | undefined,
      });
      total = deps.getKarmaTotal(userIdBytes);
      eff = effectiveKarma(total, record, height, deps.decayCfg);
    }

    const memberFlag = record !== null && isMember(record);
    // CONSENSUS_INTERFACE → What it holds → "Who may invite, and how many, is
    // one function": `null` for a root, the number clamped at `0` for a
    // member, `0` for anyone else.
    const budget = availableInvites(
      record,
      () => membershipBar(deps.getNetworkRecord().memberCount, deps.membershipBarMultiplier),
    );
    const invitesAvailable: number | null =
      budget === 'root' ? null
      : typeof budget === 'number' ? Math.max(0, budget)
      : 0;

    const karmaRows = pageResult.rows as KarmaBox[];
    // TYPES_INTERFACE → Identity record and karma valuation: the record of
    // an identity no block has written values as every field 0 and the two
    // bigint counters 0n.
    const r = record ?? EMPTY_IDENTITY_RECORD;
    res.json({
      userId: Buffer.from(userIdBytes).toString('hex'),
      total: total.toString(),
      effective: eff.toString(),
      // NODE_INTERFACE → UTXO queries, the `/karma/:userId` row of the API
      // table: a box carries `income: true` when it is the owner's income
      // box and no such key when it is their own (TYPES_INTERFACE →
      // KarmaBox). A pooled karma output carries no `income` key by rule
      // 2 of NODE_INTERFACE → Karma transition rules → "No karma output
      // carries the mark".
      boxes: karmaRows.map(b => ({
        boxId: b.id!,
        value: b.value.toString(),
        ...(b.income === true ? { income: true } : {}),
      })),
      boxCount: pageResult.count,
      next: pageResult.next ? formatKey('box', pageResult.next) : null,
      lastActivityBlock: r.lastActivityBlock,
      lastDecayBlock: r.lastDecayBlock,
      lifetimeLikesReceived: r.lifetimeLikesReceived.toString(),
      memberSinceBlock: r.memberSinceBlock,
      memberBar: r.memberBar,
      memberVouches: r.memberVouches,
      memberLikes: r.memberLikes.toString(),
      invitesUsed: r.invitesUsed,
      invitedAtBlock: r.invitedAtBlock,
      member: memberFlag,
      invitesAvailable,
      height,
    });
  });

  // GET /credits/:userId
  router.get('/credits/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const limit = parseLimit(req.query as Record<string, unknown>);
    if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
    const after = parseAfter(req.query as Record<string, unknown>, 'box');
    if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }
    // NODE_INTERFACE → UTXO queries → "`pending=1` answers the pending
    // view, as admission spends from it": the four fields range the pool's
    // view under the flag; every other field reads as without it.
    const pending = parseFlag(req.query as Record<string, unknown>, 'pending');
    if (isFlagError(pending)) { res.status(400).json({ error: pending.error }); return; }

    let total: bigint;
    let pageResult: PageResult<KarmaBox | CreditBox, BoxKey>;
    if (pending) {
      total = deps.getBoxTotalWithPending(userIdBytes, 'credit');
      pageResult = deps.getBoxesPageWithPending(userIdBytes, 'credit', {
        limit, after: after as BoxKey | undefined,
      });
    } else {
      total = deps.getCreditValue(userIdBytes);
      pageResult = deps.getCreditBoxesPage(userIdBytes, {
        limit, after: after as BoxKey | undefined,
      });
    }

    const creditRows = pageResult.rows as CreditBox[];
    res.json({
      userId: Buffer.from(userIdBytes).toString('hex'),
      total: total.toString(),
      boxes: creditRows.map(b => ({
        boxId: b.id!,
        value: b.value.toString(),
        ...(b.lockedUntilBlock !== undefined ? { lockedUntilBlock: b.lockedUntilBlock } : {}),
      })),
      boxCount: pageResult.count,
      next: pageResult.next ? formatKey('box', pageResult.next) : null,
    });
  });

  // POST /credits/transfer — pool a client-built, client-signed credit
  // transfer: checkRequestTx → validateTx + admitTx in the service → broadcast
  // → pending response, the path every other tx route takes. Credits move when
  // the transaction is mined.
  router.post('/credits/transfer', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = checkRequestTx(body.tx, deps.getCurrentHeight() + 1, deps.getUtxoEngineDeps().protocolVersionSchedule);
    } catch (err) {
      respondError(res, err, 'POST /credits/transfer (tx decode)', 'message');
      return;
    }

    try {
      // Admission judges at tip + 1 (NODE_INTERFACE → validateTx).
      const currentHeight = deps.getCurrentHeight() + 1;
      const result = sendCredits(deps.getUtxoEngineDeps(), tx, currentHeight);

      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast credit transfer tx: ${err.message}`);
        });
      }

      res.json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
      });
    } catch (err: unknown) {
      respondError(res, err, 'POST /credits/transfer', 'message');
    }
  });

  // NODE_INTERFACE → UTXO queries — a bond IS the open invite; unspent bonds only.
  router.get('/invites/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const limit = parseLimit(req.query as Record<string, unknown>);
    if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
    const after = parseAfter(req.query as Record<string, unknown>, 'id');
    if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }

    const pageResult = deps.getBondBoxesPage(userIdBytes, {
      limit, after: after as string | undefined,
    });

    // NODE_INTERFACE → Usernames → "A list row carries its names"
    const names = new Map<string, string | null>();
    res.json({
      bonds: pageResult.rows.map((b) => {
        const inviterHex = Buffer.from(b.inviterId).toString('hex');
        const inviteeHex = Buffer.from(b.inviteePublicKey).toString('hex');
        return {
          id: b.id,
          value: b.value.toString(),
          inviterId: inviterHex,
          inviterName: nameFor(inviterHex, names, deps.getUsernameByOwner),
          inviteePublicKey: inviteeHex,
          inviteeName: nameFor(inviteeHex, names, deps.getUsernameByOwner),
          createdAtBlock: b.createdAtBlock,
        };
      }),
      bondCount: pageResult.count,
      next: pageResult.next,
    });
  });

  return router;
}
