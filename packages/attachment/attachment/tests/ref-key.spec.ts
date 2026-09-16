import { describe, expect, it } from 'vitest'
import { AttachmentId, imageAttachmentRefKey } from '../src/index.ts'
import type { ImageAttachmentRef } from '../src/index.ts'

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 120,
  width: 2,
  height: 3,
  name: 'image.png',
  originalDimensions: { width: 4, height: 6 },
}

describe('image reference identity', () => {
  it('shares equal references regardless of property insertion order', () => {
    expect(imageAttachmentRefKey({
      originalDimensions: { height: 6, width: 4 },
      name: 'image.png',
      height: 3,
      width: 2,
      bytes: 120,
      mediaType: 'image/png',
      attachmentId: ref.attachmentId,
    })).toBe(imageAttachmentRefKey(ref))
  })

  it.each<{ field: string; change: Partial<ImageAttachmentRef> }>([
    { field: 'attachmentId', change: { attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`) } },
    { field: 'mediaType', change: { mediaType: 'image/jpeg' } },
    { field: 'bytes', change: { bytes: 121 } },
    { field: 'width', change: { width: 3 } },
    { field: 'height', change: { height: 4 } },
    { field: 'name', change: { name: 'other.png' } },
    { field: 'original width', change: { originalDimensions: { width: 5, height: 6 } } },
    { field: 'original height', change: { originalDimensions: { width: 4, height: 7 } } },
  ])('does not share a reference with different $field', ({ change }) => {
    expect(imageAttachmentRefKey({ ...ref, ...change })).not.toBe(imageAttachmentRefKey(ref))
  })

  it('distinguishes absent optional metadata from recorded values', () => {
    const { name, originalDimensions, ...intrinsic } = ref
    expect(name).toBe('image.png')
    expect(originalDimensions).toEqual({ width: 4, height: 6 })
    expect(new Set([
      imageAttachmentRefKey(intrinsic),
      imageAttachmentRefKey({ ...intrinsic, name: '' }),
      imageAttachmentRefKey({ ...intrinsic, originalDimensions: { width: 4, height: 6 } }),
      imageAttachmentRefKey(ref),
    ]).size).toBe(4)
  })
})
