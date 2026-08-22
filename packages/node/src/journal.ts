// ---------------------------------------------------------------------------
// Structured journal events — JSON-line output to stdout
//
// One JSON object per line: { event, level, timestamp, ...fields }
// ---------------------------------------------------------------------------

import { notePostReceived, notePostValidated } from './metrics.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JournalEvent {
  event: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

let _initialized = false;

/**
 * Initialize the journal. Must be called once at startup before any events
 * are emitted. Subsequent calls are no-ops.
 */
export function initJournal(): void {
  if (_initialized) return;
  _initialized = true;
}

/**
 * Emit a structured journal event as a single JSON line to stdout.
 * No-op if the journal is not initialized.
 */
export function emitEvent(event: JournalEvent): void {
  if (!_initialized) return;
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  // Amount fields (decay/mint events) are bigint — JSON.stringify throws on
  // bigint, so serialize them as decimal strings.
  process.stdout.write(
    JSON.stringify(record, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ) + '\n',
  );
}

// ---------------------------------------------------------------------------
// Convenience emitters for lifecycle events
// ---------------------------------------------------------------------------

export function emitServerStarting(version: string, network: string): void {
  emitEvent({ event: 'server_starting', level: 'INFO', version, network });
}

export function emitServerReady(bindAddress: string, adminAddress: string, durationMs: number): void {
  emitEvent({
    event: 'server_ready', level: 'INFO',
    bind_address: bindAddress, admin_address: adminAddress, duration_ms: durationMs,
  });
}

export function emitShutdownSignalReceived(signal: string): void {
  emitEvent({ event: 'shutdown_signal_received', level: 'INFO', signal });
}

export function emitServerShuttingDown(reason: string): void {
  emitEvent({ event: 'server_shutting_down', level: 'INFO', reason });
}

// ---------------------------------------------------------------------------
// Convenience emitters for phase timing events
// ---------------------------------------------------------------------------

export function emitDbOpenStarted(path: string): void {
  emitEvent({ event: 'db_open_started', level: 'INFO', path });
}

export function emitDbOpenComplete(durationMs: number): void {
  emitEvent({ event: 'db_open_complete', level: 'INFO', duration_ms: durationMs });
}

export function emitApiListening(bindAddress: string, port: number): void {
  emitEvent({ event: 'api_listening', level: 'INFO', bind_address: bindAddress, port });
}

// ---------------------------------------------------------------------------
// Convenience emitters for core events
// ---------------------------------------------------------------------------

export function emitPostReceived(postId: string, source: string, via: 'packet' | 'pull' = 'packet'): void {
  notePostReceived(via);
  emitEvent({ event: 'post_received', level: 'INFO', post_id: postId, source, via });
}

export function emitPostValidated(postId: string, validationDurationMs: number): void {
  notePostValidated();
  emitEvent({ event: 'post_validated', level: 'INFO', post_id: postId, validation_duration_ms: validationDurationMs });
}

export function emitPostIndexed(postId: string, parentRefCount: number): void {
  emitEvent({ event: 'post_indexed', level: 'INFO', post_id: postId, parent_ref_count: parentRefCount });
}

// ---------------------------------------------------------------------------
// Convenience emitters for peer events (JOURNAL_EVENTS → Peer Events —
// NOT IMPLEMENTED; wrappers ahead of wiring)
// ---------------------------------------------------------------------------

export function emitPeerConnected(peerId: string, direction: 'inbound' | 'outbound'): void {
  emitEvent({ event: 'peer_connected', level: 'INFO', peer_id: peerId, direction });
}

export function emitPeerDisconnected(peerId: string, reason: string): void {
  emitEvent({ event: 'peer_disconnected', level: 'INFO', peer_id: peerId, reason });
}

export function emitPeerPenalised(peerId: string, kind: string, detail: string | null): void {
  emitEvent({ event: 'peer_penalised', level: 'WARN', peer_id: peerId, kind, detail });
}

// ---------------------------------------------------------------------------
// Convenience emitter for sync events (JOURNAL_EVENTS → sync_complete)
// ---------------------------------------------------------------------------

// duration_ms: since process start for the first sync_complete, since the
// previous sync_complete after. The caller computes the duration.
export function emitSyncComplete(tipHeight: number, durationMs: number): void {
  emitEvent({ event: 'sync_complete', level: 'INFO', tip_height: tipHeight, duration_ms: durationMs });
}
