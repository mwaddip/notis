# Journal Events Contract

**Version:** 1.0
**Stability:** stable
**Last verified against code:** 2026-08-22

> ✅ **15 events are declared below and 15 are emitted — re-derived 2026-08-22.** Every emitter is a
> `journal.ts` wrapper around `emitEvent`, and an event is emitted when its wrapper is called from `src`.
> The four that read `@dagsocial/net` — `peer_connected`, `peer_disconnected`, `peer_penalised`,
> `sync_complete` — fire from the hooks `NetNode` exposes (NET_INTERFACE → API → Sync Handler
> Registration), registered in `node/src/index.ts`. "Stability: stable" refers to the *format contract*.
> `post_received` and `post_validated` are also counted (NODE_INTERFACE → Admin Listener — the `/stats`
> counters count these events at their wrappers).

> ⚠ **Two different things share the word "journal" and this document covers only one.**
> **This file** = the JSON-line **observability event log**. **`BlockJournal` / `BoxMutation`**
> (Spec B P1) = the **record-once consensus mutation log** at the store choke point, which
> feeds the AVL prover and the `stateRoot`. They are unrelated. `BlockJournal` is specified
> in `NODE_INTERFACE.md → Store Interface → Block Journal`, **not here.** Do not reason from
> one to the other.

## Format

JSON-line output. Each line is a single JSON object with these required
fields:

```json
{
  "event": "<marker-prefix>",
  "level": "INFO",
  "timestamp": "2026-07-26T..."
}
```

Event-specific fields are additional top-level keys.

**Stability classification:**
- `stable`: Marker prefix, field names, field types, and emission
  preconditions frozen across the major version. Removal requires a
  major bump and a deprecation release.
- `experimental`: New events start here. May change or be removed in
  minor versions.

**Version advertisement:** `GET /health` returns `journalEventsVersion`.

## Lifecycle Events

### server_starting
**Level:** INFO
**Fields:** `version` (string), `network` (string)
**Emitted:** First line after logger init, before any I/O.

### server_ready
**Level:** INFO
**Fields:** `bind_address` (string), `admin_address` (string),
  `duration_ms` (number)
**Emitted:** After all subsystems are up and accepting traffic.

### shutdown_signal_received
**Level:** INFO
**Fields:** `signal` (string)
**Emitted:** On SIGTERM or SIGINT.

### server_shutting_down
**Level:** INFO
**Fields:** `reason` (string)
**Emitted:** After final flush, before process exit.

## Phase Timing Events

### db_open_started
**Level:** INFO
**Fields:** `path` (string)
**Emitted:** Before opening the SQLite database.

### db_open_complete
**Level:** INFO
**Fields:** `duration_ms` (number)
**Emitted:** After the SQLite database is open and its migrations have run.

> ✅ **Both are emitted, and `initDb` brackets itself.** `db_open_complete` fires at the **end** of
> `initDb`, past `createMempoolGateIndexes` — a sixth pass after the five `migrate*` calls — since
> the contract's "after the migrations have run" means after the last pass the database needs to be
> usable, not after the five that carry the `migrate` prefix.

### api_listening
**Level:** INFO
**Fields:** `bind_address` (string), `port` (number)
**Emitted:** After `app.listen()` succeeds on the public API port.

## Core Events

### post_received
**Level:** INFO
**Fields:** `post_id` (string), `source` (string: "local" or the relaying peer
  id — which may be `''`, NET_INTERFACE → the `fromPeerId` caveat; for a pulled body, the
  serving peer), `via` (string: "packet" — the body arrived with its transaction, locally or
  by gossip — or "pull" — a placeholder's body arrived by id, NODE_INTERFACE → Store Interface
  → Posts DAG, "Backfill after sync")
**Emitted:** Once an arriving post is nameable: its creating transaction has
validated and `computePostId` can run — and, for `via: "pull"`, once the body verified
against the row's commitment and was stored. An id is not computable on an
unvalidated payload (TYPES_INTERFACE → Totality), so an invalid arrival emits
nothing. A post applied from a block without its body emits `post_indexed` for the
placeholder row and `post_received` only when the body arrives.

### post_validated
**Level:** INFO
**Fields:** `post_id` (string), `validation_duration_ms` (number)
**Emitted:** After the arrival path's validation passes. The duration spans the
work that path runs locally — `verifyPost` + `validateTx` on the local API
path, `validateTx` alone on the relay path — so the two paths' durations are
not comparable.

### post_indexed
**Level:** INFO
**Fields:** `post_id` (string), `parent_ref_count` (number: 0 root, 1 reply)
**Emitted:** After the post is stored — at local creation, or at block
application for a post first stored there. Once per post. `parent_ref_count`
is the post's own parent-ref count; DAG depth is a consumer's store walk, not
a field.

### dag_reorg
**Level:** WARN
**Fields:** `fork_point` (string), `demoted` (number), `old_tip` (string),
  `new_tip` (string)
**Emitted:** After canonical branch switch completes.

## Peer Events

The three fire from `NetNode`'s hooks — `onPeerActive(peerId, direction)`, `onPeerDisconnected(peerId,
reason)`, `onPeerPenalised(peerId, kind, detail)` (NET_INTERFACE → API → Sync Handler Registration) —
registered in `node/src/index.ts`. `reason` on a disconnect is always `''` (libp2p's `peer:disconnect`
carries none). `peer_penalised` fires for every penalty path, `gossip.ts`'s included — the hook is at
`PeerManager`'s two penalty entries.

### peer_connected
**Level:** INFO
**Fields:** `peer_id` (string), `direction` (string: "inbound" | "outbound")
**Emitted:** After handshake completes.

### peer_disconnected
**Level:** INFO
**Fields:** `peer_id` (string), `reason` (string)
**Emitted:** On disconnect.

### peer_penalised
**Level:** WARN
**Fields:** `peer_id` (string), `kind` (string), `detail` (string | null)
**Emitted:** On protocol violation by a peer.

## Sync Events

Fires from `NetNode.onSyncComplete` (every entry into the `synced` phase) through the `emitSyncComplete`
wrapper; `duration_ms` is measured since process start for the first and since the previous
`sync_complete` after. ⚠ **The phase is entered only when a peer's `SyncInfo` reports `tipHeight ===
ourHeight` while the machine is `syncing` (NET_INTERFACE → Sync State Machine)** — under continuous fast
block production (devnet) the two may never coincide at an exchange, and the event then never fires; the
wiring is not what decides it.

### sync_complete
**Level:** INFO
**Fields:** `tip_height` (number), `duration_ms` (number)
**Emitted:** First time `synced() == true` after startup or after dropping
  out of sync.

## What this contract is NOT

- NOT a complete list of every log line — only the stable, machine-parseable
  events
- NOT a guarantee of emission timing within a phase — only ordering between
  phases is guaranteed
- NOT a serialization format spec — the output is JSON-line, but the exact
  whitespace is unspecified
