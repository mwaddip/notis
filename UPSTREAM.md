# Upstream

Notis carries a few changes to its dependencies as local patches — pnpm's `patchedDependencies`, the diffs under
`patches/` — each stated in `contracts/MESH_INTERFACE.md → "libp2p is pinned."` and held by a case against the patched
package. This file names where each change stands upstream. A patch leaves the tree when a release of its package
carries the change.

**Status read 2026-11-25.** Upstream moves without a commit here, so a status is as of its reading;
`gh pr view <n> -R <repo>` answers the current one.

## libp2p/js-libp2p

| Pull request | Change | Patch | Status |
|---|---|---|---|
| [#3695](https://github.com/libp2p/js-libp2p/pull/3695) | The WebRTC-direct certificate's renewal timer re-arms in bounded steps, so a certificate whose lifespan passes Node's timer limit renews at its threshold, not at once | `@libp2p/webrtc@7.0.2` | open, no review |
| [#3702](https://github.com/libp2p/js-libp2p/pull/3702) | gossipsub keeps a peer when the inbound stream a newer one replaced errors | `@libp2p/gossipsub@17.2.1` | open, no review |
| [#3721](https://github.com/libp2p/js-libp2p/pull/3721) | The address manager does not throw removing an observed address that names no IP | `libp2p@3.5.1` | open, no review |
| [#3687](https://github.com/libp2p/js-libp2p/pull/3687) by `wemeetagain` | gossipsub retries failed and closed outbound streams; [a comment there](https://github.com/libp2p/js-libp2p/pull/3687#issuecomment-6832893162) names the case the patch's outbound move covers — an outbound stream left open on a connection that went dead | `@libp2p/gossipsub@17.2.1` | open; not ours |

## libp2p/js-libp2p-http

| Pull request | Change | Patch | Status |
|---|---|---|---|
| [#143](https://github.com/libp2p/js-libp2p-http/pull/143) | `readHeaders` hands body bytes that arrive in the same chunk as the headers back to the stream | `@libp2p/http-utils@2.0.6` | open, no review |
| [#144](https://github.com/libp2p/js-libp2p-http/pull/144) | The request line carries the URL's query | `@libp2p/http-fetch@4.0.4` | open, no review |
| [#145](https://github.com/libp2p/js-libp2p-http/pull/145) | A string body's `content-length` counts its UTF-8 bytes | `@libp2p/http-fetch@4.0.4` | open, no review |
| [#146](https://github.com/libp2p/js-libp2p-http/pull/146) | String and bytes bodies keep the `content-type` the caller set | `@libp2p/http-fetch@4.0.4` | open, no review |

## murat-dogan/node-datachannel

| Pull request | Change | Patch | Status |
|---|---|---|---|
| [#464](https://github.com/murat-dogan/node-datachannel/pull/464) by Adam Soltys (`asoltys`) | The polyfill `RTCPeerConnection` forgets a data channel the remote side opened once it closes, and closes its data channels when it closes | `node-datachannel@0.33.6` — #464's change whole | open, no review; not ours |

## Carried, not submitted

- `libp2p@3.5.1` — the connection manager holds each address to a bound on its inbound connections still upgrading,
  and the upgrader releases an address's count when an upgrade ends (`contracts/NET_INTERFACE.md → Readers → "An
  address upgrades at most four inbound connections at once, each within five seconds"`).
- `libp2p@3.5.1` — `addObservedAddr` passes over an address that names no IP, a FIPS address.
- `@libp2p/gossipsub@17.2.1` — the router's outbound stream to a peer moves onto the newer connection the peer's own
  stream arrives on (the case the comment on #3687 names), and `addDirectPeer` / `removeDirectPeer` take and let go of
  a direct peer while the router runs.
- `@libp2p/http-utils@2.0.6` — the package's `browser` map sends `stream-to-socket.js` to a browser module, keeping the
  Node-side server adapter out of the browser's import path.
