// MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists" —
// the WebRTC-direct certificate lives as long as the node's key. The
// certhash rides in the address an anchor lists, so a renewal leaves every
// anchor naming the node unreachable until it is reissued. The lifespan is
// set past any operator horizon so the renewal path is a cold branch,
// reached only when a damaged datastore is rebuilt.
//
// Pinned to 100 years (100 × 365.25 × 86_400_000 ms): comfortably inside
// X.509 GeneralizedTime (year 9999 max) and ECMAScript Date, and far past
// Node's 2^31 − 1 ms `setTimeout` limit — which is why `@libp2p/webrtc@7.0.2`
// carries a patch that re-arms its renewal timer in bounded steps
// (MESH_INTERFACE → Place in the workspace → "libp2p is pinned").
export const WEBRTC_CERT_LIFESPAN_MS = 3_155_760_000_000;
