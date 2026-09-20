# Notis — Firefox extension source review

Notis is an invite-only decentralised social network on a dual-ledger design: a Posts DAG and a
UTXO ledger of non-tradeable rep and tradeable $NOTIS. The add-on is the Notis client built as a
browser extension: the identity's secret key stays in the background script and is never
transmitted. One content script runs on `https://notis.fun/web/p/*` and passes a post id to the
background so a hosted thread opens in the extension's own page.

## Try it without an account

Open the extension's page from its toolbar button, create an identity in the profile window, press
`ask the faucet` for testnet rep and $NOTIS, and post from `new post`.

## Environment

Linux, x86-64 or ARM64. Node 22 or 24 — the build produces identical files under 22.19 and 24.13.
`zip`. GNU coreutils. Install pnpm at the version below:

    npm i -g pnpm@10.33.0

## Build

From this archive's `notis-<ver>/` directory, run these two commands verbatim:

    pnpm install --frozen-lockfile --filter '@dagsocial/web...'
    bash packages/web/scripts/build-extension.sh

## Compare

`notis-extension-<ver>-firefox.zip` lands in that directory. Its contents equal the submitted xpi's
outside `META-INF/`. The zip itself differs from build to build by its entries' timestamps.
