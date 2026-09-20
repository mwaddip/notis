# Notis — the Firefox extension's update manifest

Installed copies of the Notis extension for Firefox read `firefox/updates.json` on this branch: their
manifest's `update_url` is `https://raw.githubusercontent.com/mwaddip/notis/updates/firefox/updates.json`,
and a copy keeps the URL it was installed with.

**This branch is never deleted, renamed or force-pushed.**

It holds the update manifest and nothing of the source tree. Each release appends one entry — the
version, the signed xpi's URL on the GitHub release and its sha256 — once the asset is up, through
`packages/web/scripts/sign-extension.sh` on `master`. The rule is stated in
`contracts/WEB_INTERFACE.md`, under "The Firefox build ships signed as well".
