// MESH_INTERFACE → The IP certificate — read a log file for lines added
// AFTER a given byte offset (captured before the window). Scenarios
// capture a log's size at step start, then at step end read every byte
// past that offset and look for a pattern.
//
// Pure byte offsets are safer than mtime: a line written in the same
// millisecond as the probe would miss the mtime cut, but a byte offset
// catches it. Scenarios never roll the log over, so monotone growth
// holds.

import { existsSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';

/**
 * Return the current size of a file in bytes. `null` if the file does
 * not exist.
 */
export function readFileSize(path) {
  if (!existsSync(path)) return null;
  return statSync(path).size;
}

/**
 * Read the bytes from `offset` to end of file as a UTF-8 string. A
 * missing file reads as `''`. If `offset` is past the current size,
 * reads as `''`.
 */
export function readSince(path, offset) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  if (typeof offset !== 'number' || offset >= size) return '';
  const length = size - offset;
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

/**
 * Count the matches of `pattern` (a RegExp) in the slice of a file past
 * `offset`. The pattern must be a RegExp with the `g` flag or a plain
 * string matched by `indexOf`.
 */
export function countMatchesSince(path, offset, pattern) {
  const text = readSince(path, offset);
  if (text === '') return 0;
  if (pattern instanceof RegExp) {
    let n = 0;
    const re = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g');
    while (re.exec(text) !== null) n += 1;
    return n;
  }
  if (typeof pattern !== 'string') throw new Error('pattern must be a RegExp or a string');
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(pattern, i)) !== -1) { n += 1; i += pattern.length; }
  return n;
}
