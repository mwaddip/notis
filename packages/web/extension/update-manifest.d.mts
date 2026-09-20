export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function repoFromUpdateUrl(updateUrl: string): { owner: string; repo: string };
export interface UpdateEntry {
  version: string;
  update_link: string;
  update_hash: string;
  applications: { gecko: { strict_min_version: string } };
}
export function entryFor(input: {
  version: string;
  sha256Hex: string;
  minVersion: string;
  owner: string;
  repo: string;
}): UpdateEntry;
export function checkManifest(
  text: string,
  input: { id: string; version: string; owner: string; repo: string },
): UpdateEntry;
export function appendEntry(text: string, id: string, entry: UpdateEntry): string;
