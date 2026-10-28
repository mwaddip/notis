# notis.fun — landing page source

The landing page at `https://notis.fun/`. This directory **is** the source: the files here are
byte-identical to what `/var/www/notis.fun/` serves at the site root.

```
index.html             the page — its CSS and its two scripts are inline
og.png                 the share card (1200×630) the page's Open Graph tags name
og.html                the page og.png is rendered from — never served
favicon.svg            the mark, colours baked in
favicon.ico            16, 32 and 48 px rasters of the mark
apple-touch-icon.png   180 px raster of the mark
fonts/                 Plus Jakarta Sans + JetBrains Mono, self-hosted (SIL OFL 1.1), and fonts.css
```

The page is built to **`contracts/HOUSE_STYLE.md`**, and its copy follows the content rules in
`docs/site/README.md` — `rep` and `$NOTIS` on the face, *withdrawn* and never *deleted*, nothing about
governance. The block between the `MARK-DEFS` markers in `index.html` and `og.html` is generated
artwork; `docs/site/README.md → The mark` says how it is used.

## nginx serves a whitelist

The vhost answers `location = /` with `index.html`, and each asset the page loads has a location line
of its own — `/fonts/`, `= /og.png`, `= /favicon.svg`, `= /favicon.ico`, `= /apple-touch-icon.png`.
Everything else at the root answers 404, so **a new file the page loads needs a vhost line too**, and
`og.html` and this README are never reachable.

## Deploying

The webroot is `root:root`, files `644`, directories `755`; the `www-data` worker reads and never
writes. Writing goes through `sudo install`, with the file it replaces backed up beside it:

```bash
scp docs/landing/index.html docs/landing/og.png linuxuser@notis.fun:/tmp/
ssh linuxuser@notis.fun '
  cd /var/www/notis.fun
  for f in index.html og.png; do
    sudo cp -a "$f" "$f.bak-$(date +%Y%m%d)"
    sudo install -o root -g root -m 644 "/tmp/$f" "$f"
  done'
```

Verify by hash, not by eye:

```bash
md5sum docs/landing/index.html docs/landing/og.png
curl -s https://notis.fun/ | md5sum
curl -s https://notis.fun/og.png | md5sum
```

## The share card

`og.png` is `og.html` rendered at exactly 1200×630 by headless Firefox. `og.html` loads `fonts/` by a
relative path, so serve the directory rather than opening the file:

```bash
cd docs/landing
python3 -m http.server 8765 --bind 127.0.0.1 &
firefox --headless --no-remote --profile "$(mktemp -d)" --window-size=1200,630 \
        --screenshot og.png http://127.0.0.1:8765/og.html
kill %1
```

The card's text is the page's: `og.html`'s kicker, headline and line match the hero's label,
`<h1>` and tagline, and `index.html`'s `og:image:alt` names the headline.
