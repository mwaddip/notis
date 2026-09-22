Notis web client
================

A static bundle served beside a Notis node's HTTP API by default.
The node answers any origin, so the client can be served elsewhere
and pointed at any node; the faucet answers its own origin only,
so a faucet base is same-origin.

Serve the web/ directory as static files; nginx.example.conf shows
one way to front the node, the faucet and the client together.


Configuring for your layout
---------------------------

Seven values in web/index.html control where the client looks:

  <base href="/web/">
    The path the client's own files are served under,
    opening and closing with /.

  <meta name="notis-api" content="/testnet/api">
    The API's path on this origin, no trailing slash.

  <meta name="notis-faucet" content="/testnet/faucet">
    The faucet's path, or empty for no faucet button.

  <meta name="notis-nodes" content='[]'>
    A JSON array of API bases the client tries in order at boot when
    no node preference is stored. Empty for the web build.

  <meta name="notis-public" content="">
    The origin+base a shareable post link should carry. Empty means
    the client uses its own location, which is right for the web build.

  <meta name="notis-network" content="">
    The network the build is for — testnet, devnet, mainnet, or empty.
    Empty for the web release: the hosted client carries no verifier.

  <meta property="og:image" content="https://notis.fun/web/og.png">
    The picture's absolute URL, <origin><base>og.png.

The defaults match notis.fun's layout. Edit all seven for another.


The standalone page
-------------------

A post's URL is <base>p/<64-hex-id> — for example /web/p/<id>.
It boots the same client on that one thread. The node can answer
it with the post's preview tags (GET /shell/:id with WEB_SHELL_PATH
set); without that, serve index.html for the same path.
nginx.example.conf shows both options.


A foreign origin in the notis-api tag works; in notis-faucet it fails.
See the repository's README for the rest.
