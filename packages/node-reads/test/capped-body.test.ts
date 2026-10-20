// WEB_INTERFACE → Reading a node's answer — readCappedJson's unparseable 2xx
// body carries the raw text as a verdict names it: every C0 control, DEL and
// C1 control as its \u escape, never raw; the text so shown whole up to 120
// characters, else as much of it as fits and `…`.

import { describe, it, expect } from 'vitest';
import { readCappedJson } from '../src/http.js';

describe("readCappedJson's unparseable 2xx body", () => {
  it('an ESC and a CR in the body read as their \\u escapes, never raw', async () => {
    const body = 'bad\u001bjson\rhere';
    const res = await readCappedJson<unknown>(new Response(body, { status: 200 }), 1_024);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    // control — the prefix is in place
    expect(res.body.startsWith('unparseable body: ')).toBe(true);
    // last — the ESC and CR are shown as their \u escapes, never raw
    expect(res.body).toBe('unparseable body: bad\\u001bjson\\u000dhere');
  });

  it('a 200-ESC body reads with the 120-character bound and an ellipsis', async () => {
    const body = '\u001b'.repeat(200);
    const res = await readCappedJson<unknown>(new Response(body, { status: 200 }), 1_024);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    // control — the body carries the prefix and is non-empty after it
    expect(res.body.startsWith('unparseable body: ')).toBe(true);
    // last — 20 escaped ESCs (each 6 characters, 120 inside the prefix) and
    // an ellipsis — the escape widths count toward the bound
    expect(res.body).toBe(`unparseable body: ${'\\u001b'.repeat(20)}…`);
  });
});
