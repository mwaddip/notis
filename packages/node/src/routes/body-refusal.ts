/**
 * What the public app answers an error the body parser raised for a request
 * it refuses (NODE_INTERFACE → HTTP API → "A body the parser refuses is the
 * client's error"); null for any other error.
 *
 * An error is the parser's when it carries one of the `type` strings that
 * body-parser 1.x and raw-body 2.x stamp on their refusals: the four 4xx
 * marks the parser raises on a request it will not read, plus the two 400
 * stream marks raw-body raises when it cannot finish reading. A thrown
 * object that merely has `status: 400` is not a refusal — the mark pins
 * the error to the parser. A parser error whose status is 5xx (its
 * `stream.encoding.set`, `stream.not.readable`) is the node's fault and
 * falls to the generic 500 handler.
 */
export function bodyRefusal(
  err: unknown,
): { status: number; reason: string } | null {
  if (err === null || typeof err !== 'object') return null;

  const type = (err as { type?: unknown }).type;
  if (typeof type !== 'string' || !PARSER_TYPES.has(type)) return null;

  const raw = (err as { status?: unknown; statusCode?: unknown }).status
    ?? (err as { statusCode?: unknown }).statusCode;
  if (typeof raw !== 'number' || raw < 400 || raw >= 500) return null;

  if (type === 'entity.parse.failed') {
    return { status: 400, reason: 'malformed JSON body' };
  }
  if (type === 'entity.too.large') {
    return { status: 413, reason: 'body too large' };
  }
  return { status: raw, reason: 'bad request body' };
}

/**
 * The `type` strings body-parser 1.x and raw-body 2.x stamp on an error
 * they raise for a request the parser refuses. From the installed source:
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
 *
 * The 500 marks raw-body raises (`stream.encoding.set`, `stream.not.readable`)
 * are developer-error, not a refusal: `bodyRefusal` reads the status alongside
 * the type and lets anything 5xx fall through.
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
