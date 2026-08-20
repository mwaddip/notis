# Journal Events Contract

**Version:** 1.0
**Stability:** stable
**Last verified against code:** 2026-08-20

> ⚠ **PARTIAL — 15 events are declared below; 11 are emitted and 4 are NOT IMPLEMENTED. Re-derived
> 2026-08-20.** Every emitter is a `journal.ts` wrapper around `emitEvent`, and an event is emitted
> when its wrapper is called from `src`. **Emitted (11):** `server_starting`, `server_ready`,
> `shutdown_signal_received`, `server_shutting_down`, `db_open_started`, `db_open_complete`,
> `api_listening`, `post_received`, `post_validated`, `post_indexed`, `dag_reorg`. **Not implemented
> (4):** `sync_complete`, `peer_connected`, `peer_disconnected`, `peer_penalised` — all four wait on
> one `@dagsocial/net` passthrough, stated at their sections. "Stability: stable" refers to the
> *format contract* for events that are emitted; it is not a claim that an event exists.

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
  id — which may be `''`, NET_INTERFACE → the `fromPeerId` caveat)
**Emitted:** Once an arriving post is nameable: its creating transaction has
validated and `computePostId` can run. An id is not computable on an
unvalidated payload (TYPES_INTERFACE → Totality), so an invalid arrival emits
nothing.

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

> ⚠ **NOT IMPLEMENTED — verified 2026-08-20.** The three `journal.ts` wrappers exist and are called by
> `test/journal.test.ts` alone: `NetNode` handles libp2p's `peer:connect` / `peer:disconnect`
> internally and `penalizePeer` is its own method, none exposed to the node, so there is nothing for
> them to hook. A `@dagsocial/net` passthrough comes first, then node wiring.

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

> ⚠ **NOT IMPLEMENTED — verified 2026-08-20.** No wrapper and no emitter. `SyncMachine.onSynced` is
> public, but `NetNode` registers the callback internally and exposes no passthrough — the same
> `@dagsocial/net` change the peer events wait on.

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
