// Stub while the tests run as plain `it` — the real module lands in a later
// commit. The stub keeps the types and signatures so the test file compiles.

import type { DebugEvent } from './debug-log.js';
import type { DebugSnapshot } from './debug-snapshot.js';

export interface DebugFileDoc {
  format: 'notis-debug/1';
  savedAt: number;
  identifying: boolean;
  snapshot: DebugSnapshot;
  events: DebugEvent[];
}

export interface DebugFileInput {
  snapshot: DebugSnapshot;
  events: readonly DebugEvent[];
  identifying: boolean;
  savedAt: number;
  nowMs: number;
}

export interface DebugFile {
  filename: string;
  text: string;
}

export function debugFilename(_nowMs: number): string {
  return 'notis-debug-00000000-000000.json';
}

export function buildDebugFile(_input: DebugFileInput): DebugFile {
  return { filename: 'notis-debug-00000000-000000.json', text: '{}' };
}
