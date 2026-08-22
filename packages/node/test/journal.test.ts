import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRecord(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Initialized tests
// ---------------------------------------------------------------------------

describe('journal (initialized)', () => {
  let capturedLines: string[];

  beforeEach(async () => {
    vi.resetModules();
    capturedLines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      capturedLines.push(String(chunk));
      return true;
    });
    const { initJournal } = await import('../src/journal.js');
    initJournal();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastRecord(): Record<string, unknown> | null {
    const last = capturedLines[capturedLines.length - 1];
    if (!last) return null;
    return parseRecord(last);
  }

  describe('emitEvent', () => {
    it('writes a JSON line with event, level, timestamp, and fields', async () => {
      const { emitEvent } = await import('../src/journal.js');
      emitEvent({ event: 'test_info', level: 'INFO', foo: 'bar' });

      expect(capturedLines.length).toBe(1);
      const record = parseRecord(capturedLines[0]!);
      expect(record.event).toBe('test_info');
      expect(record.level).toBe('INFO');
      expect(record.foo).toBe('bar');
      expect(typeof record.timestamp).toBe('string');
      expect(new Date(record.timestamp as string).toISOString()).toBe(record.timestamp);
    });

    it('does not throw for any level', async () => {
      const { emitEvent } = await import('../src/journal.js');
      expect(() => {
        emitEvent({ event: 'test_info', level: 'INFO', foo: 'bar' });
        emitEvent({ event: 'test_warn', level: 'WARN', baz: 42 });
        emitEvent({ event: 'test_error', level: 'ERROR', qux: true });
      }).not.toThrow();
    });

    it('outputs exactly one line per event', async () => {
      const { emitEvent } = await import('../src/journal.js');
      emitEvent({ event: 'a', level: 'INFO' });
      emitEvent({ event: 'b', level: 'WARN' });
      emitEvent({ event: 'c', level: 'ERROR' });
      expect(capturedLines.length).toBe(3);
    });

    it('each line ends with a newline', async () => {
      const { emitEvent } = await import('../src/journal.js');
      emitEvent({ event: 'test', level: 'INFO' });
      expect(capturedLines[0]!.endsWith('\n')).toBe(true);
    });
  });

  describe('lifecycle events', () => {
    it('emitServerStarting includes version and network', async () => {
      const { emitServerStarting } = await import('../src/journal.js');
      emitServerStarting('2.0.0', 'mainnet');
      const r = lastRecord();
      expect(r!.event).toBe('server_starting');
      expect(r!.level).toBe('INFO');
      expect(r!.version).toBe('2.0.0');
      expect(r!.network).toBe('mainnet');
    });

    it('emitServerReady includes bind address and duration', async () => {
      const { emitServerReady } = await import('../src/journal.js');
      emitServerReady('0.0.0.0:3000', '127.0.0.1:3001', 42);
      const r = lastRecord();
      expect(r!.event).toBe('server_ready');
      expect(r!.bind_address).toBe('0.0.0.0:3000');
      expect(r!.admin_address).toBe('127.0.0.1:3001');
      expect(r!.duration_ms).toBe(42);
    });

    it('emitShutdownSignalReceived records signal name', async () => {
      const { emitShutdownSignalReceived } = await import('../src/journal.js');
      emitShutdownSignalReceived('SIGTERM');
      const r = lastRecord();
      expect(r!.event).toBe('shutdown_signal_received');
      expect(r!.signal).toBe('SIGTERM');
    });

    it('emitServerShuttingDown records the reason', async () => {
      const { emitServerShuttingDown } = await import('../src/journal.js');
      emitServerShuttingDown('SIGINT');
      const r = lastRecord();
      expect(r!.event).toBe('server_shutting_down');
      expect(r!.reason).toBe('SIGINT');
    });
  });

  describe('phase timing events', () => {
    it('emitDbOpenStarted records the database path', async () => {
      const { emitDbOpenStarted } = await import('../src/journal.js');
      emitDbOpenStarted('/var/lib/notis/node.db');
      const r = lastRecord();
      expect(r!.event).toBe('db_open_started');
      expect(r!.level).toBe('INFO');
      expect(r!.path).toBe('/var/lib/notis/node.db');
    });

    it('emitDbOpenComplete records the duration', async () => {
      const { emitDbOpenComplete } = await import('../src/journal.js');
      emitDbOpenComplete(17);
      const r = lastRecord();
      expect(r!.event).toBe('db_open_complete');
      expect(r!.level).toBe('INFO');
      expect(r!.duration_ms).toBe(17);
    });

    it('emitApiListening records bind address and port', async () => {
      const { emitApiListening } = await import('../src/journal.js');
      emitApiListening('::', 3000);
      const r = lastRecord();
      expect(r!.event).toBe('api_listening');
      expect(r!.level).toBe('INFO');
      expect(r!.bind_address).toBe('::');
      // A number, per the contract's field list — a port rendered as a string
      // is a different type to anything parsing these lines.
      expect(r!.port).toBe(3000);
    });

    it('opening a database emits the started/complete pair around it', async () => {
      // The emitters exist only to be called from `initDb`, and a helper with
      // no call site is the failure this closes. Driven through the real
      // function so the pair is observed in the order the contract states.
      const { initDb, closeDb } = await import('../src/store/db.js');
      const before = capturedLines.length;
      initDb(':memory:');
      closeDb();

      const emitted = capturedLines.slice(before).map(parseRecord);
      const started = emitted.findIndex((r) => r.event === 'db_open_started');
      const complete = emitted.findIndex((r) => r.event === 'db_open_complete');
      expect(started).toBeGreaterThanOrEqual(0);
      expect(complete).toBeGreaterThan(started);
      expect(emitted[started]!.path).toBe(':memory:');
      expect(typeof emitted[complete]!.duration_ms).toBe('number');
    });
  });

  describe('core events', () => {
    it('emitPostReceived includes post_id and source', async () => {
      const { emitPostReceived } = await import('../src/journal.js');
      emitPostReceived('abc123', 'http');
      const r = lastRecord();
      expect(r!.event).toBe('post_received');
      expect(r!.post_id).toBe('abc123');
      expect(r!.source).toBe('http');
    });

    it('emitPostValidated includes post_id and timing', async () => {
      const { emitPostValidated } = await import('../src/journal.js');
      emitPostValidated('abc123', 15);
      const r = lastRecord();
      expect(r!.event).toBe('post_validated');
      expect(r!.validation_duration_ms).toBe(15);
    });

    it('emitPostIndexed includes post_id and parent_ref_count', async () => {
      const { emitPostIndexed } = await import('../src/journal.js');
      emitPostIndexed('abc123', 1);
      const r = lastRecord();
      expect(r!.event).toBe('post_indexed');
      expect(r!.parent_ref_count).toBe(1);
    });

  });

  describe('peer events', () => {
    it('emitPeerConnected includes peer_id and direction', async () => {
      const { emitPeerConnected } = await import('../src/journal.js');
      emitPeerConnected('peer1', 'outbound');
      const r = lastRecord();
      expect(r!.event).toBe('peer_connected');
      expect(r!.peer_id).toBe('peer1');
      expect(r!.direction).toBe('outbound');
    });

    it('emitPeerDisconnected includes peer_id and reason', async () => {
      const { emitPeerDisconnected } = await import('../src/journal.js');
      emitPeerDisconnected('peer1', 'timeout');
      const r = lastRecord();
      expect(r!.event).toBe('peer_disconnected');
      expect(r!.peer_id).toBe('peer1');
      expect(r!.reason).toBe('timeout');
    });

    it('emitPeerPenalised includes peer_id, kind, and detail', async () => {
      const { emitPeerPenalised } = await import('../src/journal.js');
      emitPeerPenalised('peer1', 'invalid_pow', 'difficulty too low');
      const r = lastRecord();
      expect(r!.event).toBe('peer_penalised');
      expect(r!.level).toBe('WARN');
      expect(r!.peer_id).toBe('peer1');
      expect(r!.kind).toBe('invalid_pow');
      expect(r!.detail).toBe('difficulty too low');
    });

    it('emitPeerPenalised accepts null detail', async () => {
      const { emitPeerPenalised } = await import('../src/journal.js');
      emitPeerPenalised('peer1', 'timeout', null);
      const r = lastRecord();
      expect(r!.detail).toBeNull();
    });
  });

  describe('convenience emitters', () => {
    it('all convenience emitters do not throw', async () => {
      const {
        emitServerStarting,
        emitServerReady,
        emitShutdownSignalReceived,
        emitServerShuttingDown,
        emitPostReceived,
        emitPostValidated,
        emitPostIndexed,
        emitPeerConnected,
        emitPeerDisconnected,
        emitPeerPenalised,
      } = await import('../src/journal.js');

      expect(() => {
        emitServerStarting('1.0.0', 'mainnet');
        emitServerReady('0.0.0.0:3000', '127.0.0.1:3001', 100);
        emitShutdownSignalReceived('SIGTERM');
        emitServerShuttingDown('SIGTERM');
        emitPostReceived('abc123', 'http');
        emitPostValidated('abc123', 2);
        emitPostIndexed('abc123', 5);
        emitPeerConnected('peer1', 'outbound');
        emitPeerDisconnected('peer1', 'timeout');
        emitPeerPenalised('peer1', 'invalid_pow', 'difficulty too low');
      }).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Uninitialized tests — separate describe to reset modules
// ---------------------------------------------------------------------------

describe('journal (uninitialized)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emitEvent is a no-op when journal is not initialized', async () => {
    const mockWrite = vi.fn();
    vi.spyOn(process.stdout, 'write').mockImplementation(mockWrite);

    const { emitEvent } = await import('../src/journal.js');
    emitEvent({ event: 'test', level: 'INFO' });

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('convenience emitters are also no-ops when uninitialized', async () => {
    const mockWrite = vi.fn();
    vi.spyOn(process.stdout, 'write').mockImplementation(mockWrite);

    const { emitServerStarting, emitPeerConnected } = await import('../src/journal.js');
    emitServerStarting('1.0.0', 'testnet');
    emitPeerConnected('peer1', 'outbound');

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('initJournal is idempotent — calling twice does not throw', async () => {
    const { initJournal, emitEvent } = await import('../src/journal.js');
    expect(() => {
      initJournal();
      initJournal();
      initJournal();
    }).not.toThrow();
    // After init, events should work
    emitEvent({ event: 'after_init', level: 'INFO' });
    // We don't assert write here since we didn't mock — just testing no throw
  });
});
