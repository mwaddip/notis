import { describe, it, expect } from 'vitest';
import { createFiguresVerifier } from '../src/extension/figures-verifier';
import type { Anchor, FiguresResult, Listing, proveFigures } from '@dagsocial/nipopow-client';
import type { BlockHeader, NetworkProfile, NetworkType } from '@dagsocial/types';
import { profileFor } from '@dagsocial/types';

// createFiguresVerifier is the extension's seam over the tool's `proveFigures`
// (WEB_INTERFACE → The extension → "The verified figures"). Its one job is to
// strip a trailing `/` from the reading base, pin the build's profile, and
// hand every other argument through unchanged. The tests inject a `prove`
// stub so the wire is asserted without a real proof engine.

type PoPowHeader = Anchor['suffixHead'];

function header(height: number, tag: string): BlockHeader {
  const suffix = tag.padStart(2, '0');
  return {
    protocolVersion: 1,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(31) + suffix,
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 0x1d00ffff,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
  };
}

function popow(h: BlockHeader): PoPowHeader {
  return { header: h, interlinks: [] };
}

function anchorFor(h: number): Anchor {
  return { tip: header(h, 'aa'), suffixHead: popow(header(h - 19, 'bb')) };
}

function emptyResult(): FiguresResult {
  return {
    boxes: [],
    record: { status: 'absent' },
    karma: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, effective: 0n },
    credits: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n },
    heightAfter: 100,
    failed: false,
  };
}

function emptyListing(): Listing {
  return { karma: { boxes: [], height: 50, effective: '0' }, credits: { boxes: [] } };
}

const USER = 'aa'.repeat(32);

describe('createFiguresVerifier — the seam the App knows', () => {
  it('calls `prove` with the normalised base, the user, the listing, the anchor, and profileFor(network)', async () => {
    // A trailing slash on the reading base is stripped so the tool's
    // `${nodeUrl}/api/v1/proof/…` never asks a double-slash URL — the same
    // rule the tip verifier applies.
    let seen: {
      nodeUrl: string;
      user: string;
      listing: Listing;
      anchor: Anchor;
      profile: NetworkProfile;
    } | null = null;
    const prove = (async (
      nodeUrl: string,
      user: string,
      listing: Listing,
      anchor: Anchor,
      profile: NetworkProfile,
    ): Promise<FiguresResult> => {
      seen = { nodeUrl, user, listing, anchor, profile };
      return emptyResult();
    }) as typeof proveFigures;

    const network: NetworkType = 'testnet';
    const listing = emptyListing();
    const anchor = anchorFor(200);
    const v = createFiguresVerifier({
      network,
      fetch: (async () => new Response('')) as typeof fetch,
      prove,
    });
    await v.run('https://a.example/', USER, listing, anchor);

    expect(seen).not.toBeNull();
    expect(seen!.nodeUrl).toBe('https://a.example'); // trailing slash stripped
    expect(seen!.user).toBe(USER);
    expect(seen!.listing).toBe(listing);
    expect(seen!.anchor).toBe(anchor);
    expect(seen!.profile).toBe(profileFor(network));
  });

  it('a base without a trailing slash reaches `prove` unchanged', async () => {
    let seenUrl = '';
    const prove = (async (nodeUrl: string): Promise<FiguresResult> => {
      seenUrl = nodeUrl;
      return emptyResult();
    }) as typeof proveFigures;
    const v = createFiguresVerifier({
      network: 'testnet',
      fetch: (async () => new Response('')) as typeof fetch,
      prove,
    });
    await v.run('https://a.example', USER, emptyListing(), anchorFor(200));
    expect(seenUrl).toBe('https://a.example');
  });

  it('the tool\'s FiguresResult reaches the caller unchanged', async () => {
    const custom: FiguresResult = {
      ...emptyResult(),
      heightAfter: 4242,
      karma: { proven: 5n, young: 0n, unchecked: 0n, absent: 0n, effective: 5n },
    };
    const prove = (async (): Promise<FiguresResult> => custom) as typeof proveFigures;
    const v = createFiguresVerifier({
      network: 'testnet',
      fetch: (async () => new Response('')) as typeof fetch,
      prove,
    });
    const got = await v.run('https://a.example', USER, emptyListing(), anchorFor(200));
    expect(got).toBe(custom);
  });
});
