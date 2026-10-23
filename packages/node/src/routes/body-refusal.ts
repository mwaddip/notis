/**
 * The 4xx answer for an error the body parser hands back, or null for one
 * carrying no 4xx status. The caller is `createApp`'s `express.json` callback,
 * and an error raised anywhere else never reaches this function.
 * NODE_INTERFACE → HTTP API → "A refusal is the parser's by where it comes from"
 */
export function bodyRefusal(
  err: unknown,
): { status: number; reason: string } | null {
  if (err === null || typeof err !== 'object') return null;

  let status: number | undefined;
  if ('status' in err && typeof err.status === 'number') {
    status = err.status;
  } else if ('statusCode' in err && typeof err.statusCode === 'number') {
    status = err.statusCode;
  }
  if (status === undefined || status < 400 || status >= 500) return null;

  const type = 'type' in err && typeof err.type === 'string' ? err.type : null;
  if (type === 'entity.parse.failed') {
    return { status: 400, reason: 'malformed JSON body' };
  }
  if (type === 'entity.too.large') {
    return { status: 413, reason: 'body too large' };
  }
  return { status, reason: 'bad request body' };
}
