import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';
// MESH_INTERFACE → Place in the workspace — `node-datachannel`, the native
// binding under `@libp2p/webrtc`'s Node side, crashes with
// `v8::HandleScope::CreateHandle` when more than one worker thread holds a
// live `RTCPeerConnection` in the same process. Running each test file in
// its own child process is the one isolation node-datachannel's native
// callbacks tolerate; the trade-off is longer per-file startup (~1 s).
export default mergeConfig(
  shared,
  defineConfig({
    test: { globals: true, passWithNoTests: true, pool: 'forks' },
  }),
);
