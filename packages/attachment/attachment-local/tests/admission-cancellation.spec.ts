import { Context } from '@deepseek-ai/cordis'
import { getEventListeners } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import LocalAttachmentStore from '../src/index.ts'
import { detectImage } from '../src/image.ts'
import { normalizeImage } from '../src/normalization.ts'
import { commitPreparedImageFile, prepareImageFile } from '../src/store.ts'
import type { SaveImageAttachment } from '@deepseek-ai/dsh-attachment'

async function image(red: number): Promise<SaveImageAttachment> {
  return {
    data: await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: red, g: 20, b: 30 } } })
      .png().toBuffer(),
    mediaType: 'image/png',
  }
}

it('removes a cancelled queued admission without publishing its image', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-admission-queue-'))
  try {
    const store = new LocalAttachmentStore(new Context(), { dshHome: home, imageCompressionConcurrency: 1 })
    const first = await image(10)
    const second = await image(200)
    const controller = new AbortController()
    const reason = new Error('cancel queued image')
    const saving = store.saveImage(first)
    const cancelled = store.saveImage(second, controller.signal)
    const rejected = expect(cancelled).rejects.toBe(reason)
    const completed = Promise.all([saving, rejected])
    controller.abort(reason)
    const [ref] = await completed
    const stored = await store.readImage(ref)
    expect(Buffer.from(stored.data)).toEqual(Buffer.from(first.data))
    const files = await readdir(join(store.root, 'objects'), { recursive: true, withFileTypes: true })
    expect(files.filter(entry => entry.isFile()).map(entry => entry.name))
      .toEqual([ref.attachmentId.slice('sha256:'.length)])
    await expect(readdir(join(store.root, 'tmp'))).resolves.toEqual([])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it.each(['single', 'batch', 'validation'])('cancels %s admission before storage publication', async (kind) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-admission-active-'))
  try {
    const store = new LocalAttachmentStore(new Context(), { dshHome: home, imageCompressionConcurrency: 1 })
    const input = await image(60)
    const controller = new AbortController()
    const reason = new Error('cancel image preparation')
    const operation = kind === 'single'
      ? store.saveImage(input, controller.signal)
      : kind === 'batch'
        ? store.saveImages([input, input], controller.signal)
        : store.validateImage(input, controller.signal)
    const rejected = expect(operation).rejects.toBe(reason)
    queueMicrotask(() => { controller.abort(reason) })
    await rejected
    expect(existsSync(store.root)).toBe(false)
    await store.validateImage(input)
    expect(existsSync(store.root)).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('joins native normalization before returning cancellation', async () => {
  const input = await image(120)
  const detected = await detectImage(input.data)
  const controller = new AbortController()
  const reason = new Error('cancel active native encoding')
  const operation = normalizeImage(input.data, detected, {
    maxPixels: 64,
    maxDimension: 8,
    maxBytes: 1024,
  }, controller.signal)
  const rejected = expect(operation).rejects.toBe(reason)
  queueMicrotask(() => { controller.abort(reason) })
  await rejected
})

it('settles every batch preparation before reporting an invalid image', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-admission-settlement-'))
  try {
    const store = new LocalAttachmentStore(new Context(), {
      dshHome: home,
      imageCompressionConcurrency: 2,
      normalizedImageMaxPixels: 64,
    })
    const input = await image(160)
    const controller = new AbortController()
    await expect(store.saveImages([
      { data: new Uint8Array(), mediaType: 'image/png' },
      input,
    ], controller.signal)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    expect(getEventListeners(controller.signal, 'abort')).toEqual([])
    expect(existsSync(store.root)).toBe(false)
    await store.validateImage(input)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it.each(['before', 'during'])('cancels %s directory preparation without publishing bytes', async (timing) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-admission-commit-'))
  try {
    const store = new LocalAttachmentStore(new Context(), { dshHome: home })
    const input = await image(80)
    const prepared = await prepareImageFile(input, store.imageLimits, store.normalizationPolicy)
    const controller = new AbortController()
    const reason = new Error('cancel prepared publication')
    if (timing === 'before') controller.abort(reason)
    const operation = commitPreparedImageFile(store.root, prepared, controller.signal)
    const rejected = expect(operation).rejects.toBe(reason)
    if (timing === 'during') queueMicrotask(() => { controller.abort(reason) })
    await rejected
    const entries = await readdir(home, { recursive: true, withFileTypes: true })
    expect(entries.filter(entry => entry.isFile())).toEqual([])
    const ref = await commitPreparedImageFile(store.root, prepared)
    const stored = await store.readImage(ref)
    expect(Buffer.from(stored.data)).toEqual(Buffer.from(input.data))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
