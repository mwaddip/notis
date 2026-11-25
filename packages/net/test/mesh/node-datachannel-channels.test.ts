// MESH_INTERFACE → "libp2p is pinned." — `node-datachannel@0.33.6`'s
// polyfill `RTCPeerConnection` adds a remote-opened data channel to
// `#dataChannels` with no `close` listener, and `close()` closes the
// native peer connection without closing `#dataChannels`. The patch
// gives a remote-opened channel the same `close` listener that a
// locally created channel has (delete from the set, bump
// `#dataChannelsClosed`), and `close()` closes each channel in the
// set before closing the native peer connection. A WebRTC connection
// that stays up holds no channel of a stream that ended, and a
// connection closed before it connected closes the data channels it
// opened.
//
// The patch carries `murat-dogan/node-datachannel#464` by Adam
// Soltys hunk for hunk.
//
// The cases call the polyfill directly — a focused suite, independent
// of `@libp2p/webrtc`'s transport wiring. The suite builds live
// peer connections (no mock libdatachannel), so each case closes the
// peer connections it opened in a `finally` block to let the native
// callbacks settle and the vitest worker exit.

import { describe, it, expect } from 'vitest';
import { RTCPeerConnection } from 'node-datachannel/polyfill';

// `RTCPeerConnection`'s `.getStats()` returns a Map keyed by
// `report.id`; the polyfill's single peer-connection report is keyed
// `'P'` (`node-datachannel@0.33.6/src/polyfill/RTCPeerConnection.ts`).
const PEER_CONNECTION_REPORT_ID = 'P';

interface PolyfillStats {
    dataChannelsOpened: number;
    dataChannelsClosed: number;
}

async function readStats(pc: RTCPeerConnection): Promise<PolyfillStats> {
    const reports = await pc.getStats();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (reports as Map<string, any>).get(PEER_CONNECTION_REPORT_ID);
    if (entry == null) {
        throw new Error(`no '${PEER_CONNECTION_REPORT_ID}' entry in getStats()`);
    }
    return {
        dataChannelsOpened: entry.dataChannelsOpened as number,
        dataChannelsClosed: entry.dataChannelsClosed as number,
    };
}

async function waitEvent(target: EventTarget, type: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            target.removeEventListener(type, onEvent);
            resolve(false);
        }, timeoutMs);
        function onEvent(): void {
            clearTimeout(timer);
            target.removeEventListener(type, onEvent);
            resolve(true);
        }
        target.addEventListener(type, onEvent);
    });
}

async function openPair(): Promise<{
    opener: RTCPeerConnection;
    responder: RTCPeerConnection;
    localChannel: RTCDataChannel;
    remoteChannel: RTCDataChannel;
}> {
    const opener = new RTCPeerConnection();
    const responder = new RTCPeerConnection();
    opener.addEventListener('icecandidate', (e: Event) => {
        const candidate = (e as RTCPeerConnectionIceEvent).candidate;
        void responder.addIceCandidate(candidate ?? undefined);
    });
    responder.addEventListener('icecandidate', (e: Event) => {
        const candidate = (e as RTCPeerConnectionIceEvent).candidate;
        void opener.addIceCandidate(candidate ?? undefined);
    });
    const remotePromise = new Promise<RTCDataChannel>((resolve) => {
        responder.addEventListener('datachannel', (e: Event) => {
            resolve((e as RTCDataChannelEvent).channel);
        });
    });
    const localChannel = opener.createDataChannel('label');
    await responder.setRemoteDescription(await opener.createOffer());
    await opener.setRemoteDescription(await responder.createAnswer());
    const opened = await waitEvent(localChannel, 'open', 10_000);
    if (!opened) {
        opener.close();
        responder.close();
        throw new Error("local data channel never fired 'open'");
    }
    const remoteChannel = await remotePromise;
    return { opener, responder, localChannel, remoteChannel };
}

describe("node-datachannel@0.33.6's polyfill RTCPeerConnection, patched", () => {
    it.fails(
        "1. a data channel the remote side opened is forgotten once it closes",
        async () => {
            const pair = await openPair();
            const { opener, responder, localChannel, remoteChannel } = pair;
            try {
                const before = await readStats(responder);
                expect(before.dataChannelsOpened).toBe(1);
                expect(before.dataChannelsClosed).toBe(0);

                const closed = waitEvent(remoteChannel, 'close', 10_000);
                localChannel.close();
                const fired = await closed;
                expect(fired).toBe(true);

                const after = await readStats(responder);
                expect(after.dataChannelsOpened).toBe(0);
                expect(after.dataChannelsClosed).toBe(1);
            } finally {
                opener.close();
                responder.close();
            }
        },
        30_000,
    );

    it.fails(
        '2. close() on a connection that never connected closes its data channel',
        async () => {
            const pc = new RTCPeerConnection();
            try {
                const channel = pc.createDataChannel('label');
                await pc.setLocalDescription(await pc.createOffer());

                pc.close();

                if (channel.readyState !== 'closed') {
                    await waitEvent(channel, 'close', 2_000);
                }

                expect(channel.readyState).toBe('closed');
            } finally {
                pc.close();
            }
        },
        10_000,
    );
});
