export interface SyncInfo {
  tipHeight: number;
  tipBlockId: string;
  anchors: { height: number; blockId: string }[];
}

export interface Inv {
  typeId: number; // 101 = ordering block header; 102 retired, never reuse
  ids: string[];
}

export interface ModifierRequest {
  typeId: number;
  ids: string[];
}

export interface ModifierResponse {
  typeId: number;
  modifiers: { id: string; data: Uint8Array }[];
}

export interface SyncState {
  phase: 'idle' | 'syncing' | 'synced';
  syncPeerId: string | null;
  stalledPeers: Set<string>;
  downloadedHeight: number;
  stateAppliedHeight: number;
}
