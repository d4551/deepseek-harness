/** Content-addressed, owner-private local attachment storage. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readFile, rm, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import {
  AttachmentError,
  AttachmentId,
} from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { ensureDurableDirectoryWin32, publishNewFileWin32 } from '@deepseek-ai/dsh-atomic-write/win32'
import { normalizeImage } from './normalization.ts'
import type { NormalizationPolicy } from './normalization.ts'
import { detectImage, probeImage } from './image.ts'
import type { DetectedImage } from './image.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const durableHomes = new Set<string>()

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Strip both separator styles by hand: a POSIX host treats `\` as an
  // ordinary character, so path.basename would keep a Windows client's full
  // local path and leak it into the reference and the session log.
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  let clean = ''
  for (const character of leaf) {
    const code = character.codePointAt(0)
    if (code === undefined || code <= 0x1f || code === 0x7f) continue
    clean += character
  }
  clean = clean.trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function ensureReference(ref: ImageAttachmentRef): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]
}

/**
 * Derive the absolute immutable-object path for one normalized attachment.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - durable normalized attachment reference.
 * @returns provider-local path without reading the object.
 */
export function normalizedImagePath(root: string, ref: ImageAttachmentRef): string {
  const sha256 = ensureReference(ref)
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

async function inspectMetadata(
  data: Uint8Array,
  declaredMediaType: ImageAttachmentRef['mediaType'],
  limits: ImageAttachmentLimits,
): Promise<DetectedImage> {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  const detected = await detectImage(data, { maxPixels: limits.maxImagePixels, maxDimension: limits.maxImageDimension })
  if (detected.mediaType !== declaredMediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  return detected
}

/**
 * Run the full admission policy for one image without touching storage,
 * including normalization: a batch whose members all validate cannot later
 * be refused by the normalized image byte cap during publication.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved source admission policy.
 * @param policy - resolved normalization policy.
 * @param signal - cancellation checked before and between native image operations.
 * @returns completion after the raster has been decoded and its normalized version proven to fit.
 */
export async function validateImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
  signal?: AbortSignal,
): Promise<void> {
  await prepareImageFile(input, limits, policy, signal)
}

/** Fully prepared normalized object, verified before any batch member is persisted. */
export interface PreparedImageFile {
  /** Deterministic normalized bytes whose digest is {@link ref.attachmentId}. */
  data: Uint8Array
  /** Durable reference describing {@link data}. */
  ref: ImageAttachmentRef
}

/**
 * Decode, normalize, and verify one submitted image without touching storage.
 * @param input - submitted encoded bytes and declared media type.
 * @param limits - source admission policy.
 * @param policy - independent normalization policy.
 * @param signal - cancellation checked before and between native image operations.
 * @returns immutable reference facts beside bytes ready for atomic publication.
 */
export async function prepareImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
  signal?: AbortSignal,
): Promise<PreparedImageFile> {
  signal?.throwIfAborted()
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  const detected = await inspectMetadata(input.data, input.mediaType, limits)
  signal?.throwIfAborted()
  const normalized = await normalizeImage(input.data, detected, policy, signal)
  signal?.throwIfAborted()
  const sha256 = digest(normalized.data)
  const name = displayName(input.name)
  const downscaled = detected.width !== normalized.width || detected.height !== normalized.height
  return {
    data: normalized.data,
    ref: {
      attachmentId: AttachmentId(`sha256:${sha256}`),
      mediaType: normalized.mediaType,
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.data.byteLength,
      ...(name !== undefined ? { name } : {}),
      ...downscaled ? { originalDimensions: { width: detected.width, height: detected.height } } : {},
    },
  }
}

/**
 * Make a POSIX directory's entries durable (fsync on a read-only directory
 * handle). A synced file alone does not survive a crash when its directory
 * entry never reached storage, so the publication directory is synced before a
 * durable reference is reported.
 *
 * Windows takes no part in this: it exposes no directory-fsync contract, so
 * every entry there is made durable where it is created instead —
 * {@link ensureDurableDirectoryWin32} for directories, {@link
 * publishNewFileWin32} for objects — each of which flushes the namespace
 * change before it returns.
 */
async function syncPosixDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  return await handle.sync().then(
    () => handle.close(),
    (error: Thrown) => handle.close().then(() => {
      throw error
    }),
  )
}

/**
 * Create one private directory tree and persist every ancestor entry up to a
 * caller-vouched durable boundary. The walk deliberately ignores what mkdir
 * reports as newly created: a concurrent first save can create a level this
 * process then merely observes, so "already existed" is not "already durable"
 * — the entry may still be unsynced in the creator, and a crash would drop a
 * directory the session checkpoint already references. Re-syncing a durable
 * entry is harmless; skipping an unsynced one is not.
 * @param path - absolute directory to create.
 * @param boundary - absolute ancestor the caller vouches is already durable.
 */
async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  if (process.platform === 'win32') {
    await ensureDurableDirectoryWin32(target)
    return
  }
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncPosixDirectory(parent)
    if (parent === level) return
    level = parent
  }
}

/**
 * Publish the staged object at its content-addressed name, leaving no staging
 * entry behind. POSIX hard-links the target and then drops the staging name,
 * which fails with `EEXIST` when another writer stored the same content first.
 * Windows has no directory fsync, so the staging file is MOVED into place with
 * write-through namespace semantics instead — same no-clobber outcome, and the
 * entry is durable when the call returns.
 * @param temporary - the synced staging file.
 * @param target - the content-addressed destination.
 * @returns whether this call created the entry or found an existing one.
 */
function existingObject(error: Thrown, temporary: string): Promise<'exists'> {
  if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  return unlink(temporary).then(() => 'exists')
}

async function publishObject(temporary: string, target: string): Promise<'published' | 'exists'> {
  const published = process.platform === 'win32'
    ? publishNewFileWin32(temporary, target)
    : link(temporary, target)
  return await published.then(
    () => {
      // Windows shares the read-only attribute across hard links and refuses to
      // unlink either name once it is set, so the staging name goes before the
      // caller stamps the target read-only. The Windows move already consumed it.
      if (process.platform === 'win32') return 'published'
      return unlink(temporary).then(
        () => 'published',
        (error: Thrown) => existingObject(error, temporary),
      )
    },
    (error: Thrown) => existingObject(error, temporary),
  )
}

/**
 * Establish this process's proof that one DSH_HOME entry and every ancestor
 * below the filesystem root are durable. Mere existence is insufficient: a
 * concurrent process may have created the directory but not synced its parent.
 */
async function ensureDurableHome(path: string): Promise<string> {
  const home = resolve(path)
  if (!durableHomes.has(home)) {
    await ensureDurableDirectory(home, parse(home).root)
    durableHomes.add(home)
  }
  return home
}

/**
 * Publish one already verified normalized image below a versioned attachment root.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param prepared - deterministic normalized bytes and reference.
 * @param signal - cancellation is accepted until atomic publication starts; publication then completes durably.
 * @returns durable content-addressed normalized image reference.
 */
export async function commitPreparedImageFile(
  root: string,
  prepared: PreparedImageFile,
  signal?: AbortSignal,
): Promise<ImageAttachmentRef> {
  signal?.throwIfAborted()
  const normalized = prepared.data
  const sha256 = ensureReference(prepared.ref)
  if (digest(normalized) !== sha256 || normalized.byteLength !== prepared.ref.bytes) {
    throw new AttachmentError('Prepared attachment bytes do not match their reference.', 'ATTACHMENT_CORRUPT')
  }
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const staging = join(root, 'tmp')
  // Establish DSH_HOME itself against the filesystem root once per process.
  // Every process performs that proof independently, so observing a directory
  // another process created can never be mistaken for durable publication.
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(bucket, boundary)
  await ensureDurableDirectory(staging, boundary)
  signal?.throwIfAborted()
  const temporary = join(staging, randomUUID())
  const target = normalizedImagePath(root, prepared.ref)
  let publicationStarted = false
  return await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600).then(
    handle => handle.writeFile(normalized, { signal }).then(
      () => handle.sync(),
    ).then(
      () => handle.close(),
      (error: Thrown) => handle.close().then(() => {
        throw error
      }),
    ).then(() => {
      signal?.throwIfAborted()
      publicationStarted = true
      return publishObject(temporary, target).then((published) => {
        if (published !== 'exists') return
        return readFile(target).then((existing) => {
          if (digest(new Uint8Array(existing)) !== sha256) {
            throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
          }
        })
      }).then(() => {
        // The target remains the sole link for a new object; this also restores
        // read-only mode when the deduplication path observes an existing object.
        return chmod(target, 0o400)
      }).then(() => {
        // Persist the target entry and close a concurrent bucket-creation window
        // before the reference can reach a session checkpoint. The dedup path
        // repeats both syncs because it may observe another writer's link before
        // that writer reaches its own durability boundary. Windows published both
        // entries write-through already, so it has nothing left to flush.
        if (process.platform === 'win32') return
        return syncPosixDirectory(bucket).then(() => syncPosixDirectory(join(root, 'objects')))
      })
    }),
  ).then(
    () => prepared.ref,
    (error: Thrown) => rm(temporary, { force: true }).then(() => {
      if (!publicationStarted) signal?.throwIfAborted()
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('Unable to persist image attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
    }),
  )
}

/**
 * Decode and normalize one image once, then publish the prepared object.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param input - submitted encoded bytes and declared media type.
 * @param limits - resolved source admission policy.
 * @param policy - resolved normalization policy.
 * @param signal - cancellation of preparation and publication before its atomic commit begins.
 * @returns durable content-addressed normalized image reference.
 */
export async function saveImageFile(
  root: string,
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
  signal?: AbortSignal,
): Promise<ImageAttachmentRef> {
  return commitPreparedImageFile(root, await prepareImageFile(input, limits, policy, signal), signal)
}

/**
 * Read and verify one content-addressed image.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for filesystem and verification work.
 * @returns verified bytes and reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readImageFile(
  root: string,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredImageAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  const data = await readFile(normalizedImagePath(root, ref), { signal }).then(
    bytes => new Uint8Array(bytes),
    (error: Thrown) => {
      signal?.throwIfAborted()
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
      throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
    },
  )
  signal?.throwIfAborted()
  if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  // The digest proves these are the exact bytes admission fully decoded, so
  // the read path only re-derives the header fields (no raster decode, no
  // per-request pixel amplification on history replay).
  const metadata = await probeImage(data)
  signal?.throwIfAborted()
  if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
    || metadata.width !== ref.width || metadata.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}
