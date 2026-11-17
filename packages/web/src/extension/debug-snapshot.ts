// Stub while the tests run as plain `it` — the real module lands in a later
// commit. Returning every section as `{ error }` here keeps the first
// assertion in each case failing against the expected shape so the failing
// line is pinned.

import type { MeshClient, ClientState, MeshDiagnostics } from '../mesh/mesh-client.js';
import type { DebugLog, DebugLogStats } from './debug-log.js';

export interface BuildFacts { version: string; commit: string; network: string; userAgent: string; }
export interface SettingsFacts { serve: boolean; links: 'site' | 'here' | null; signPolicy: 'silent' | 'ask'; handNode: { address: string; off: boolean }; }
export interface SnapshotPending { kind: string; txId: string; postId: string; expiresAtHeight: number; stage: string; }
export interface SnapshotWaiting { kind: string; txId: string; postId: string; seq: number; ledger: 'rep' | 'credits'; chain: string; }
export interface ReaderFacts { identityLoaded: boolean; unlocked: boolean; pubKeyHex: string | null; name: string | null; pending: SnapshotPending[]; waiting: SnapshotWaiting[]; lastTipRun: Record<string, unknown> | null; lastFiguresRun: Record<string, unknown> | null; lastNamesRun: Record<string, unknown> | null; observedAddress?: string | null; }
export type MeshSnapshotSeam = Pick<MeshClient, 'state' | 'diagnostics'>;
export type ReaderSeam = () => ReaderFacts;
export type SettingsSeam = () => SettingsFacts;
export interface SnapshotSeams { build: () => BuildFacts; settings: SettingsSeam; mesh: MeshSnapshotSeam; reader: ReaderSeam; debugLog: Pick<DebugLog, 'stats'>; }
export interface PostCacheFacts { /* empty */ }
export type SectionOr<T> = T | { error: string };
export interface DebugSnapshot {
  build: SectionOr<BuildFacts>;
  settings: SectionOr<SettingsFacts>;
  mesh: SectionOr<{ state: ClientState; diagnostics: MeshDiagnostics }>;
  reader: SectionOr<ReaderFacts>;
  postCache: SectionOr<PostCacheFacts>;
  log: SectionOr<DebugLogStats>;
}

export async function takeSnapshot(_seams: SnapshotSeams): Promise<DebugSnapshot> {
  return {
    build: { error: 'not implemented' },
    settings: { error: 'not implemented' },
    mesh: { error: 'not implemented' },
    reader: { error: 'not implemented' },
    postCache: { error: 'not implemented' },
    log: { error: 'not implemented' },
  };
}
