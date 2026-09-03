/**
 * Behavior of the WebDAV drive provider against a stubbed `webdav` client: the
 * request options it builds, the credentials it resolves per operation, the
 * revision tokens it derives, and the failure codes it raises. No network.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { drivePath } from '@deepseek-ai/dsh-network-drive/identity'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { AuthType } from 'webdav'
import type { FileStat, WebDAVClientOptions } from 'webdav'
import WebDavNetworkDrive from '@deepseek-ai/dsh-network-drive-webdav'
import * as WebDavInvariant from '../src/invariant.ts'

interface RecordedCall {
  method: string
  path: string
  options: Record<string, unknown>
}

interface StubNode {
  type: 'file' | 'directory'
  content: string
  etag: string | null
  lastmod: string
}

/** One GET answer in the detailed form `details: true` asks for. */
interface StubAnswer {
  status: number
  headers: Record<string, string>
  data: unknown
}

const calls: RecordedCall[] = []
const clientOptions: WebDAVClientOptions[] = []
const nodes = new Map<string, StubNode>()
let failWith: { status: number } | undefined
/** A value the next client call throws verbatim, for failures that carry no HTTP status. */
let rejectWith: { value: unknown } | undefined
let putResult = true
let stallMs = 0

/**
 * How the stub answers a GET carrying a `Range` header. The default is a
 * conforming server: 206 with exactly the requested window and the
 * `Content-Range` that places it. Tests replace it to model servers that
 * ignore, mis-state, or mis-place the window.
 * @param bytes - the whole stored entity.
 * @param range - the window the request asked for.
 * @returns the answer the client returns to the provider.
 */
let rangeAnswer = (bytes: Uint8Array, range: { offset: number; length: number }): StubAnswer => ({
  status: 206,
  headers: { 'content-range': `bytes ${range.offset}-${range.offset + range.length - 1}/${bytes.byteLength}` },
  data: bytes.slice(range.offset, range.offset + range.length).buffer,
})

/** The default conforming-server answer, restored before every test. */
const CONFORMING_RANGE_ANSWER = rangeAnswer

/**
 * The window one `Range` request header names.
 * @param header - the `Range` value the provider sent, if any.
 * @returns the requested window, or `undefined` for an unranged GET.
 */
function requestedWindow(header: string | undefined): { offset: number; length: number } | undefined {
  const stated = header === undefined ? null : /^bytes=(\d+)-(\d+)$/.exec(header)
  const first = stated?.[1]
  const last = stated?.[2]
  if (first === undefined || last === undefined) return undefined
  return { offset: Number(first), length: Number(last) - Number(first) + 1 }
}

function statOf(path: string): FileStat {
  const node = nodes.get(path)
  if (node === undefined) throw Object.assign(new Error('Invalid response: 404'), { status: 404 })
  return {
    filename: path,
    basename: path.slice(path.lastIndexOf('/') + 1),
    lastmod: node.lastmod,
    size: new TextEncoder().encode(node.content).byteLength,
    type: node.type,
    etag: node.etag,
  }
}

function record(method: string, path: string, options: Record<string, unknown> | undefined): void {
  calls.push({ method, path, options: options ?? {} })
  if (rejectWith !== undefined) {
    const thrown = rejectWith.value
    rejectWith = undefined
    throw thrown
  }
  if (failWith !== undefined) {
    const error = Object.assign(new Error(`Invalid response: ${failWith.status}`), { status: failWith.status })
    failWith = undefined
    throw error
  }
}

vi.mock('webdav', async () => {
  const actual = await vi.importActual<typeof import('webdav')>('webdav')
  return {
    AuthType: actual.AuthType,
    createClient: (url: string, options: WebDAVClientOptions) => {
      clientOptions.push({ url, ...options } as WebDAVClientOptions)
      return {
        stat: async (path: string, options?: Record<string, unknown>) => {
          record('stat', path, options)
          if (stallMs > 0) {
            await new Promise(resolve => setTimeout(resolve, stallMs))
            const signal = options?.signal as AbortSignal | undefined
            if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
          }
          return statOf(path)
        },
        getDirectoryContents: async (path: string, options?: Record<string, unknown>) => {
          record('list', path, options)
          statOf(path)
          return [...nodes.keys()]
            .filter(candidate => candidate !== path && candidate.slice(0, candidate.lastIndexOf('/')) === (path === '/' ? '' : path))
            .map(statOf)
        },
        getFileContents: async (path: string, options?: Record<string, unknown>) => {
          record('read', path, options)
          const node = nodes.get(path)
          if (node === undefined) throw Object.assign(new Error('Invalid response: 404'), { status: 404 })
          const bytes = new TextEncoder().encode(node.content)
          const headers = options?.headers as Record<string, string> | undefined
          const window = requestedWindow(headers?.Range)
          if (window === undefined) return { status: 200, headers: {}, data: bytes.buffer }
          return rangeAnswer(bytes, window)
        },
        putFileContents: async (path: string, data: ArrayBuffer, options?: Record<string, unknown>) => {
          record('write', path, options)
          if (!putResult) {
            putResult = true
            return false
          }
          nodes.set(path, {
            type: 'file',
            content: new TextDecoder().decode(new Uint8Array(data)),
            etag: '"written"',
            lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT',
          })
          return true
        },
        deleteFile: async (path: string, options?: Record<string, unknown>) => {
          record('remove', path, options)
          nodes.delete(path)
        },
        moveFile: async (from: string, to: string, options?: Record<string, unknown>) => {
          record('move', `${from}->${to}`, options)
          const node = nodes.get(from)
          if (node !== undefined) {
            nodes.delete(from)
            nodes.set(to, node)
          }
        },
        createDirectory: async (path: string, options?: Record<string, unknown>) => {
          record('makeDirectory', path, options)
          nodes.set(path, { type: 'directory', content: '', etag: null, lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
        },
      }
    },
  }
})

const contexts: Context[] = []

beforeEach(() => {
  calls.length = 0
  clientOptions.length = 0
  nodes.clear()
  nodes.set('/', { type: 'directory', content: '', etag: null, lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
  failWith = undefined
  rejectWith = undefined
  putResult = true
  stallMs = 0
  rangeAnswer = CONFORMING_RANGE_ANSWER
})

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

const secrets = new Map<string, string>([['DRIVE_USER', 'alice'], ['DRIVE_PASS', 'hunter2'], ['DRIVE_TOKEN', 'bearer-value']])

function credentialProvider(): CredentialProvider {
  return {
    resolve: async (ref: string) => {
      const value = secrets.get(ref)
      return value === undefined ? undefined : { value, source: 'env' }
    },
  } as unknown as CredentialProvider
}

/** A server that ignores `Range` and answers 200 with the whole entity. */
const wholeEntity = (bytes: Uint8Array): StubAnswer => ({ status: 200, headers: {}, data: bytes.buffer })

/**
 * Store one file on the stubbed server.
 * @param path - the request path the node answers at.
 * @param content - the file's whole content.
 */
function store(path: string, content: string): void {
  nodes.set(path, { type: 'file', content, etag: '"abc123"', lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
}

/**
 * Read one window of `/notes.md` as text.
 * @param drive - the provider under test.
 * @param range - the byte window to request.
 * @returns the decoded bytes the provider returned.
 */
async function readText(drive: WebDavNetworkDrive, range: { offset: number; length: number }): Promise<string> {
  const content = await drive.read(drivePath('notes.md'), range)
  return new TextDecoder().decode(content.bytes)
}

async function setup(config: Record<string, unknown> = {}): Promise<WebDavNetworkDrive> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('credentials', credentialProvider())
  await ctx.plugin(WebDavNetworkDrive, {
    url: 'https://drive.example.com/remote.php/dav/files/alice',
    authType: 'password',
    usernameEnv: 'DRIVE_USER',
    passwordEnv: 'DRIVE_PASS',
    ...config,
  })
  return ctx.networkDrive as WebDavNetworkDrive
}

describe('WebDavNetworkDrive operations', () => {
  it('stats, lists, reads a byte range, writes, moves, removes, and creates directories', async () => {
    nodes.set('/notes.md', { type: 'file', content: 'hello drive', etag: '"abc123"', lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    nodes.set('/dir', { type: 'directory', content: '', etag: null, lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    const drive = await setup()

    await expect(drive.stat(drivePath('notes.md'))).resolves.toEqual({
      path: 'notes.md',
      type: 'file',
      version: 'etag:"abc123"',
      size: 11,
    })
    await expect(drive.stat(drivePath('missing.md'))).resolves.toBeUndefined()

    const listed = await drive.list(drivePath(''))
    expect(listed.map(entry => entry.name).sort()).toEqual(['dir', 'notes.md'])
    // A server that omits ETags still yields a revision that moves with content.
    expect(listed.find(entry => entry.name === 'dir')?.version).toBe('mtime:Tue, 03 Sep 2026 00:00:00 GMT:0')

    const ranged = await drive.read(drivePath('notes.md'), { offset: 0, length: 5 })
    expect(new TextDecoder().decode(ranged.bytes)).toBe('hello')
    // `details: true` is load-bearing: without the status and headers the
    // provider cannot tell a served window from a whole small body.
    expect(calls.find(call => call.method === 'read')?.options).toMatchObject({
      headers: { Range: 'bytes=0-4' },
      format: 'binary',
      details: true,
    })

    await expect(drive.read(drivePath('notes.md'), undefined)).resolves.toMatchObject({ version: 'etag:"abc123"' })
    await expect(drive.write(drivePath('notes.md'), new TextEncoder().encode('replaced'), undefined))
      .resolves.toBe('etag:"written"')
    expect(nodes.get('/notes.md')?.content).toBe('replaced')

    await drive.makeDirectory(drivePath('deep/dir'))
    expect(calls.find(call => call.method === 'makeDirectory')?.options).toMatchObject({ recursive: true })
    await drive.move(drivePath('notes.md'), drivePath('moved.md'))
    expect(nodes.has('/moved.md')).toBe(true)
    await drive.remove(drivePath('moved.md'))
    expect(nodes.has('/moved.md')).toBe(false)
  })

  it('sends the compare-and-set precondition the caller asked for', async () => {
    nodes.set('/guarded.md', { type: 'file', content: 'before', etag: '"v1"', lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    const drive = await setup()

    await drive.write(drivePath('guarded.md'), new TextEncoder().encode('after'), {
      kind: 'replaceIfVersion',
      version: (await drive.stat(drivePath('guarded.md')))!.version,
    })
    expect(calls.filter(call => call.method === 'write').at(-1)?.options).toMatchObject({
      headers: { 'If-Match': '"v1"' },
      overwrite: true,
    })

    await drive.write(drivePath('fresh.md'), new TextEncoder().encode('new'), { kind: 'createIfAbsent' })
    expect(calls.filter(call => call.method === 'write').at(-1)?.options).toMatchObject({ overwrite: false })

    // A revision the server never expressed as an ETag cannot be sent as a
    // validator, so the guard degrades to "some entity must exist".
    nodes.set('/plain.md', { type: 'file', content: 'x', etag: null, lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    await drive.write(drivePath('plain.md'), new TextEncoder().encode('y'), {
      kind: 'replaceIfVersion',
      version: (await drive.stat(drivePath('plain.md')))!.version,
    })
    expect(calls.filter(call => call.method === 'write').at(-1)?.options).toMatchObject({ headers: { 'If-Match': '*' } })
  })

  it('reports a refused create-if-absent as a precondition failure', async () => {
    nodes.set('/present.md', { type: 'file', content: 'x', etag: '"v1"', lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    const drive = await setup()
    putResult = false
    await expect(drive.write(drivePath('present.md'), new TextEncoder().encode('y'), { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'DRIVE_PRECONDITION_FAILED' })
  })

  it('passes through the window a 206 answer places at the requested offset', async () => {
    // The conforming answer is exactly the requested window, and its
    // Content-Range says so; cutting it again from the offset would read past
    // its end and return nothing.
    store('/notes.md', 'hello drive')
    const drive = await setup()
    await expect(readText(drive, { offset: 6, length: 5 })).resolves.toBe('drive')
  })

  it('cuts the window from the offset when the server ignores Range', async () => {
    // A collection without Range support answers 200 with the whole entity.
    // Taking the leading bytes would return "hello" for a window that starts
    // at 6, with no error.
    store('/notes.md', 'hello drive')
    rangeAnswer = wholeEntity
    const drive = await setup()
    await expect(readText(drive, { offset: 6, length: 5 })).resolves.toBe('drive')
  })

  it('returns no bytes when a server that ignores Range holds fewer than the window', async () => {
    // The regression: a 200 body shorter than the requested length is the
    // whole file, not a served window. Treating a short body as the window
    // returned this file's leading bytes for every offset past zero.
    store('/notes.md', 'drive')
    rangeAnswer = wholeEntity
    const drive = await setup()
    await expect(readText(drive, { offset: 6, length: 5 })).resolves.toBe('')
    await expect(readText(drive, { offset: 2, length: 5 })).resolves.toBe('ive')
  })

  it('cuts a 206 window that starts before the requested offset', async () => {
    store('/notes.md', 'hello drive')
    rangeAnswer = bytes => ({
      status: 206,
      headers: { 'content-range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` },
      data: bytes.buffer,
    })
    const drive = await setup()
    await expect(readText(drive, { offset: 6, length: 5 })).resolves.toBe('drive')
  })

  it('accepts a windowed body the client hands over as a view', async () => {
    store('/notes.md', 'hello drive')
    rangeAnswer = (bytes, range) => ({
      status: 206,
      headers: { 'content-range': `bytes ${range.offset}-${range.offset + range.length - 1}/${bytes.byteLength}` },
      data: bytes.subarray(range.offset, range.offset + range.length),
    })
    const drive = await setup()
    await expect(readText(drive, { offset: 6, length: 5 })).resolves.toBe('drive')
  })

  it.each([
    [
      'a 206 whose window starts past the requested offset',
      (bytes: Uint8Array): StubAnswer => ({
        status: 206,
        headers: { 'content-range': `bytes 8-${bytes.byteLength - 1}/${bytes.byteLength}` },
        data: bytes.slice(8).buffer,
      }),
      'served bytes from 8 for a window requested at 6',
    ],
    [
      'a 206 with no Content-Range',
      (bytes: Uint8Array): StubAnswer => ({ status: 206, headers: {}, data: bytes.buffer }),
      'answered 206 without a Content-Range placing the body',
    ],
    [
      'a 206 whose Content-Range states no first byte',
      (bytes: Uint8Array): StubAnswer => ({
        status: 206,
        headers: { 'content-range': `bytes */${bytes.byteLength}` },
        data: bytes.buffer,
      }),
      'answered 206 without a Content-Range placing the body',
    ],
    [
      'a status that is neither 200 nor 206',
      (bytes: Uint8Array): StubAnswer => ({ status: 204, headers: {}, data: bytes.buffer }),
      'answered 204 for a byte range',
    ],
    [
      'a body that is not binary',
      (): StubAnswer => ({ status: 200, headers: {}, data: 'hello drive' }),
      'the drive returned no binary body',
    ],
  ])('refuses %s rather than returning bytes from an unknown region', async (_label, answer, message) => {
    store('/notes.md', 'hello drive')
    rangeAnswer = answer
    const drive = await setup()
    await expect(drive.read(drivePath('notes.md'), { offset: 6, length: 5 }))
      .rejects.toMatchObject({ code: 'DRIVE_IO_ERROR', message: expect.stringContaining(message) as string })
  })

  it('rejects reading a directory and an invalid byte range', async () => {
    nodes.set('/dir', { type: 'directory', content: '', etag: null, lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    const drive = await setup()
    await expect(drive.read(drivePath('dir'), undefined)).rejects.toMatchObject({ code: 'DRIVE_NOT_FILE' })
    await expect(drive.read(drivePath('dir'), { offset: -1, length: 4 })).rejects.toThrow('range offset')
    await expect(drive.read(drivePath('dir'), { offset: 0, length: 0 })).rejects.toThrow('range length')
  })

  it('treats an existing collection as a satisfied make-directory and skips the root', async () => {
    const drive = await setup()
    await drive.makeDirectory(drivePath(''))
    expect(calls.some(call => call.method === 'makeDirectory')).toBe(false)
    failWith = { status: 405 }
    await expect(drive.makeDirectory(drivePath('already'))).resolves.toBeUndefined()
  })

  it('reports any other make-directory failure instead of reading it as already-there', async () => {
    const drive = await setup()
    failWith = { status: 500 }
    await expect(drive.makeDirectory(drivePath('denied'))).rejects.toMatchObject({ code: 'DRIVE_IO_ERROR' })
  })

  it('sends exactly the bytes of a view into a larger buffer', async () => {
    // The seam hands over a Uint8Array, which may be a window on a longer
    // buffer; publishing the backing buffer would upload the neighbours too.
    const drive = await setup()
    const backing = new TextEncoder().encode('..hello..')
    await drive.write(drivePath('view.md'), backing.subarray(2, 7), undefined)
    expect(nodes.get('/view.md')?.content).toBe('hello')
  })
})

describe('WebDavNetworkDrive credentials, cancellation, and failures', () => {
  it('resolves the credential through the seam on every operation', async () => {
    nodes.set('/a.md', { type: 'file', content: 'a', etag: '"v"', lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    const drive = await setup()

    await drive.stat(drivePath('a.md'))
    await drive.stat(drivePath('a.md'))
    expect(clientOptions).toHaveLength(2)
    expect(clientOptions[0]).toMatchObject({ authType: AuthType.Password, username: 'alice', password: 'hunter2' })

    secrets.set('DRIVE_PASS', 'rotated')
    await drive.stat(drivePath('a.md'))
    expect(clientOptions.at(-1)).toMatchObject({ password: 'rotated' })
    secrets.set('DRIVE_PASS', 'hunter2')
  })

  it('frames a bearer token and an anonymous endpoint', async () => {
    nodes.set('/a.md', { type: 'file', content: 'a', etag: '"v"', lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    const tokenDrive = await setup({ authType: 'token', tokenEnv: 'DRIVE_TOKEN' })
    await tokenDrive.stat(drivePath('a.md'))
    expect(clientOptions.at(-1)).toMatchObject({
      authType: AuthType.Token,
      token: { access_token: 'bearer-value', token_type: 'Bearer' },
    })

    const anonymous = await setup({ authType: 'none' })
    await anonymous.stat(drivePath('a.md'))
    expect(clientOptions.at(-1)).toMatchObject({ authType: AuthType.None })

    const digest = await setup({ authType: 'digest' })
    await digest.stat(drivePath('a.md'))
    expect(clientOptions.at(-1)).toMatchObject({ authType: AuthType.Digest })

    const auto = await setup({ authType: 'auto' })
    await auto.stat(drivePath('a.md'))
    expect(clientOptions.at(-1)).toMatchObject({ authType: AuthType.Auto })
  })

  it('reports an unconfigured credential rather than calling the endpoint anonymously', async () => {
    const drive = await setup({ usernameEnv: 'DRIVE_ABSENT' })
    await expect(drive.stat(drivePath('a.md'))).rejects.toMatchObject({ code: 'DRIVE_UNAUTHENTICATED' })
    expect(calls).toHaveLength(0)
  })

  it('threads the caller signal into the client and reports an abort as one', async () => {
    nodes.set('/a.md', { type: 'file', content: 'a', etag: '"v"', lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    const drive = await setup()

    await drive.stat(drivePath('a.md'), new AbortController().signal)
    expect(calls.at(-1)?.options.signal).toBeInstanceOf(AbortSignal)

    const controller = new AbortController()
    controller.abort()
    await expect(drive.stat(drivePath('a.md'), controller.signal)).rejects.toMatchObject({ code: 'DRIVE_ABORTED' })
  })

  it.each([
    [401, 'DRIVE_UNAUTHENTICATED'],
    [403, 'DRIVE_PERMISSION_DENIED'],
    [409, 'DRIVE_NOT_DIRECTORY'],
    [412, 'DRIVE_PRECONDITION_FAILED'],
    [413, 'DRIVE_TOO_LARGE'],
    [500, 'DRIVE_IO_ERROR'],
  ])('maps HTTP %i onto %s', async (status, code) => {
    nodes.set('/a.md', { type: 'file', content: 'a', etag: '"v"', lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    const drive = await setup()
    failWith = { status }
    await expect(drive.write(drivePath('a.md'), new TextEncoder().encode('x'), undefined))
      .rejects.toMatchObject({ code })
  })

  it('reports a client failure that carries no HTTP status', async () => {
    store('/a.md', 'a')
    const drive = await setup()
    rejectWith = { value: 'connection reset by peer' }
    await expect(drive.stat(drivePath('a.md'))).rejects.toMatchObject({
      code: 'DRIVE_IO_ERROR',
      message: expect.stringContaining('connection reset by peer') as string,
    })
  })

  it('reports a transport abort as a cancellation when the caller cancelled nothing', async () => {
    // The client aborts its own request on a transport fault; the caller has
    // no signal to read, so the error itself is the only evidence.
    store('/a.md', 'a')
    const drive = await setup()
    rejectWith = { value: new DOMException('aborted', 'AbortError') }
    await expect(drive.stat(drivePath('a.md'))).rejects.toMatchObject({ code: 'DRIVE_ABORTED' })
  })

  it('maps a missing collection onto not-found when listing', async () => {
    const drive = await setup()
    await expect(drive.list(drivePath('nowhere'))).rejects.toMatchObject({ code: 'DRIVE_NOT_FOUND' })
  })

  it('distinguishes its own request deadline from the caller cancelling', async () => {
    nodes.set('/a.md', { type: 'file', content: 'a', etag: '"v"', lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT' })
    const drive = await setup({ requestTimeoutMs: 1 })
    stallMs = 30

    await expect(drive.stat(drivePath('a.md'))).rejects.toMatchObject({
      code: 'DRIVE_IO_ERROR',
      message: expect.stringContaining('did not answer within 1ms') as string,
    })

    const caller = new AbortController()
    const cancelled = drive.stat(drivePath('a.md'), caller.signal)
    caller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'DRIVE_ABORTED' })
  })
})

describe('WebDavNetworkDrive configuration', () => {
  it.each([
    ['a relative endpoint', { url: 'drive.example.com' }, 'url must be an absolute URL'],
    ['a non-HTTP endpoint', { url: 'ftp://drive.example.com' }, 'url must use http or https'],
    ['a fractional deadline', { requestTimeoutMs: 1.5 }, 'requestTimeoutMs must be a positive integer'],
    ['token auth without a token reference', { authType: 'token' }, 'requires tokenEnv'],
    ['password auth without a password reference', { passwordEnv: undefined }, 'requires both usernameEnv and passwordEnv'],
  ])('refuses %s at load', async (_label, override, message) => {
    await expect(setup(override)).rejects.toThrow(message)
  })

  it('registers the package-owned invariant installer and releases it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(WebDavInvariant).await()
    // The registry refuses a second registration under the same package name,
    // which is what makes the mount observable: the same call can only succeed
    // once disposal has released the name.
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-network-drive-webdav', () => {})).toThrow('already registered')
    await fiber.dispose()
    const release = ctx.invariants.register('@deepseek-ai/dsh-network-drive-webdav', () => {})
    expect(typeof release).toBe('function')
    release()
  })
})
