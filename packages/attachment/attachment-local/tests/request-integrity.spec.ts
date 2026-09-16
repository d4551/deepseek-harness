import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it } from 'vitest'
import LocalAttachmentStore from '../src/index.ts'

const source = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
))
const policy = { maxPixels: 1, maxBytes: 1024 }
const invalidReferences: { field: string; change: Partial<ImageAttachmentRef> }[] = [
  { field: 'bytes', change: { bytes: 0 } },
  { field: 'width', change: { width: 2 } },
  { field: 'height', change: { height: 2 } },
  { field: 'mediaType', change: { mediaType: 'image/jpeg' } },
]

describe('concurrent request-image integrity', () => {
  for (const invalidFirst of [false, true]) {
    it.each(invalidReferences)(`verifies $field independently when invalid-first is ${invalidFirst}`, async ({ change }) => {
      const dshHome = await mkdtemp(join(tmpdir(), 'dsh-request-integrity-'))
      try {
        const store = new LocalAttachmentStore(new Context(), { dshHome })
        const ref = await store.saveImage({ data: source, mediaType: 'image/png' })
        const invalid = { ...ref, ...change }
        const ordered = invalidFirst ? [invalid, ref] : [ref, invalid]
        const results = await Promise.allSettled(ordered.map(value => store.readImageRequest(value, policy)))

        expect(results[invalidFirst ? 0 : 1]).toMatchObject({
          status: 'rejected',
          reason: {
            code: 'ATTACHMENT_CORRUPT',
            message: 'Stored attachment metadata does not match its reference.',
          },
        })
        expect(results[invalidFirst ? 1 : 0]).toMatchObject({
          status: 'fulfilled',
          value: { attachment: ref, data: source },
        })
        await expect(store.readImage(ref)).resolves.toEqual({ ref, data: source })
      } finally {
        await rm(dshHome, { recursive: true, force: true })
      }
    })
  }

  it('preserves each reference display name for identical immutable bytes', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-request-names-'))
    try {
      const store = new LocalAttachmentStore(new Context(), { dshHome })
      const ref = await store.saveImage({ data: source, mediaType: 'image/png', name: 'first.png' })
      const renamed = { ...ref, name: 'second.png' }
      const resized = { ...ref, originalDimensions: { width: 4, height: 3 } }
      const results = await Promise.all([
        store.readImageRequest(ref, policy),
        store.readImageRequest(renamed, policy),
        store.readImageRequest(resized, policy),
      ])
      expect(results.map(result => result.attachment)).toEqual([ref, renamed, resized])
      expect(results.map(result => result.data)).toEqual([source, source, source])
      expect(results[0]?.variantId).toBe(results[1]?.variantId)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('releases settled requests so subsequent reads verify the current object', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-request-settlement-'))
    try {
      const store = new LocalAttachmentStore(new Context(), { dshHome })
      const ref = await store.saveImage({ data: source, mediaType: 'image/png' })
      await expect(store.readImageRequest(ref, policy)).resolves.toMatchObject({
        attachment: ref, data: source,
      })
      await rm(store.imageHostPath(ref))
      await expect(store.readImageRequest(ref, policy)).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      })
      expect(await store.saveImage({ data: source, mediaType: 'image/png' })).toEqual(ref)
      await expect(store.readImageRequest(ref, policy)).resolves.toMatchObject({
        attachment: ref, data: source,
      })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})
