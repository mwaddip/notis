// Build and check the Firefox update manifest — an `update_url` on
// raw.githubusercontent.com pointing at a file on the repository's `updates`
// branch, one entry per release carrying the version, the release asset's
// URL and its sha256.
// WEB_INTERFACE → "The Firefox build ships signed as well".
//
// Pure ESM, no I/O and no `process`: every value the module needs — the
// add-on id, the minimum version, the repository's owner and name — is
// passed in, so the module restates no constant of the signed build's own
// manifest. Errors name their function.

/** Parse a Mozilla extension version — 1 to 4 dot-separated non-negative
 *  integers, each up to nine digits, no leading zero on a non-zero number.
 *  Throws, naming `fn`, on any shape outside that. Returns the digit array. */
function parseVersion(fn, s) {
  if (typeof s !== 'string') {
    throw new Error(`${fn}: version is not a string`);
  }
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 4) {
    throw new Error(`${fn}: version ${JSON.stringify(s)} has ${parts.length} elements, expected 1–4`);
  }
  const nums = [];
  for (const p of parts) {
    if (p === '') {
      throw new Error(`${fn}: version ${JSON.stringify(s)} has an empty element`);
    }
    if (!/^[0-9]+$/.test(p)) {
      throw new Error(`${fn}: version ${JSON.stringify(s)} element ${JSON.stringify(p)} is not a non-negative integer`);
    }
    if (p.length > 9) {
      throw new Error(`${fn}: version ${JSON.stringify(s)} element ${JSON.stringify(p)} has more than nine digits`);
    }
    if (p.length > 1 && p[0] === '0') {
      throw new Error(`${fn}: version ${JSON.stringify(s)} element ${JSON.stringify(p)} has a leading zero`);
    }
    nums.push(Number(p));
  }
  return nums;
}

/** Compare two Mozilla extension versions. Returns -1 | 0 | 1: `a < b`,
 *  `a === b`, `a > b`. A missing element equals `0`, so `1.0` equals
 *  `1.0.0.0` and `1.10` is newer than `1.9`. Throws on either operand
 *  outside the accepted shape (see `parseVersion`). */
export function compareVersions(a, b) {
  const na = parseVersion('compareVersions', a);
  const nb = parseVersion('compareVersions', b);
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Return `{ owner, repo }` from a raw.githubusercontent.com update URL of
 *  the form
 *  `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path…>`.
 *  Throws on another host, a non-`https:` scheme, an invalid URL, or fewer
 *  path segments than owner/repo/branch/path. */
export function repoFromUpdateUrl(updateUrl) {
  if (typeof updateUrl !== 'string') {
    throw new Error(`repoFromUpdateUrl: updateUrl is not a string`);
  }
  let u;
  try {
    u = new URL(updateUrl);
  } catch {
    throw new Error(`repoFromUpdateUrl: ${JSON.stringify(updateUrl)} is not a valid URL`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(`repoFromUpdateUrl: protocol is not https:, got ${u.protocol}`);
  }
  if (u.host !== 'raw.githubusercontent.com') {
    throw new Error(`repoFromUpdateUrl: host is not raw.githubusercontent.com, got ${u.host}`);
  }
  const parts = u.pathname.replace(/^\//, '').split('/');
  if (parts.length < 4 || parts[0] === '' || parts[1] === '' || parts[2] === '') {
    throw new Error(`repoFromUpdateUrl: path ${JSON.stringify(u.pathname)} needs owner, repo, branch and a path`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Build one manifest entry — the release's asset URL and its sha256, plus
 *  a Firefox `strict_min_version`. Throws on a version `compareVersions`
 *  rejects, on a `sha256Hex` that is not 64 lowercase hex characters, or
 *  on a missing owner or repo. */
export function entryFor({ version, sha256Hex, minVersion, owner, repo }) {
  parseVersion('entryFor', version);
  parseVersion('entryFor', minVersion);
  if (typeof sha256Hex !== 'string' || !/^[0-9a-f]{64}$/.test(sha256Hex)) {
    throw new Error(`entryFor: sha256Hex must be 64 lowercase hex characters`);
  }
  if (typeof owner !== 'string' || owner === '') {
    throw new Error(`entryFor: owner is missing`);
  }
  if (typeof repo !== 'string' || repo === '') {
    throw new Error(`entryFor: repo is missing`);
  }
  return {
    version,
    update_link: `https://github.com/${owner}/${repo}/releases/download/v${version}/notis-extension-${version}-firefox.xpi`,
    update_hash: `sha256:${sha256Hex}`,
    applications: { gecko: { strict_min_version: minVersion } },
  };
}

/** Structural check of an update manifest text, from the perspective of
 *  `id` and `{ owner, repo }`. Returns the parsed updates array. Throws,
 *  naming `fn`, on:
 *  - text that is not JSON
 *  - no `addons[id].updates` array
 *  - an entry without a string `version` or `update_link`
 *  - an `update_link` that is not `https:` or, when `linkPrefix` is given,
 *    not under it
 *  - an `update_hash` present but not `sha256:` + 64 lowercase hex
 *  - versions not strictly ascending in array order */
function structuralCheck(fn, text, id, linkPrefix) {
  if (typeof text !== 'string') {
    throw new Error(`${fn}: manifest text is not a string`);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(`${fn}: manifest is not JSON`);
  }
  const updates = obj?.addons?.[id]?.updates;
  if (!Array.isArray(updates)) {
    throw new Error(`${fn}: addons[${JSON.stringify(id)}].updates is not an array`);
  }
  for (let i = 0; i < updates.length; i++) {
    const e = updates[i];
    if (!e || typeof e.version !== 'string') {
      throw new Error(`${fn}: entry ${i} has no string version`);
    }
    if (typeof e.update_link !== 'string') {
      throw new Error(`${fn}: entry ${i} has no string update_link`);
    }
    if (!e.update_link.startsWith('https://')) {
      throw new Error(`${fn}: entry ${i} update_link is not https:`);
    }
    if (linkPrefix !== null && !e.update_link.startsWith(linkPrefix)) {
      throw new Error(`${fn}: entry ${i} update_link is not under ${linkPrefix}`);
    }
    if (e.update_hash !== undefined) {
      if (typeof e.update_hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(e.update_hash)) {
        throw new Error(`${fn}: entry ${i} update_hash is not "sha256:" + 64 lowercase hex`);
      }
    }
  }
  for (let i = 1; i < updates.length; i++) {
    if (compareVersions(updates[i - 1].version, updates[i].version) !== -1) {
      throw new Error(`${fn}: versions are not strictly ascending at index ${i}`);
    }
  }
  return updates;
}

/** Return the entry for `version` from an update manifest text. Throws
 *  every structural defect (see `structuralCheck`) and, past those, when
 *  `version` is absent from the list or when an `update_link` sits outside
 *  `https://github.com/<owner>/<repo>/releases/download/`. */
export function checkManifest(text, { id, version, owner, repo }) {
  const linkPrefix = `https://github.com/${owner}/${repo}/releases/download/`;
  const updates = structuralCheck('checkManifest', text, id, linkPrefix);
  for (const e of updates) {
    if (e.version === version) return e;
  }
  throw new Error(`checkManifest: version ${JSON.stringify(version)} is absent from the list`);
}

/** Return the manifest text with `entry` appended to `addons[id].updates`.
 *  Two-space JSON, one closing newline. Runs the structural check on the
 *  incoming text and on its own output (see `structuralCheck`), so an
 *  entry with no `update_link`, an `http:` link or a malformed
 *  `update_hash` is refused; throws when the entry's version is not
 *  strictly greater than the last entry's — a duplicate and a downgrade
 *  are both refused. An `updates: []` manifest takes its first entry. */
export function appendEntry(text, id, entry) {
  const updates = structuralCheck('appendEntry', text, id, null);
  if (!entry || typeof entry.version !== 'string') {
    throw new Error(`appendEntry: entry.version is not a string`);
  }
  parseVersion('appendEntry', entry.version);
  if (updates.length > 0) {
    const last = updates[updates.length - 1].version;
    if (compareVersions(last, entry.version) !== -1) {
      throw new Error(`appendEntry: entry.version ${JSON.stringify(entry.version)} is not strictly greater than ${JSON.stringify(last)}`);
    }
  }
  const obj = JSON.parse(text);
  obj.addons[id].updates.push(entry);
  const out = JSON.stringify(obj, null, 2) + '\n';
  structuralCheck('appendEntry', out, id, null);
  return out;
}
