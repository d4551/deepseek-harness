/** Bounded raw HTTP body intake for GitHub signature verification. */

import { isUtf8 } from 'node:buffer'
import type { IncomingMessage } from 'node:http'

/** HTTP refusal whose message is safe to return without request data. */
export class WebhookHttpError extends Error {
  override readonly name = 'WebhookHttpError'

  constructor(
    readonly status: 400 | 401 | 405 | 413 | 415 | 503,
    message: string,
  ) {
    super(message)
  }
}

/** Values a Promise reject arm may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

/** Parse a decimal Content-Length or reject an ambiguous header. */
function contentLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length']
  if (value === undefined) return undefined
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new WebhookHttpError(400, 'invalid Content-Length')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw new WebhookHttpError(413, 'request body is too large')
  return length
}

/**
 * Accumulate one request's chunks until EOF, abort, or the byte ceiling.
 * Stream refusal becomes an aborted-body error; a ceiling hit stays 413.
 */
function collectBoundedChunks(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  const iterator: AsyncIterator<Buffer | string> = request[Symbol.asyncIterator]()
  const readNext = (): Promise<Buffer> =>
    iterator.next().then(
      (step) => {
        if (step.done) return Buffer.concat(chunks, size)
        const chunk = typeof step.value === 'string' ? Buffer.from(step.value) : step.value
        size += chunk.byteLength
        if (size > maxBodyBytes) {
          request.resume()
          throw new WebhookHttpError(413, 'request body is too large')
        }
        chunks.push(chunk)
        return readNext()
      },
      (reason: Thrown) => {
        if (reason instanceof WebhookHttpError) throw reason
        throw new WebhookHttpError(400, 'request body was aborted')
      },
    )
  return readNext()
}

/**
 * Read one request body as exact, bounded UTF-8 text.
 * @param request - incoming request before any parser consumes it.
 * @param maxBodyBytes - positive byte ceiling.
 * @returns the decoded body after EOF.
 * @throws {WebhookHttpError} for invalid length, excessive bytes, invalid UTF-8, or an aborted stream.
 */
export async function readBoundedUtf8Body(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<string> {
  const declared = contentLength(request)
  if (declared !== undefined && declared > maxBodyBytes) {
    request.resume()
    throw new WebhookHttpError(413, 'request body is too large')
  }
  const bytes = await collectBoundedChunks(request, maxBodyBytes)
  if (!request.complete) throw new WebhookHttpError(400, 'request body was aborted')
  if (!isUtf8(bytes)) throw new WebhookHttpError(400, 'request body is not valid UTF-8')
  return bytes.toString('utf8')
}
