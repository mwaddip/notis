// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, posix } from 'node:path';

// The row discriminant lives in `api/dto.ts` behind `isWithdrawn`, `isLight`
// and `isFull`; `api/light-page.ts` is the only other site that reads a row's
// `kind` by name, where it rebuilds each arm field by field (WEB_INTERFACE →
// The extension → "The light read"). A bare discriminant anywhere else is a
// row the compiler can no longer narrow — the lint catches it before the suite
// is run.

const SRC = resolve(fileURLToPath(new URL('../src', import.meta.url)));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = resolve(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...tsFiles(abs));
    else if (name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

const files = tsFiles(SRC).map((f) => ({
  abs: f,
  rel: posix.normalize(relative(SRC, f).split(/[\\/]/).join('/')),
  text: readFileSync(f, 'utf8'),
}));

const DTO = 'api/dto.ts';
const LIGHT_PAGE = 'api/light-page.ts';

describe("discriminant sites — `'kind' in` and `.kind === 'light' | 'withdrawn'` live in dto.ts (and light-page.ts for the latter)", () => {
  it("`'kind' in` appears only in api/dto.ts", () => {
    const offenders = files.filter((f) => f.rel !== DTO && f.text.includes("'kind' in"));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  it("`.kind === 'light'` and `.kind === 'withdrawn'` appear only in api/dto.ts and api/light-page.ts", () => {
    const pattern = /\.kind\s*===\s*['"](light|withdrawn)['"]/;
    const offenders = files.filter((f) => f.rel !== DTO && f.rel !== LIGHT_PAGE && pattern.test(f.text));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });
});
