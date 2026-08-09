# docs.notis.fun — site source

The documentation site, mirrored from the live server. This directory **is** the
source: pages here are byte-identical to what `https://docs.notis.fun` serves.

```
index.html                 Introduction        /
first-principles/          First principles    /first-principles/
architecture/              Architecture        /architecture/
economy/                   Economy             /economy/
karma/                     Karma               /karma/
assets/_nav.html           shared sidebar: mark, brand, nav, theme control (SSI include)
assets/style.css           tokens, theme, shell, and every component used site-wide
assets/site.js             theme, sidebar, active nav item, scroll-hover suppression
assets/fonts/              Plus Jakarta Sans + JetBrains Mono, self-hosted (SIL OFL 1.1)
```

The site is built to **`contracts/HOUSE_STYLE.md`**. Read it before changing
anything visual — it carries the reasoning, and the reasoning is what stops a
rule being overridden by whoever finds it inconvenient.

## The sidebar is one file

Every page's `<aside class="sidebar">` contains nothing but an SSI include of
`/assets/_nav.html`, which carries the whole sidebar interior: the mark sprite,
the brand, the navigation and the theme control.

nginx resolves it server-side (`ssi on;` in the vhost's `location /`). The
active item is marked by `site.js`, matching `location.pathname` against each
item's `href` — the include cannot know which page it was served into.

**Adding a page means editing `assets/_nav.html` — once — not every page.**
Do not inline the nav into a page; it will silently drift from the others.

⚠ **Never write an SSI include directive inside `_nav.html`, not even quoted in
a comment.** nginx resolves includes recursively and does not care that one is
quoted, so a directive naming that file would include it into itself. HTML
comments do not nest either, so the comment quoting it ends at the quoted
directive's own `-->` and spills the rest onto the page as text.

⚠ Because SSI is resolved by nginx, opening these files over `file://` shows no
sidebar. That is expected. Serve the directory over HTTP to preview properly —
and use a server that resolves the include, or you are checking a page nobody
will ever be served.

## The shared stylesheet, and what stays per-page

`assets/style.css` owns the token set, both themes, the page shell, and every
component that appears on three or more pages — headings, prose, the pull quote,
the callout, the read-next cards, the footer. A page's own `<style>` block owns
only components that page uses: `karma/`'s ledger and tables, `economy/`'s
comparison columns.

This replaces the earlier "CSS is deliberately not factored out" convention,
which was written before there was a fixed token set. A token block copied five
times drifts, and nothing tells you when it has. Page-local components do not
drift, because there is only ever one copy.

## Theme

Sand is the primary ground. The stored choice wins; failing that
`prefers-color-scheme: dark`; failing that Sand. `#dark` / `#light` in the URL
overrides everything and is never stored, which is also how a theme gets
checked in a headless screenshot.

`site.js` is loaded from `<head>` **without `defer`** on purpose: the theme has
to be on `<html>` before the first paint, or every navigation flashes the
default ground before settling. `<html>` carries `class="no-anim"` for the same
reason, and the script removes it after the first paint — restoring a stored
preference is not motion, so it must be painted, not transitioned into.

## Deploying

Webroot is `root:root`, dirs `755`, files `664` — deliberate. The `www-data`
worker can read but not write, so a compromised worker cannot rewrite the site.
That means writing goes through `sudo install`, never a direct `scp` into place.
Passwordless sudo is available for `linuxuser@notis.fun`.

```bash
# one page
scp docs/site/karma/index.html linuxuser@notis.fun:/tmp/karma-index.html
ssh linuxuser@notis.fun '
  sudo install -d -o root -g root -m 755 /var/www/docs.notis.fun/karma
  sudo install -o root -g root -m 664 /tmp/karma-index.html \
       /var/www/docs.notis.fun/karma/index.html'

# the nav (touches every page's sidebar at once — back it up first)
scp docs/site/assets/_nav.html linuxuser@notis.fun:/tmp/_nav.html
ssh linuxuser@notis.fun '
  sudo cp -a /var/www/docs.notis.fun/assets/_nav.html \
             /var/www/docs.notis.fun/assets/_nav.html.bak-$(date +%Y%m%d)
  sudo install -o root -g root -m 664 /tmp/_nav.html \
       /var/www/docs.notis.fun/assets/_nav.html'

# the shared stylesheet and behaviour (same blast radius as the nav — back up first)
scp docs/site/assets/style.css docs/site/assets/site.js linuxuser@notis.fun:/tmp/
ssh linuxuser@notis.fun '
  for f in style.css site.js; do
    sudo cp -a /var/www/docs.notis.fun/assets/$f \
               /var/www/docs.notis.fun/assets/$f.bak-$(date +%Y%m%d) 2>/dev/null || true
    sudo install -o root -g root -m 664 /tmp/$f /var/www/docs.notis.fun/assets/$f
  done'

# the fonts (write once; they only change if a face changes)
scp docs/site/assets/fonts/* linuxuser@notis.fun:/tmp/
ssh linuxuser@notis.fun '
  sudo install -d -o root -g root -m 755 /var/www/docs.notis.fun/assets/fonts
  sudo install -o root -g root -m 664 /tmp/Plus-Jakarta-Sans.woff2 /tmp/JetBrains-Mono.woff2 \
       /var/www/docs.notis.fun/assets/fonts/'
```

Verify afterwards — a broken include fails quietly, serving a page with no
sidebar rather than an error:

```bash
curl -s https://docs.notis.fun/karma/ | grep -c 'siteNav'          # expect 1+
curl -s https://docs.notis.fun/karma/ | grep -c 'include virtual'  # expect 0
curl -s -o /dev/null -w '%{http_code}\n' https://docs.notis.fun/assets/style.css   # expect 200
curl -s -o /dev/null -w '%{http_code}\n' https://docs.notis.fun/assets/fonts/Plus-Jakarta-Sans.woff2
```

`docs.notis.fun` serves static files normally (`try_files $uri $uri/ =404`), so
`/assets/` needs no nginx whitelist — unlike `notis.fun`, whose `location /`
returns 404 for anything not explicitly listed.

To re-sync this directory from the server:

```bash
rsync -a --exclude '*.bak*' linuxuser@notis.fun:/var/www/docs.notis.fun/ docs/site/
```

## The mark

The sprite in `_nav.html` and `favicon.svg` are **generated artwork**. The build
pipeline that produces them is deliberately not in this repository — only its
output is tracked — so there is nothing here to run, and neither file can be
regenerated from a clone. Do not hand-edit the block between the `MARK-DEFS`
markers: a regeneration elsewhere will overwrite it without noticing.

Instances are `<use href="#mark…">`, and the artwork must stay inline SVG
because `--notis-green` and `--notis-keyline` do not cross into an `<img>`.
`favicon.svg` is the exception and has its colours baked in as literals — it is
loaded standalone, with no page to inherit those properties from, so left
unbaked it renders in the fallback bright green rather than Fern.

Pick the tier by rendered size — the cut points were measured, and getting them
wrong is visible:

| id | tier | size |
|---|---|---|
| `#mark` | full | ≥ 160px |
| `#mark-mid` | mid | 96–160 |
| `#mark-small` | small | 32–96 |
| `#mark-micro` | micro | ≤ 32 |

## Content rules

- **No governance.** Governance mechanics are deliberately unpublished. Nothing
  about voting, chambers, quorums or treasury control belongs on this site.
- **Numbers are placeholders.** Economic constants are untuned. Any page quoting
  figures says so prominently — see the callout on `karma/`.
- **Say what is built.** Mechanics described here are partly still being
  implemented; the footer carries that disclaimer site-wide.
- **"Withdrawn", never "deleted".** Content withdrawal stops propagation and
  records intent; it cannot retract what someone already copied. The wording
  should not imply otherwise.
- **The coin is the notis.** **Notis** the network, **notis** the unit,
  invariant plural, ticker NOTIS. Never "credits" — that was the old name and
  the landing page has already moved.
