// MESH_INTERFACE → What the client remembers — the helpers that judge a
// node's proof against the kept one, name the fork two proofs share,
// and pick the entries the client records after a check. Ahead of
// code: the signatures stand and the bodies throw, so the cases catch
// them as failing until the implementation lands.

import type { NipopowProof } from '@dagsocial/nipopow';
import type { NodeTipResult } from '@dagsocial/nipopow-client';
import type { NetworkProfile } from '@dagsocial/types';
import type { MeshContact, NodeEntry } from './node-list.js';

function ahead(name: string): never {
  throw new Error(`${name}: AHEAD OF CODE`);
}

export function continues(
  _kept: NipopowProof,
  _proof: NipopowProof,
  _profile: NetworkProfile,
): boolean {
  return ahead('continues');
}

export function judgeByMemory(
  _kept: NipopowProof,
  _nodes: readonly NodeTipResult[],
  _profile: NetworkProfile,
): { lost: number[]; best: number | null; foreign: boolean } {
  return ahead('judgeByMemory');
}

export function forkKey(
  _a: NipopowProof,
  _b: NipopowProof,
  _profile: NetworkProfile,
): string | null {
  return ahead('forkKey');
}

export function nodesToRemember(
  _entries: readonly NodeEntry[],
  _ownId: string,
  _cap: number,
): MeshContact[] {
  return ahead('nodesToRemember');
}
