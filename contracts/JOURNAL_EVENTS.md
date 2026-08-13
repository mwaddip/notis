# Journal Events Contract

**Version:** 1.0
**Stability:** stable
**Last verified against code:** 2026-08-06

> ⚠ **PARTIAL — and the shortfall is most of the document. Re-verified 2026-08-11.**
> **17 of the 22 events declared "stable" below are never emitted, and 8 have no emitter
> anywhere in the codebase.**
>
> **Both halves re-derived: 22 events are declared, and these 8 do not appear in any
> package's `src` at all** — `api_listening`, `dag_load_started`, `dag_load_complete`,
> `db_open_started`, `db_open_complete`, `migration_started`, `migration_complete`,
> `sync_complete`. The other 14 names occur somewhere in `src`, but **occurring is not
> emitting**: a name can appear in a type or a comment. The "17 never emitted" figure was not
> re-derived here and rests on the original audit; the 8 is exact. This file was written 2026-07-26 and **not one line was
> changed** through Specs A–G; the Peer and Sync families predate the net package's peer
> discovery and sync work, and the Migration family predates the schema-version guard.
> Treat every event here as unimplemented unless you have found its emitter. "Stability:
> stable" refers to the *format contract* for events that are emitted — it is not a claim
> that the events exist.
>
> Per-family status is marked at each heading. Full inventory:
> `prompts/audit-node-store.report.md`.

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

> ⚠ **NOT IMPLEMENTED.** Neither `db_open_started` nor `db_open_complete` is emitted anywhere in
> `packages/node/src` — measured 2026-08-13, and the gap predates this note. The field list above
> is what an implementation should carry, not a description of output anyone can observe.

### dag_load_started
**Level:** INFO
**Fields:** (none)
**Emitted:** Before rebuilding the in-memory DAG view from canonical_branch.

### dag_load_complete
**Level:** INFO
**Fields:** `post_count` (number), `duration_ms` (number)
**Emitted:** After the canonical branch is loaded into memory.

### api_listening
**Level:** INFO
**Fields:** `bind_address` (string), `port` (number)
**Emitted:** After `app.listen()` succeeds on the public API port.

## Core Events

### post_received
**Level:** INFO
**Fields:** `post_id` (string), `source` (string: "local" or peer_id)
**Emitted:** On post arrival via gossip or local API.

### post_validated
**Level:** INFO
**Fields:** `post_id` (string), `validation_duration_ms` (number)
**Emitted:** After all validation phases pass.

### post_indexed
**Level:** INFO
**Fields:** `post_id` (string), `depth` (number)
**Emitted:** After post is stored and linked into the DAG.

### pow_verification_failed
**Level:** WARN
**Fields:** `post_id` (string), `reason` (string)
**Emitted:** On PoW check failure.

### dag_reorg
**Level:** WARN
**Fields:** `fork_point` (string), `demoted` (number), `old_tip` (string),
  `new_tip` (string)
**Emitted:** After canonical branch switch completes.

## Anomaly Events

### validation_stuck
**Level:** WARN
**Fields:** `post_id` (string), `reason` (string), `attempt_count` (number)
**Emitted:** When the same post fails validation for 5+ consecutive sweeps.

### dag_height_drift
**Level:** WARN
**Fields:** `gap` (number), `mode` (string), `old_height` (number),
  `new_height` (number)
**Emitted:** At most once at startup when databases disagree on validated
  height. Absence = databases agreed.

## Peer Events

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

### sync_complete
**Level:** INFO
**Fields:** `tip_height` (number), `duration_ms` (number)
**Emitted:** First time `synced() == true` after startup or after dropping
  out of sync.

## Migration Events

### migration_started
**Level:** INFO
**Fields:** `name` (string), `from_version` (number), `to_version` (number)
**Emitted:** Before migration N begins.

### migration_complete
**Level:** INFO
**Fields:** `name` (string), `duration_ms` (number), `rows_affected` (number)
**Emitted:** After migration N commits.

## What this contract is NOT

- NOT a complete list of every log line — only the stable, machine-parseable
  events
- NOT a guarantee of emission timing within a phase — only ordering between
  phases is guaranteed
- NOT a serialization format spec — the output is JSON-line, but the exact
  whitespace is unspecified
