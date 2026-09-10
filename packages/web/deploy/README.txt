Notis web client
================

A static bundle served from the same origin as a Notis node's HTTP
API — the node sends no CORS headers.

Serve the web/ directory as static files. The node and the client
share one origin; nginx.example.conf shows one way to front both.


Configuring for your layout
---------------------------

Four values in web/index.html control where the client looks:

  <base href="/web/">
    The path the client's own files are served under,
    opening and closing with /.

  <meta name="notis-api" content="/testnet/api">
    The API's path on this origin, no trailing slash.

  <meta name="notis-faucet" content="/testnet/faucet">
    The faucet's path, or empty for no faucet button.

  <meta property="og:image" content="https://notis.fun/web/og.png">
    The picture's absolute URL, <origin><base>og.png.

The defaults match notis.fun's layout. Edit all four for another.


The standalone page
-------------------

A post's URL is <base>p/<64-hex-id> — for example /web/p/<id>.
It boots the same client on that one thread. The node can answer
it with the post's preview tags (GET /shell/:id with WEB_SHELL_PATH
set); without that, serve index.html for the same path.
nginx.example.conf shows both options.


A foreign origin in a tag fails until the node sends CORS headers.
See the repository's README for the rest.
