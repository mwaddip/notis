/**
 * What the public app answers an error the body parser raised for a request
 * it refuses, or null for any other error
 * (NODE_INTERFACE → HTTP API → "A body the parser refuses is the client's
 * error"). An error is the parser's when its `type` is in `PARSER_TYPES` and
 * its status is 4xx; a parser error whose 5xx mark falls through to the
 * generic 500 handler, and a thrown object that merely carries a 4xx status
 * without a `type` is not a refusal either.
 */
export function bodyRefusal(
  err: unknown,
): { status: number; reason: string } | null {
  if (err === null || typeof err !== 'object') return null;

  if (!('type' in err) || typeof err.type !== 'string') return null;
  if (!PARSER_TYPES.has(err.type)) return null;

  let status: number | undefined;
  if ('status' in err && typeof err.status === 'number') {
    status = err.status;
  } else if ('statusCode' in err && typeof err.statusCode === 'number') {
    status = err.statusCode;
  }
  if (status === undefined || status < 400 || status >= 500) return null;

  if (err.type === 'entity.parse.failed') {
    return { status: 400, reason: 'malformed JSON body' };
  }
  if (err.type === 'entity.too.large') {
    return { status: 413, reason: 'body too large' };
  }
  return { status, reason: 'bad request body' };
}

/**
 * The `type` marks body-parser 1.x and raw-body 2.x stamp on a refusal, with
 * the status each one carries. From the installed source:
 *
 *   body-parser/lib/read.js:
 *     - 400 `entity.parse.failed` — JSON.parse threw
 *     - 403 `entity.verify.failed` — a `verify` callback threw
 *     - 415 `charset.unsupported` — request's charset is not utf-*
 *     - 415 `encoding.unsupported` — content-encoding neither identity,
 *       deflate nor gzip, or inflate disabled
 *   raw-body/index.js:
 *     - 413 `entity.too.large` — body exceeds the declared or configured limit
 *     - 400 `request.aborted` — stream aborted before end
 *     - 400 `request.size.invalid` — received bytes did not match
 *       content-length
 *     - 415 `encoding.unsupported` — iconv has no decoder for the charset
 */
const PARSER_TYPES: ReadonlySet<string> = new Set([
  'entity.parse.failed',
  'entity.too.large',
  'entity.verify.failed',
  'charset.unsupported',
  'encoding.unsupported',
  'request.aborted',
  'request.size.invalid',
]);
