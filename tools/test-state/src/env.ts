// The environment every spawned process of a run reads from the developer
// shell. PATH resolves `node`'s dynamic libraries, HOME is the OS's fallback
// temp root, and the temp-dir variables point at the writable temp root. Every
// other variable the loader or the generator sets by name, so a shell
// carrying MESH_* or WEB_SHELL_PATH cannot change what the node under test
// sees.
export const SPAWN_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
];

export function allowlistedEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of SPAWN_ENV_ALLOWLIST) {
    const v = source[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}
