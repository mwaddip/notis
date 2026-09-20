import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  repoFromUpdateUrl,
  entryFor,
  checkManifest,
  appendEntry,
} from '../extension/update-manifest.mjs';

// WEB_INTERFACE → "The Firefox build ships signed as well" —
// the Firefox update manifest, the entry shape, and the rules the module
// enforces. Every rule has a passing and a throwing exemplar; each throw
// is asserted by a fragment of its message naming the function that
// raised it.

const ID = 'extension@notis.fun';
const OWNER = 'mwaddip';
const REPO = 'notis';
const UPDATE_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/updates/firefox/updates.json`;

const HEX64_A = '0'.repeat(64);
const HEX64_B = 'a'.repeat(64);

describe('compareVersions', () => {
  it('equal values return 0', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('a missing element equals 0 — "1.0" equals "1.0.0.0"', () => {
    expect(compareVersions('1.0', '1.0.0.0')).toBe(0);
  });

  it('a > b returns 1 — "1.10" is newer than "1.9"', () => {
    expect(compareVersions('1.10', '1.9')).toBe(1);
  });

  it('a < b returns -1 — "0.3.1" is older than "0.3.2"', () => {
    expect(compareVersions('0.3.1', '0.3.2')).toBe(-1);
  });

  it('throws naming compareVersions on a non-string', () => {
    expect(() => compareVersions(1 as unknown as string, '1.0')).toThrow(/compareVersions/);
  });

  it('throws naming compareVersions on letters', () => {
    expect(() => compareVersions('a.b.c', '1.0')).toThrow(/compareVersions/);
  });

  it('throws naming compareVersions on an empty element', () => {
    expect(() => compareVersions('1..0', '1.0.0')).toThrow(/compareVersions/);
  });

  it('throws naming compareVersions on a leading zero — "2.01"', () => {
    expect(() => compareVersions('2.01', '2.1')).toThrow(/compareVersions/);
  });

  it('accepts a bare "0" as an element — no leading-zero throw', () => {
    expect(compareVersions('1.0', '1.0')).toBe(0);
  });

  it('throws naming compareVersions on more than four elements', () => {
    expect(() => compareVersions('1.2.3.4.5', '1.0')).toThrow(/compareVersions/);
  });

  it('throws naming compareVersions on a number over nine digits', () => {
    expect(() => compareVersions('1234567890.0', '1.0')).toThrow(/compareVersions/);
  });

  it('accepts nine digits — "999999999.0" > "1.0"', () => {
    expect(compareVersions('999999999.0', '1.0')).toBe(1);
  });
});

describe('repoFromUpdateUrl', () => {
  it('extracts owner and repo from the release URL', () => {
    expect(repoFromUpdateUrl(UPDATE_URL)).toEqual({ owner: OWNER, repo: REPO });
  });

  it('throws naming repoFromUpdateUrl on another host', () => {
    expect(() =>
      repoFromUpdateUrl('https://example.com/mwaddip/notis/updates/firefox/updates.json'),
    ).toThrow(/repoFromUpdateUrl/);
  });

  it('throws naming repoFromUpdateUrl on http://', () => {
    expect(() =>
      repoFromUpdateUrl('http://raw.githubusercontent.com/mwaddip/notis/updates/firefox/updates.json'),
    ).toThrow(/repoFromUpdateUrl/);
  });

  it('throws naming repoFromUpdateUrl on an invalid URL', () => {
    expect(() => repoFromUpdateUrl('not a url')).toThrow(/repoFromUpdateUrl/);
  });

  it('throws naming repoFromUpdateUrl on fewer than four path segments', () => {
    expect(() =>
      repoFromUpdateUrl('https://raw.githubusercontent.com/mwaddip/notis/updates'),
    ).toThrow(/repoFromUpdateUrl/);
  });

  it('throws naming repoFromUpdateUrl on a non-string', () => {
    expect(() => repoFromUpdateUrl(1 as unknown as string)).toThrow(/repoFromUpdateUrl/);
  });
});

describe('entryFor', () => {
  const version = '0.3.1';
  const minVersion = '140.0';

  it('builds the exact shape from valid inputs', () => {
    expect(
      entryFor({ version, sha256Hex: HEX64_A, minVersion, owner: OWNER, repo: REPO }),
    ).toEqual({
      version: '0.3.1',
      update_link:
        'https://github.com/mwaddip/notis/releases/download/v0.3.1/notis-extension-0.3.1-firefox.xpi',
      update_hash: `sha256:${HEX64_A}`,
      applications: { gecko: { strict_min_version: '140.0' } },
    });
  });

  it('throws naming entryFor on a version compareVersions rejects', () => {
    expect(() =>
      entryFor({ version: '2.01', sha256Hex: HEX64_A, minVersion, owner: OWNER, repo: REPO }),
    ).toThrow(/entryFor/);
  });

  it('throws naming entryFor on a minVersion outside the shape', () => {
    expect(() =>
      entryFor({ version, sha256Hex: HEX64_A, minVersion: '140.0.a', owner: OWNER, repo: REPO }),
    ).toThrow(/entryFor/);
  });

  it('throws naming entryFor on a sha256Hex that is not 64 hex characters', () => {
    expect(() =>
      entryFor({ version, sha256Hex: 'abc', minVersion, owner: OWNER, repo: REPO }),
    ).toThrow(/entryFor/);
  });

  it('throws naming entryFor on uppercase hex', () => {
    expect(() =>
      entryFor({
        version,
        sha256Hex: 'A'.repeat(64),
        minVersion,
        owner: OWNER,
        repo: REPO,
      }),
    ).toThrow(/entryFor/);
  });

  it('throws naming entryFor on a missing owner', () => {
    expect(() =>
      entryFor({ version, sha256Hex: HEX64_A, minVersion, owner: '', repo: REPO }),
    ).toThrow(/entryFor/);
  });

  it('throws naming entryFor on a missing repo', () => {
    expect(() =>
      entryFor({ version, sha256Hex: HEX64_A, minVersion, owner: OWNER, repo: '' }),
    ).toThrow(/entryFor/);
  });
});

const emptyManifest = () =>
  JSON.stringify({ addons: { [ID]: { updates: [] } } }, null, 2) + '\n';

function withEntries(entries: readonly unknown[]): string {
  return JSON.stringify({ addons: { [ID]: { updates: entries } } }, null, 2) + '\n';
}

describe('checkManifest', () => {
  it('finds the entry for a version present in the list', () => {
    const entry = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const text = withEntries([entry]);
    expect(checkManifest(text, { id: ID, version: '0.3.1', owner: OWNER, repo: REPO })).toEqual(
      entry,
    );
  });

  it('throws naming checkManifest on non-JSON text', () => {
    expect(() =>
      checkManifest('not json', { id: ID, version: '0.3.1', owner: OWNER, repo: REPO }),
    ).toThrow(/checkManifest/);
  });

  it("throws naming checkManifest when addons[id].updates is not an array", () => {
    const text = JSON.stringify({ addons: { [ID]: {} } }, null, 2) + '\n';
    expect(() =>
      checkManifest(text, { id: ID, version: '0.3.1', owner: OWNER, repo: REPO }),
    ).toThrow(/checkManifest/);
  });

  it('throws naming checkManifest on an entry with no string version', () => {
    const text = withEntries([{ update_link: 'https://github.com/mwaddip/notis/releases/download/v/x.xpi' }]);
    expect(() =>
      checkManifest(text, { id: ID, version: '0.3.1', owner: OWNER, repo: REPO }),
    ).toThrow(/checkManifest/);
  });

  it('throws naming checkManifest on an entry with no string update_link', () => {
    const text = withEntries([{ version: '0.3.1' }]);
    expect(() =>
      checkManifest(text, { id: ID, version: '0.3.1', owner: OWNER, repo: REPO }),
    ).toThrow(/checkManifest/);
  });

  it("throws naming checkManifest on an update_link outside the release-download prefix", () => {
    const text = withEntries([
      {
        version: '0.3.1',
        update_link: 'https://example.com/notis-extension-0.3.1-firefox.xpi',
      },
    ]);
    expect(() =>
      checkManifest(text, { id: ID, version: '0.3.1', owner: OWNER, repo: REPO }),
    ).toThrow(/checkManifest/);
  });

  it("throws naming checkManifest on an update_link that is not https:", () => {
    const text = withEntries([
      {
        version: '0.3.1',
        update_link:
          'http://github.com/mwaddip/notis/releases/download/v0.3.1/notis-extension-0.3.1-firefox.xpi',
      },
    ]);
    expect(() =>
      checkManifest(text, { id: ID, version: '0.3.1', owner: OWNER, repo: REPO }),
    ).toThrow(/checkManifest/);
  });

  it("throws naming checkManifest on an update_hash outside the sha256: hex64 shape", () => {
    const entry = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const text = withEntries([{ ...entry, update_hash: 'sha256:zz' }]);
    expect(() =>
      checkManifest(text, { id: ID, version: '0.3.1', owner: OWNER, repo: REPO }),
    ).toThrow(/checkManifest/);
  });

  it('throws naming checkManifest on versions not strictly ascending', () => {
    const a = entryFor({
      version: '0.3.2',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const b = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_B,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const text = withEntries([a, b]);
    expect(() =>
      checkManifest(text, { id: ID, version: '0.3.1', owner: OWNER, repo: REPO }),
    ).toThrow(/checkManifest/);
  });

  it('throws naming checkManifest when the version is absent from the list', () => {
    const entry = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const text = withEntries([entry]);
    expect(() =>
      checkManifest(text, { id: ID, version: '0.3.9', owner: OWNER, repo: REPO }),
    ).toThrow(/checkManifest/);
  });
});

describe('appendEntry', () => {
  it('takes a first entry against an empty updates array', () => {
    const entry = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const text = appendEntry(emptyManifest(), ID, entry);
    const parsed = JSON.parse(text);
    expect(parsed.addons[ID].updates).toEqual([entry]);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('appends a strictly-greater entry as the new last', () => {
    const first = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const second = entryFor({
      version: '0.3.2',
      sha256Hex: HEX64_B,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const step1 = appendEntry(emptyManifest(), ID, first);
    const step2 = appendEntry(step1, ID, second);
    const parsed = JSON.parse(step2);
    expect(parsed.addons[ID].updates).toEqual([first, second]);
  });

  it('throws naming appendEntry on a duplicate version', () => {
    const first = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const text = appendEntry(emptyManifest(), ID, first);
    expect(() => appendEntry(text, ID, first)).toThrow(/appendEntry/);
  });

  it('throws naming appendEntry on a downgrade', () => {
    const first = entryFor({
      version: '0.3.2',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const second = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_B,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const text = appendEntry(emptyManifest(), ID, first);
    expect(() => appendEntry(text, ID, second)).toThrow(/appendEntry/);
  });

  it('throws naming appendEntry when the incoming text has a broken entry', () => {
    const text = withEntries([{ update_link: 'https://github.com/mwaddip/notis/releases/download/x' }]);
    const next = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    expect(() => appendEntry(text, ID, next)).toThrow(/appendEntry/);
  });

  it('throws naming appendEntry when entry.version is not a string', () => {
    expect(() =>
      appendEntry(emptyManifest(), ID, { version: 1 } as unknown as Parameters<typeof appendEntry>[2]),
    ).toThrow(/appendEntry/);
  });

  it('throws naming appendEntry on an entry with no update_link', () => {
    const bad = { version: '0.3.1' } as unknown as Parameters<typeof appendEntry>[2];
    expect(() => appendEntry(emptyManifest(), ID, bad)).toThrow(/appendEntry/);
  });

  it('throws naming appendEntry on an entry with an http: update_link', () => {
    const bad: Parameters<typeof appendEntry>[2] = {
      version: '0.3.1',
      update_link:
        'http://github.com/mwaddip/notis/releases/download/v0.3.1/notis-extension-0.3.1-firefox.xpi',
      update_hash: `sha256:${HEX64_A}`,
      applications: { gecko: { strict_min_version: '140.0' } },
    };
    expect(() => appendEntry(emptyManifest(), ID, bad)).toThrow(/appendEntry/);
  });

  it('throws naming appendEntry on an entry with a malformed update_hash', () => {
    const bad: Parameters<typeof appendEntry>[2] = {
      version: '0.3.1',
      update_link:
        'https://github.com/mwaddip/notis/releases/download/v0.3.1/notis-extension-0.3.1-firefox.xpi',
      update_hash: 'sha256:zz',
      applications: { gecko: { strict_min_version: '140.0' } },
    };
    expect(() => appendEntry(emptyManifest(), ID, bad)).toThrow(/appendEntry/);
  });
});

describe('whole path — empty → 0.3.1 → 0.3.2 → checkManifest → refusals', () => {
  it('drives the happy path through entryFor and appendEntry, then checks both', () => {
    const e1 = entryFor({
      version: '0.3.1',
      sha256Hex: HEX64_A,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });
    const e2 = entryFor({
      version: '0.3.2',
      sha256Hex: HEX64_B,
      minVersion: '140.0',
      owner: OWNER,
      repo: REPO,
    });

    const step1 = appendEntry(emptyManifest(), ID, e1);
    const step2 = appendEntry(step1, ID, e2);

    // The text ends with one newline and parses.
    expect(step2.endsWith('\n')).toBe(true);
    expect(step2.endsWith('\n\n')).toBe(false);
    const parsed = JSON.parse(step2);
    expect(parsed.addons[ID].updates).toEqual([e1, e2]);

    // checkManifest finds both.
    expect(checkManifest(step2, { id: ID, version: '0.3.1', owner: OWNER, repo: REPO })).toEqual(e1);
    expect(checkManifest(step2, { id: ID, version: '0.3.2', owner: OWNER, repo: REPO })).toEqual(e2);

    // A third append of 0.3.2 (duplicate) throws.
    expect(() => appendEntry(step2, ID, e2)).toThrow(/appendEntry/);

    // A third append of 0.3.1 (downgrade) throws.
    expect(() => appendEntry(step2, ID, e1)).toThrow(/appendEntry/);
  });
});
