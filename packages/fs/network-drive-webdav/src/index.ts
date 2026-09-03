/**
 * WebDAV Service Provider for the network-drive capability seam. It maps every
 * seam operation onto one `webdav` client call, threads the caller's
 * `AbortSignal` into the request, and re-resolves its credential from
 * `ctx.credentials` on every operation so a rotated secret reaches the next
 * call without a plugin restart.
 *
 * @module @deepseek-ai/dsh-network-drive-webdav
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { DriveError, driveChildPath, driveVersion } from '@deepseek-ai/dsh-network-drive/identity'
import { NetworkDrive } from '@deepseek-ai/dsh-network-drive'
import type {
  DriveByteRange,
  DriveContent,
  DriveDirEntry,
  DriveEntryType,
  DrivePath,
  DriveStat,
  DriveVersion,
  DriveWriteIntent,
} from '@deepseek-ai/dsh-network-drive/types'
import { AuthType, createClient } from 'webdav'
import type { BufferLike, FileStat, Headers as WebDavHeaders, ResponseDataDetailed, WebDAVClient, WebDAVClientOptions } from 'webdav'

/** How the provider authenticates to the WebDAV endpoint. */
export type WebDavAuthMode = 'none' | 'password' | 'token' | 'digest' | 'auto'

/** Configuration for the WebDAV network-drive provider. */
export interface Config {
  /** Absolute `http(s)` URL of the WebDAV collection that backs the drive root. */
  url: string
  /** Which WebDAV authentication scheme to use. */
  authType?: WebDavAuthMode
  /** Credential reference (environment-variable name) holding the username, for `password`, `digest`, and `auto`. */
  usernameEnv?: string
  /** Credential reference holding the password, for `password`, `digest`, and `auto`. */
  passwordEnv?: string
  /** Credential reference holding the bearer token value, for `token`. */
  tokenEnv?: string
  /** Deadline in milliseconds for one drive operation; the provider aborts the request when it expires. */
  requestTimeoutMs?: number
}

interface ResolvedConfig {
  url: string
  authType: WebDavAuthMode
  usernameEnv: CredentialRef | undefined
  passwordEnv: CredentialRef | undefined
  tokenEnv: CredentialRef | undefined
  requestTimeoutMs: number
}

interface SchemaResolvedConfig extends Config {
  authType: WebDavAuthMode
  requestTimeoutMs: number
}

/** The validated authentication scheme plus the credential references it requires. */
type AuthPlan =
  | { scheme: 'none' }
  | { scheme: 'token'; tokenEnv: CredentialRef }
  | { scheme: 'password' | 'digest' | 'auto'; usernameEnv: CredentialRef; passwordEnv: CredentialRef }

/** Fields a `webdav` client error carries beyond `Error`. */
interface WebDavStatusError {
  status?: number
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as WebDavStatusError).status
  return typeof status === 'number' ? status : undefined
}

function aborted(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Translate one `webdav` failure into the seam's closed code union.
 * @param error - the failure the client raised.
 * @param operation - the seam operation name, for the message.
 * @param path - the drive path the operation addressed.
 * @param signal - the caller's signal, which outranks the transport's own classification.
 * @returns the typed drive error to raise.
 */
function mapError(error: unknown, operation: string, path: DrivePath, signal: AbortSignal | undefined): DriveError {
  if (error instanceof DriveError) return error
  if (aborted(error, signal)) return new DriveError(`${operation} "${path}" aborted`, 'DRIVE_ABORTED', { cause: error })
  const status = statusOf(error)
  switch (status) {
    case 401:
    case 403:
      return new DriveError(
        `cannot ${operation} "${path}": the drive rejected the configured credential`,
        status === 401 ? 'DRIVE_UNAUTHENTICATED' : 'DRIVE_PERMISSION_DENIED',
        { cause: error },
      )
    case 404:
    case 410:
      return new DriveError(`cannot ${operation} "${path}": not found`, 'DRIVE_NOT_FOUND', { cause: error })
    case 409:
      return new DriveError(`cannot ${operation} "${path}": a parent collection is missing or is a file`, 'DRIVE_NOT_DIRECTORY', { cause: error })
    case 412:
      return new DriveError(`cannot ${operation} "${path}": the drive holds another revision`, 'DRIVE_PRECONDITION_FAILED', { cause: error })
    case 413:
      return new DriveError(`cannot ${operation} "${path}": the drive refused the transfer size`, 'DRIVE_TOO_LARGE', { cause: error })
    default:
      return new DriveError(`cannot ${operation} "${path}": ${String(error)}`, 'DRIVE_IO_ERROR', { cause: error })
  }
}

/**
 * The seam's entry kind for one WebDAV entry. `webdav` parses `resourcetype`
 * into exactly a file or a collection, so this drive never reports `other`.
 * @param stat - the entry the server described.
 * @returns the seam's entry kind.
 */
function entryType(stat: FileStat): DriveEntryType {
  return stat.type === 'directory' ? 'directory' : 'file'
}

/**
 * The bytes of one GET body, or `undefined` when the answer is not binary.
 * @param data - the payload the client returned for a binary-format read.
 * @returns the body as bytes, or `undefined` when it is not a binary body.
 */
function bodyBytes(data: BufferLike | string | undefined): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return undefined
}

/**
 * The first-byte position a `Content-Range` answer states.
 * @param header - the response's `Content-Range` value, if it sent one.
 * @returns the stated first-byte position, or `undefined` when the header is absent or unparsable.
 */
function statedStart(header: string | undefined): number | undefined {
  const stated = header === undefined ? null : /^bytes\s+(\d+)-/.exec(header.trim())
  const digits = stated?.[1]
  return digits === undefined ? undefined : Number(digits)
}

/**
 * The zero-based file position the answered body starts at, for a ranged read.
 *
 * Body length cannot tell a served window from a whole small file: a server
 * that ignores `Range` answers 200 with the entire entity, and that entity may
 * be shorter than the requested length. Only the status says which one
 * arrived. A 200 body starts at zero and is cut here; a 206 body starts where
 * its `Content-Range` says. Any other answer, a 206 without a parseable
 * `Content-Range`, and a window served past the requested offset all leave the
 * region unverifiable, so the read fails instead of returning bytes the caller
 * did not ask for.
 * @param status - the HTTP status the drive answered.
 * @param headers - the response headers, whose names `webdav` lowercases.
 * @param range - the window the caller requested.
 * @param path - the drive path, for the failure message.
 * @returns the file position of the body's first byte.
 * @throws DriveError `DRIVE_IO_ERROR` when the answer does not place its body.
 */
function answeredStart(status: number, headers: WebDavHeaders, range: DriveByteRange, path: DrivePath): number {
  if (status === 200) return 0
  if (status !== 206) {
    throw new DriveError(
      `cannot read "${path}": the drive answered ${status} for a byte range, which does not say where the body starts`,
      'DRIVE_IO_ERROR',
    )
  }
  const start = statedStart(headers['content-range'])
  if (start === undefined) {
    throw new DriveError(
      `cannot read "${path}": the drive answered 206 without a Content-Range placing the body`,
      'DRIVE_IO_ERROR',
    )
  }
  if (start > range.offset) {
    throw new DriveError(
      `cannot read "${path}": the drive served bytes from ${start} for a window requested at ${range.offset}`,
      'DRIVE_IO_ERROR',
    )
  }
  return start
}

/**
 * Derive the seam's revision token from one WebDAV entry. The ETag is the
 * server's own revision identity when it supplies one; otherwise the token
 * combines the last-modified stamp with the byte size, which distinguishes
 * same-second writes of different lengths.
 * @param stat - the entry the server described.
 * @returns the branded revision token.
 */
function versionOf(stat: FileStat): DriveVersion {
  const etag = stat.etag === null ? '' : stat.etag.trim()
  return driveVersion(etag === '' ? `mtime:${stat.lastmod}:${stat.size}` : `etag:${etag}`)
}

/** The WebDAV request path for one drive path: the client is already rooted at the drive root. */
function requestPath(path: DrivePath): string {
  return `/${path}`
}

/** WebDAV network drive over one remote collection. */
export class WebDavNetworkDrive extends NetworkDrive {
  static Config: z<Config> = z.object({
    url: z.string(),
    authType: z.union(['none', 'password', 'token', 'digest', 'auto'] as const).default('password'),
    usernameEnv: z.string(),
    passwordEnv: z.string(),
    tokenEnv: z.string(),
    requestTimeoutMs: z.number().default(30_000),
  })

  private readonly config: ResolvedConfig

  private readonly auth: AuthPlan

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery fills the defaulted fields before construction; the input type does not encode that step.
    const resolved = config as SchemaResolvedConfig
    this.config = {
      url: config.url,
      authType: resolved.authType,
      usernameEnv: config.usernameEnv === undefined ? undefined : credentialRef(config.usernameEnv),
      passwordEnv: config.passwordEnv === undefined ? undefined : credentialRef(config.passwordEnv),
      tokenEnv: config.tokenEnv === undefined ? undefined : credentialRef(config.tokenEnv),
      requestTimeoutMs: resolved.requestTimeoutMs,
    }
    this.validateEndpoint()
    this.auth = this.resolveAuth()
  }

  /**
   * Reject a composition whose endpoint or deadline configuration is unusable,
   * at load rather than at the first operation.
   */
  private validateEndpoint(): void {
    const url = URL.parse(this.config.url)
    if (url === null) {
      throw new Error(`network-drive-webdav: url must be an absolute URL, got ${JSON.stringify(this.config.url)}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`network-drive-webdav: url must use http or https, got ${JSON.stringify(url.protocol)}`)
    }
    if (!Number.isSafeInteger(this.config.requestTimeoutMs) || this.config.requestTimeoutMs < 1) {
      throw new Error('network-drive-webdav: requestTimeoutMs must be a positive integer')
    }
  }

  /**
   * Resolve the configured scheme into the credential references it requires,
   * rejecting a composition that cannot serve it at load rather than at the
   * first operation.
   * @returns the validated scheme and its credential references.
   */
  private resolveAuth(): AuthPlan {
    switch (this.config.authType) {
      case 'none':
        return { scheme: 'none' }
      case 'token':
        if (this.config.tokenEnv === undefined) {
          throw new Error('network-drive-webdav: authType "token" requires tokenEnv naming the credential holding the bearer token')
        }
        return { scheme: 'token', tokenEnv: this.config.tokenEnv }
      case 'password':
      case 'digest':
      case 'auto':
        if (this.config.usernameEnv === undefined || this.config.passwordEnv === undefined) {
          throw new Error(`network-drive-webdav: authType ${JSON.stringify(this.config.authType)} requires both usernameEnv and passwordEnv`)
        }
        return { scheme: this.config.authType, usernameEnv: this.config.usernameEnv, passwordEnv: this.config.passwordEnv }
    }
  }

  /**
   * Read one credential reference through the credential seam, falling back to
   * the launch environment when no provider is mounted, exactly as the model
   * adapters do.
   * @param ref - the reference to resolve.
   * @returns the non-empty secret.
   * @throws DriveError `DRIVE_UNAUTHENTICATED` when nothing is configured.
   */
  private async secret(ref: CredentialRef): Promise<string> {
    const credentials = this.ctx.get('credentials')
    const value = credentials === undefined ? process.env[ref] : (await credentials.resolve(ref))?.value
    if (value === undefined || value === '') {
      throw new DriveError(
        `network-drive-webdav: no value for credential ${ref}; store it through the credentials service or export it in the launching environment`,
        'DRIVE_UNAUTHENTICATED',
      )
    }
    return value
  }

  /**
   * Build one request-scoped client from freshly resolved credentials. The
   * client is deliberately per operation: the credential seam's contract is
   * that consumers re-resolve at each operation instead of caching a value
   * across them.
   * @returns the authenticated WebDAV client for one operation.
   */
  private async client(): Promise<WebDAVClient> {
    const options: WebDAVClientOptions = {}
    switch (this.auth.scheme) {
      case 'none':
        options.authType = AuthType.None
        break
      case 'token':
        options.authType = AuthType.Token
        // The seam's own tokenEnv holds the bearer value; the client frames it.
        options.token = { access_token: await this.secret(this.auth.tokenEnv), token_type: 'Bearer' }
        break
      case 'password':
      case 'digest':
      case 'auto':
        options.authType = this.auth.scheme === 'password'
          ? AuthType.Password
          : this.auth.scheme === 'digest' ? AuthType.Digest : AuthType.Auto
        options.username = await this.secret(this.auth.usernameEnv)
        options.password = await this.secret(this.auth.passwordEnv)
        break
    }
    return createClient(this.config.url, options)
  }

  /**
   * Run one client call under a signal that also carries the configured
   * per-operation deadline, and translate any failure into the seam's codes.
   * @param operation - the seam operation name, for messages.
   * @param path - the drive path being addressed.
   * @param signal - the caller's cancellation signal.
   * @param run - the client call, receiving the client and the combined signal.
   * @returns whatever `run` resolves to.
   */
  private async call<T>(
    operation: string,
    path: DrivePath,
    signal: AbortSignal | undefined,
    run: (client: WebDAVClient, requestSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    // Read the caller's state through a call rather than a narrowed property:
    // it changes between the guard and the failure, which is the whole point.
    const cancelled = (): boolean => signal !== undefined && signal.aborted
    if (cancelled()) throw new DriveError(`${operation} "${path}" aborted`, 'DRIVE_ABORTED')
    const deadline = AbortSignal.timeout(this.config.requestTimeoutMs)
    const requestSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    try {
      return await run(await this.client(), requestSignal)
    } catch (error: unknown) {
      if (deadline.aborted && !cancelled()) {
        throw new DriveError(
          `cannot ${operation} "${path}": the drive did not answer within ${this.config.requestTimeoutMs}ms`,
          'DRIVE_IO_ERROR',
          { cause: error },
        )
      }
      throw mapError(error, operation, path, signal)
    }
  }

  override async stat(path: DrivePath, signal?: AbortSignal): Promise<DriveStat | undefined> {
    return this.call('stat', path, signal, async (client, requestSignal) => {
      let stat: FileStat
      try {
        stat = await client.stat(requestPath(path), { signal: requestSignal }) as FileStat
      } catch (error: unknown) {
        const status = statusOf(error)
        if (status === 404 || status === 410) return undefined
        throw error
      }
      return {
        path,
        type: entryType(stat),
        version: versionOf(stat),
        ...stat.type === 'file' ? { size: stat.size } : {},
      }
    })
  }

  override async list(path: DrivePath, signal?: AbortSignal): Promise<DriveDirEntry[]> {
    return this.call('list', path, signal, async (client, requestSignal) => {
      const contents = await client.getDirectoryContents(requestPath(path), { signal: requestSignal, details: false })
      return contents.map(stat => ({
        name: stat.basename,
        path: driveChildPath(path, stat.basename),
        type: entryType(stat),
        version: versionOf(stat),
        ...stat.type === 'file' ? { size: stat.size } : {},
      }))
    })
  }

  override async read(path: DrivePath, range: DriveByteRange | undefined, signal?: AbortSignal): Promise<DriveContent> {
    if (range !== undefined && (!Number.isSafeInteger(range.offset) || range.offset < 0)) {
      throw new DriveError(`cannot read "${path}": range offset must be a non-negative integer`, 'DRIVE_IO_ERROR')
    }
    if (range !== undefined && (!Number.isSafeInteger(range.length) || range.length < 1)) {
      throw new DriveError(`cannot read "${path}": range length must be a positive integer`, 'DRIVE_IO_ERROR')
    }
    return this.call('read', path, signal, async (client, requestSignal) => {
      // The revision is read first so the caller learns which revision the
      // bytes belong to; a concurrent replacement between the two calls surfaces
      // at the caller's next compare-and-set rather than as silent staleness.
      const stat = await client.stat(requestPath(path), { signal: requestSignal }) as FileStat
      if (entryType(stat) !== 'file') {
        throw new DriveError(`cannot read "${path}": not a file`, 'DRIVE_NOT_FILE')
      }
      const rangeHeader = range === undefined
        ? {}
        : { headers: { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }
      // `details: true` is what makes the answer placeable: it carries the
      // status and headers beside the body. `webdav` types the return as the
      // union of both answer forms because the signature is not overloaded on
      // the flag, so the detailed arm is asserted here and re-checked through
      // `bodyBytes`, which fails loud on anything else.
      const answer = await client.getFileContents(requestPath(path), {
        signal: requestSignal,
        format: 'binary',
        details: true,
        ...rangeHeader,
      }) as ResponseDataDetailed<BufferLike | string>
      const whole = bodyBytes(answer.data)
      if (whole === undefined) {
        throw new DriveError(`cannot read "${path}": the drive returned no binary body`, 'DRIVE_IO_ERROR')
      }
      if (range === undefined) return { bytes: whole, version: versionOf(stat) }
      const start = answeredStart(answer.status, answer.headers, range, path)
      const from = range.offset - start
      return { bytes: whole.subarray(from, from + range.length), version: versionOf(stat) }
    })
  }

  override async write(
    path: DrivePath,
    bytes: Uint8Array,
    expected: DriveWriteIntent | undefined,
    signal?: AbortSignal,
  ): Promise<DriveVersion> {
    return this.call('write', path, signal, async (client, requestSignal) => {
      const guard = expected?.kind === 'replaceIfVersion'
        ? { headers: { 'If-Match': revisionHeader(expected.version) } }
        : {}
      const published = await client.putFileContents(requestPath(path), bufferOf(bytes), {
        signal: requestSignal,
        overwrite: expected?.kind !== 'createIfAbsent',
        ...guard,
      })
      if (!published) {
        throw new DriveError(`cannot write "${path}": the drive already holds this path`, 'DRIVE_PRECONDITION_FAILED')
      }
      const stat = await client.stat(requestPath(path), { signal: requestSignal }) as FileStat
      return versionOf(stat)
    })
  }

  override async remove(path: DrivePath, signal?: AbortSignal): Promise<void> {
    await this.call('remove', path, signal, async (client, requestSignal) => {
      await client.deleteFile(requestPath(path), { signal: requestSignal })
    })
  }

  override async move(from: DrivePath, to: DrivePath, signal?: AbortSignal): Promise<void> {
    await this.call('move', from, signal, async (client, requestSignal) => {
      await client.moveFile(requestPath(from), requestPath(to), { signal: requestSignal, overwrite: true })
    })
  }

  override async makeDirectory(path: DrivePath, signal?: AbortSignal): Promise<void> {
    if (path.length === 0) return
    await this.call('makeDirectory', path, signal, async (client, requestSignal) => {
      try {
        await client.createDirectory(requestPath(path), { signal: requestSignal, recursive: true })
      } catch (error: unknown) {
        // MKCOL answers 405 when the collection is already there, which is the
        // outcome this operation promises.
        if (statusOf(error) !== 405) throw error
      }
    })
  }
}

/**
 * Recover the raw ETag an `If-Match` header needs from the seam's revision
 * token. A token the provider derived from modification metadata cannot be sent
 * as a validator, so it becomes `*`: the write still refuses to create an
 * absent path, and the caller's own content check owns the rest.
 * @param version - the revision token the caller compares against.
 * @returns the `If-Match` header value.
 */
function revisionHeader(version: DriveVersion): string {
  return version.startsWith('etag:') ? version.slice('etag:'.length) : '*'
}

/**
 * Present bytes to the client as its own payload type without copying when the
 * view already spans its whole buffer.
 * @param bytes - the content to upload.
 * @returns the exact bytes as an `ArrayBuffer` payload.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.slice().buffer
}

export default WebDavNetworkDrive
