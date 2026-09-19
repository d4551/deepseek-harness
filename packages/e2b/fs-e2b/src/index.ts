/**
 * E2B provider for the filesystem capability seam. Paths, contents, and
 * atomic staging files remain inside the shared remote sandbox.
 * @module @deepseek-ai/dsh-fs-e2b
 */

import { KeyedLock } from '@deepseek-ai/dsh-keyed-lock'
import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import {
  CommandExitError,
  e2bControlEnvs,
  FileNotFoundError,
  FileType,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import type { EntryInfo, Sandbox } from '@deepseek-ai/dsh-e2b'
import {
  BINARY_SAMPLE_BYTES,
  decodeText,
  decodeTextStream,
  detectsCrlf,
  literalEdit,
  normalizeLineEndings,
  restoreLineEndings,
} from '@deepseek-ai/dsh-fs/text'

const VERSION_METADATA_KEY = 'dsh-version'
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/**
 * Human text for a rejected filesystem, stream, or remote-control value.
 * @param reason - the Thrown or claim-boundary unknown to render.
 * @returns the Error message, primitive text, or object tag.
 */
function thrownMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  switch (typeof reason) {
    case 'string': return reason
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(reason)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (reason === null) return 'null'
      return Object.prototype.toString.call(reason)
  }
}

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function abortedError(operation: string): FsError {
  return new FsError(`${operation} aborted`, 'FS_ABORTED')
}



function decodeCanonicalPath(encoded: string): string {
  if (encoded.length === 0 || !BASE64.test(encoded)) {
    throw new Error('fs-e2b: canonical path transport returned invalid base64')
  }
  const framed = Buffer.from(encoded, 'base64')
  if (framed.toString('base64') !== encoded
    || framed.length < 2
    || framed.at(-1) !== 0
    || framed.subarray(0, -1).includes(0)) {
    throw new Error('fs-e2b: canonical path transport returned invalid NUL framing')
  }
  let path: string
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(framed.subarray(0, -1))
  } catch (error) {
    throw new Error('fs-e2b: canonical path is not valid UTF-8', { cause: error })
  }
  if (!posix.isAbsolute(path)) throw new Error('fs-e2b: canonical path is not absolute')
  return path
}

function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function commandOpts(signal: AbortSignal | undefined): { envs: Record<string, string>; signal?: AbortSignal } {
  return { envs: e2bControlEnvs(), ...signalOpts(signal) }
}

function openReadStream(
  sandbox: Sandbox,
  target: FsTarget,
  signal: AbortSignal | undefined,
): Promise<ReadableStream<Uint8Array>> {
  // The pinned SDK's stream overload lies for empty files: content-length 0
  // returns '' instead of a ReadableStream.
  return sandbox.files.read(String(target.targetKey), { format: 'stream', ...signalOpts(signal) }).then(
    read => typeof read === 'string'
      ? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
      : read,
    (error: Thrown) => {
      throw mapError(error, 'read', target.displayPath, signal)
    },
  )
}

function entryType(entry: EntryInfo): FsInfo['type'] {
  switch (entry.type) {
    case FileType.FILE:
      return 'file'
    case FileType.DIR:
      return 'directory'
    default:
      return 'other'
  }
}

function entryVersion(entry: EntryInfo): ReturnType<typeof FsVersion> {
  const facts = JSON.stringify([
    entry.metadata?.[VERSION_METADATA_KEY],
    entry.path,
    entry.type,
    entry.size,
    entry.mode,
    entry.modifiedTime?.toISOString(),
    entry.symlinkTarget,
  ])
  return FsVersion(`e2b:${createHash('sha256').update(facts).digest('hex')}`)
}

function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  if (error instanceof FileNotFoundError) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (/permission denied|operation not permitted/i.test(thrownMessage(error))) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${thrownMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}


/** Remote filesystem backend sharing the sandbox owned by `ctx.e2b`. */
export class E2BFileSystem extends FileSystem {
  static inject = ['e2b']

  private readonly locks = new KeyedLock()

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.e2b.cwd, path)
    const mapped = (error: Thrown): never => {
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
    return this.ctx.e2b.getSandbox().then(
      sandbox => this.canonicalPath(sandbox, displayPath, opts?.signal).then((targetKey) => {
        if (opts?.signal?.aborted === true) mapped(abortedError('resolve'))
        return { targetKey: FsTargetKey(targetKey), displayPath }
      }, mapped),
      mapped,
    )
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`fs-e2b: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const entry = await this.probe(String(target.targetKey), target.displayPath, signal)
    if (entry === undefined) return undefined
    return {
      version: entryVersion(entry),
      type: entryType(entry),
      ...(entry.type === FileType.FILE ? { size: entry.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.e2b.cwd, path)
    const entry = await this.probe(displayPath, displayPath, signal)
    if (entry === undefined) return undefined
    const type = entry.symlinkTarget !== undefined
      ? 'symlink' as const
      : entry.type === FileType.FILE
        ? 'file' as const
        : entry.type === FileType.DIR
          ? 'directory' as const
          : 'other' as const
    return {
      version: entryVersion(entry),
      type,
      ...(entry.type === FileType.FILE ? { size: entry.size } : {}),
    }
  }

  override readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const mapped = (error: Thrown): never => {
      throw mapError(error, 'read', target.displayPath, signal)
    }
    return this.ctx.e2b.getSandbox().then(
      sandbox => this.requireRegular(target, signal).then(
        () => sandbox.files.read(String(target.targetKey), { format: 'bytes', ...signalOpts(signal) }).then((bytes) => {
          if (signal?.aborted === true) mapped(abortedError('read'))
          return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
        }, mapped),
        mapped,
      ),
      mapped,
    )
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const sandbox = await this.ctx.e2b.getSandbox()
    const info = await this.requireRegular(target, signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const stream = await openReadStream(sandbox, target, signal)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    const mapped = (error: Thrown): never => {
      throw mapError(error, 'read', target.displayPath, signal)
    }
    const pull = (): Promise<Uint8Array> => {
      if (signal?.aborted === true) return Promise.reject(abortedError('read'))
      return reader.read().then((chunk) => {
        if (chunk.done) {
          const whole = new Uint8Array(bytes)
          let offset = 0
          for (const part of chunks) {
            whole.set(part, offset)
            offset += part.byteLength
          }
          return whole
        }
        // The stat preflight covers the at-rest case; this streamed bound stops
        // a post-stat grower without transferring past the first overflowing chunk.
        bytes += chunk.value.byteLength
        if (bytes > maxBytes) {
          mapped(new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE'))
        }
        chunks.push(chunk.value)
        return pull()
      }, mapped)
    }
    return pull().then(
      (whole) => {
        reader.releaseLock()
        return whole
      },
      (error: Thrown) => reader.cancel().then(
        () => {
          reader.releaseLock()
          return mapped(error)
        },
        (_streamCancellationFailure: Thrown) => {
          reader.releaseLock()
          return mapped(error)
        },
      ),
    )
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const sandbox = await this.ctx.e2b.getSandbox()
    await this.requireRegular(target, signal)
    const stream = await openReadStream(sandbox, target, signal)
    const displayPath = target.displayPath
    return {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        const reader = stream.getReader()
        const state = { completed: false, released: false }
        const mapped = (error: Thrown): never => {
          throw mapError(error, 'read', displayPath, signal)
        }
        const byteSource: AsyncIterable<Uint8Array> = {
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<Uint8Array, undefined>> => {
              if (signal?.aborted === true) {
                return Promise.reject(abortedError('read')).then(undefined, mapped)
              }
              return reader.read().then(
                (next) => {
                  if (next.done) {
                    state.completed = true
                    return { done: true as const, value: undefined }
                  }
                  return { done: false as const, value: next.value }
                },
                mapped,
              )
            },
          }),
        }
        const iterator = decodeTextStream(byteSource, displayPath, BINARY_SAMPLE_BYTES)[Symbol.asyncIterator]()
        const release = async (): Promise<void> => {
          if (state.released) return
          state.released = true
          if (!state.completed) {
            await reader.cancel().then(
              () => { reader.releaseLock() },
              (_streamCancellationFailure: Thrown) => { reader.releaseLock() },
            )
            return
          }
          reader.releaseLock()
        }
        return {
          next: (): Promise<IteratorResult<string>> => iterator.next().then(
            (result) => {
              if (!result.done) return result
              return release().then(() => result)
            },
            (error: Thrown) => release().then(() => mapped(error)),
          ),
          async return(): Promise<IteratorReturnResult<undefined>> {
            await release()
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    const mapped = (error: Thrown): never => {
      throw mapError(error, 'list', target.displayPath, signal)
    }
    return this.ctx.e2b.getSandbox().then(
      sandbox => sandbox.files.list(String(target.targetKey), { depth: 1, ...signalOpts(signal) }).then((listed) => {
        const entries: FsDirEntry[] = []
        const collectFrom = (index: number): Promise<FsDirEntry[]> | FsDirEntry[] => {
          for (let i = index; i < listed.length; i++) {
            const entry = listed[i]
            if (entry === undefined) continue
            const displayPath = posix.join(target.displayPath, entry.name)
            if (entry.symlinkTarget === undefined) {
              entries.push({
                name: entry.name,
                type: entryType(entry),
                target: { targetKey: FsTargetKey(entry.path), displayPath },
                version: entryVersion(entry),
                ...(entry.type === FileType.FILE ? { size: entry.size } : {}),
              })
              continue
            }
            return this.canonicalPath(sandbox, entry.path, signal).then(
              canonical => this.probe(canonical, displayPath, signal).then((resolved) => {
                entries.push({
                  name: entry.name,
                  type: resolved === undefined ? 'other' : entryType(resolved),
                  target: { targetKey: FsTargetKey(canonical), displayPath },
                  ...(resolved !== undefined ? { version: entryVersion(resolved) } : {}),
                  ...(resolved?.type === FileType.FILE ? { size: resolved.size } : {}),
                })
                return collectFrom(i + 1)
              }, mapped),
              mapped,
            )
          }
          return entries.sort((left, right) => left.name.localeCompare(right.name))
        }
        return collectFrom(0)
      }, mapped),
      mapped,
    )
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.locks.run(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing !== undefined && entryType(existing) !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(
        target,
        content,
        existing,
        expected?.kind === 'createIfAbsent',
        signal,
      )
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.locks.run(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (entryType(existing) !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && entryVersion(existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, existing, false, signal)
      return { version, before, after }
    })
  }


  private canonicalPath(sandbox: Sandbox, path: string, signal?: AbortSignal): Promise<string> {
    return sandbox.commands.run(
      `set -o pipefail; realpath -mz -- ${quoteE2BShellArg(path)} | base64 -w0`,
      commandOpts(signal),
    ).then(
      result => decodeCanonicalPath(result.stdout),
      (error: Thrown) => {
        if (error instanceof CommandExitError) throw new Error(error.stderr || error.message, { cause: error })
        throw error
      },
    )
  }

  private probe(path: string, displayPath: string, signal?: AbortSignal): Promise<EntryInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const mapped = (error: Thrown): EntryInfo | undefined => {
      if (error instanceof FileNotFoundError) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
    return this.ctx.e2b.getSandbox().then(
      sandbox => sandbox.files.getInfo(path, signalOpts(signal)).then((entry) => {
        if (signal?.aborted === true) throw mapError(abortedError('stat'), 'stat', displayPath, signal)
        return entry
      }, mapped),
      mapped,
    )
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  private checkWriteIntent(existing: EntryInfo | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || entryVersion(existing) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    const mapped = (error: Thrown): null => {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
    return this.ctx.e2b.getSandbox().then(
      sandbox => sandbox.files.read(String(target.targetKey), { format: 'bytes', ...signalOpts(signal) }).then((bytes) => {
        if (signal?.aborted === true) throw mapError(abortedError('read'), 'read', target.displayPath, signal)
        try {
          return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.length))
        } catch (error) {
          if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
          throw mapError(error, 'read', target.displayPath, signal)
        }
      }, mapped),
      mapped,
    )
  }

  private readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const mapped = (error: Thrown): never => {
      throw mapError(error, 'edit', target.displayPath, signal)
    }
    return this.ctx.e2b.getSandbox().then(
      sandbox => sandbox.files.read(String(target.targetKey), { format: 'bytes', ...signalOpts(signal) }).then((bytes) => {
        if (signal?.aborted === true) mapped(abortedError('edit'))
        return decodeText(bytes, target.displayPath, bytes.length)
      }, mapped),
      mapped,
    )
  }

  private writeAtomic(
    target: FsTarget,
    content: string,
    existing: EntryInfo | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    const targetPath = String(target.targetKey)
    const versionId = randomUUID()
    const stagingDirectory = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`)
    const temporary = posix.join(stagingDirectory, 'content')
    let stagingDirectoryCreated = false
    const mapped = (error: Thrown): never => {
      throw mapError(error, 'write', target.displayPath, signal)
    }
    return this.ctx.e2b.getSandbox().then((sandbox) => {
      const fail = (error: Thrown): Promise<never> => {
        if (!stagingDirectoryCreated) mapped(error)
        return sandbox.files.remove(stagingDirectory).then(
          () => mapped(error),
          (_stagingDirectoryAlreadyAbsentOrCleanupFailed: Thrown) => mapped(error),
        )
      }
      const afterCommit = (committed: EntryInfo): Promise<ReturnType<typeof FsVersion>> =>
        sandbox.files.remove(stagingDirectory).then(
          () => entryVersion(committed),
          (_committedStagingCleanupFailure: Thrown) => entryVersion(committed),
        )
      const abortWrite = (): Promise<never> => fail(abortedError('write'))
      return sandbox.files.makeDir(stagingDirectory, signalOpts(signal)).then((created) => {
        if (!created) return fail(new Error('private staging directory already exists'))
        stagingDirectoryCreated = true
        return sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(stagingDirectory)}`, commandOpts(signal)).then(() => {
          if (signal?.aborted === true) return abortWrite()
          return sandbox.files.write(temporary, content, {
            metadata: { [VERSION_METADATA_KEY]: versionId },
            ...signalOpts(signal),
          }).then(() => {
            if (signal?.aborted === true) return abortWrite()
            const mode = existing === undefined ? 0o600 : existing.mode & 0o777
            return sandbox.commands.run(
              `chmod ${mode.toString(8)} -- ${quoteE2BShellArg(temporary)}`,
              commandOpts(signal),
            ).then(() => {
              if (signal?.aborted === true) return abortWrite()
              if (createIfAbsent) {
                return sandbox.files.getInfo(temporary, signalOpts(signal)).then((staged) => {
                  if (signal?.aborted === true) return abortWrite()
                  const targetArg = quoteE2BShellArg(targetPath)
                  return sandbox.commands.run(
                    `if ln -T -- ${quoteE2BShellArg(temporary)} ${targetArg}; then printf created; elif test -e ${targetArg} || test -L ${targetArg}; then printf exists; else exit 1; fi`,
                    commandOpts(undefined),
                  ).then((publication) => {
                    if (publication.stdout === 'exists') {
                      return fail(new FsError(
                        `cannot overwrite existing "${target.displayPath}" without reading it first`,
                        'FS_NOT_OBSERVED',
                      ))
                    }
                    if (publication.stdout !== 'created') {
                      return fail(new Error('guarded create returned an invalid publication result'))
                    }
                    return afterCommit({ ...staged, name: posix.basename(targetPath), path: targetPath })
                  }, fail)
                }, fail)
              }
              return sandbox.files.rename(temporary, targetPath).then(afterCommit, fail)
            }, fail)
          }, fail)
        }, fail)
      }, fail)
    }, mapped)
  }
}

export default E2BFileSystem
