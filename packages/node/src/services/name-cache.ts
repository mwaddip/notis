// NODE_INTERFACE → Usernames → "A list row carries its names": one keyed read
// per distinct identity per response.

type NameByOwner = (owner: string) => { name: string } | null;

export function nameFor(
  hex: string,
  cache: Map<string, string | null>,
  getUsernameByOwner: NameByOwner,
): string | null {
  const cached = cache.get(hex);
  if (cached !== undefined) return cached;
  const row = getUsernameByOwner(hex);
  const name = row ? row.name : null;
  cache.set(hex, name);
  return name;
}
