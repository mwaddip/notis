import { describe, it, expect } from 'vitest';
import { bodyRefusal } from '../../src/routes/body-refusal.js';
import { ClientError } from '../../src/services/client-error.js';

// NODE_INTERFACE → HTTP API → "A body the parser refuses is the client's error"

// Shaped exactly as body-parser 1.x and raw-body 2.x stamp their errors:
// http-errors 2.0.1's `createError` sets `status === statusCode` and copies
// the custom properties onto the Error (`type`, `expose`, …). The fields the
// recogniser reads are `type` and `status`/`statusCode`; the message is free.
function parserError(status: number, type: string): Error {
  const err = new Error(`parser mark: ${type}`) as Error & {
    status: number;
    statusCode: number;
    expose: boolean;
    type: string;
  };
  err.status = status;
  err.statusCode = status;
  err.expose = status < 500;
  err.type = type;
  return err;
}

describe('bodyRefusal — a body the parser refuses is the client\'s error', () => {
  // Each `type` the installed parser can raise and what the function answers.
  const table: Array<{
    name: string;
    status: number;
    type: string;
    answer: { status: number; reason: string };
  }> = [
    {
      name: 'entity.parse.failed → 400 malformed JSON body',
      status: 400,
      type: 'entity.parse.failed',
      answer: { status: 400, reason: 'malformed JSON body' },
    },
    {
      name: 'entity.too.large → 413 body too large',
      status: 413,
      type: 'entity.too.large',
      answer: { status: 413, reason: 'body too large' },
    },
    {
      name: 'entity.verify.failed → 403 bad request body',
      status: 403,
      type: 'entity.verify.failed',
      answer: { status: 403, reason: 'bad request body' },
    },
    {
      name: 'charset.unsupported → 415 bad request body',
      status: 415,
      type: 'charset.unsupported',
      answer: { status: 415, reason: 'bad request body' },
    },
    {
      name: 'encoding.unsupported → 415 bad request body',
      status: 415,
      type: 'encoding.unsupported',
      answer: { status: 415, reason: 'bad request body' },
    },
    {
      name: 'request.aborted → 400 bad request body',
      status: 400,
      type: 'request.aborted',
      answer: { status: 400, reason: 'bad request body' },
    },
    {
      name: 'request.size.invalid → 400 bad request body',
      status: 400,
      type: 'request.size.invalid',
      answer: { status: 400, reason: 'bad request body' },
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      expect(bodyRefusal(parserError(row.status, row.type))).toEqual(row.answer);
    });
  }

  // Null is only answered when a mark pins the error to the parser.

  it('a plain Error is null', () => {
    expect(bodyRefusal(new Error('something broke'))).toBeNull();
  });

  it('a ClientError (a route\'s own 400) is null — no parser mark', () => {
    expect(bodyRefusal(new ClientError('bad', 400))).toBeNull();
  });

  it('an object with status 400 and no parser mark is null', () => {
    const err = Object.assign(new Error('fake'), { status: 400, statusCode: 400 });
    expect(bodyRefusal(err)).toBeNull();
  });

  // A parser error with a 5xx status is the node's fault, not a refusal
  // (raw-body's stream.encoding.set and stream.not.readable are 500).

  it('a parser mark with a 500 status is null (stream.encoding.set)', () => {
    expect(bodyRefusal(parserError(500, 'stream.encoding.set'))).toBeNull();
  });

  it('a parser mark with a 500 status is null (stream.not.readable)', () => {
    expect(bodyRefusal(parserError(500, 'stream.not.readable'))).toBeNull();
  });

  it('null is null', () => {
    expect(bodyRefusal(null)).toBeNull();
  });

  it('a string is null', () => {
    expect(bodyRefusal('something')).toBeNull();
  });

  it('a number is null', () => {
    expect(bodyRefusal(42)).toBeNull();
  });

  // Edge: a mark with no status — nothing to refuse with.

  it('a parser mark without a status is null', () => {
    const err = new Error('mark but no status') as Error & { type: string };
    err.type = 'entity.parse.failed';
    expect(bodyRefusal(err)).toBeNull();
  });
});
