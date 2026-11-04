import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// MESH_INTERFACE → Place in the workspace → "libp2p is pinned" — the
// WebRTC-direct cert-lifetime suite builds the real `@libp2p/webrtc`
// transport, whose Node side binds `node-datachannel`. That native binding
// crashes with `v8::HandleScope::CreateHandle` when more than one worker
// thread holds a live `RTCPeerConnection` in the same process. Forks
// isolate each test file in its own child process — the same mitigation
// `tools/mesh-poc/vitest.config.ts` applies for the same reason.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globals: true,
      passWithNoTests: true,
      pool: 'forks',
      testTimeout: 15000, // libp2p tests may need more time
    },
  }),
);
