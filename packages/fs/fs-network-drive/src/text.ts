/**
 * Text handling the drive-backed filesystem provider applies to materialized
 * bytes: UTF-8 decoding with binary rejection, the LF storage normalization the
 * `ctx.fs` diff basis is expressed in, and the literal search-and-replace the
 * seam's `editText` performs.
 *
 * @module @deepseek-ai/dsh-fs-network-drive/text
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditRequest } from '@deepseek-ai/dsh-fs'

/** Leading bytes inspected for NUL before a file is accepted as text. */
export const BINARY_SAMPLE_BYTES = 8192

/**
 * Replace CRLF line endings with LF, the storage form every `ctx.fs` diff basis
 * is expressed in.
 * @param value - decoded file text.
 * @returns the text with CRLF collapsed to LF.
 */
export function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

/**
 * Whether a file's existing text is predominantly CRLF, sampled over its head.
 * @param value - decoded file text as stored.
 * @returns true when CRLF outnumbers bare LF in the sample.
 */
export function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

/**
 * Restore a file's original line-ending convention before it is written back.
 * @param value - LF-normalized text.
 * @param crlf - whether the file was predominantly CRLF.
 * @returns the text in the file's own convention.
 */
export function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

/**
 * Decode materialized bytes as UTF-8, rejecting binary content first.
 * @param bytes - the exact file bytes.
 * @param displayPath - the path named in failure messages.
 * @param binarySampleBytes - how many leading bytes are inspected for NUL.
 * @returns the decoded text.
 * @throws FsError `FS_NOT_TEXT` for NUL-bearing or invalid UTF-8 content.
 */
export function decodeText(bytes: Uint8Array, displayPath: string, binarySampleBytes: number): string {
  if (bytes.subarray(0, binarySampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

/**
 * Apply one literal search-and-replace to LF-normalized text.
 * @param content - the file's current LF-normalized text.
 * @param request - the literal edit, whose strings are normalized the same way.
 * @param displayPath - the path named in failure messages.
 * @returns the edited text.
 * @throws FsError `FS_EDIT_NOT_FOUND` for an empty or unmatched search string,
 *   `FS_AMBIGUOUS_EDIT` when a single-match edit matched more than once.
 */
export function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}
