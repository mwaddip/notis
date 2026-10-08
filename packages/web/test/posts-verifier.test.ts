import { describe, it, expect } from 'vitest';
import { createPostsVerifier } from '../src/extension/posts-verifier';
import type { PostCheck } from '@dagsocial/nipopow-client';

// WEB_INTERFACE → The extension → "The post check" — the posts verifier
// seam is a thin wrapper over the tool's checkPosts; the App's test
// (`app-post-check.test.ts`) covers the ingest behaviour over the three
// reads, and this one pins the module's own injection point and the
// default-wiring passthrough.

describe('createPostsVerifier', () => {
  it('calls the injected check once per batch and passes the rows through', () => {
    let calls = 0;
    const captured: unknown[][] = [];
    const result: PostCheck[] = [{ status: 'bound', id: 'ab'.repeat(32), txBytes: new Uint8Array(0), author: 'cd'.repeat(32), parent: null }];
    const v = createPostsVerifier({
      check: (rows) => {
        calls += 1;
        captured.push(rows);
        return result;
      },
    });
    const rows = [{ shape: 1 }];
    const out = v.check(rows);
    expect(calls).toBe(1);
    expect(captured[0]).toBe(rows);
    expect(out).toBe(result);
  });

  it('the default-wired verifier is a function; a batch of malformed rows gives malformed statuses', () => {
    const v = createPostsVerifier();
    const out = v.check([null, 42]);
    expect(out).toHaveLength(2);
    expect(out[0]!.status).toBe('unbound');
    expect(out[1]!.status).toBe('unbound');
  });
});
