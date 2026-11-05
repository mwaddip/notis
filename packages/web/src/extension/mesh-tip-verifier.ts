// The mesh client's check as the extension's tip verifier
// (WEB_INTERFACE → The extension → "The verified tip"). A run awaits one check
// over the mesh client and answers `tipRunOf(client.state())`: the verdict and
// — under `verified` alone — the anchor, with the chain's name beside them.

import type { MeshClient } from '../mesh/index.js';
import type { TipRun } from '../model/state.js';
import { tipRunOf } from '../model/mesh-verdict.js';

export interface MeshTipVerifierOptions {
  client: MeshClient;
}

export interface MeshTipVerifier {
  run(): Promise<TipRun>;
}

export function createMeshTipVerifier(opts: MeshTipVerifierOptions): MeshTipVerifier {
  return {
    async run(): Promise<TipRun> {
      await opts.client.check();
      return tipRunOf(opts.client.state());
    },
  };
}
