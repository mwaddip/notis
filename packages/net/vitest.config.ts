import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// The forks pool isolates each test file in its own child process:
// `@libp2p/webrtc@7.0.2` binds `node-datachannel` on Node, whose native
// callbacks crash with `v8::HandleScope::CreateHandle` when more than
// one worker thread holds a live `RTCPeerConnection` in the same
// process, so every suite that builds the transport runs in its own
// child.
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
